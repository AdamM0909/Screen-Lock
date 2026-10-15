const $ = (id) => document.getElementById(id);

let selectedMin = 0;      // 0 = until unlocked, "custom" = use the input
let currentTab = null;
let timerHandle = null;

function show(section) {
  for (const id of ["setup", "ready", "locked"]) $(id).classList.toggle("hidden", id !== section);
  const st = $("status");
  st.textContent = section === "locked" ? "Locked" : "Unlocked";
  st.classList.toggle("on", section === "locked");
}

function msg(el, text, kind = "err") {
  el.textContent = text;
  el.className = "msg " + (text ? kind : "");
}

function lockable(url) {
  return /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");
}

function selectedMode() {
  return document.querySelector("input[name=mode]:checked").value;
}

function updateLockButton() {
  const mode = selectedMode();
  const ok = mode === "screen" || (currentTab && lockable(currentTab.url));
  $("lockBtn").disabled = !ok;
  msg($("readyMsg"), ok ? "" : "This page can't be locked. Open a normal website, or pick Lock screen only.");
  $("lockBtn").textContent = mode === "screen" ? "Lock the browser" : "Lock this tab";
}

function selectDuration(btn) {
  for (const b of document.querySelectorAll("#durations .chip")) b.classList.toggle("on", b === btn);
  selectedMin = btn.dataset.min === "custom" ? "custom" : Number(btn.dataset.min);
  $("customMin").classList.toggle("hidden", selectedMin !== "custom");
  if (selectedMin === "custom") $("customMin").focus();
}

function renderLockedTimer(lock) {
  if (timerHandle) clearInterval(timerHandle);
  if (!lock.until) {
    $("lockedTimer").classList.add("hidden");
    return;
  }
  $("lockedTimer").classList.remove("hidden");
  $("lockedTimerLabel").textContent = lock.source === "schedule"
    ? `Schedule "${lock.scheduleName}" unlocks in`
    : "Unlocks in";
  const tick = () => { $("lockedCountdown").textContent = formatDuration(lock.until - Date.now()); };
  tick();
  timerHandle = setInterval(tick, 1000);
}

async function render() {
  const settings = await getSettings();
  applyTheme(settings.theme);

  const lock = await getLock();
  if (lock) {
    $("lockedHeading").textContent = lock.mode === "screen" ? "Locked" : "Locked to";
    $("lockedTitle").textContent = lock.mode === "screen" ? "Lock screen" : (lock.title || "Locked tab");
    $("lockedUrl").textContent = lock.mode === "screen" ? "The whole browser is locked." : lockTargetLabel(lock);
    renderLockedTimer(lock);
    show("locked");
    $("unlockPw").focus();
    return;
  }
  if (!(await hasPassword())) {
    show("setup");
    $("newPw").focus();
    return;
  }

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (currentTab && lockable(currentTab.url)) {
    $("pageHint").textContent = currentTab.title || currentTab.url;
    $("siteHint").textContent = new URL(currentTab.url).host;
  }

  const { prefs = {} } = await chrome.storage.local.get("prefs");
  if (prefs.mode) {
    const input = document.querySelector(`input[name=mode][value=${prefs.mode}]`);
    if (input) input.checked = true;
  }
  $("fullscreen").checked = !!prefs.fullscreen;
  $("message").value = prefs.message || "";
  updateLockButton();
  show("ready");
}

$("savePw").addEventListener("click", async () => {
  const a = $("newPw").value, b = $("newPw2").value;
  if (a.length < 4) return msg($("setupMsg"), "Use at least 4 characters.");
  if (a !== b) return msg($("setupMsg"), "The two passwords don't match.");
  await setPassword(a);
  render();
});
$("newPw2").addEventListener("keydown", (e) => { if (e.key === "Enter") $("savePw").click(); });

for (const r of document.querySelectorAll("input[name=mode]")) r.addEventListener("change", updateLockButton);
for (const b of document.querySelectorAll("#durations .chip")) b.addEventListener("click", () => selectDuration(b));

$("lockBtn").addEventListener("click", async () => {
  const mode = selectedMode();
  if (mode !== "screen" && (!currentTab || !lockable(currentTab.url))) return;

  let minutes = selectedMin;
  if (minutes === "custom") {
    minutes = Math.round(Number($("customMin").value));
    if (!(minutes >= 1 && minutes <= 1440)) return msg($("readyMsg"), "Enter between 1 and 1440 minutes.");
  }

  const fullscreen = $("fullscreen").checked;
  const message = $("message").value.trim();
  await chrome.storage.local.set({ prefs: { mode, fullscreen, message } });

  $("lockBtn").disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: "start-lock",
    opts: {
      mode,
      tab: mode === "screen" ? null : { id: currentTab.id, windowId: currentTab.windowId, url: currentTab.url, title: currentTab.title },
      title: currentTab && currentTab.title,
      fullscreen,
      minutes: minutes || 0,
      message,
      source: "manual"
    }
  }).catch((e) => ({ error: String(e) }));
  if (res && res.error) {
    $("lockBtn").disabled = false;
    return msg($("readyMsg"), "Couldn't lock: " + res.error);
  }
  window.close();
});

async function doUnlock() {
  const btn = $("unlockBtn");
  btn.disabled = true;
  const res = await tryUnlockSecret($("unlockPw").value);
  btn.disabled = false;
  if (res.ok) {
    await unlock(res.method);
    msg($("unlockMsg"), "Unlocked.", "ok");
    setTimeout(render, 400);
  } else {
    $("unlockPw").value = "";
    msg($("unlockMsg"), failMessage(res));
  }
}
$("unlockBtn").addEventListener("click", doUnlock);
$("unlockPw").addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });

$("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

render();
