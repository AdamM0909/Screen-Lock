// Run with: node tests/run-tests.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");
const { makeChrome } = require("./fake-chrome");

const EXT = path.join(__dirname, "..", "extension");
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function loadWorker() {
  const chrome = makeChrome();
  const ctx = vm.createContext({
    chrome, crypto: globalThis.crypto, console, setTimeout, clearTimeout,
    TextEncoder, URL, URLSearchParams
  });
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  return { chrome, ctx };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e));
  }
}

async function setupBrowser(chrome) {
  const w = await chrome.windows.create({ url: "https://game.example/play" });
  const t1 = w.tabs[0];
  const t2 = await chrome.tabs.create({ windowId: w.id, url: "https://news.example/", active: false });
  const w2 = await chrome.windows.create({ url: "https://other.example/" });
  return { w, t1, t2, w2 };
}

// Make the current lock look older than the grace period so escapes get logged.
async function ageLock(chrome) {
  const { lock } = await chrome.storage.local.get("lock");
  lock.since -= 60000;
  await chrome.storage.local.set({ lock });
  await wait();
}

async function logTypes(chrome) {
  const { log = [] } = await chrome.storage.local.get("log");
  return log.map((e) => e.type);
}

(async () => {
  console.log("Helpers");
  const { ctx: L } = loadWorker();

  await test("base32 round trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 77, 13, 99, 200, 4]);
    assert.deepEqual([...L.base32Decode(L.base32Encode(bytes))], [...bytes]);
    assert.equal(L.base32Encode(new TextEncoder().encode("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  await test("TOTP matches the RFC 6238 test vectors", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const vectors = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
    for (const [t, code] of vectors) assert.equal(await L.totpAt(secret, Math.floor(t / 30), 8), code, `t=${t}`);
  });

  await test("phone code accepts current and neighbor steps, rejects others", async () => {
    const s = L.newTotpSecret();
    assert.equal(s.length, 32);
    const now = Date.now(), c = L.totpCounter(now);
    assert.equal(await L.findTotpCounter(s, await L.totpAt(s, c), now), c);
    assert.equal(await L.findTotpCounter(s, await L.totpAt(s, c - 1), now), c - 1);
    assert.equal(await L.findTotpCounter(s, await L.totpAt(s, c - 3), now), -1);
    assert.equal(await L.findTotpCounter(s, "12ab56", now), -1);
  });

  await test("same-day schedule window", () => {
    const s = { enabled: true, days: [1], start: "15:00", end: "17:00" };
    const mon = (h, m = 0) => new Date(2026, 9, 12, h, m); // Mon Oct 12 2026
    assert.ok(L.scheduleWindow(s, mon(16)));
    assert.ok(L.scheduleWindow(s, mon(15)));
    assert.equal(L.scheduleWindow(s, mon(17)), null);
    assert.equal(L.scheduleWindow(s, mon(14, 59)), null);
    assert.equal(L.scheduleWindow(s, new Date(2026, 9, 13, 16)), null); // Tue
    assert.equal(L.scheduleWindow({ ...s, enabled: false }, mon(16)), null);
    assert.equal(L.scheduleWindow(s, mon(16)).end.getHours(), 17);
  });

  await test("overnight schedule window belongs to the start day", () => {
    const s = { enabled: true, days: [5], start: "21:00", end: "07:00" }; // Friday nights
    const d = (day, h, m = 0) => new Date(2026, 9, day, h, m); // Oct 16 2026 is Fri
    const w = L.scheduleWindow(s, d(16, 22));
    assert.ok(w);
    assert.equal(w.end.getDate(), 17);
    assert.equal(w.end.getHours(), 7);
    assert.ok(L.scheduleWindow(s, d(17, 6, 59)));
    assert.equal(L.scheduleWindow(s, d(17, 7)), null);
    assert.equal(L.scheduleWindow(s, d(17, 22)), null); // Sat night not picked
    assert.equal(L.scheduleWindow(s, d(16, 6)), null);  // Fri morning belongs to Thu
    assert.equal(L.scheduleWindow(s, d(15, 23)), null); // Thu night
  });

  await test("bad schedules never match", () => {
    const now = new Date();
    assert.equal(L.scheduleWindow({ enabled: true, days: [now.getDay()], start: "10:00", end: "10:00" }, now), null);
    assert.equal(L.scheduleWindow({ enabled: true, days: [], start: "00:00", end: "23:59" }, now), null);
    assert.equal(L.scheduleWindow({ enabled: true, days: [now.getDay()], start: "25:00", end: "23:59" }, now), null);
  });

  await test("duration formatting", () => {
    assert.equal(L.formatDuration(65000), "1:05");
    assert.equal(L.formatDuration(3723000), "1:02:03");
    assert.equal(L.formatDuration(-5), "0:00");
    assert.equal(L.formatSpan(90 * 60000), "1h 30m");
    assert.equal(L.formatSpan(5 * 60000), "5m");
  });

  console.log("Locking");

  await test("page lock closes other tabs and windows, keeps the target", async () => {
    const { chrome } = loadWorker();
    const { t1 } = await setupBrowser(chrome);
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "page", tab: t1, source: "manual" } });
    await wait();
    const { tabs, windows } = chrome._state;
    assert.deepEqual([...tabs.keys()], [t1.id]);
    assert.equal(windows.size, 1);
    const types = await logTypes(chrome);
    assert.ok(types.includes("lock"));
    assert.ok(!types.some((t) => t.startsWith("blocked")), "no escape logs during grace period");
  });

  await test("escape attempts are blocked and logged", async () => {
    const { chrome } = loadWorker();
    const { t1, w } = await setupBrowser(chrome);
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "page", tab: t1, source: "manual", fullscreen: true } });
    await wait();
    await ageLock(chrome);

    await chrome.tabs.create({ windowId: w.id, url: "https://sneaky.example/" });
    await wait();
    assert.equal(chrome._state.tabs.size, 1, "new tab closed");

    await chrome.tabs.update(t1.id, { url: "https://youtube.example/" });
    chrome.tabs.onUpdated.fire(t1.id, { url: "https://youtube.example/" });
    await wait();
    assert.equal(chrome._state.tabs.get(t1.id).url, "https://game.example/play", "sent back");

    await chrome.tabs.remove(t1.id);
    await wait();
    const { lock } = await chrome.storage.local.get("lock");
    assert.notEqual(lock.tabId, t1.id);
    assert.equal(chrome._state.tabs.get(lock.tabId).url, "https://game.example/play", "reopened");

    await chrome.windows.create({ url: "https://another.example/" });
    await wait();
    assert.equal(chrome._state.windows.size, 1, "new window closed");
    assert.equal(chrome._state.windows.get(lock.windowId).state, "fullscreen");

    const types = await logTypes(chrome);
    for (const t of ["blocked-tab", "blocked-site", "reopened", "blocked-window"]) assert.ok(types.includes(t), t);
  });

  await test("site lock allows the whole site only", async () => {
    const { chrome } = loadWorker();
    const { t1 } = await setupBrowser(chrome);
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "site", tab: t1, source: "manual" } });
    await wait();
    await chrome.tabs.update(t1.id, { url: "https://game.example/level2" });
    chrome.tabs.onUpdated.fire(t1.id, { url: "https://game.example/level2" });
    await wait();
    assert.equal(chrome._state.tabs.get(t1.id).url, "https://game.example/level2");
    await chrome.tabs.update(t1.id, { url: "https://evil.example/" });
    chrome.tabs.onUpdated.fire(t1.id, { url: "https://evil.example/" });
    await wait();
    assert.equal(chrome._state.tabs.get(t1.id).url, "https://game.example/play");
  });

  await test("password unlock, wrong tries and cooldown", async () => {
    const { chrome, ctx } = loadWorker();
    const { t1 } = await setupBrowser(chrome);
    await ctx.setPassword("hunter22");
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "page", tab: t1, source: "manual", fullscreen: true } });
    await wait();
    for (let i = 0; i < 4; i++) assert.equal((await ctx.tryUnlockSecret("nope")).ok, false);
    const fifth = await ctx.tryUnlockSecret("nope");
    assert.equal(fifth.ok, false);
    assert.ok(fifth.wait > 0, "cooldown started");
    const blocked = await ctx.tryUnlockSecret("hunter22");
    assert.equal(blocked.ok, false, "right password refused during cooldown");
    const { attempts } = await chrome.storage.local.get("attempts");
    attempts.until = 0;
    await chrome.storage.local.set({ attempts });
    const res = await ctx.tryUnlockSecret("hunter22");
    assert.equal(res.ok, true);
    assert.equal(res.method, "password");
    await ctx.unlock(res.method);
    await wait();
    assert.equal(await ctx.getLock(), null);
    const { lock } = await chrome.storage.local.get("lock");
    assert.equal(chrome._state.windows.get(lock.windowId).state, "maximized", "left fullscreen");
    const types = await logTypes(chrome);
    assert.ok(types.includes("wrong") && types.includes("cooldown") && types.includes("unlock"));
  });

  await test("phone code unlocks once and can't be reused", async () => {
    const { chrome, ctx } = loadWorker();
    const { t1 } = await setupBrowser(chrome);
    await ctx.setPassword("hunter22");
    const secret = ctx.newTotpSecret();
    await chrome.storage.local.set({ totp: { enabled: true, secret, lastCounter: 0 } });
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "page", tab: t1, source: "manual" } });
    await wait();
    const code = await ctx.totpAt(secret, ctx.totpCounter());
    const res = await ctx.tryUnlockSecret(code);
    assert.equal(res.ok, true);
    assert.equal(res.method, "phone code");
    assert.equal((await ctx.tryUnlockSecret(code)).ok, false, "reused code refused");
    await chrome.storage.local.set({ totp: { enabled: false, secret, lastCounter: 0 } });
    const fresh = await ctx.totpAt(secret, ctx.totpCounter());
    assert.equal((await ctx.tryUnlockSecret(fresh)).ok, false, "off means off");
  });

  await test("lock screen mode opens the lock page and leaves it on unlock", async () => {
    const { chrome, ctx } = loadWorker();
    await setupBrowser(chrome);
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "screen", source: "manual" } });
    await wait();
    const lock = await ctx.getLock();
    assert.equal(lock.mode, "screen");
    assert.equal(chrome._state.tabs.size, 1);
    assert.equal(chrome._state.tabs.get(lock.tabId).url, "chrome-extension://testid/lockscreen.html");
    await ctx.unlock("password");
    await wait();
    assert.equal(chrome._state.tabs.get(lock.tabId).url, "chrome://newtab/");
  });

  await test("timer lock ends by itself", async () => {
    const { chrome, ctx } = loadWorker();
    const { t1 } = await setupBrowser(chrome);
    await chrome.runtime.sendMessage({ type: "start-lock", opts: { mode: "page", tab: t1, minutes: 30, source: "manual" } });
    await wait();
    const lock = await ctx.getLock();
    assert.ok(lock.until > Date.now() + 29 * 60000);
    assert.ok(chrome._state.alarms.has("tablock-due"));
    lock.until = Date.now() - 1000;
    await chrome.storage.local.set({ lock });
    chrome.alarms.onAlarm.fire({ name: "tablock-due" });
    await wait();
    assert.equal(await ctx.getLock(), null);
    const { log } = await chrome.storage.local.get("log");
    const last = log[log.length - 1];
    assert.equal(last.type, "auto-unlock");
    assert.ok(/Timer finished/.test(last.detail));
  });

  console.log("Schedules");

  function liveSchedule(extra = {}) {
    const now = new Date();
    const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const start = new Date(now.getTime() - 10 * 60000), end = new Date(now.getTime() + 50 * 60000);
    return { id: "s1", name: "Homework", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: hm(start), end: hm(end), target: { kind: "screen" }, ...extra };
  }

  await test("schedule locks automatically and ends at the end time", async () => {
    const { chrome, ctx } = loadWorker();
    await setupBrowser(chrome);
    await chrome.storage.local.set({ schedules: [liveSchedule()] });
    chrome.alarms.onAlarm.fire({ name: "tablock-check" });
    await wait(200);
    const lock = await ctx.getLock();
    assert.ok(lock, "locked by schedule");
    assert.equal(lock.source, "schedule");
    assert.equal(lock.scheduleName, "Homework");
    assert.ok(lock.until > Date.now());
    assert.ok((await logTypes(chrome)).includes("auto-lock"));
    lock.until = Date.now() - 1;
    await chrome.storage.local.set({ lock });
    chrome.alarms.onAlarm.fire({ name: "tablock-due" });
    await wait(200);
    assert.equal(await ctx.getLock(), null);
  });

  await test("unlocking early keeps the schedule from relocking until it ends", async () => {
    const { chrome, ctx } = loadWorker();
    await setupBrowser(chrome);
    await ctx.setPassword("hunter22");
    await chrome.storage.local.set({ schedules: [liveSchedule()] });
    chrome.alarms.onAlarm.fire({ name: "tablock-check" });
    await wait(200);
    assert.ok(await ctx.getLock());
    await ctx.unlock("password");
    await wait(200);
    chrome.alarms.onAlarm.fire({ name: "tablock-check" });
    await wait(200);
    assert.equal(await ctx.getLock(), null, "stays unlocked");
    const { scheduleOverride } = await chrome.storage.local.get("scheduleOverride");
    assert.equal(scheduleOverride.scheduleId, "s1");
  });

  await test("schedule with a website target locks to that site", async () => {
    const { chrome, ctx } = loadWorker();
    await setupBrowser(chrome);
    await chrome.storage.local.set({ schedules: [liveSchedule({ target: { kind: "site", url: "https://www.khanacademy.org/" } })] });
    chrome.alarms.onAlarm.fire({ name: "tablock-check" });
    await wait(200);
    const lock = await ctx.getLock();
    assert.equal(lock.mode, "site");
    assert.equal(lock.origin, "https://www.khanacademy.org");
    assert.equal(chrome._state.tabs.get(lock.tabId).url, "https://www.khanacademy.org/");
  });

  await test("disabled or off-hours schedules do nothing", async () => {
    const { chrome, ctx } = loadWorker();
    await setupBrowser(chrome);
    await chrome.storage.local.set({ schedules: [liveSchedule({ enabled: false }), liveSchedule({ id: "s2", days: [] })] });
    chrome.alarms.onAlarm.fire({ name: "tablock-check" });
    await wait(200);
    assert.equal(await ctx.getLock(), null);
  });

  console.log("QR code");
  await test("QR generator produces the right size for an otpauth link", () => {
    const qctx = vm.createContext({ TextEncoder, globalThis: {} });
    vm.runInContext(fs.readFileSync(path.join(EXT, "qr.js"), "utf8"), qctx);
    const m = qctx.globalThis.qrEncode("otpauth://totp/Tab%20Lock?secret=" + "A".repeat(32) + "&issuer=Tab%20Lock&digits=6&period=30");
    assert.equal(m.length, 41); // version 6
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
