const crypto = require("node:crypto");

const SCHEMA_VERSION = 1;
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

function localDayKey(date = new Date(), boundaryHour = 4) {
  const adjusted = new Date(date);
  adjusted.setHours(adjusted.getHours() - boundaryHour);
  const year = adjusted.getFullYear();
  const month = String(adjusted.getMonth() + 1).padStart(2, "0");
  const day = String(adjusted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createDay(key) {
  return { key, tasks: [] };
}

function createInitialState(now = new Date()) {
  const settings = { ...DEFAULT_SETTINGS };
  const activeDay = localDayKey(now, settings.dayBoundaryHour);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    activeDay,
    days: { [activeDay]: createDay(activeDay) },
    pendingRollover: null,
    settings,
  };
}

function clone(value) {
  return structuredClone(value);
}

function normalizeTimeRange(value) {
  if (!value || typeof value !== "object") return null;
  const start = typeof value.start === "string" ? value.start : "";
  const end = typeof value.end === "string" ? value.end : "";
  if (!TIME_VALUE_PATTERN.test(start) || !TIME_VALUE_PATTERN.test(end) || start === end) return null;
  return { start, end };
}

function formatTimeRange(value) {
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

function normalizeTask(task, fallbackOrder = 0) {
  if (!task || typeof task !== "object") return null;
  const text = String(task.text || "").trim();
  if (!text) return null;
  return {
    id: typeof task.id === "string" ? task.id : crypto.randomUUID(),
    text,
    section: task.section === "focus" ? "focus" : "today",
    order: Number.isFinite(task.order) ? task.order : fallbackOrder,
    done: Boolean(task.done),
    timeRange: normalizeTimeRange(task.timeRange),
    createdAt: typeof task.createdAt === "string" ? task.createdAt : new Date().toISOString(),
    completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
  };
}

function isPersistedStateShape(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (raw.schemaVersion !== SCHEMA_VERSION) return false;
  if (!Number.isInteger(raw.revision) || raw.revision < 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.activeDay || "")) return false;
  if (!raw.days || typeof raw.days !== "object" || Array.isArray(raw.days)) return false;
  if (!raw.settings || typeof raw.settings !== "object" || Array.isArray(raw.settings)) return false;
  if (!raw.days[raw.activeDay] || !Array.isArray(raw.days[raw.activeDay].tasks)) return false;
  if (raw.settings.windowBounds !== undefined
    && raw.settings.windowBounds !== null
    && !normalizeWindowBounds(raw.settings.windowBounds)) return false;

  for (const [key, day] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !day || !Array.isArray(day.tasks)) return false;
    for (const task of day.tasks) {
      if (!task || typeof task !== "object") return false;
      if (typeof task.id !== "string" || !task.id) return false;
      if (typeof task.text !== "string" || !task.text.trim()) return false;
      if (!['focus', 'today'].includes(task.section)) return false;
      if (!Number.isFinite(task.order) || typeof task.done !== "boolean") return false;
      if (task.timeRange !== undefined && task.timeRange !== null && !normalizeTimeRange(task.timeRange)) return false;
    }
  }
  return true;
}

function normalizeState(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") return createInitialState(now);
  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    locked: Boolean(rawSettings.locked),
    launchAtLogin: Boolean(rawSettings.launchAtLogin),
    reducedMotion: Boolean(rawSettings.reducedMotion),
    reducedTransparency: Boolean(rawSettings.reducedTransparency),
    windowBounds: normalizeWindowBounds(rawSettings.windowBounds),
  };
  settings.dayBoundaryHour = [0, 2, 4, 6].includes(Number(rawSettings.dayBoundaryHour))
    ? Number(rawSettings.dayBoundaryHour)
    : 4;
  settings.windowMode = ["desktop", "normal", "floating"].includes(rawSettings.windowMode)
    ? rawSettings.windowMode
    : "desktop";
  settings.windowModeVersion = 1;
  const days = {};
  if (raw.days && typeof raw.days === "object") {
    for (const [key, day] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const tasks = Array.isArray(day?.tasks)
        ? day.tasks.map((task, index) => normalizeTask(task, index)).filter(Boolean)
        : [];
      days[key] = { key, tasks };
      normalizeOrders(days[key]);
    }
  }
  const fallbackDay = localDayKey(now, settings.dayBoundaryHour);
  const activeDay = /^\d{4}-\d{2}-\d{2}$/.test(raw.activeDay) ? raw.activeDay : fallbackDay;
  if (!days[activeDay]) days[activeDay] = createDay(activeDay);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    activeDay,
    days,
    pendingRollover: normalizeRollover(raw.pendingRollover),
    settings,
  };
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

function normalizeOrders(day) {
  for (const section of ["focus", "today"]) {
    day.tasks
      .filter((task) => task.section === section)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .forEach((task, index) => {
        task.order = index;
      });
  }
}

function ensureCurrentDay(state, now = new Date()) {
  const current = localDayKey(now, state.settings.dayBoundaryHour);
  if (current === state.activeDay && state.days?.[current]) return state;
  const next = clone(state);
  if (!next.days[current]) next.days[current] = createDay(current);
  if (current === next.activeDay) return next;

  if (next.pendingRollover?.taskIds?.length) {
    next.pendingRollover.toDay = current;
    next.activeDay = current;
    next.revision += 1;
    return next;
  }

  const previous = next.days[next.activeDay] || createDay(next.activeDay);
  const unfinished = previous.tasks.filter((task) => !task.done).map((task) => task.id);
  next.pendingRollover = unfinished.length
    ? { fromDay: next.activeDay, toDay: current, taskIds: unfinished }
    : null;
  next.activeDay = current;
  next.revision += 1;
  return next;
}

function getTask(state, id) {
  for (const [dayKey, day] of Object.entries(state.days)) {
    const task = day.tasks.find((item) => item.id === id);
    if (task) return { task, day, dayKey };
  }
  return null;
}

function activeDay(state) {
  if (!state.days[state.activeDay]) state.days[state.activeDay] = createDay(state.activeDay);
  return state.days[state.activeDay];
}

function applyOperation(state, operation, now = new Date()) {
  if (!operation || typeof operation.type !== "string") throw new Error("无效操作");
  const next = ensureCurrentDay(normalizeState(state, now), now);
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
        id: crypto.randomUUID(),
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
      if (!text) {
        found.day.tasks = found.day.tasks.filter((task) => task.id !== operation.id);
      } else {
        found.task.text = text;
      }
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
      const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(operation.dayKey || "")
        ? operation.dayKey
        : next.activeDay;
      if (!next.days[dayKey]) next.days[dayKey] = createDay(dayKey);
      const restored = normalizeTask(operation.task, next.days[dayKey].tasks.length);
      if (restored && !getTask(next, restored.id)) next.days[dayKey].tasks.push(restored);
      normalizeOrders(next.days[dayKey]);
      break;
    }
    case "tasks:restore": {
      const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(operation.dayKey || "")
        ? operation.dayKey
        : next.activeDay;
      if (!next.days[dayKey]) next.days[dayKey] = createDay(dayKey);
      for (const item of Array.isArray(operation.tasks) ? operation.tasks : []) {
        const restored = normalizeTask(item, next.days[dayKey].tasks.length);
        if (restored && !getTask(next, restored.id)) next.days[dayKey].tasks.push(restored);
      }
      normalizeOrders(next.days[dayKey]);
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
    case "tasks:clearCompleted": {
      day.tasks = day.tasks.filter((task) => !task.done);
      normalizeOrders(day);
      break;
    }
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
    case "rollover:dismiss": {
      next.pendingRollover = null;
      break;
    }
    case "settings:set": {
      const key = operation.key;
      const allowed = new Set([
        "windowMode", "locked", "launchAtLogin", "dayBoundaryHour",
        "reducedMotion", "reducedTransparency", "windowBounds",
      ]);
      if (!allowed.has(key)) throw new Error("不支持的设置");
      if (key === "windowMode") {
        if (!["desktop", "normal", "floating"].includes(operation.value)) throw new Error("无效的窗口模式");
        next.settings[key] = operation.value;
        next.settings.windowModeVersion = 1;
      }
      else if (key === "dayBoundaryHour") {
        if (![0, 2, 4, 6].includes(operation.value)) throw new Error("无效的换日时间");
        next.settings[key] = operation.value;
      }
      else if (key === "windowBounds") {
        const bounds = normalizeWindowBounds(operation.value);
        if (operation.value !== null && !bounds) throw new Error("无效的窗口位置");
        next.settings[key] = bounds;
      }
      else {
        if (typeof operation.value !== "boolean") throw new Error("无效的开关设置");
        next.settings[key] = operation.value;
      }
      break;
    }
    default:
      throw new Error(`未知操作: ${operation.type}`);
  }

  next.schemaVersion = SCHEMA_VERSION;
  next.revision += 1;
  return next;
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

module.exports = {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  applyOperation,
  createInitialState,
  ensureCurrentDay,
  formatTimeRange,
  isPersistedStateShape,
  localDayKey,
  markdownForState,
  normalizeTimeRange,
  normalizeWindowBounds,
  normalizeState,
};
