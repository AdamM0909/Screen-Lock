// A small in-memory stand-in for the Chrome extension APIs Tab Lock uses,
// so the background worker and helpers can be tested with plain Node.

function makeEvent() {
  const fns = [];
  return {
    addListener: (f) => fns.push(f),
    fire: (...a) => fns.forEach((f) => f(...a)),
    fns
  };
}

function makeArea(name, onChanged) {
  let data = {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    _data: () => data,
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      onChanged.fire(changes, name);
    },
    async remove(keys) {
      const list = typeof keys === "string" ? [keys] : keys;
      const changes = {};
      for (const k of list) {
        if (k in data) changes[k] = { oldValue: clone(data[k]) };
        delete data[k];
      }
      onChanged.fire(changes, name);
    }
  };
}

function makeChrome() {
  const onChanged = makeEvent();
  let nextId = 100;
  const windows = new Map(); // id -> { id, state, type, focused }
  const tabs = new Map();    // id -> { id, windowId, url, title, active }
  const alarms = new Map();

  const ev = {
    tabs: { onCreated: makeEvent(), onActivated: makeEvent(), onRemoved: makeEvent(), onUpdated: makeEvent(), onReplaced: makeEvent() },
    windows: { onCreated: makeEvent(), onRemoved: makeEvent(), onFocusChanged: makeEvent(), onBoundsChanged: makeEvent() }
  };

  const tabCopy = (t) => ({ ...t });
  const winTabs = (wid) => [...tabs.values()].filter((t) => t.windowId === wid);

  const chrome = {
    _state: { windows, tabs, alarms },
    runtime: {
      id: "testid",
      getURL: (p) => `chrome-extension://testid/${p}`,
      onMessage: makeEvent(),
      onStartup: makeEvent(),
      onInstalled: makeEvent(),
      async sendMessage(msg) {
        let resp;
        const sender = { id: "testid" };
        for (const f of chrome.runtime.onMessage.fns) {
          const keep = f(msg, sender, (r) => { resp = r; });
          if (keep === true) await new Promise((r) => setTimeout(r, 50));
        }
        return resp;
      },
      openOptionsPage() {}
    },
    storage: {
      onChanged,
      local: null,
      session: null
    },
    alarms: {
      create(name, info) { alarms.set(name, info); },
      get(name, cb) { cb(alarms.get(name)); },
      clear(name) { alarms.delete(name); },
      onAlarm: makeEvent()
    },
    commands: { onCommand: makeEvent() },
    tabs: {
      ...ev.tabs,
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab with id " + id);
        return tabCopy(tabs.get(id));
      },
      async create({ windowId, url = "chrome://newtab/", active = true }) {
        if (windowId != null && !windows.has(windowId)) throw new Error("No window");
        if (windowId == null) windowId = [...windows.keys()][0];
        const t = { id: nextId++, windowId, url, title: url, active };
        if (active) winTabs(windowId).forEach((x) => (x.active = false));
        tabs.set(t.id, t);
        ev.tabs.onCreated.fire(tabCopy(t));
        return tabCopy(t);
      },
      async update(id, props) {
        const t = tabs.get(id);
        if (!t) throw new Error("No tab");
        if (props.url) t.url = props.url;
        if (props.active) { winTabs(t.windowId).forEach((x) => (x.active = false)); t.active = true; }
        return tabCopy(t);
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        tabs.delete(id);
        ev.tabs.onRemoved.fire(id);
      },
      async query() {
        return [...tabs.values()].filter((t) => t.active).map(tabCopy);
      }
    },
    windows: {
      ...ev.windows,
      WINDOW_ID_NONE: -1,
      async getAll(opts = {}) {
        return [...windows.values()]
          .filter((w) => !opts.windowTypes || opts.windowTypes.includes(w.type))
          .map((w) => ({ ...w, tabs: opts.populate ? winTabs(w.id).map(tabCopy) : undefined }));
      },
      async getLastFocused() {
        const w = [...windows.values()].find((x) => x.type === "normal");
        if (!w) throw new Error("none");
        return { ...w };
      },
      async create({ url, type = "normal" }) {
        const w = { id: nextId++, state: "normal", type, focused: true };
        windows.set(w.id, w);
        const t = { id: nextId++, windowId: w.id, url: url || "chrome://newtab/", title: url, active: true };
        tabs.set(t.id, t);
        ev.windows.onCreated.fire({ ...w });
        return { ...w, tabs: [tabCopy(t)] };
      },
      async update(id, props) {
        const w = windows.get(id);
        if (!w) throw new Error("No window");
        Object.assign(w, props);
        return { ...w };
      },
      async remove(id) {
        if (!windows.has(id)) throw new Error("No window");
        windows.delete(id);
        for (const t of winTabs(id)) tabs.delete(t.id);
        ev.windows.onRemoved.fire(id);
      }
    }
  };
  chrome.storage.local = makeArea("local", onChanged);
  chrome.storage.session = makeArea("session", onChanged);
  return chrome;
}

module.exports = { makeChrome };
