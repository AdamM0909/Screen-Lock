// Tab Lock shared helpers.
// Loaded by every extension page and by the background worker (importScripts).
//
// Security notes:
//  - The password is never stored. Only a salted PBKDF2-SHA256 hash is kept.
//  - The phone-unlock secret has to be stored as-is (that is how authenticator
//    codes work). It lives in chrome.storage.local, which web pages cannot read.

const PBKDF2_ITER = 150000;
const MAX_FAILS = 5;            // wrong tries before a cooldown
const COOLDOWN_MS = 60000;      // 1 minute cooldown
const TOTP_STEP = 30;           // seconds per phone code
const TOTP_DIGITS = 6;
const LOG_MAX = 1000;           // oldest log entries are dropped past this
const LOCKSCREEN_URL = chrome.runtime.getURL("lockscreen.html");

const THEMES = {
  gold:   { name: "Gold",   accent: "#e8b44a" },
  ember:  { name: "Ember",  accent: "#ff7a45" },
  neon:   { name: "Neon",   accent: "#38d9f5" },
  toxic:  { name: "Toxic",  accent: "#8be04e" },
  violet: { name: "Violet", accent: "#b48cff" }
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------- bytes

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- password

async function hashPassword(pw, saltHex, iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations },
    key,
    256
  );
  return toHex(bits);
}

async function hasPassword() {
  const { auth } = await chrome.storage.local.get("auth");
  return !!(auth && auth.hash);
}

async function setPassword(pw) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(pw, salt);
  await chrome.storage.local.set({ auth: { salt, hash, iterations: PBKDF2_ITER } });
}

async function checkPassword(pw) {
  const { auth } = await chrome.storage.local.get("auth");
  if (!auth || !pw) return false;
  const h = await hashPassword(pw, auth.salt, auth.iterations || PBKDF2_ITER);
  return safeEqual(h, auth.hash);
}

// ---------------------------------------------------------------- phone codes (TOTP, RFC 6238)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function newTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function totpAt(secret, counter, digits = TOTP_DIGITS) {
  const key = await crypto.subtle.importKey(
    "raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 255;
    c = Math.floor(c / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function totpCounter(timeMs = Date.now()) {
  return Math.floor(timeMs / 1000 / TOTP_STEP);
}

// Returns the matching counter, or -1. Allows one step of clock drift each way.
async function findTotpCounter(secret, code, timeMs = Date.now()) {
  if (!/^\d{6}$/.test(code)) return -1;
  const now = totpCounter(timeMs);
  for (const c of [now, now - 1, now + 1]) {
    if (safeEqual(await totpAt(secret, c), code)) return c;
  }
  return -1;
}

function totpUri(secret, label = "Tab Lock") {
  const l = encodeURIComponent(label);
  return `otpauth://totp/${l}?secret=${secret}&issuer=${l}&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

// Checks a phone code and marks it used so the same code can't be used twice.
async function checkPhoneCode(code) {
  const { totp } = await chrome.storage.local.get("totp");
  if (!totp || !totp.enabled || !totp.secret) return false;
  const counter = await findTotpCounter(totp.secret, code);
  if (counter < 0 || counter <= (totp.lastCounter || -1)) return false;
  totp.lastCounter = counter;
  await chrome.storage.local.set({ totp });
  return true;
}

// ---------------------------------------------------------------- unlocking

// Checks a password OR a phone code, with a shared cooldown after too many
// wrong tries. Returns { ok: true, method } or { ok: false, wait, left }.
async function tryUnlockSecret(input) {
  const { attempts = { fails: 0, until: 0 } } = await chrome.storage.local.get("attempts");
  const now = Date.now();
  if (now < attempts.until) {
    return { ok: false, wait: Math.ceil((attempts.until - now) / 1000), left: 0 };
  }
  let method = null;
  if (await checkPassword(input)) method = "password";
  else if (/^\d{6}$/.test((input || "").trim()) && (await checkPhoneCode(input.trim()))) method = "phone code";

  if (method) {
    await chrome.storage.local.set({ attempts: { fails: 0, until: 0 } });
    return { ok: true, method };
  }
  attempts.fails += 1;
  let res;
  if (attempts.fails >= MAX_FAILS) {
    attempts.fails = 0;
    attempts.until = now + COOLDOWN_MS;
    res = { ok: false, wait: Math.ceil(COOLDOWN_MS / 1000), left: 0 };
    logEvent("cooldown", `${MAX_FAILS} wrong tries, ${COOLDOWN_MS / 1000}s cooldown`);
  } else {
    res = { ok: false, wait: 0, left: MAX_FAILS - attempts.fails };
    logEvent("wrong", "Wrong password or code");
  }
  await chrome.storage.local.set({ attempts });
  return res;
}

// Password only (used for settings and changing the password).
async function tryPassword(pw) {
  const { attempts = { fails: 0, until: 0 } } = await chrome.storage.local.get("attempts");
  const now = Date.now();
  if (now < attempts.until) return { ok: false, wait: Math.ceil((attempts.until - now) / 1000), left: 0 };
  if (await checkPassword(pw)) {
    await chrome.storage.local.set({ attempts: { fails: 0, until: 0 } });
    return { ok: true, method: "password" };
  }
  attempts.fails += 1;
  let res;
  if (attempts.fails >= MAX_FAILS) {
    attempts.fails = 0;
    attempts.until = now + COOLDOWN_MS;
    res = { ok: false, wait: COOLDOWN_MS / 1000, left: 0 };
    logEvent("cooldown", "Too many wrong tries on settings");
  } else {
    res = { ok: false, wait: 0, left: MAX_FAILS - attempts.fails };
    logEvent("wrong", "Wrong password on settings");
  }
  await chrome.storage.local.set({ attempts });
  return res;
}

function failMessage(res) {
  if (res.wait) return `Too many wrong tries. Wait ${res.wait} seconds.`;
  return `Wrong password or code. ${res.left} ${res.left === 1 ? "try" : "tries"} left before a cooldown.`;
}

// ---------------------------------------------------------------- lock state

async function getLock() {
  const { lock } = await chrome.storage.local.get("lock");
  return lock && lock.active ? lock : null;
}

// endReason: "password", "phone code", "timer", "schedule ended"
async function unlock(endReason) {
  const { lock } = await chrome.storage.local.get("lock");
  if (lock && lock.active) {
    lock.active = false;
    lock.endReason = endReason || "unlocked";
    lock.endedAt = Date.now();
    await chrome.storage.local.set({ lock });
  }
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return {
    theme: THEMES[settings.theme] ? settings.theme : "gold",
    clock24: !!settings.clock24,
    message: settings.message || ""
  };
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = THEMES[theme] ? theme : "gold";
}

function lockTargetLabel(lock) {
  if (!lock) return "";
  if (lock.mode === "screen") return "Lock screen";
  if (lock.mode === "site") return `${lock.origin} (whole site)`;
  return lock.url;
}

// ---------------------------------------------------------------- schedules

function parseHM(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || "");
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function atMinutes(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

// If `now` falls inside one of the schedule's windows, returns
// { start: Date, end: Date }. Otherwise null. Windows that cross midnight
// (like 21:00 to 07:00) belong to the day they start on.
function scheduleWindow(s, now = new Date()) {
  if (!s || !s.enabled || !Array.isArray(s.days) || !s.days.length) return null;
  const start = parseHM(s.start), end = parseHM(s.end);
  if (start === null || end === null || start === end) return null;
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (end > start) {
    if (!s.days.includes(today.getDay())) return null;
    const a = atMinutes(today, start), b = atMinutes(today, end);
    return now >= a && now < b ? { start: a, end: b } : null;
  }
  // overnight window
  if (s.days.includes(today.getDay())) {
    const a = atMinutes(today, start);
    if (now >= a) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return { start: a, end: atMinutes(tomorrow, end) };
    }
  }
  if (s.days.includes(yesterday.getDay())) {
    const b = atMinutes(today, end);
    if (now < b) return { start: atMinutes(yesterday, start), end: b };
  }
  return null;
}

function formatClock(date, clock24) {
  return date.toLocaleTimeString([], { hour: clock24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !clock24 });
}

function formatHM(hm, clock24) {
  const m = parseHM(hm);
  if (m === null) return hm || "";
  return formatClock(atMinutes(new Date(), m), clock24);
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatSpan(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---------------------------------------------------------------- usage log

const IS_WORKER = typeof window === "undefined";
let _logQueue = Promise.resolve();

async function appendLog(entry) {
  const { log = [] } = await chrome.storage.local.get("log");
  log.push(entry);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  await chrome.storage.local.set({ log });
}

// Pages send log entries to the background worker so all writes happen in
// one place and never overwrite each other.
function logEvent(type, detail = "", extra = {}) {
  const entry = { ...extra, t: Date.now(), type, detail: String(detail).slice(0, 300) };
  if (IS_WORKER) {
    _logQueue = _logQueue.then(() => appendLog(entry)).catch(() => {});
    return _logQueue;
  }
  return chrome.runtime.sendMessage({ type: "log", entry }).catch(() => appendLog(entry));
}

const LOG_LABELS = {
  lock: "Locked",
  unlock: "Unlocked",
  "auto-lock": "Schedule locked",
  "auto-unlock": "Auto unlocked",
  wrong: "Wrong password",
  cooldown: "Cooldown",
  "blocked-tab": "Blocked new tab",
  "blocked-window": "Blocked new window",
  "blocked-site": "Sent back to page",
  reopened: "Reopened closed tab",
  fullscreen: "Fullscreen restored",
  settings: "Settings changed"
};

const ESCAPE_TYPES = new Set(["blocked-tab", "blocked-window", "blocked-site", "reopened", "fullscreen"]);
