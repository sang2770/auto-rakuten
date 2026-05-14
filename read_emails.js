const Imap = require("imap");
const { simpleParser } = require("mailparser");
const POP3Client = require("poplib");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const https = require("https");

const DOMAINS_FILE = path.resolve(__dirname, "domains.txt"); // domain|imap_server

const imapMappings = {
  "mineo.jp": { server: "imaps.mineo.jp", port: 993 },
  "gmail.com": { server: "imap.imap.com", port: 993 },
  "yahoo.com": { server: "imap.mail.yahoo.com", port: 993 },
  "outlook.com": { server: "outlook.office365.com", port: 993 },
  "hotmail.com": { server: "outlook.office365.com", port: 993 },
  "aol.com": { server: "imap.aol.com", port: 993 },
  "icloud.com": { server: "imap.mail.me.com", port: 993 },
  "rakuten.jp": { server: "popmail.gol.com", port: 993 },
};

let domainsLoaded = false;
function loadDomains() {
  if (domainsLoaded) return;
  if (!fs.existsSync(DOMAINS_FILE)) {
    domainsLoaded = true;
    return;
  }
  console.log("📂 Đang tải cấu hình IMAP từ domains.txt...");
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
          // Bỏ qua nếu server chỉ là dạng đoán mò imap. hoặc pop. để ưu tiên auto-discovery
          if (server === `imap.${domain}` || server === `pop.${domain}`) {
            continue;
          }
          imapMappings[domain] = { server, port: port || 993 };
        }
      }
    }
  } catch (e) {
    console.warn(`⚠️ Lỗi khi đọc domains.txt: ${e.message}`);
  }
  domainsLoaded = true;
  console.log(
    `✅ Đã tải xong danh sách domains (tổng số: ${Object.keys(imapMappings).length})`,
  );
}

async function getAutoconfig(domain) {
  const url = `https://autoconfig.thunderbird.net/v1.1/${domain}`;
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return resolve(null);
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve(data));
      })
      .on("error", () => resolve(null));
  });
}

async function discoverMailSettings(domain) {
  console.log(`🌐 Đang tự động dò tìm cấu hình cho ${domain}...`);
  // 1. Thử Mozilla Autoconfig
  const xml = await getAutoconfig(domain);
  if (xml) {
    const imapMatch = xml.match(
      /<incoming type="imap">.*?<hostname>(.*?)<\/hostname>.*?<port>(.*?)<\/port>/s,
    );
    if (imapMatch)
      return { server: imapMatch[1], port: parseInt(imapMatch[2], 10) };

    const popMatch = xml.match(
      /<incoming type="pop3">.*?<hostname>(.*?)<\/hostname>.*?<port>(.*?)<\/port>/s,
    );
    if (popMatch)
      return { server: popMatch[1], port: parseInt(popMatch[2], 10) };
  }

  // 2. DNS Brute-force
  const candidates = ["imap", "mail", "pop", "pop3"];
  for (const p of candidates) {
    const host = `${p}.${domain}`;
    try {
      await dns.lookup(host);
      console.log(`✨ Tìm thấy server qua DNS: ${host}`);
      return { server: host, port: p.startsWith("pop") ? 110 : 993 };
    } catch (e) {}
  }

  return null;
}

async function getImapServer(domain) {
  loadDomains();
  const d = domain.toLowerCase();

  // 1. Kiểm tra mapping hiện có (từ file hoặc hardcode)
  const parts = d.split(".");
  for (let i = 0; i <= parts.length - 2; i++) {
    const parentDomain = parts.slice(i).join(".");
    if (imapMappings[parentDomain]) {
      return imapMappings[parentDomain];
    }
  }

  // 2. Nếu không thấy, thử Auto-discovery
  const discovered = await discoverMailSettings(d);
  if (discovered) {
    imapMappings[d] = discovered; // Cache lại trong memory
    return discovered;
  }

  // 3. Fallback mặc định
  return { server: `imap.${domain}`, port: 993 };
}

async function readLastEmailsPop3(email, password, server, port, count = 5) {
  const isSsl = port == 995 || port == 465; // Thường là 995
  return new Promise((resolve, reject) => {
    let results = [];
    const client = new POP3Client(port, server, {
      tlserrs: false,
      enabletls: isSsl,
      debug: false,
    });

    client.on("error", (err) => {
      reject(err);
    });

    client.on("connect", () => {
      client.login(email, password);
    });

    client.on("login", (status, rawdata) => {
      if (status) {
        client.stat();
      } else {
        reject(new Error("POP3 Login failed: " + rawdata));
      }
    });

    client.on("stat", (status, data) => {
      if (status && data.count > 0) {
        const total = data.count;
        const toFetch = Math.min(count, total);
        let fetched = 0;

        const fetchNext = (idx) => {
          if (idx <= 0 || results.length >= toFetch) {
            client.quit();
            resolve(results);
            return;
          }
          client.retr(idx);
        };

        client.on("retr", (status, msgnumber, raw) => {
          if (status) {
            simpleParser(raw, (err, parsed) => {
              fetched++;
              if (!err) {
                results.push({
                  subject: parsed.subject,
                  date: parsed.date,
                  from: parsed.from.text,
                  text: parsed.text ?? "(Không có nội dung)",
                });
              }
              if (results.length < toFetch && total - fetched > 0) {
                fetchNext(total - fetched);
              } else {
                client.quit();
                resolve(results);
              }
            });
          } else {
            fetchNext(total - fetched - 1);
          }
        });

        fetchNext(total);
      } else {
        client.quit();
        resolve([]);
      }
    });
  });
}

async function readLastEmails(email, password, count = 1) {
  const domain = email.split("@")[1];
  const { server, port } = await getImapServer(domain);

  // Kiểm tra xem là POP3 hay IMAP (ưu tiên dựa vào port)
  const isPop3 = port == 110 || port == 995;

  if (isPop3) {
    console.log(`🔍 Đang sử dụng giao thức POP3 trên cổng ${port}...`);
    return readLastEmailsPop3(email, password, server, port, count);
  }

  console.log(`🔍 Đang sử dụng giao thức IMAP trên cổng ${port}...`);
  const imapConfig = {
    user: email,
    password: password,
    host: server,
    port: port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 10000,
    authTimeout: 10000,
  };

  console.log(`🔍 Đang kết nối tới ${server}...`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig);
    let results = [];
    let fetchCount = 0;
    let parsedCount = 0;
    let isDone = false;

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

        if (box.messages.total === 0) {
          console.log("Hộp thư trống.");
          return cleanup();
        }

        const start = Math.max(1, box.messages.total - count + 1);
        const fetch = imap.seq.fetch(`${start}:${box.messages.total}`, {
          bodies: "",
        });

        fetch.on("message", (msg, seqno) => {
          fetchCount++;
          msg.on("body", (stream) => {
            simpleParser(stream, (err, parsed) => {
              parsedCount++;
              console.log(parsed);
              if (!err) {
                results.push({
                  subject: parsed.subject,
                  date: parsed.date,
                  from: parsed.from.text,
                  text: parsed.text ?? "(Không có nội dung văn bản)",
                });
              } else {
                console.error(`❌ Lỗi parse email ${seqno}:`, err.message);
              }

              if (parsedCount === fetchCount && fetchFinished) {
                cleanup();
              }
            });
          });
        });

        let fetchFinished = false;
        fetch.once("end", () => {
          fetchFinished = true;
          if (parsedCount === fetchCount) {
            cleanup();
          }
        });

        fetch.once("error", (err) => {
          cleanup(err);
        });
      });
    });

    imap.once("error", (err) => {
      cleanup(err);
    });

    imap.once("end", () => {
      if (!isDone) cleanup();
    });

    imap.connect();
  });
}

// Chạy script
const email = "machida@fides.dti.ne.jp";
const password = "jun66118";

console.log("🚀 Bắt đầu đọc email...");

readLastEmails(email, password, 1)
  .then((emails) => {
    console.log(`\n✅ Thành công! Đã tìm thấy ${emails.length} email.`);
    console.log(`--- 5 EMAIL GẦN NHẤT CỦA ${email} ---\n`);
    emails.forEach((mail, i) => {
      console.log(`${i + 1}. [${mail.date}] ${mail.subject}`);
      console.log(`   Từ: ${mail.from}`);
      console.log(`   Nội dung: ${mail.text.replace(/\n/g, " ")}...\n`);
    });
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ LỖI TRONG QUÁ TRÌNH ĐỌC EMAIL:", err.message);
    process.exit(1);
  });
