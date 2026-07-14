import test from "node:test";
import assert from "node:assert/strict";
import storeModule from "../shared/store.cjs";
import { createBrowserApi, makeFixture } from "../src/api.js";

const { applyOperation, createInitialState, ensureCurrentDay } = storeModule;

function fakeBrowserWindow(initialState) {
  const values = new Map([["desktop-note-state-v1", JSON.stringify(initialState)]]);
  return {
    location: { search: "" },
    crypto: { randomUUID: () => "browser-generated-id" },
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); },
    },
  };
}

test("browser preview appends a focus overflow task to the end of Today", async () => {
  const now = new Date(2026, 6, 14, 14, 0, 0);
  let initial = createInitialState(now);
  for (const text of ["F1", "F2", "F3", "T1", "T2", "T3", "T4", "T5"]) {
    initial = applyOperation(initial, { type: "task:add", text }, now);
  }

  const browserApi = createBrowserApi(fakeBrowserWindow(initial), {
    now: () => now,
    randomUUID: () => "browser-added",
  });
  const browserResult = await browserApi.mutate({ type: "task:add", text: "overflow", section: "focus" });

  assert.equal(browserResult.ok, true);
  const browserTasks = browserResult.state.days[browserResult.state.activeDay].tasks;
  const browserAdded = browserTasks.find((task) => task.text === "overflow");
  assert.deepEqual({ id: browserAdded.id, section: browserAdded.section, order: browserAdded.order }, {
    id: "browser-added",
    section: "today",
    order: 5,
  });
  assert.deepEqual(
    browserTasks.filter((task) => task.section === "today").map((task) => task.text),
    ["T1", "T2", "T3", "T4", "T5", "overflow"],
  );
  assert.equal(browserResult.state.revision, initial.revision + 1);
});

test("browser preview rejects invalid operations without changing revision", async () => {
  const now = new Date(2026, 6, 14, 14, 0, 0);
  const initial = createInitialState(now);
  const browserApi = createBrowserApi(fakeBrowserWindow(initial), { now: () => now });

  for (const operation of [
    { type: "task:add", text: "   " },
    { type: "task:add", text: "bad time", timeRange: { start: "10:00", end: "10:00" } },
    { type: "settings:set", key: "unknown", value: true },
    { type: "settings:set", key: "locked", value: "yes" },
    { type: "settings:set", key: "windowBounds", value: { x: 10 } },
  ]) {
    const result = await browserApi.mutate(operation);
    assert.equal(result.ok, false);
    assert.equal(result.state.revision, initial.revision);
  }
});

test("browser rollover moves the selected task into the active day", async () => {
  const dayOne = new Date(2026, 6, 14, 14, 0, 0);
  const dayTwo = new Date(2026, 6, 15, 14, 0, 0);
  let initial = applyOperation(createInitialState(dayOne), { type: "task:add", text: "move tomorrow" }, dayOne);
  initial = ensureCurrentDay(initial, dayTwo);
  const taskId = initial.pendingRollover.taskIds[0];

  const browserApi = createBrowserApi(fakeBrowserWindow(initial), { now: () => dayTwo });
  const browserResult = await browserApi.mutate({ type: "rollover:move", taskIds: [taskId] });

  assert.equal(browserResult.ok, true);
  assert.equal(browserResult.state.pendingRollover, null);
  assert.equal(browserResult.state.days[browserResult.state.activeDay].tasks[0].id, taskId);
  assert.equal(browserResult.state.revision, initial.revision + 1);
});

test("browser preview emits saving and saved around a shared-store mutation", async () => {
  const now = new Date("2026-07-14T10:00:00+08:00");
  const browserApi = createBrowserApi(fakeBrowserWindow(createInitialState(now)), {
    now: () => now,
    randomUUID: () => "adapter-task-id",
  });
  const statuses = [];
  browserApi.onSaveStatus((status) => statuses.push(status));

  const result = await browserApi.mutate({ type: "task:add", text: "薄适配层任务" });

  assert.equal(result.ok, true);
  assert.deepEqual(statuses, ["saving", "saved"]);
  assert.equal(result.state.days[result.state.activeDay].tasks[0].id, "adapter-task-id");
  assert.equal(result.state.days[result.state.activeDay].tasks[0].createdAt, now.toISOString());
});

test("browser preview keeps an in-memory mutation visible when storage fails", async () => {
  const now = new Date("2026-07-14T10:00:00+08:00");
  const browserWindow = fakeBrowserWindow(createInitialState(now));
  browserWindow.localStorage.setItem = () => { throw new Error("storage unavailable"); };
  const browserApi = createBrowserApi(browserWindow, {
    now: () => now,
    randomUUID: () => "kept-in-memory",
  });
  const before = await browserApi.getState();
  const result = await browserApi.mutate({ type: "task:add", text: "仍应显示" });
  const after = await browserApi.getState();

  assert.equal(result.ok, false);
  assert.equal(after.state.revision, before.state.revision + 1);
  assert.equal(
    after.state.days[after.state.activeDay].tasks.some((task) => task.id === "kept-in-memory"),
    true,
  );
});

test("reference fixture contains only visible tasks", () => {
  const fixture = makeFixture(new Date(2026, 6, 14, 14, 0, 0));
  const tasks = fixture.days[fixture.activeDay].tasks;
  assert.equal(tasks.length, 5);
  assert.equal(tasks.some((task) => Object.hasOwn(task, "hidden")), false);
});
