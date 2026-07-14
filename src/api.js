import storeModule from "desktop-note/store";

const {
  DEFAULT_SETTINGS,
  applyOperation,
  ensureCurrentDay,
  formatTimeRange,
  localDayKey,
  markdownForState,
  normalizeState,
  normalizeTimeRange,
} = storeModule;

export { formatTimeRange, normalizeTimeRange };
export const dayKey = localDayKey;

function applyBrowserOperation(state, operation, {
  now = new Date(),
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  return applyOperation(state, operation, now, { randomUUID });
}

export function makeFixture(now = new Date()) {
  const activeDayKey = localDayKey(now);
  const timestamp = now.toISOString();
  const items = [
    ["整理回归结果", "focus", true, { start: "09:00", end: "10:30" }],
    ["修改引言的研究动机", "focus", true, null],
    ["核对参考文献", "focus", true, { start: "23:00", end: "01:00" }],
    ["更新专利数据", "today", false, { start: "14:00", end: "15:15" }],
    ["回复合作者", "today", false, null],
  ];
  return {
    schemaVersion: 1,
    revision: 1,
    activeDay: activeDayKey,
    days: {
      [activeDayKey]: {
        key: activeDayKey,
        tasks: items.map(([text, section, done, timeRange], index) => ({
          id: `fixture-${index + 1}`,
          text,
          section,
          order: section === "focus" ? index : index - 3,
          done,
          timeRange,
          createdAt: timestamp,
          completedAt: done ? timestamp : null,
        })),
      },
    },
    pendingRollover: null,
    settings: { ...DEFAULT_SETTINGS, windowMode: "floating" },
  };
}

export function createBrowserApi(browserWindow, {
  now = () => new Date(),
  randomUUID = () => browserWindow.crypto.randomUUID(),
} = {}) {
  if (!browserWindow) throw new TypeError("browserWindow is required");
  const fixtureMode = new URLSearchParams(browserWindow.location?.search || "").get("fixture") === "reference";
  const storageKey = "desktop-note-state-v1";
  const stateListeners = new Set();
  const saveListeners = new Set();
  const focusListeners = new Set();
  const settingsListeners = new Set();
  const quitListeners = new Set();
  const initialNow = now();

  let raw;
  try {
    raw = fixtureMode
      ? makeFixture(initialNow)
      : JSON.parse(browserWindow.localStorage.getItem(storageKey)) || makeFixture(initialNow);
  } catch {
    raw = makeFixture(initialNow);
  }
  if (!raw || typeof raw !== "object") raw = makeFixture(initialNow);

  let state = normalizeState(raw, initialNow, { randomUUID });
  const initialRevision = state.revision;
  state = ensureCurrentDay(state, initialNow);
  if (!fixtureMode && state.revision !== initialRevision) {
    try {
      browserWindow.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Keep the recovered state in memory; a later mutation will report storage failures.
    }
  }

  function emit(status = "saved") {
    stateListeners.forEach((listener) => listener({ state: structuredClone(state), status }));
    saveListeners.forEach((listener) => listener(status));
  }

  async function mutate(operation) {
    let next;
    try {
      next = applyBrowserOperation(state, operation, { now: now(), randomUUID });
    } catch (error) {
      return { ok: false, error: error?.message || "操作失败", state: structuredClone(state) };
    }

    state = next;
    emit("saving");
    try {
      if (!fixtureMode) browserWindow.localStorage.setItem(storageKey, JSON.stringify(state));
      emit("saved");
      return { ok: true, state: structuredClone(state) };
    } catch (error) {
      emit("error");
      return { ok: false, error: error?.message || "保存失败", state: structuredClone(state) };
    }
  }

  return {
    getState: async () => ({ ok: true, state: structuredClone(state) }),
    mutate,
    openSettings: async () => {
      settingsListeners.forEach((listener) => listener());
      return { ok: true };
    },
    openDataFolder: async () => ({ ok: true }),
    exportMarkdown: async () => {
      if (!browserWindow.document || !browserWindow.Blob || !browserWindow.URL) {
        return { ok: false, error: "当前预览环境无法导出" };
      }
      const url = browserWindow.URL.createObjectURL(
        new browserWindow.Blob([markdownForState(state)], { type: "text/markdown" }),
      );
      const anchor = browserWindow.document.createElement("a");
      anchor.href = url;
      anchor.download = `Note-${state.activeDay}.md`;
      anchor.click();
      browserWindow.URL.revokeObjectURL(url);
      return { ok: true };
    },
    setWindowMode: (mode) => mutate({ type: "settings:set", key: "windowMode", value: mode }),
    setLocked: (locked) => mutate({ type: "settings:set", key: "locked", value: locked }),
    setLaunchAtLogin: (enabled) => mutate({ type: "settings:set", key: "launchAtLogin", value: enabled }),
    quitReady: async () => ({ ok: true }),
    onState: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    onSaveStatus: (listener) => { saveListeners.add(listener); return () => saveListeners.delete(listener); },
    onFocusInput: (listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); },
    onOpenSettings: (listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); },
    onPrepareQuit: (listener) => { quitListeners.add(listener); return () => quitListeners.delete(listener); },
  };
}

const browserWindow = typeof window !== "undefined" ? window : null;
export const noteApi = browserWindow?.noteDesktop || (browserWindow ? createBrowserApi(browserWindow) : null);
export const isDesktop = Boolean(browserWindow?.noteDesktop)
  || new URLSearchParams(browserWindow?.location?.search || "").get("runtime") === "desktop";
