const TIME_VALUE_PATTERN = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
const DEFAULT_SETTINGS = Object.freeze({
  windowMode: "desktop",
  windowModeVersion: 1,
  locked: false,
  launchAtLogin: false,
  dayBoundaryHour: 4,
  reducedMotion: false,
  reducedTransparency: false,
  windowBounds: null,
});

export function dayKey(date = new Date(), boundaryHour = 4) {
  const adjusted = new Date(date);
  adjusted.setHours(adjusted.getHours() - boundaryHour);
  const year = adjusted.getFullYear();
  const month = String(adjusted.getMonth() + 1).padStart(2, "0");
  const day = String(adjusted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeTimeRange(value) {
  if (!value || typeof value !== "object") return null;
  const start = typeof value.start === "string" ? value.start : "";
  const end = typeof value.end === "string" ? value.end : "";
  if (!TIME_VALUE_PATTERN.test(start) || !TIME_VALUE_PATTERN.test(end) || start === end) return null;
  return { start, end };
}

export function formatTimeRange(value) {
  const range = normalizeTimeRange(value);
  if (!range) return "";
  return `${range.start}–${range.end < range.start ? "次日 " : ""}${range.end}`;
}

function normalizeWindowBounds(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: Math.trunc(value.x), y: Math.trunc(value.y) };
}

function createDay(key) {
  return { key, tasks: [] };
}

function normalizeTask(task, fallbackOrder, now, randomUUID) {
  if (!task || typeof task !== "object") return null;
  const text = String(task.text || "").trim();
  if (!text) return null;
  return {
    id: typeof task.id === "string" ? task.id : randomUUID(),
    text,
    section: task.section === "focus" ? "focus" : "today",
    order: Number.isFinite(task.order) ? task.order : fallbackOrder,
    done: Boolean(task.done),
    timeRange: normalizeTimeRange(task.timeRange),
    createdAt: typeof task.createdAt === "string" ? task.createdAt : now.toISOString(),
    completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
  };
}

function normalizeOrders(day) {
  for (const section of ["focus", "today"]) {
    day.tasks
      .filter((task) => task.section === section)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .forEach((task, index) => { task.order = index; });
  }
}

function normalizeRollover(value) {
  if (!value || typeof value !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.fromDay || "")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.toDay || "")) return null;
  return {
    fromDay: value.fromDay,
    toDay: value.toDay,
    taskIds: Array.isArray(value.taskIds) ? value.taskIds.filter((id) => typeof id === "string") : [],
  };
}

function normalizeBrowserState(raw, now, randomUUID) {
  if (!raw || typeof raw !== "object") return makeFixture(now);
  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    windowMode: ["desktop", "normal", "floating"].includes(rawSettings.windowMode)
      ? rawSettings.windowMode
      : "desktop",
    locked: Boolean(rawSettings.locked),
    launchAtLogin: Boolean(rawSettings.launchAtLogin),
    dayBoundaryHour: [0, 2, 4, 6].includes(Number(rawSettings.dayBoundaryHour))
      ? Number(rawSettings.dayBoundaryHour)
      : 4,
    reducedMotion: Boolean(rawSettings.reducedMotion),
    reducedTransparency: Boolean(rawSettings.reducedTransparency),
    windowBounds: normalizeWindowBounds(rawSettings.windowBounds),
  };
  const days = {};
  if (raw.days && typeof raw.days === "object") {
    for (const [key, day] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const tasks = Array.isArray(day?.tasks)
        ? day.tasks.map((task, index) => normalizeTask(task, index, now, randomUUID)).filter(Boolean)
        : [];
      days[key] = { key, tasks };
      normalizeOrders(days[key]);
    }
  }
  const fallbackDay = dayKey(now, settings.dayBoundaryHour);
  const activeDay = /^\d{4}-\d{2}-\d{2}$/.test(raw.activeDay || "") ? raw.activeDay : fallbackDay;
  if (!days[activeDay]) days[activeDay] = createDay(activeDay);
  return {
    schemaVersion: 1,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    activeDay,
    days,
    pendingRollover: normalizeRollover(raw.pendingRollover),
    settings,
  };
}

function ensureCurrentDayInPlace(state, now) {
  const current = dayKey(now, state.settings.dayBoundaryHour);
  if (!state.days[current]) state.days[current] = createDay(current);
  if (current === state.activeDay) return;

  if (state.pendingRollover?.taskIds?.length) {
    state.pendingRollover.toDay = current;
    state.activeDay = current;
    state.revision += 1;
    return;
  }

  const previous = state.days[state.activeDay] || createDay(state.activeDay);
  const unfinished = previous.tasks.filter((task) => !task.done).map((task) => task.id);
  state.pendingRollover = unfinished.length
    ? { fromDay: state.activeDay, toDay: current, taskIds: unfinished }
    : null;
  state.activeDay = current;
  state.revision += 1;
}

function getTask(state, id) {
  for (const [taskDayKey, day] of Object.entries(state.days)) {
    const task = day.tasks.find((item) => item.id === id);
    if (task) return { task, day, dayKey: taskDayKey };
  }
  return null;
}

function activeDay(state) {
  if (!state.days[state.activeDay]) state.days[state.activeDay] = createDay(state.activeDay);
  return state.days[state.activeDay];
}

function applySetting(state, operation) {
  const key = operation.key;
  const allowed = new Set([
    "windowMode", "locked", "launchAtLogin", "dayBoundaryHour",
    "reducedMotion", "reducedTransparency", "windowBounds",
  ]);
  if (!allowed.has(key)) throw new Error("不支持的设置");
  if (key === "windowMode") {
    if (!["desktop", "normal", "floating"].includes(operation.value)) throw new Error("无效的窗口模式");
    state.settings.windowMode = operation.value;
    state.settings.windowModeVersion = 1;
    return;
  }
  if (key === "dayBoundaryHour") {
    if (![0, 2, 4, 6].includes(operation.value)) throw new Error("无效的换日时间");
    state.settings.dayBoundaryHour = operation.value;
    return;
  }
  if (key === "windowBounds") {
    const bounds = normalizeWindowBounds(operation.value);
    if (operation.value !== null && !bounds) throw new Error("无效的窗口位置");
    state.settings.windowBounds = bounds;
    return;
  }
  if (typeof operation.value !== "boolean") throw new Error("无效的开关设置");
  state.settings[key] = operation.value;
}

export function applyBrowserOperation(state, operation, {
  now = new Date(),
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!operation || typeof operation.type !== "string") throw new Error("无效操作");
  const next = structuredClone(state);
  ensureCurrentDayInPlace(next, now);
  const day = activeDay(next);
  const timestamp = now.toISOString();

  switch (operation.type) {
    case "task:add": {
      const text = String(operation.text || "").trim();
      if (!text) throw new Error("任务内容不能为空");
      const timeRange = normalizeTimeRange(operation.timeRange);
      if (operation.timeRange != null && !timeRange) throw new Error("请选择有效的开始和结束时间");
      const focusCount = day.tasks.filter((task) => task.section === "focus").length;
      let section = operation.section === "today" || operation.section === "focus"
        ? operation.section
        : focusCount < 3 ? "focus" : "today";
      if (section === "focus" && focusCount >= 3) section = "today";
      const order = day.tasks.filter((task) => task.section === section).length;
      day.tasks.push({
        id: randomUUID(),
        text,
        section,
        order,
        done: false,
        timeRange,
        createdAt: timestamp,
        completedAt: null,
      });
      break;
    }
    case "task:text": {
      const found = getTask(next, operation.id);
      if (!found) break;
      const text = String(operation.text || "").trim();
      if (!text) found.day.tasks = found.day.tasks.filter((task) => task.id !== operation.id);
      else found.task.text = text;
      normalizeOrders(found.day);
      break;
    }
    case "task:toggle": {
      const found = getTask(next, operation.id);
      if (!found) break;
      const done = typeof operation.done === "boolean" ? operation.done : !found.task.done;
      found.task.done = done;
      found.task.completedAt = done ? timestamp : null;
      break;
    }
    case "task:time": {
      const found = getTask(next, operation.id);
      if (!found) break;
      const timeRange = normalizeTimeRange(operation.timeRange);
      if (operation.timeRange != null && !timeRange) throw new Error("请选择有效的开始和结束时间");
      found.task.timeRange = timeRange;
      break;
    }
    case "task:delete": {
      const found = getTask(next, operation.id);
      if (!found) break;
      found.day.tasks = found.day.tasks.filter((task) => task.id !== operation.id);
      normalizeOrders(found.day);
      break;
    }
    case "task:restore": {
      const restoreDayKey = /^\d{4}-\d{2}-\d{2}$/.test(operation.dayKey || "")
        ? operation.dayKey
        : next.activeDay;
      if (!next.days[restoreDayKey]) next.days[restoreDayKey] = createDay(restoreDayKey);
      const restored = normalizeTask(operation.task, next.days[restoreDayKey].tasks.length, now, randomUUID);
      if (restored && !getTask(next, restored.id)) next.days[restoreDayKey].tasks.push(restored);
      normalizeOrders(next.days[restoreDayKey]);
      break;
    }
    case "tasks:restore": {
      const restoreDayKey = /^\d{4}-\d{2}-\d{2}$/.test(operation.dayKey || "")
        ? operation.dayKey
        : next.activeDay;
      if (!next.days[restoreDayKey]) next.days[restoreDayKey] = createDay(restoreDayKey);
      for (const item of Array.isArray(operation.tasks) ? operation.tasks : []) {
        const restored = normalizeTask(item, next.days[restoreDayKey].tasks.length, now, randomUUID);
        if (restored && !getTask(next, restored.id)) next.days[restoreDayKey].tasks.push(restored);
      }
      normalizeOrders(next.days[restoreDayKey]);
      break;
    }
    case "task:move": {
      const found = getTask(next, operation.id);
      if (!found || found.dayKey !== next.activeDay) break;
      const toSection = operation.toSection === "focus" ? "focus" : "today";
      const focusTasks = day.tasks.filter((task) => task.section === "focus");
      if (toSection === "focus" && found.task.section !== "focus" && focusTasks.length >= 3) {
        throw new Error("今日三件最多只能放 3 项");
      }
      const oldSection = found.task.section;
      const oldList = day.tasks
        .filter((task) => task.section === oldSection && task.id !== found.task.id)
        .sort((a, b) => a.order - b.order);
      found.task.section = toSection;
      const newList = day.tasks
        .filter((task) => task.section === toSection && task.id !== found.task.id)
        .sort((a, b) => a.order - b.order);
      const index = Math.max(0, Math.min(Number(operation.toIndex) || 0, newList.length));
      newList.splice(index, 0, found.task);
      oldList.forEach((task, order) => { task.order = order; });
      newList.forEach((task, order) => { task.order = order; });
      normalizeOrders(day);
      break;
    }
    case "tasks:clearCompleted":
      day.tasks = day.tasks.filter((task) => !task.done);
      normalizeOrders(day);
      break;
    case "rollover:move": {
      const pending = next.pendingRollover;
      if (!pending) break;
      const selected = new Set(Array.isArray(operation.taskIds) ? operation.taskIds : []);
      const pendingIds = new Set(pending.taskIds);
      const from = next.days[pending.fromDay];
      const to = next.days[pending.toDay] || createDay(pending.toDay);
      next.days[pending.toDay] = to;
      if (from) {
        const moving = from.tasks.filter(
          (task) => pendingIds.has(task.id) && selected.has(task.id) && !task.done,
        );
        const movingIds = new Set(moving.map((task) => task.id));
        from.tasks = from.tasks.filter((task) => !movingIds.has(task.id));
        let focusCount = to.tasks.filter((task) => task.section === "focus").length;
        for (const task of moving) {
          if (task.section === "focus") {
            if (focusCount >= 3) task.section = "today";
            else focusCount += 1;
          }
          task.order = to.tasks.filter((item) => item.section === task.section).length;
          to.tasks.push(task);
        }
        normalizeOrders(from);
        normalizeOrders(to);
      }
      next.pendingRollover = null;
      break;
    }
    case "rollover:dismiss":
      next.pendingRollover = null;
      break;
    case "settings:set":
      applySetting(next, operation);
      break;
    default:
      throw new Error(`未知操作: ${operation.type}`);
  }

  next.schemaVersion = 1;
  next.revision += 1;
  return next;
}

export function makeFixture(now = new Date()) {
  const activeDayKey = dayKey(now);
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

function markdownForState(state) {
  const lines = ["# Note", ""];
  const dayKeys = Object.keys(state.days).sort().reverse();
  for (const key of dayKeys) {
    lines.push(`## ${key}`, "");
    const tasks = [...state.days[key].tasks].sort((a, b) => a.order - b.order);
    for (const task of tasks) {
      const time = formatTimeRange(task.timeRange);
      lines.push(`- [${task.done ? "x" : " "}] ${time ? `${time} ` : ""}${task.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
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

  let raw;
  try {
    raw = fixtureMode
      ? makeFixture(now())
      : JSON.parse(browserWindow.localStorage.getItem(storageKey)) || makeFixture(now());
  } catch {
    raw = makeFixture(now());
  }
  let state = normalizeBrowserState(raw, now(), randomUUID);
  const initialRevision = state.revision;
  ensureCurrentDayInPlace(state, now());
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
