const Imap = require('imap');
const { simpleParser } = require('mailparser');

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

function getImapServer(domain) {
  if (imapMappings[domain]) return imapMappings[domain];
  return { server: `imap.${domain}`, port: 993 };
}

async function readLastEmails(email, password, count = 5) {
  const domain = email.split("@")[1];
  const { server, port } = getImapServer(domain);

  const imapConfig = {
    user: email,
    password: password,
    host: server,
    port: port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 10000,
    authTimeout: 10000
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
        const fetch = imap.seq.fetch(`${start}:${box.messages.total}`, { bodies: "" });

        fetch.on("message", (msg, seqno) => {
          fetchCount++;
          msg.on("body", (stream) => {
            simpleParser(stream, (err, parsed) => {
              parsedCount++;
              if (!err) {
                results.push({
                  subject: parsed.subject,
                  date: parsed.date,
                  from: parsed.from.text,
                  text: parsed.text ? parsed.text.substring(0, 200) : "(Không có nội dung văn bản)"
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
const email = "hikko0629@mineo.jp";
const password = "hikko978655";

console.log("🚀 Bắt đầu đọc email...");

readLastEmails(email, password, 5)
  .then(emails => {
    console.log(`\n✅ Thành công! Đã tìm thấy ${emails.length} email.`);
    console.log(`--- 5 EMAIL GẦN NHẤT CỦA ${email} ---\n`);
    emails.forEach((mail, i) => {
      console.log(`${i + 1}. [${mail.date}] ${mail.subject}`);
      console.log(`   Từ: ${mail.from}`);
      console.log(`   Nội dung: ${mail.text.replace(/\n/g, ' ')}...\n`);
    });
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ LỖI TRONG QUÁ TRÌNH ĐỌC EMAIL:", err.message);
    process.exit(1);
  });
