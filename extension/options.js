const $ = (id) => document.getElementById(id);
const SETTINGS_SESSION_MS = 10 * 60000;

function msg(el, text, kind = "err") {
  el.textContent = text;
  el.className = "msg " + (text ? kind : "");
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

// ================================================================ gate

async function sessionOpen() {
  const { settingsUntil = 0 } = await chrome.storage.session.get("settingsUntil");
  return Date.now() < settingsUntil;
}

async function boot() {
  const s = await getSettings();
  applyTheme(s.theme);

  if (await getLock()) {
    $("gate").classList.remove("hidden");
    $("gateText").textContent = "Tab Lock is locked right now. Unlock first, then open settings.";
    $("gateForm").classList.add("hidden");
    return;
  }
  if (!(await hasPassword())) {
    $("gate").classList.remove("hidden");
    $("gateText").textContent = "First create a password: click the Tab Lock padlock in the toolbar.";
    $("gateForm").classList.add("hidden");
    return;
  }
  if (await sessionOpen()) return openMain();
  $("gate").classList.remove("hidden");
  $("gatePw").focus();
}

$("gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await tryPassword($("gatePw").value);
  $("gatePw").value = "";
  if (!res.ok) return msg($("gateMsg"), failMessage(res));
  await chrome.storage.session.set({ settingsUntil: Date.now() + SETTINGS_SESSION_MS });
  openMain();
});

async function openMain() {
  $("gate").classList.add("hidden");
  $("main").classList.remove("hidden");
  $("nav").classList.remove("hidden");
  await Promise.all([renderSchedules(), renderLook(), renderPhone(), renderLog()]);
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

// Close settings after the session runs out.
setInterval(async () => {
  if (!$("main").classList.contains("hidden") && !(await sessionOpen())) location.reload();
}, 15000);

$("lockSettings").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.storage.session.remove("settingsUntil");
  location.reload();
});

// ================================================================ schedules

let editingId = null;
let formDays = new Set([0, 1, 2, 3, 4, 5, 6]);

async function getSchedules() {
  const { schedules = [] } = await chrome.storage.local.get("schedules");
  return schedules;
}

function daysLabel(days) {
  const set = [...days].sort();
  const key = set.join("");
  if (key === "0123456") return "Every day";
  if (key === "12345") return "Weekdays";
  if (key === "06") return "Weekends";
  if (key === "01234") return "Sun to Thu (school nights)";
  return set.map(d => DAY_NAMES[d]).join(", ");
}

function targetLabel(t) {
  if (!t || t.kind === "screen") return "Lock screen";
  try {
    return `${t.kind === "site" ? "Website" : "Page"}: ${new URL(t.url).host}`;
  } catch {
    return "Lock screen";
  }
}

async function renderSchedules() {
  const list = $("schedList");
  list.textContent = "";
  const schedules = await getSchedules();
  const settings = await getSettings();
  if (!schedules.length) {
    list.append(el("div", { class: "empty" }, "No schedules yet. Add one to lock automatically, like a bedtime or homework time."));
    return;
  }
  for (const s of schedules) {
    const live = !!scheduleWindow(s);
    const overnight = parseHM(s.end) < parseHM(s.start);
    const name = el("div", { class: "name" }, s.name || "Schedule");
    if (live) name.append(el("span", { class: "tag" }, "Active now"));
    const row = el("div", { class: `sched${s.enabled ? "" : " off"}${live ? " live" : ""}` },
      el("div", { class: "main" },
        name,
        el("div", { class: "when" },
          `${daysLabel(s.days)}, ${formatHM(s.start, settings.clock24)} to ${formatHM(s.end, settings.clock24)}${overnight ? " (next day)" : ""}`,
          ` · ${targetLabel(s.target)}${s.fullscreen ? " · fullscreen" : ""}${s.enabled ? "" : " · off"}`)
      ),
      el("div", { class: "btns" },
        el("button", { class: "ghost small", onclick: () => toggleSchedule(s.id) }, s.enabled ? "Turn off" : "Turn on"),
        el("button", { class: "ghost small", onclick: () => editSchedule(s) }, "Edit"),
        el("button", { class: "danger small", onclick: () => deleteSchedule(s.id) }, "Delete")
      )
    );
    list.append(row);
  }
}

function renderDayChips() {
  const box = $("sDays");
  box.textContent = "";
  DAY_NAMES.forEach((name, i) => {
    box.append(el("button", {
      class: `chip${formDays.has(i) ? " on" : ""}`,
      type: "button",
      onclick: () => {
        formDays.has(i) ? formDays.delete(i) : formDays.add(i);
        renderDayChips();
      }
    }, name));
  });
}

function updateFormHints() {
  const start = parseHM($("sStart").value), end = parseHM($("sEnd").value);
  $("sOvernight").textContent = start !== null && end !== null && end < start
    ? "This one runs overnight and ends the next morning."
    : "";
  $("sUrlWrap").classList.toggle("hidden", $("sKind").value === "screen");
}

function openForm(s) {
  editingId = s ? s.id : null;
  $("schedFormTitle").textContent = s ? "Edit schedule" : "New schedule";
  $("sName").value = s ? s.name : "";
  formDays = new Set(s ? s.days : [0, 1, 2, 3, 4, 5, 6]);
  $("sStart").value = s ? s.start : "21:00";
  $("sEnd").value = s ? s.end : "07:00";
  $("sKind").value = s && s.target ? s.target.kind : "screen";
  $("sUrl").value = s && s.target && s.target.url ? s.target.url : "";
  $("sMessage").value = s ? s.message || "" : "";
  $("sFull").checked = s ? !!s.fullscreen : false;
  $("sEnabled").checked = s ? !!s.enabled : true;
  renderDayChips();
  updateFormHints();
  msg($("sMsg"), "");
  $("schedForm").classList.remove("hidden");
  $("sName").focus();
}

function editSchedule(s) {
  openForm(s);
  $("schedForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function saveSchedules(schedules, note) {
  await chrome.storage.local.set({ schedules });
  logEvent("settings", note);
  await renderSchedules();
  await chrome.runtime.sendMessage({ type: "check-schedules" }).catch(() => {});
}

async function toggleSchedule(id) {
  const schedules = await getSchedules();
  const s = schedules.find(x => x.id === id);
  if (!s) return;
  if (!s.enabled && scheduleWindow({ ...s, enabled: true }) &&
      !confirm(`"${s.name}" is in its locked time right now. Turning it on will lock the browser right away. Continue?`)) return;
  s.enabled = !s.enabled;
  await saveSchedules(schedules, `Schedule "${s.name}" turned ${s.enabled ? "on" : "off"}`);
}

async function deleteSchedule(id) {
  const schedules = await getSchedules();
  const s = schedules.find(x => x.id === id);
  if (!s || !confirm(`Delete the schedule "${s.name}"?`)) return;
  await saveSchedules(schedules.filter(x => x.id !== id), `Schedule "${s.name}" deleted`);
  if (editingId === id) $("schedForm").classList.add("hidden");
}

$("addSched").addEventListener("click", () => openForm(null));
$("sCancel").addEventListener("click", () => $("schedForm").classList.add("hidden"));
$("sStart").addEventListener("input", updateFormHints);
$("sEnd").addEventListener("input", updateFormHints);
$("sKind").addEventListener("change", updateFormHints);

$("sSave").addEventListener("click", async () => {
  const name = $("sName").value.trim() || "Schedule";
  const start = $("sStart").value, end = $("sEnd").value;
  const kind = $("sKind").value;
  let url = $("sUrl").value.trim();

  if (!formDays.size) return msg($("sMsg"), "Pick at least one day.");
  if (parseHM(start) === null || parseHM(end) === null) return msg($("sMsg"), "Set a start and end time.");
  if (start === end) return msg($("sMsg"), "The start and end time can't be the same.");
  if (kind !== "screen") {
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      url = u.href;
    } catch {
      return msg($("sMsg"), "Enter a full web address, like https://www.khanacademy.org/");
    }
  }

  const schedule = {
    id: editingId || crypto.randomUUID(),
    name,
    enabled: $("sEnabled").checked,
    days: [...formDays].sort(),
    start,
    end,
    target: kind === "screen" ? { kind: "screen" } : { kind, url },
    message: $("sMessage").value.trim(),
    fullscreen: $("sFull").checked
  };

  if (scheduleWindow(schedule) &&
      !confirm(`"${name}" is in its locked time right now, so saving it will lock the browser right away. Continue?`)) return;

  const schedules = await getSchedules();
  const i = schedules.findIndex(x => x.id === schedule.id);
  if (i >= 0) schedules[i] = schedule;
  else schedules.push(schedule);

  // A fresh save clears any "unlocked early" pass for this schedule.
  const { scheduleOverride } = await chrome.storage.local.get("scheduleOverride");
  if (scheduleOverride && scheduleOverride.scheduleId === schedule.id) await chrome.storage.local.remove("scheduleOverride");

  $("schedForm").classList.add("hidden");
  await saveSchedules(schedules, `Schedule "${name}" saved`);
});

// ================================================================ look

let lookTheme = "gold";

async function renderLook() {
  const s = await getSettings();
  lookTheme = s.theme;
  renderThemeChips();
  $("clock24").checked = s.clock24;
  $("defMessage").value = s.message;
}

function renderThemeChips() {
  const box = $("themes");
  box.textContent = "";
  for (const [key, t] of Object.entries(THEMES)) {
    const sw = el("i");
    sw.style.background = t.accent;
    box.append(el("button", {
      class: `chip${key === lookTheme ? " on" : ""}`,
      type: "button",
      onclick: () => {
        lookTheme = key;
        applyTheme(key);
        renderThemeChips();
      }
    }, el("span", { class: "swatch" }, sw, t.name)));
  }
}

async function saveLook() {
  await chrome.storage.local.set({
    settings: { theme: lookTheme, clock24: $("clock24").checked, message: $("defMessage").value.trim() }
  });
  logEvent("settings", `Lock screen look saved (${THEMES[lookTheme].name})`);
  msg($("lookMsg"), "Saved.", "ok");
}

$("saveLook").addEventListener("click", saveLook);
$("previewLook").addEventListener("click", async () => {
  await saveLook();
  chrome.tabs.create({ url: chrome.runtime.getURL("lockscreen.html?preview=1") });
});

// ================================================================ phone unlock

let pendingSecret = null;

async function renderPhone() {
  const { totp } = await chrome.storage.local.get("totp");
  const on = !!(totp && totp.enabled);
  $("phoneOn").classList.toggle("hidden", !on || !!pendingSecret);
  $("phoneOff").classList.toggle("hidden", on || !!pendingSecret);
  $("phoneSetupBox").classList.toggle("hidden", !pendingSecret);
}

function startSetup() {
  pendingSecret = newTotpSecret();
  qrToCanvas($("qr"), qrEncode(totpUri(pendingSecret)), 6, 4);
  $("secretText").textContent = pendingSecret.match(/.{1,4}/g).join(" ");
  $("confirmCode").value = "";
  msg($("setupMsg"), "");
  renderPhone();
  $("confirmCode").focus();
}

$("phoneSetup").addEventListener("click", startSetup);
$("phoneReset").addEventListener("click", () => {
  if (confirm("Set up a new phone? The old phone's codes will stop working once you finish.")) startSetup();
});
$("cancelSetup").addEventListener("click", () => {
  pendingSecret = null;
  renderPhone();
});

$("confirmBtn").addEventListener("click", async () => {
  const code = $("confirmCode").value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return msg($("setupMsg"), "Type the 6-digit code from the app.");
  const counter = await findTotpCounter(pendingSecret, code);
  if (counter < 0) return msg($("setupMsg"), "That code doesn't match. Check the phone's clock is set automatically and try the newest code.");
  await chrome.storage.local.set({ totp: { enabled: true, secret: pendingSecret, lastCounter: counter, since: Date.now() } });
  pendingSecret = null;
  logEvent("settings", "Phone unlock turned on");
  await renderPhone();
  msg($("testMsg"), "Phone unlock is on.", "ok");
});
$("confirmCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("confirmBtn").click(); });

$("testBtn").addEventListener("click", async () => {
  const code = $("testCode").value.replace(/\s/g, "");
  const { totp } = await chrome.storage.local.get("totp");
  if (!totp || !/^\d{6}$/.test(code)) return msg($("testMsg"), "Type the 6-digit code from the app.");
  // Testing doesn't use the code up.
  const ok = (await findTotpCounter(totp.secret, code)) >= 0;
  msg($("testMsg"), ok ? "That code works." : "That code doesn't match right now.", ok ? "ok" : "err");
  $("testCode").value = "";
});

$("phoneDisable").addEventListener("click", async () => {
  if (!confirm("Turn off phone unlock? You can set it up again later.")) return;
  await chrome.storage.local.remove("totp");
  logEvent("settings", "Phone unlock turned off");
  msg($("testMsg"), "");
  renderPhone();
});

// ================================================================ log

const FILTERS = {
  all: () => true,
  locks: (e) => ["lock", "unlock", "auto-lock", "auto-unlock"].includes(e.type),
  escapes: (e) => ESCAPE_TYPES.has(e.type),
  wrong: (e) => e.type === "wrong" || e.type === "cooldown"
};

async function getLog() {
  const { log = [] } = await chrome.storage.local.get("log");
  return log;
}

function stat(value, label, alert = false) {
  return el("div", { class: `stat${alert ? " alert" : ""}` },
    el("div", { class: "v" }, String(value)),
    el("div", { class: "l" }, label));
}

async function renderLog() {
  const log = await getLog();
  const weekAgo = Date.now() - 7 * 86400000;
  const week = log.filter(e => e.t >= weekAgo);
  const locks = week.filter(e => e.type === "lock" || e.type === "auto-lock").length;
  const lockedMs = week.filter(e => e.type === "unlock" || e.type === "auto-unlock").reduce((a, e) => a + (e.ms || 0), 0);
  const escapes = week.filter(e => ESCAPE_TYPES.has(e.type)).length;
  const wrong = week.filter(e => e.type === "wrong").length;

  const stats = $("stats");
  stats.textContent = "";
  stats.append(
    stat(locks, "Locks, last 7 days"),
    stat(lockedMs ? formatSpan(lockedMs) : "0m", "Time locked, last 7 days"),
    stat(escapes, "Escape attempts, last 7 days", escapes > 0),
    stat(wrong, "Wrong passwords, last 7 days", wrong > 0)
  );

  const filter = FILTERS[$("logFilter").value] || FILTERS.all;
  const rows = log.filter(filter).slice().reverse();
  const body = $("logBody");
  body.textContent = "";
  for (const e of rows.slice(0, 500)) {
    const d = new Date(e.t);
    const cls = ESCAPE_TYPES.has(e.type) ? "escape" : (e.type === "wrong" || e.type === "cooldown" ? "wrong" : "");
    body.append(el("tr", { class: cls },
      el("td", {}, `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`),
      el("td", { class: "type" }, LOG_LABELS[e.type] || e.type),
      el("td", {}, e.detail || "")
    ));
  }
  $("logEmpty").classList.toggle("hidden", rows.length > 0);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$("logFilter").addEventListener("change", renderLog);

$("exportCsv").addEventListener("click", async () => {
  const log = await getLog();
  const lines = [["time", "event", "details", "locked_minutes"].join(",")];
  for (const e of log) {
    lines.push([
      new Date(e.t).toISOString(),
      LOG_LABELS[e.type] || e.type,
      e.detail || "",
      e.ms ? Math.round(e.ms / 60000) : ""
    ].map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `tab-lock-log-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
});

$("clearLog").addEventListener("click", async () => {
  if (!confirm("Clear the whole usage log? This can't be undone.")) return;
  await chrome.storage.local.set({ log: [] });
  logEvent("settings", "Usage log cleared");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || $("main").classList.contains("hidden")) return;
  if (changes.log) renderLog();
  if (changes.schedules) renderSchedules();
  if (changes.lock && changes.lock.newValue && changes.lock.newValue.active) location.reload();
});

// ================================================================ password

$("chgBtn").addEventListener("click", async () => {
  const res = await tryPassword($("oldPw").value);
  if (!res.ok) return msg($("chgMsg"), failMessage(res));
  const a = $("chgPw").value, b = $("chgPw2").value;
  if (a.length < 4) return msg($("chgMsg"), "Use at least 4 characters.");
  if (a !== b) return msg($("chgMsg"), "The two new passwords don't match.");
  await setPassword(a);
  for (const id of ["oldPw", "chgPw", "chgPw2"]) $(id).value = "";
  logEvent("settings", "Password changed");
  msg($("chgMsg"), "Password changed.", "ok");
});

boot();
