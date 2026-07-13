function dayKey(date = new Date(), boundaryHour = 4) {
  const adjusted = new Date(date);
  adjusted.setHours(adjusted.getHours() - boundaryHour);
  const year = adjusted.getFullYear();
  const month = String(adjusted.getMonth() + 1).padStart(2, "0");
  const day = String(adjusted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeFixture() {
  const activeDay = dayKey();
  const timestamp = new Date().toISOString();
  const items = [
    ["整理回归结果", "focus", true],
    ["修改引言的研究动机", "focus", true],
    ["核对参考文献", "focus", true],
    ["更新专利数据", "today", false],
    ["回复合作者", "today", false],
    ["整理访谈记录", "today", false],
  ];
  return {
    schemaVersion: 1,
    revision: 1,
    activeDay,
    days: {
      [activeDay]: {
        key: activeDay,
        tasks: items.map(([text, section, done], index) => ({
          id: `fixture-${index + 1}`,
          text,
          section,
          order: section === "focus" ? index : index - 3,
          done,
          createdAt: timestamp,
          completedAt: done ? timestamp : null,
          hidden: index === 5,
        })),
      },
    },
    pendingRollover: null,
    settings: {
      windowMode: "floating",
      locked: false,
      launchAtLogin: false,
      dayBoundaryHour: 4,
      reducedMotion: false,
      reducedTransparency: false,
      windowBounds: null,
    },
  };
}

function createBrowserApi() {
  const fixtureMode = new URLSearchParams(window.location.search).get("fixture") === "reference";
  const storageKey = "desktop-note-state-v1";
  const stateListeners = new Set();
  const saveListeners = new Set();
  const focusListeners = new Set();
  const settingsListeners = new Set();
  const quitListeners = new Set();

  let state;
  try {
    state = fixtureMode ? makeFixture() : JSON.parse(localStorage.getItem(storageKey)) || makeFixture();
  } catch {
    state = makeFixture();
  }

  function day() {
    if (!state.days[state.activeDay]) state.days[state.activeDay] = { key: state.activeDay, tasks: [] };
    return state.days[state.activeDay];
  }

  function emit(status = "saved") {
    state.revision += 1;
    if (!fixtureMode) localStorage.setItem(storageKey, JSON.stringify(state));
    stateListeners.forEach((listener) => listener({ state: structuredClone(state), status }));
    saveListeners.forEach((listener) => listener(status));
  }

  function normalizeOrders() {
    for (const section of ["focus", "today"]) {
      day().tasks
        .filter((task) => task.section === section)
        .sort((a, b) => a.order - b.order)
        .forEach((task, index) => { task.order = index; });
    }
  }

  async function mutate(operation) {
    try {
      const tasks = day().tasks;
      const found = operation.id ? tasks.find((task) => task.id === operation.id) : null;
      switch (operation.type) {
        case "task:add": {
          const text = String(operation.text || "").trim();
          if (!text) break;
          const focusCount = tasks.filter((task) => task.section === "focus").length;
          const section = operation.section || (focusCount < 3 ? "focus" : "today");
          tasks.push({
            id: crypto.randomUUID(),
            text,
            section: section === "focus" && focusCount < 3 ? "focus" : "today",
            order: tasks.filter((task) => task.section === section).length,
            done: false,
            createdAt: new Date().toISOString(),
            completedAt: null,
          });
          break;
        }
        case "task:text":
          if (found && String(operation.text || "").trim()) found.text = String(operation.text).trim();
          else if (found) day().tasks = tasks.filter((task) => task.id !== found.id);
          break;
        case "task:toggle":
          if (found) {
            found.done = typeof operation.done === "boolean" ? operation.done : !found.done;
            found.completedAt = found.done ? new Date().toISOString() : null;
          }
          break;
        case "task:delete":
          if (found) day().tasks = tasks.filter((task) => task.id !== found.id);
          break;
        case "task:restore":
          if (operation.task && !tasks.some((task) => task.id === operation.task.id)) tasks.push(structuredClone(operation.task));
          break;
        case "tasks:restore":
          for (const task of operation.tasks || []) {
            if (!tasks.some((item) => item.id === task.id)) tasks.push(structuredClone(task));
          }
          break;
        case "task:move": {
          if (!found) break;
          const toSection = operation.toSection === "focus" ? "focus" : "today";
          if (toSection === "focus" && found.section !== "focus" && tasks.filter((task) => task.section === "focus").length >= 3) {
            throw new Error("今日三件最多只能放 3 项");
          }
          found.section = toSection;
          const list = tasks.filter((task) => task.section === toSection && task.id !== found.id).sort((a, b) => a.order - b.order);
          list.splice(Math.max(0, Math.min(Number(operation.toIndex) || 0, list.length)), 0, found);
          list.forEach((task, index) => { task.order = index; });
          break;
        }
        case "tasks:clearCompleted":
          day().tasks = tasks.filter((task) => !task.done);
          break;
        case "rollover:move":
        case "rollover:dismiss":
          state.pendingRollover = null;
          break;
        case "settings:set":
          state.settings[operation.key] = operation.value;
          break;
        default:
          throw new Error(`未知操作: ${operation.type}`);
      }
      normalizeOrders();
      emit("saved");
      return { ok: true, state: structuredClone(state) };
    } catch (error) {
      return { ok: false, error: error.message, state: structuredClone(state) };
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
      const lines = ["# Note", "", `## ${state.activeDay}`, ""];
      day().tasks.forEach((task) => lines.push(`- [${task.done ? "x" : " "}] ${task.text}`));
      const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Note-${state.activeDay}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
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

export const noteApi = window.noteDesktop || createBrowserApi();
export const isDesktop = Boolean(window.noteDesktop)
  || new URLSearchParams(window.location.search).get("runtime") === "desktop";
