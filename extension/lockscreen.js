// Runs both the full lock screen (lockscreen.html) and the small unlock box
// (unlock.html, which has <body class="compact">).

const $ = (id) => document.getElementById(id);
const COMPACT = document.body.classList.contains("compact");
const AUTO_CLOSE_S = 30;     // the small unlock box closes itself so it can't be left open

let settings = { theme: "gold", clock24: false, message: "" };
let lock = null;
let closeIn = AUTO_CLOSE_S;
let busy = false;

function renderClock() {
  const now = new Date();
  $("clock").textContent = formatClock(now, settings.clock24);
  $("date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function renderLock() {
  if (!lock) return;
  const scheduled = lock.source === "schedule";
  $("title").textContent = scheduled ? (lock.scheduleName || "Scheduled lock") : "Locked";
  document.title = scheduled ? `Locked: ${lock.scheduleName}` : "Locked";

  if (lock.mode === "screen") {
    $("sub").textContent = scheduled ? "This browser is locked for now." : "This browser is locked.";
  } else {
    $("sub").textContent = `Locked to ${lock.title || lockTargetLabel(lock)}`;
  }

  const message = (lock.message || settings.message || "").trim();
  $("message").textContent = message;
  $("message").classList.toggle("hidden", !message);
}

function renderTimer() {
  if (!lock || !lock.until) {
    $("timer").classList.add("hidden");
    return;
  }
  const left = lock.until - Date.now();
  $("timer").classList.remove("hidden");
  $("timerLabel").textContent = lock.source === "schedule"
    ? `Unlocks at ${formatClock(new Date(lock.until), settings.clock24)}`
    : "Unlocks in";
  $("timerValue").textContent = formatDuration(left);
  const total = lock.until - (lock.since || lock.until);
  const done = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 1;
  $("timerBar").style.width = `${(done * 100).toFixed(2)}%`;
}

function renderHint() {
  if (COMPACT) {
    $("hint").textContent = `Password or 6-digit phone code. Closes in ${closeIn}s.`;
  }
}

function showMsg(text, kind = "err") {
  $("msg").textContent = text;
  $("msg").className = "msg " + (text ? kind : "");
}

const PREVIEW = new URLSearchParams(location.search).has("preview");
const previewStart = Date.now();

async function load() {
  settings = await getSettings();
  applyTheme(settings.theme);
  lock = PREVIEW
    ? {
        active: true, mode: "screen", source: "schedule", scheduleName: "Preview",
        since: previewStart - 10 * 60000, until: previewStart + 20 * 60000, message: ""
      }
    : await getLock();
  renderClock();
  if (!lock) {
    if (COMPACT) return window.close();
    $("title").textContent = "Unlocked";
    $("sub").textContent = "You can close this tab.";
    $("form").classList.add("hidden");
    $("hint").classList.add("hidden");
    $("timer").classList.add("hidden");
    return;
  }
  renderLock();
  renderTimer();
  renderHint();
  $("pw").focus();
}

async function submit(e) {
  e.preventDefault();
  if (busy) return;
  const value = $("pw").value;
  if (!value) return $("pw").focus();
  if (PREVIEW) {
    $("pw").value = "";
    return showMsg("Preview only. Nothing is locked.", "ok");
  }
  busy = true;
  $("go").disabled = true;
  const res = await tryUnlockSecret(value);
  busy = false;
  $("go").disabled = false;
  if (res.ok) {
    showMsg("Unlocked.", "ok");
    await unlock(res.method); // the background takes it from here
    if (COMPACT) setTimeout(() => window.close(), 300);
  } else {
    $("pw").value = "";
    showMsg(failMessage(res));
    const card = $("card");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
    closeIn = AUTO_CLOSE_S;
    $("pw").focus();
  }
}

$("form").addEventListener("submit", submit);

setInterval(() => {
  renderClock();
  renderTimer();
  if (COMPACT) {
    closeIn -= 1;
    renderHint();
    if (closeIn <= 0) window.close();
  }
}, 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.lock || changes.settings) load();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "focus-input") $("pw").focus();
});

// Typing anywhere goes into the password box.
document.addEventListener("keydown", (e) => {
  if (document.activeElement !== $("pw") && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    $("pw").focus();
  }
});

load();
