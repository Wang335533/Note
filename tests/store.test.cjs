const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SCHEMA_VERSION,
  applyOperation,
  createInitialState,
  ensureCurrentDay,
  formatTimeRange,
  isPersistedStateShape,
  localDayKey,
  markdownForState,
  normalizeState,
  normalizeWindowBounds,
  searchState,
} = require("../shared/store.cjs");
const { createSerializedWriter, selectLatestValidCandidate } = require("../electron/persistence.cjs");

test("04:00 boundary keeps late-night work on the previous day", () => {
  const lateNight = new Date(2026, 6, 13, 3, 59, 0);
  const morning = new Date(2026, 6, 13, 4, 0, 0);
  assert.equal(localDayKey(lateNight, 4), "2026-07-12");
  assert.equal(localDayKey(morning, 4), "2026-07-13");
});

test("the first three tasks become Today Three automatically", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = createInitialState(now);
  for (const text of ["A", "B", "C", "D"]) {
    state = applyOperation(state, { type: "task:add", text }, now);
  }
  const tasks = state.days[state.activeDay].tasks;
  assert.deepEqual(tasks.map((task) => task.section), ["focus", "focus", "focus", "today"]);
});

test("shared Store accepts platform UUID injection without changing its public state shape", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const state = applyOperation(
    createInitialState(now),
    { type: "task:add", text: "跨平台任务" },
    now,
    { randomUUID: () => "platform-task-id" },
  );
  const task = state.days[state.activeDay].tasks[0];
  assert.equal(task.id, "platform-task-id");
  assert.equal(task.createdAt, now.toISOString());
});

test("empty task creation is rejected without changing the source state", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const state = createInitialState(now);
  assert.throws(
    () => applyOperation(state, { type: "task:add", text: "   " }, now),
    /任务内容不能为空/,
  );
  assert.equal(state.revision, 0);
  assert.equal(state.days[state.activeDay].tasks.length, 0);
});

test("Today Three never accepts a fourth task", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = createInitialState(now);
  for (const text of ["A", "B", "C", "D"]) state = applyOperation(state, { type: "task:add", text }, now);
  const fourth = state.days[state.activeDay].tasks.find((task) => task.text === "D");
  assert.throws(
    () => applyOperation(state, { type: "task:move", id: fourth.id, toSection: "focus", toIndex: 0 }, now),
    /最多只能放 3 项/,
  );
});

test("completion is persisted and can be undone", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(createInitialState(now), { type: "task:add", text: "核对参考文献" }, now);
  const task = state.days[state.activeDay].tasks[0];
  state = applyOperation(state, { type: "task:toggle", id: task.id, done: true }, now);
  assert.equal(state.days[state.activeDay].tasks[0].done, true);
  state = applyOperation(state, { type: "task:toggle", id: task.id, done: false }, now);
  assert.equal(state.days[state.activeDay].tasks[0].done, false);
});

test("optional time ranges are saved, edited, cleared, and never reorder tasks", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = createInitialState(now);
  state = applyOperation(state, {
    type: "task:add",
    text: "下午会议",
    timeRange: { start: "15:00", end: "16:15" },
  }, now);
  state = applyOperation(state, { type: "task:add", text: "优先处理" }, now);

  const [meeting, priority] = state.days[state.activeDay].tasks;
  assert.deepEqual(meeting.timeRange, { start: "15:00", end: "16:15" });
  assert.equal(priority.timeRange, null);
  assert.deepEqual(state.days[state.activeDay].tasks.map((task) => task.text), ["下午会议", "优先处理"]);

  state = applyOperation(state, {
    type: "task:time",
    id: meeting.id,
    timeRange: { start: "23:00", end: "01:00" },
  }, now);
  assert.equal(formatTimeRange(state.days[state.activeDay].tasks[0].timeRange), "23:00–次日 01:00");

  state = applyOperation(state, { type: "task:time", id: meeting.id, timeRange: null }, now);
  assert.equal(state.days[state.activeDay].tasks[0].timeRange, null);
});

test("equal or off-step time ranges are rejected while legacy tasks normalize to no time", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const initial = createInitialState(now);
  assert.throws(
    () => applyOperation(initial, {
      type: "task:add",
      text: "无效时段",
      timeRange: { start: "10:15", end: "10:15" },
    }, now),
    /有效的开始和结束时间/,
  );
  assert.throws(
    () => applyOperation(initial, {
      type: "task:add",
      text: "错误刻度",
      timeRange: { start: "10:10", end: "11:00" },
    }, now),
    /有效的开始和结束时间/,
  );

  const legacy = createInitialState(now);
  legacy.days[legacy.activeDay].tasks.push({
    id: "legacy-task",
    text: "旧任务",
    section: "focus",
    order: 0,
    done: false,
    createdAt: now.toISOString(),
    completedAt: null,
  });
  assert.equal(normalizeState(legacy, now).days[legacy.activeDay].tasks[0].timeRange, null);
});

test("a new day creates a review instead of silently rolling tasks over", () => {
  const dayOne = new Date(2026, 6, 12, 20, 0, 0);
  const dayTwo = new Date(2026, 6, 13, 10, 0, 0);
  let state = applyOperation(createInitialState(dayOne), { type: "task:add", text: "未完成" }, dayOne);
  const oldDay = state.activeDay;
  state = ensureCurrentDay(state, dayTwo);
  assert.equal(state.activeDay, "2026-07-13");
  assert.equal(state.days[oldDay].tasks.length, 1);
  assert.equal(state.days[state.activeDay].tasks.length, 0);
  assert.equal(state.pendingRollover.taskIds.length, 1);
});

test("an unresolved rollover survives across additional days", () => {
  const dayOne = new Date(2026, 6, 12, 20, 0, 0);
  const dayTwo = new Date(2026, 6, 13, 10, 0, 0);
  const dayThree = new Date(2026, 6, 14, 10, 0, 0);
  let state = applyOperation(createInitialState(dayOne), { type: "task:add", text: "仍需决定" }, dayOne);
  const originalDay = state.activeDay;
  const taskId = state.days[originalDay].tasks[0].id;

  state = ensureCurrentDay(state, dayTwo);
  state = ensureCurrentDay(state, dayThree);

  assert.equal(state.activeDay, "2026-07-14");
  assert.equal(state.pendingRollover.fromDay, originalDay);
  assert.equal(state.pendingRollover.toDay, "2026-07-14");
  assert.deepEqual(state.pendingRollover.taskIds, [taskId]);

  state = applyOperation(state, { type: "rollover:move", taskIds: [taskId] }, dayThree);
  assert.equal(state.pendingRollover, null);
  assert.equal(state.days["2026-07-14"].tasks[0].id, taskId);
});

test("finishing a task during the day boundary never deletes it during rollover", () => {
  const dayOne = new Date(2026, 6, 12, 20, 0, 0);
  const dayTwo = new Date(2026, 6, 13, 10, 0, 0);
  let state = applyOperation(createInitialState(dayOne), { type: "task:add", text: "跨日完成" }, dayOne);
  const oldDay = state.activeDay;
  const taskId = state.days[oldDay].tasks[0].id;

  state = applyOperation(state, { type: "task:toggle", id: taskId, done: true }, dayTwo);
  state = applyOperation(state, { type: "rollover:move", taskIds: [taskId] }, dayTwo);

  const occurrences = Object.values(state.days)
    .flatMap((day) => day.tasks)
    .filter((task) => task.id === taskId);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].done, true);
  assert.equal(state.days[oldDay].tasks.some((task) => task.id === taskId), true);
});

test("rollover keeps Today Three capped at three tasks", () => {
  const dayOne = new Date(2026, 6, 12, 20, 0, 0);
  const dayTwo = new Date(2026, 6, 13, 10, 0, 0);
  let state = createInitialState(dayOne);
  for (const text of ["A", "B", "C"]) {
    state = applyOperation(state, { type: "task:add", text }, dayOne);
  }
  const movingIds = state.days[state.activeDay].tasks.map((task) => task.id);

  state = applyOperation(state, { type: "task:add", text: "新一天先记下" }, dayTwo);
  state = applyOperation(state, { type: "rollover:move", taskIds: movingIds }, dayTwo);

  const todayTasks = state.days[state.activeDay].tasks;
  assert.equal(todayTasks.filter((task) => task.section === "focus").length, 3);
  assert.equal(todayTasks.filter((task) => task.section === "today").length, 1);
});

test("normalization recovers from malformed input", () => {
  const state = normalizeState({ settings: { dayBoundaryHour: 99 }, days: "bad" }, new Date(2026, 6, 12, 12));
  assert.equal(state.settings.dayBoundaryHour, 4);
  assert.ok(state.days[state.activeDay]);
});

test("desktop mode is the default and all three window layers are preserved", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const raw = createInitialState(now);
  assert.equal(raw.settings.windowMode, "desktop");

  const desktop = normalizeState(raw, now);
  assert.equal(desktop.settings.windowMode, "desktop");

  const normal = applyOperation(desktop, {
    type: "settings:set",
    key: "windowMode",
    value: "normal",
  }, now);
  assert.equal(normal.settings.windowMode, "normal");

  const floating = applyOperation(normal, {
    type: "settings:set",
    key: "windowMode",
    value: "floating",
  }, now);
  assert.equal(floating.settings.windowMode, "floating");
});

test("settings reject invalid values and window bounds preserve compatible size data", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const state = createInitialState(now);

  assert.throws(
    () => applyOperation(state, { type: "settings:set", key: "windowMode", value: "above-everything" }, now),
    /无效的窗口模式/,
  );
  assert.throws(
    () => applyOperation(state, { type: "settings:set", key: "locked", value: "yes" }, now),
    /无效的开关设置/,
  );
  assert.throws(
    () => applyOperation(state, { type: "settings:set", key: "windowBounds", value: { x: 10 } }, now),
    /无效的窗口位置/,
  );

  const moved = applyOperation(state, {
    type: "settings:set",
    key: "windowBounds",
    value: { x: -120.8, y: 0, ignored: "value" },
  }, now);
  assert.deepEqual(moved.settings.windowBounds, { x: -120, y: 0 });
  const resized = applyOperation(moved, {
    type: "settings:set",
    key: "windowBounds",
    value: { x: -120.8, y: 0, width: 620.9, height: 900.4, ignored: "value" },
  }, now);
  assert.deepEqual(resized.settings.windowBounds, { x: -120, y: 0, width: 620, height: 900 });
  assert.deepEqual(normalizeWindowBounds({ x: 5, y: 8, width: 420 }), null);
  assert.deepEqual(normalizeWindowBounds({ x: 5, y: 8, width: 0, height: 660 }), null);
  assert.deepEqual(normalizeWindowBounds({ x: Infinity, y: 0 }), null);

  const malformed = structuredClone(resized);
  malformed.settings.windowBounds = { x: 10, y: 20, width: "620", height: 900 };
  assert.equal(isPersistedStateShape(malformed), false);
});

test("current-day checks reuse the existing state until the date actually changes", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const state = createInitialState(now);
  assert.equal(ensureCurrentDay(state, new Date(2026, 6, 12, 23, 0, 0)), state);
  assert.notEqual(ensureCurrentDay(state, new Date(2026, 6, 13, 10, 0, 0)), state);
});

test("Markdown export is generated from the same state", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(createInitialState(now), { type: "task:add", text: "整理回归结果" }, now);
  const task = state.days[state.activeDay].tasks[0];
  state = applyOperation(state, { type: "task:toggle", id: task.id, done: true }, now);
  const markdown = markdownForState(state);
  assert.match(markdown, /## 2026-07-12/);
  assert.match(markdown, /- \[x\] 整理回归结果/);
});

test("Markdown export includes a cross-midnight time label", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const state = applyOperation(createInitialState(now), {
    type: "task:add",
    text: "夜间写作",
    timeRange: { start: "23:00", end: "01:00" },
  }, now);
  assert.match(markdownForState(state), /23:00–次日 01:00 夜间写作/);
});

test("a failed disk write does not poison later saves", async () => {
  const written = [];
  let attempts = 0;
  const writer = createSerializedWriter(async (value) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk unavailable");
    written.push(value);
  });

  await assert.rejects(writer.write("first"), /disk unavailable/);
  await writer.write("latest");

  assert.equal(attempts, 2);
  assert.deepEqual(written, ["latest"]);
});

test("state recovery rejects structurally invalid JSON and prefers the newest valid candidate", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const primary = createInitialState(now);
  primary.revision = 3;
  const temporary = structuredClone(primary);
  temporary.revision = 5;
  const backup = structuredClone(primary);
  backup.revision = 4;

  assert.equal(isPersistedStateShape(primary), true);
  assert.equal(isPersistedStateShape({ schemaVersion: 1, revision: 99, days: {} }), false);

  const selected = selectLatestValidCandidate([
    { kind: "primary", raw: { schemaVersion: 1, revision: 99, days: {} } },
    { kind: "temporary", raw: temporary },
    { kind: "backup", raw: backup },
  ], isPersistedStateShape);

  assert.equal(selected.kind, "temporary");
  assert.equal(selected.raw.revision, 5);
});

test("schema v1 migrates to the notes-capable schema without changing Todo content", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let current = applyOperation(createInitialState(now), { type: "task:add", text: "保留旧清单" }, now);
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  delete legacy.notebooks;
  delete legacy.notes;
  delete legacy.settings.activeModule;
  delete legacy.settings.notesLastNotebookId;
  delete legacy.settings.notesLastNoteId;
  delete legacy.settings.notesPane;
  delete legacy.settings.resumeModuleAfterRollover;

  assert.equal(isPersistedStateShape(legacy), true);
  const migrated = normalizeState(legacy, now);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.days[migrated.activeDay].tasks[0].text, "保留旧清单");
  assert.deepEqual(migrated.notebooks, {});
  assert.deepEqual(migrated.notes, {});
  assert.equal(migrated.settings.activeModule, "todo");
});

test("notebooks and Markdown notes are created, moved, pinned, and updated deterministically", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  const later = new Date(2026, 6, 12, 15, 0, 0);
  let state = applyOperation(
    createInitialState(now),
    { type: "notebook:add", name: "研究" },
    now,
    { randomUUID: () => "notebook-research" },
  );
  state = applyOperation(
    state,
    { type: "note:add", notebookId: "notebook-research" },
    now,
    { randomUUID: () => "note-identification" },
  );
  state = applyOperation(state, {
    type: "note:update",
    id: "note-identification",
    title: "识别策略",
    body: "## 主要假设\n\n平行趋势。",
  }, later);
  state = applyOperation(state, { type: "note:pin", id: "note-identification", pinned: true }, later);

  const notebook = state.notebooks["notebook-research"];
  const note = state.notes["note-identification"];
  assert.equal(notebook.name, "研究");
  assert.equal(note.notebookId, notebook.id);
  assert.equal(note.title, "识别策略");
  assert.match(note.body, /平行趋势/);
  assert.equal(note.updatedAt, later.toISOString());
  assert.equal(note.pinnedAt, later.toISOString());
  assert.deepEqual(note.attachments, []);
});

test("a trashed notebook supports individual restore before whole-notebook restore", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(
    createInitialState(now),
    { type: "notebook:add", name: "项目甲" },
    now,
    { randomUUID: () => "notebook-a" },
  );
  state = applyOperation(state, { type: "note:add", notebookId: "notebook-a", title: "笔记一" }, now, {
    randomUUID: () => "note-one",
  });
  state = applyOperation(state, { type: "note:add", notebookId: "notebook-a", title: "笔记二" }, now, {
    randomUUID: () => "note-two",
  });
  state = applyOperation(state, { type: "notebook:trash", id: "notebook-a" }, now);

  assert.ok(state.notebooks["notebook-a"].trashedAt);
  assert.ok(state.notes["note-one"].trashedAt);
  assert.ok(state.notes["note-two"].trashedAt);

  state = applyOperation(state, { type: "note:restore", id: "note-one" }, now);
  assert.equal(state.notes["note-one"].notebookId, null);
  assert.equal(state.notes["note-one"].trashedAt, null);

  state = applyOperation(state, { type: "notebook:restore", id: "notebook-a" }, now);
  assert.equal(state.notebooks["notebook-a"].trashedAt, null);
  assert.equal(state.notes["note-two"].notebookId, "notebook-a");
  assert.equal(state.notes["note-two"].trashedAt, null);
  assert.equal(state.notes["note-one"].notebookId, null);
});

test("permanently deleting a linked note clears task backlinks without deleting the task", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(createInitialState(now), { type: "note:add", title: "回归记录" }, now, {
    randomUUID: () => "note-regression",
  });
  state = applyOperation(state, {
    type: "task:add",
    text: "复查回归",
    noteId: "note-regression",
  }, now, { randomUUID: () => "task-review" });
  state = applyOperation(state, { type: "note:trash", id: "note-regression" }, now);
  state = applyOperation(state, { type: "note:deletePermanent", id: "note-regression" }, now);

  assert.equal(state.notes["note-regression"], undefined);
  assert.equal(state.days[state.activeDay].tasks[0].id, "task-review");
  assert.equal(state.days[state.activeDay].tasks[0].noteId, null);
});

test("rollover review temporarily routes Notes users to Todo and returns afterward", () => {
  const dayOne = new Date(2026, 6, 12, 20, 0, 0);
  const dayTwo = new Date(2026, 6, 13, 10, 0, 0);
  let state = applyOperation(createInitialState(dayOne), {
    type: "settings:set",
    key: "activeModule",
    value: "notes",
  }, dayOne);
  state = applyOperation(state, { type: "task:add", text: "明天复盘" }, dayOne);
  state = ensureCurrentDay(state, dayTwo);

  assert.equal(state.settings.activeModule, "todo");
  assert.equal(state.settings.resumeModuleAfterRollover, "notes");

  state = applyOperation(state, { type: "rollover:dismiss" }, dayTwo);
  assert.equal(state.settings.activeModule, "notes");
  assert.equal(state.settings.resumeModuleAfterRollover, null);
});

test("unified search groups notes, open tasks, and completed historical tasks", () => {
  const dayOne = new Date(2026, 6, 12, 14, 0, 0);
  const dayTwo = new Date(2026, 6, 13, 14, 0, 0);
  let state = applyOperation(createInitialState(dayOne), {
    type: "note:add",
    title: "平行趋势",
    body: "事件研究图的解释",
  }, dayOne, { randomUUID: () => "note-search" });
  state = applyOperation(state, { type: "task:add", text: "绘制事件研究图" }, dayOne, {
    randomUUID: () => "task-search-done",
  });
  state = applyOperation(state, { type: "task:toggle", id: "task-search-done", done: true }, dayOne);
  state = ensureCurrentDay(state, dayTwo);
  state = applyOperation(state, { type: "rollover:dismiss" }, dayTwo);
  state = applyOperation(state, { type: "task:add", text: "检查事件研究设定" }, dayTwo, {
    randomUUID: () => "task-search-open",
  });

  const results = searchState(state, "事件研究");
  assert.deepEqual(results.notes.map((item) => item.id), ["note-search"]);
  assert.deepEqual(results.openTasks.map((item) => item.id), ["task-search-open"]);
  assert.deepEqual(results.completedTasks.map((item) => item.id), ["task-search-done"]);
  assert.equal(results.completedTasks[0].dayKey, "2026-07-12");
});

test("notes navigation changes module, view, selection, and pane atomically", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(createInitialState(now), { type: "notebook:add", name: "研究" }, now, {
    randomUUID: () => "notebook-nav",
  });
  state = applyOperation(state, { type: "note:add", notebookId: "notebook-nav", title: "导航目标" }, now, {
    randomUUID: () => "note-nav",
  });
  state = applyOperation(state, { type: "settings:set", key: "activeModule", value: "todo" }, now);
  const revision = state.revision;

  state = applyOperation(state, {
    type: "notes:navigate",
    viewId: "notebook-nav",
    noteId: "note-nav",
    pane: "editor",
  }, now);

  assert.equal(state.revision, revision + 1);
  assert.deepEqual({
    activeModule: state.settings.activeModule,
    viewId: state.settings.notesLastNotebookId,
    noteId: state.settings.notesLastNoteId,
    pane: state.settings.notesPane,
  }, {
    activeModule: "notes",
    viewId: "notebook-nav",
    noteId: "note-nav",
    pane: "editor",
  });
  const unchanged = applyOperation(state, {
    type: "notes:navigate",
    viewId: "notebook-nav",
    noteId: "note-nav",
    pane: "editor",
  }, now);
  assert.equal(unchanged.revision, state.revision);
});

test("notes layout preferences default open and persist independent collapse choices", () => {
  const now = new Date(2026, 6, 19, 10, 0, 0);
  let state = createInitialState(now);
  assert.equal(state.settings.notesSidebarCollapsed, false);
  assert.equal(state.settings.notesToolbarCollapsed, false);
  state = applyOperation(state, {
    type: "settings:set",
    key: "notesSidebarCollapsed",
    value: true,
  }, now);
  state = applyOperation(state, {
    type: "settings:set",
    key: "notesToolbarCollapsed",
    value: true,
  }, now);
  const recovered = normalizeState(JSON.parse(JSON.stringify(state)), now);
  assert.equal(recovered.settings.notesSidebarCollapsed, true);
  assert.equal(recovered.settings.notesToolbarCollapsed, true);
});

test("unchanged note edits and invalid note targets never increase revision", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(createInitialState(now), {
    type: "note:add",
    title: "不变",
    body: "正文",
  }, now, { randomUUID: () => "note-stable" });
  const revision = state.revision;
  state = applyOperation(state, {
    type: "note:update",
    id: "note-stable",
    title: "不变",
    body: "正文",
  }, now);
  assert.equal(state.revision, revision);
  assert.throws(
    () => applyOperation(state, { type: "note:update", id: "missing", body: "x" }, now),
    /未找到笔记/,
  );
  assert.equal(state.revision, revision);
});
