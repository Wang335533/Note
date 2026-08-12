const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createNativeDialogCoordinator } = require("../electron/native-dialog.cjs");

test("native dialogs lift the host window, stay single-flight, and restore it", async () => {
  const calls = [];
  const window = { isDestroyed: () => false };
  let finishDialog;
  const pendingDialog = new Promise((resolve) => { finishDialog = resolve; });
  const coordinator = createNativeDialogCoordinator({
    dialog: {
      async showSaveDialog(receivedWindow, options) {
        calls.push(["dialog", receivedWindow, options.title]);
        return pendingDialog;
      },
    },
    getWindow: () => window,
    beforeOpen: async (receivedWindow) => calls.push(["before", receivedWindow]),
    afterClose: async (receivedWindow) => calls.push(["after", receivedWindow]),
  });

  const first = coordinator.showSaveDialog({ title: "导出" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.isActive(), true);

  const duplicate = await coordinator.showSaveDialog({ title: "重复" });
  assert.deepEqual(duplicate, { canceled: true, filePath: "", busy: true });
  assert.equal(calls.filter(([name]) => name === "dialog").length, 1);

  finishDialog({ canceled: false, filePath: "D:\\notes\\note.md" });
  assert.deepEqual(await first, { canceled: false, filePath: "D:\\notes\\note.md" });
  assert.equal(coordinator.isActive(), false);
  assert.deepEqual(calls.map(([name]) => name), ["before", "dialog", "after"]);
  assert.equal(calls[0][1], window);
  assert.equal(calls[1][1], window);
  assert.equal(calls[2][1], window);
});

test("native dialog cleanup runs after failures and allows the next dialog", async () => {
  let attempts = 0;
  let restores = 0;
  const coordinator = createNativeDialogCoordinator({
    dialog: {
      async showOpenDialog() {
        attempts += 1;
        if (attempts === 1) throw new Error("dialog failed");
        return { canceled: true, filePaths: [] };
      },
    },
    afterClose: async () => { restores += 1; },
  });

  await assert.rejects(() => coordinator.showOpenDialog({}), /dialog failed/);
  assert.equal(coordinator.isActive(), false);
  assert.deepEqual(await coordinator.showOpenDialog({}), { canceled: true, filePaths: [] });
  assert.equal(restores, 2);
});

test("desktop file pickers all use the managed dialog lifecycle", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.doesNotMatch(mainSource, /dialog\.show(?:Open|Save)Dialog/);
  assert.match(mainSource, /nativeDialogs\.showOpenDialog/);
  assert.match(mainSource, /nativeDialogs\.showSaveDialog/);
  assert.match(mainSource, /mainWindow\.on\("blur",[\s\S]+nativeDialogs\.isActive\(\)/);
});
