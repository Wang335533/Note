const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attachmentIdFromUrl,
  createLibraryExportPlan,
  deriveImportedTitle,
  noteAssetUrl,
  safeFileSegment,
} = require("../shared/library-files.cjs");
const { applyOperation, createInitialState } = require("../shared/store.cjs");

test("Windows-safe export names never preserve traversal or reserved device names", () => {
  assert.equal(safeFileSegment("../研究:设计?. "), "研究 设计");
  assert.equal(safeFileSegment("CON"), "CON-note");
  assert.equal(safeFileSegment("   "), "无标题");
});

test("imported titles prefer the first Markdown heading and fall back to the file name", () => {
  assert.equal(deriveImportedTitle("draft.md", "# 识别策略\n\n正文"), "识别策略");
  assert.equal(deriveImportedTitle("会议纪要.md", "没有一级标题"), "会议纪要");
});

test("internal note asset URLs round-trip only safe attachment ids", () => {
  const url = noteAssetUrl("asset-1");
  assert.equal(url, "note-asset://local/asset-1");
  assert.equal(attachmentIdFromUrl(url), "asset-1");
  assert.equal(attachmentIdFromUrl("note-asset://local/a%2Fb"), null);
});

test("library export preserves notebook structure, unique note names, and relative images", () => {
  const now = new Date(2026, 6, 12, 14, 0, 0);
  let state = applyOperation(createInitialState(now), { type: "notebook:add", name: "研究/项目" }, now, {
    randomUUID: () => "notebook-research",
  });
  state = applyOperation(state, {
    type: "note:add",
    notebookId: "notebook-research",
    title: "识别策略",
    body: "![图](note-asset://local/image-one)",
  }, now, { randomUUID: () => "note-one" });
  state = applyOperation(state, {
    type: "note:attachment:add",
    id: "note-one",
    attachment: {
      id: "image-one",
      fileName: "plot.png",
      mimeType: "image/png",
      relativePath: "attachments/image-one.png",
    },
  }, now);
  state = applyOperation(state, {
    type: "note:add",
    notebookId: "notebook-research",
    title: "识别策略",
    body: "第二篇",
  }, now, { randomUUID: () => "note-two" });
  state = applyOperation(state, {
    type: "folder:add",
    notebookId: "notebook-research",
    name: "机制/检验",
  }, now, { randomUUID: () => "folder-mechanism" });
  state = applyOperation(state, {
    type: "note:add",
    notebookId: "notebook-research",
    folderId: "folder-mechanism",
    title: "中介路径",
    body: "文件夹内笔记",
  }, now, { randomUUID: () => "note-three" });

  const plan = createLibraryExportPlan(state);
  assert.deepEqual(plan.notes.map((note) => note.relativePath), [
    "研究 项目/识别策略.md",
    "研究 项目/识别策略--note-two.md",
    "研究 项目/机制 检验/中介路径.md",
  ]);
  assert.equal(plan.notes[0].content, "![图](识别策略.assets/image-one.png)");
  assert.equal(plan.notes[0].assets[0].relativePath, "研究 项目/识别策略.assets/image-one.png");
});

test("browser and desktop library helpers stay behaviorally aligned", async () => {
  const browserHelpers = await import("../shared/library-files.mjs");
  assert.equal(browserHelpers.safeFileSegment("../研究:设计?. "), safeFileSegment("../研究:设计?. "));
  assert.equal(browserHelpers.deriveImportedTitle("会议纪要.md", "没有一级标题"), deriveImportedTitle("会议纪要.md", "没有一级标题"));
  assert.equal(browserHelpers.noteAssetUrl("asset-1"), noteAssetUrl("asset-1"));
});
