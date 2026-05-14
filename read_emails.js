const Imap = require("imap");
const { simpleParser } = require("mailparser");
const POP3Client = require("poplib");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const https = require("https");
const Database = require('better-sqlite3');

const DOMAINS_FILE = path.resolve(__dirname, "domains.txt"); // domain|imap_server
const dbPath = path.resolve(__dirname, 'db.db');
const db = new Database(dbPath, { readonly: true });

let imapMappings = {
  "mineo.jp": { server: "imaps.mineo.jp", port: 993 },
  "gmail.com": { server: "imap.gmail.com", port: 993 },
};

let domainsLoaded = false;
function loadDomains() {
  if (domainsLoaded) return;
  if (!fs.existsSync(DOMAINS_FILE)) {
    domainsLoaded = true;
    return;
  }
  try {
    const lines = fs.readFileSync(DOMAINS_FILE, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim() || line.startsWith("#")) continue;
      const parts = line.split("|");
      if (parts.length >= 2) {
        const domain = parts[0].trim().toLowerCase();
        const server = parts[1].trim();
        const port = parts.length > 2 ? parseInt(parts[2].trim(), 10) : 993;
        if (domain && server) {
          if (server === `imap.${domain}` || server === `pop.${domain}`) continue;
          imapMappings[domain] = { server, port: port || 993 };
        }
      }
    }
  } catch (e) { }
  domainsLoaded = true;
}

function getImapConfig(domain) {
  try {
    const query = db.prepare('SELECT * FROM IMAP WHERE Domain = ?');
    const row = query.get(domain);
    if (!row) return null;

    return {
      server: row.Server,
      port: row.Port,
      isSsl: (row.SocketType === 0 || row[3] === 0),
      type: row.Type?.toLowerCase() || 'imap'
    };
  } catch (e) {
    return null;
  }
}

async function getAutoconfig(domain) {
  const url = `https://autoconfig.thunderbird.net/v1.1/${domain}`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve(data));
    }).on("error", () => resolve(null));
  });
}

async function discoverMailSettings(domain) {
  const xml = await getAutoconfig(domain);
  if (xml) {
    const imapMatch = xml.match(/<incoming type="imap">.*?<hostname>(.*?)<\/hostname>.*?<port>(.*?)<\/port>/s);
    if (imapMatch) return { server: imapMatch[1], port: parseInt(imapMatch[2], 10) };
    const popMatch = xml.match(/<incoming type="pop3">.*?<hostname>(.*?)<\/hostname>.*?<port>(.*?)<\/port>/s);
    if (popMatch) return { server: popMatch[1], port: parseInt(popMatch[2], 10) };
  }
  const candidates = ["imap", "mail", "pop", "pop3"];
  for (const p of candidates) {
    const host = `${p}.${domain}`;
    try {
      await dns.lookup(host);
      return { server: host, port: p.startsWith("pop") ? 110 : 993 };
    } catch (e) { }
  }
  return null;
}

async function getImapServer(domain) {
  const d = domain.toLowerCase();

  // 1. Database
  const dbConfig = getImapConfig(d);
  if (dbConfig) return dbConfig;

  // 2. Mapping
  loadDomains();
  const parts = d.split(".");
  for (let i = 0; i <= parts.length - 2; i++) {
    const parentDomain = parts.slice(i).join(".");
    if (imapMappings[parentDomain]) return imapMappings[parentDomain];
  }

  // 3. Auto-discovery
  const discovered = await discoverMailSettings(d);
  if (discovered) {
    imapMappings[d] = discovered;
    return discovered;
  }

  // 4. Fallback
  return { server: `imap.${domain}`, port: 993 };
}

async function readLastEmailsPop3(email, password, server, port, count = 5) {
  const isSsl = port == 995 || port == 465;
  return new Promise((resolve, reject) => {
    let results = [];
    const client = new POP3Client(port, server, { tlserrs: false, enabletls: isSsl, debug: false });
    client.on("error", (err) => reject(err));
    client.on("connect", () => client.login(email, password));
    client.on("login", (status, rawdata) => {
      if (status) client.stat();
      else reject(new Error("POP3 Login failed: " + rawdata));
    });
    client.on("stat", (status, data) => {
      if (status && data.count > 0) {
        const total = data.count;
        const toFetch = Math.min(count, total);
        let fetched = 0;
        const fetchNext = (idx) => {
          if (idx <= 0 || results.length >= toFetch) { client.quit(); resolve(results); return; }
          client.retr(idx);
        };
        client.on("retr", (status, msgnumber, raw) => {
          if (status) {
            simpleParser(raw, (err, parsed) => {
              fetched++;
              if (!err) {
                results.push({ subject: parsed.subject, date: parsed.date, from: parsed.from.text, text: parsed.text ?? "(Không có nội dung)" });
              }
              if (results.length < toFetch && total - fetched > 0) fetchNext(total - fetched);
              else { client.quit(); resolve(results); }
            });
          } else fetchNext(total - fetched - 1);
        });
        fetchNext(total);
      } else { client.quit(); resolve([]); }
    });
  });
}

async function readLastEmails(email, password, count = 1) {
  const domain = email.split("@")[1];
  const config = await getImapServer(domain);
  const { server, port, type } = config;
  const isSsl = config.isSsl || port == 993 || port == 995 || port == 465;
  const isPop3 = type === 'pop3' || port == 110 || port == 995;

  if (isPop3) {
    console.log(`🔍 Sử dụng POP3: ${server}:${port} (SSL: ${isSsl})`);
    return readLastEmailsPop3(email, password, server, port, count);
  }

  console.log(`🔍 Sử dụng IMAP: ${server}:${port} (SSL: ${isSsl})`);
  const imapConfig = {
    user: email,
    password: password,
    host: server,
    port: port,
    tls: isSsl,
    tlsOptions: {
      rejectUnauthorized: false,
      minVersion: "TLSv1",
      ciphers: "DEFAULT@SECLEVEL=0"
    },
    connTimeout: 20000,
    authTimeout: 20000,
  };

  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig);
    let results = [];
    let isDone = false;
    let fetchCount = 0;
    let parsedCount = 0;

    const cleanup = (err) => {
      if (isDone) return;
      isDone = true;
      imap.end();
      if (err) reject(err);
      else resolve(results.sort((a, b) => b.date - a.date));
    };

    imap.once("ready", () => {
      imap.openBox("INBOX", true, (err, box) => {
        if (err) return cleanup(err);
        if (box.messages.total === 0) return cleanup();
        const start = Math.max(1, box.messages.total - count + 1);
        const fetch = imap.seq.fetch(`${start}:${box.messages.total}`, { bodies: "" });
        fetch.on("message", (msg) => {
          fetchCount++;
          msg.on("body", (stream) => {
            simpleParser(stream, (err, parsed) => {
              parsedCount++;
              if (!err) results.push({ subject: parsed.subject, date: parsed.date, from: parsed.from.text, text: parsed.text ?? "" });
              if (parsedCount === fetchCount && fetchFinished) cleanup();
            });
          });
        });
        let fetchFinished = false;
        fetch.once("end", () => { fetchFinished = true; if (parsedCount === fetchCount) cleanup(); });
        fetch.once("error", cleanup);
      });
    });
    imap.once("error", cleanup);
    imap.connect();
  });
}

// Chạy thử
const email = "hikko0629@mineo.jp";
const password = "hikko978655";

console.log(`🚀 Kiểm tra email cho ${email}...`);
readLastEmails(email, password, 1)
  .then((emails) => {
    emails.forEach((mail, i) => {
      console.log(`${i + 1}. [${mail.date}] ${mail.subject}`);
      console.log(`   Từ: ${mail.from}`);
      console.log(`   Nội dung: ${mail.text.substring(0, 100)}...\n`);
    });
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Lỗi:", err.message);
    process.exit(1);
  });
