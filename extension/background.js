// Tab Lock background worker.
//
// While a lock is active it keeps the browser on the locked tab:
// closes other tabs and windows, sends the tab back if it navigates away,
// reopens it if it gets closed, and keeps it fullscreen if asked.
// It also runs schedules and timers, and writes the usage log.

importScripts("lib.js");

const UNLOCK_PAGE = chrome.runtime.getURL("unlock.html");
const GRACE_MS = 4000;          // don't log "escape attempts" right after locking
const LOG_THROTTLE_MS = 3000;   // one log entry per escape type per 3 seconds

async function getUnlockWindowId() {
  const { unlockWindowId } = await chrome.storage.session.get("unlockWindowId");
  return unlockWindowId || null;
}

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function isAllowedUrl(lock, url) {
  if (!url || url === "about:blank") return true; // still loading
  if (lock.mode === "site") {
    try {
      return new URL(url).origin === lock.origin;
    } catch {
      return false;
    }
  }
  return stripHash(url) === stripHash(lock.url);
}

// ---------------------------------------------------------------- escape logging

const lastLogged = {};
function logEscape(lock, type, detail) {
  if (Date.now() - (lock.since || 0) < GRACE_MS) return;
  const now = Date.now();
  if (now - (lastLogged[type] || 0) < LOG_THROTTLE_MS) return;
  lastLogged[type] = now;
  logEvent(type, detail);
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "";
  }
}

// ---------------------------------------------------------------- enforcement

// Make sure the locked tab exists. Recreate it if it was closed.
async function ensureLockedTab(lock) {
  try {
    return await chrome.tabs.get(lock.tabId);
  } catch {
    let tab = null;
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const unlockId = await getUnlockWindowId();
    const target = wins.find(w => w.id === lock.windowId) || wins.find(w => w.id !== unlockId);
    if (target) {
      try {
        tab = await chrome.tabs.create({ windowId: target.id, url: lock.url, active: true });
      } catch {
        tab = null; // window was closing
      }
    }
    if (!tab) {
      const w = await chrome.windows.create({ url: lock.url, focused: true });
      tab = w.tabs[0];
    }
    lock.tabId = tab.id;
    lock.windowId = tab.windowId;
    await chrome.storage.local.set({ lock });
    logEscape(lock, "reopened", "The locked tab was closed and reopened");
    return tab;
  }
}

async function doEnforce(refocus) {
  const lock = await getLock();
  if (!lock) return;

  if (lock.until && Date.now() >= lock.until) {
    await unlock(lock.source === "schedule" ? "schedule ended" : "timer");
    return;
  }

  const tab = await ensureLockedTab(lock);
  if (tab.windowId !== lock.windowId) {
    lock.windowId = tab.windowId;
    await chrome.storage.local.set({ lock });
  }

  const unlockId = await getUnlockWindowId();
  const wins = await chrome.windows.getAll({ populate: true });
  const unlockOpen = !!unlockId && wins.some(w => w.id === unlockId);

  // Close every other window and every other tab.
  for (const w of wins) {
    if (w.id === unlockId) continue;
    if (w.id !== tab.windowId) {
      await chrome.windows.remove(w.id).catch(() => {});
      logEscape(lock, "blocked-window", "Closed another window");
      continue;
    }
    for (const t of w.tabs || []) {
      if (t.id !== tab.id) {
        await chrome.tabs.remove(t.id).catch(() => {});
        logEscape(lock, "blocked-tab", hostOf(t.pendingUrl || t.url) || "New tab");
      }
    }
  }

  // Send the tab back if it left the allowed page or site.
  const current = tab.pendingUrl || tab.url;
  if (current && !isAllowedUrl(lock, current)) {
    await chrome.tabs.update(tab.id, { url: lock.url }).catch(() => {});
    logEscape(lock, "blocked-site", hostOf(current));
  }
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});

  // Keep the locked window in front and fullscreen (unless the unlock box is open).
  if (!unlockOpen) {
    const win = wins.find(w => w.id === tab.windowId);
    const upd = {};
    if (refocus) upd.focused = true;
    if (lock.fullscreen && win && win.state !== "fullscreen") {
      upd.state = "fullscreen";
      if (win.state !== "minimized") logEscape(lock, "fullscreen", "Fullscreen was exited");
    }
    if (Object.keys(upd).length) await chrome.windows.update(tab.windowId, upd).catch(() => {});
  }
}

// Run enforcement one at a time so events don't trip over each other.
let queue = Promise.resolve();
function enforce(refocus = true) {
  queue = queue.then(() => doEnforce(refocus)).catch(err => console.warn("Tab Lock:", err));
  return queue;
}

// ---------------------------------------------------------------- starting a lock

// Starts a lock. opts: { mode: "page"|"site"|"screen", tab, url, fullscreen,
// minutes, until, message, source: "manual"|"schedule", scheduleId, scheduleName }
async function startLock(opts) {
  let tab = opts.tab || null;
  let url = opts.url || (tab && tab.url) || "";
  const mode = opts.mode || "page";

  if (mode === "screen") {
    url = LOCKSCREEN_URL;
    tab = null;
  }

  if (!tab) {
    // Open the target in the last used normal window (or a new one).
    let win = null;
    try {
      win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    } catch {
      win = null;
    }
    if (win) {
      tab = await chrome.tabs.create({ windowId: win.id, url, active: true }).catch(() => null);
    }
    if (!tab) {
      const w = await chrome.windows.create({ url, focused: true });
      tab = w.tabs[0];
    }
  }

  let until = opts.until || null;
  if (!until && opts.minutes) until = Date.now() + opts.minutes * 60000;

  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }

  const lock = {
    active: true,
    tabId: tab.id,
    windowId: tab.windowId,
    url,
    origin,
    title: mode === "screen" ? "Lock screen" : (opts.title || tab.title || url),
    mode,
    fullscreen: !!opts.fullscreen,
    since: Date.now(),
    until,
    message: opts.message || "",
    source: opts.source || "manual",
    scheduleId: opts.scheduleId || null,
    scheduleName: opts.scheduleName || ""
  };
  await chrome.storage.local.set({ lock });
  if (until) chrome.alarms.create("tablock-due", { when: until });
  await enforce();
}

// ---------------------------------------------------------------- schedules and timers

async function checkSchedules() {
  const lock = await getLock();
  if (lock) {
    if (lock.until && Date.now() >= lock.until) {
      await unlock(lock.source === "schedule" ? "schedule ended" : "timer");
    }
    return;
  }
  const { schedules = [], scheduleOverride } = await chrome.storage.local.get(["schedules", "scheduleOverride"]);
  const now = new Date();
  for (const s of schedules) {
    const w = scheduleWindow(s, now);
    if (!w) continue;
    // Someone unlocked this window early with the password: leave it unlocked
    // until the window ends.
    if (scheduleOverride && scheduleOverride.scheduleId === s.id && now.getTime() < scheduleOverride.until) continue;
    const target = s.target || { kind: "screen" };
    const usesUrl = (target.kind === "page" || target.kind === "site") && /^https?:\/\//i.test(target.url || "");
    await startLock({
      mode: usesUrl ? target.kind : "screen",
      url: target.url,
      fullscreen: !!s.fullscreen,
      until: w.end.getTime(),
      message: s.message || "",
      source: "schedule",
      scheduleId: s.id,
      scheduleName: s.name || "Scheduled lock"
    });
    return;
  }
}

// ---------------------------------------------------------------- unlocking

async function openUnlockWindow() {
  const lock = await getLock();
  if (!lock) return;
  if (lock.mode === "screen") {
    // The lock screen has its own password box. Just bring it forward.
    await chrome.windows.update(lock.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(lock.tabId, { active: true }).catch(() => {});
    await chrome.runtime.sendMessage({ type: "focus-input" }).catch(() => {});
    return;
  }
  const existing = await getUnlockWindowId();
  if (existing) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return;
    } catch {
      /* it was closed */
    }
  }
  const w = await chrome.windows.create({
    url: UNLOCK_PAGE,
    type: "popup",
    width: 420,
    height: 520,
    focused: true
  });
  await chrome.storage.session.set({ unlockWindowId: w.id });
}

async function onUnlocked(lock) {
  chrome.alarms.clear("tablock-due");

  const reason = lock.endReason || "unlocked";
  const ms = Math.max(0, (lock.endedAt || Date.now()) - (lock.since || Date.now()));
  const lockedFor = formatSpan(ms);
  if (reason === "timer" || reason === "schedule ended") {
    logEvent("auto-unlock", `${reason === "timer" ? "Timer finished" : "Schedule ended"} after ${lockedFor}`, { ms });
  } else {
    logEvent("unlock", `With ${reason} after ${lockedFor}`, { ms });
  }

  // Unlocked early during a schedule: don't relock until that window ends.
  if (lock.source === "schedule" && lock.until && reason !== "schedule ended") {
    await chrome.storage.local.set({ scheduleOverride: { scheduleId: lock.scheduleId, until: lock.until } });
  }

  if (lock.fullscreen) {
    await chrome.windows.update(lock.windowId, { state: "maximized" }).catch(() => {});
  }
  if (lock.mode === "screen") {
    await chrome.tabs.update(lock.tabId, { url: "chrome://newtab/" }).catch(async () => {
      await chrome.tabs.create({ windowId: lock.windowId }).catch(() => {});
      await chrome.tabs.remove(lock.tabId).catch(() => {});
    });
  }
  const unlockId = await getUnlockWindowId();
  if (unlockId) {
    await chrome.windows.remove(unlockId).catch(() => {});
    await chrome.storage.session.remove("unlockWindowId");
  }
}

function describeLock(lock) {
  const parts = [];
  if (lock.source === "schedule") parts.push(`Schedule "${lock.scheduleName}"`);
  parts.push(lock.mode === "screen" ? "Lock screen" : `${lock.mode === "site" ? "Site" : "Page"}: ${hostOf(lock.url)}`);
  if (lock.until) parts.push(`until ${new Date(lock.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------- event wiring
// (top level so it survives worker restarts)

chrome.tabs.onCreated.addListener(() => enforce());
chrome.tabs.onActivated.addListener(() => enforce());
chrome.tabs.onRemoved.addListener(() => enforce());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") enforce(false);
});
chrome.tabs.onReplaced.addListener(async (addedId, removedId) => {
  const lock = await getLock();
  if (lock && lock.tabId === removedId) {
    lock.tabId = addedId;
    await chrome.storage.local.set({ lock });
  }
  enforce(false);
});

chrome.windows.onCreated.addListener(() => enforce());
chrome.windows.onRemoved.addListener(async (windowId) => {
  const unlockId = await getUnlockWindowId();
  if (windowId === unlockId) await chrome.storage.session.remove("unlockWindowId");
  enforce();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE means focus went to another program, which a browser
  // extension can't control. Only react when another Chrome window took focus.
  if (windowId !== chrome.windows.WINDOW_ID_NONE) enforce();
});
if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener(() => enforce(false));
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "open-unlock") openUnlockWindow();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;
  if (msg.type === "open-unlock") {
    openUnlockWindow().then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "enforce") {
    enforce().then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "start-lock") {
    startLock(msg.opts).then(() => sendResponse(true), (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "check-schedules") {
    checkSchedules().then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "log" && msg.entry) {
    _logQueue = _logQueue.then(() => appendLog(msg.entry)).catch(() => {});
    _logQueue.then(() => sendResponse(true));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.lock) return;
  const before = changes.lock.oldValue;
  const after = changes.lock.newValue;
  const wasOn = !!(before && before.active);
  const isOn = !!(after && after.active);
  if (isOn && (!wasOn || before.since !== after.since)) {
    logEvent(after.source === "schedule" ? "auto-lock" : "lock", describeLock(after));
    enforce();
  }
  if (wasOn && !isOn) onUnlocked(after || before);
});

function ensureAlarms() {
  chrome.alarms.get("tablock-check", (a) => {
    if (!a) chrome.alarms.create("tablock-check", { periodInMinutes: 0.5 });
  });
}

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  checkSchedules().then(() => enforce());
});
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  checkSchedules().then(() => enforce());
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tablock-check" || a.name === "tablock-due") {
    checkSchedules().then(() => enforce(false));
  }
});
