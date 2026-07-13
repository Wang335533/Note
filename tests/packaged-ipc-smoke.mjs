import assert from "node:assert/strict";

const endpoint = process.argv[2] || "http://127.0.0.1:9223";
const shouldQuit = process.argv.includes("--quit");

async function findPageTarget() {
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === "page" && target.title === "Note");
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Note debug target was not found");
}

const target = await findPageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function call(method, params = {}) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await call("Runtime.enable");
const expression = `
(async () => {
  const before = await window.noteDesktop.getState();
  if (!before.ok) throw new Error("getState failed");
  const dayKey = before.state.activeDay;
  const originalTasks = structuredClone(before.state.days[dayKey]?.tasks || []);

  const addResult = await window.noteDesktop.mutate({
    type: "task:add",
    text: "__Note IPC delete smoke__",
    timeRange: { start: "09:00", end: "10:15" },
  });
  if (!addResult.ok) throw new Error(addResult.error || "add failed");
  const added = (addResult.state.days[dayKey]?.tasks || []).find(
    (task) => !originalTasks.some((original) => original.id === task.id),
  );
  if (!added) throw new Error("added task was not returned");
  if (added.timeRange?.start !== "09:00" || added.timeRange?.end !== "10:15") {
    throw new Error("added task time range was not returned");
  }

  const timeResult = await window.noteDesktop.mutate({
    type: "task:time",
    id: added.id,
    timeRange: { start: "23:00", end: "01:00" },
  });
  if (!timeResult.ok) throw new Error(timeResult.error || "time edit failed");
  const timed = (timeResult.state.days[dayKey]?.tasks || []).find((task) => task.id === added.id);
  if (timed?.timeRange?.start !== "23:00" || timed?.timeRange?.end !== "01:00") {
    throw new Error("cross-midnight time edit was not returned");
  }

  const clearTimeResult = await window.noteDesktop.mutate({ type: "task:time", id: added.id, timeRange: null });
  if (!clearTimeResult.ok) throw new Error(clearTimeResult.error || "time clear failed");
  const clearedTime = (clearTimeResult.state.days[dayKey]?.tasks || []).find((task) => task.id === added.id);
  if (clearedTime?.timeRange !== null) throw new Error("cleared task time still exists");

  const renameResult = await window.noteDesktop.mutate({
    type: "task:text",
    id: added.id,
    text: "__Note IPC delete smoke renamed__",
  });
  if (!renameResult.ok) throw new Error(renameResult.error || "rename failed");

  const deleteResult = await window.noteDesktop.mutate({ type: "task:delete", id: added.id });
  if (!deleteResult.ok) throw new Error(deleteResult.error || "delete failed");
  if ((deleteResult.state.days[dayKey]?.tasks || []).some((task) => task.id === added.id)) {
    throw new Error("deleted task still exists");
  }

  let clearCompleted = "skipped-existing-completed";
  if (!originalTasks.some((task) => task.done)) {
    const addDone = await window.noteDesktop.mutate({ type: "task:add", text: "__Note IPC clear smoke__" });
    if (!addDone.ok) throw new Error(addDone.error || "clear setup add failed");
    const clearTask = (addDone.state.days[dayKey]?.tasks || []).find(
      (task) => !originalTasks.some((original) => original.id === task.id),
    );
    if (!clearTask) throw new Error("clear setup task was not returned");
    const toggleDone = await window.noteDesktop.mutate({ type: "task:toggle", id: clearTask.id, done: true });
    if (!toggleDone.ok) throw new Error(toggleDone.error || "clear setup toggle failed");
    const clearResult = await window.noteDesktop.mutate({ type: "tasks:clearCompleted" });
    if (!clearResult.ok) throw new Error(clearResult.error || "clear completed failed");
    if ((clearResult.state.days[dayKey]?.tasks || []).some((task) => task.id === clearTask.id)) {
      throw new Error("cleared task still exists");
    }
    clearCompleted = "passed";
  }

  const after = await window.noteDesktop.getState();
  const finalTasks = after.state.days[dayKey]?.tasks || [];
  return {
    add: addResult.ok,
    timeAddEditClear: true,
    rename: renameResult.ok,
    delete: deleteResult.ok,
    clearCompleted,
    originalTasksPreserved: JSON.stringify(finalTasks) === JSON.stringify(originalTasks),
    originalTaskCount: originalTasks.length,
    finalTaskCount: finalTasks.length,
  };
})()
`;

const evaluated = await call("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});

if (evaluated.exceptionDetails) {
  throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
}

const result = evaluated.result.value;
assert.equal(result.add, true);
assert.equal(result.timeAddEditClear, true);
assert.equal(result.rename, true);
assert.equal(result.delete, true);
assert.equal(result.originalTasksPreserved, true);
assert.equal(result.originalTaskCount, result.finalTaskCount);

if (shouldQuit) {
  await call("Runtime.evaluate", {
    expression: "window.noteDesktop.quitReady().catch(() => {}); true",
    returnByValue: true,
  });
}

socket.close();
console.log(JSON.stringify(result));
