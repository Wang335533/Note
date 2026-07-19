const test = require("node:test");
const assert = require("node:assert/strict");
const {
  emptyRichBody,
  isRichBody,
  markdownFromRichBody,
  plainTextFromRichBody,
  stripOwnFormatMarkers,
} = require("../shared/rich-text.cjs");
const {
  SCHEMA_VERSION,
  applyOperation,
  createInitialState,
  isPersistedStateShape,
  normalizeState,
  searchState,
} = require("../shared/store.cjs");

const formattedDocument = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{
        type: "text",
        text: "研究设计",
        marks: [
          { type: "bold" },
          { type: "underline" },
          { type: "textStyle", attrs: { fontFamily: "Times New Roman", fontSize: "20px" } },
        ],
      }],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "核对变量" }] }],
        },
      ],
    },
  ],
};

test("rich documents validate with a strict node and mark allowlist", () => {
  assert.equal(isRichBody(emptyRichBody()), true);
  assert.equal(isRichBody(formattedDocument), true);
  assert.equal(isRichBody({ type: "doc", content: [{ type: "script", text: "bad" }] }), false);
  assert.equal(isRichBody({ type: "doc", content: [{ type: "text", text: "not a block" }] }), false);
  assert.equal(isRichBody({ type: "doc", content: [{ type: "text", text: "bad", marks: [{ type: "onclick" }] }] }), false);
  assert.equal(isRichBody({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
  }), false);
  assert.equal(isRichBody({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "relative", marks: [{ type: "link", attrs: { href: "../appendix.md" } }] }] }],
  }), true);
  assert.equal(isRichBody({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "bad", marks: [{ type: "textStyle", attrs: { fontFamily: "Comic Sans MS" } }] }] }],
  }), false);
});

test("clean Markdown export keeps semantics and drops visual-only font metadata", () => {
  const markdown = markdownFromRichBody(formattedDocument);
  assert.equal(markdown, "## **研究设计**\n\n- [x] 核对变量");
  assert.doesNotMatch(markdown, /font|span|Times New Roman|20px|<u>/i);
  assert.equal(plainTextFromRichBody(formattedDocument), "研究设计\n核对变量");
});

test("only Note-owned legacy markers are removed from plain legacy text", () => {
  const source = '<font data-note-font="simhei">重点</font> <span data-note-size="20">大字</span> <font color="red">保留</font>';
  assert.equal(stripOwnFormatMarkers(source), '重点 大字 <font color="red">保留</font>');
  assert.equal(stripOwnFormatMarkers("普通 </font> 文本"), "普通 </font> 文本");
});

test("schema 2 Markdown notes migrate without loss and wait for editor conversion", () => {
  const now = new Date(2026, 6, 19, 14, 0, 0);
  let current = applyOperation(createInitialState(now), {
    type: "note:add",
    title: "旧笔记",
    body: "## 标题\n\n正文",
  }, now, { randomUUID: () => "legacy-note" });
  const legacy = structuredClone(current);
  legacy.schemaVersion = 2;
  delete legacy.notes["legacy-note"].richBody;

  assert.equal(isPersistedStateShape(legacy), true);
  const migrated = normalizeState(legacy, now);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.notes["legacy-note"].body, "## 标题\n\n正文");
  assert.equal(migrated.notes["legacy-note"].richBody, null);
});

test("rich note mutations derive clean Markdown and searchable plain text", () => {
  const now = new Date(2026, 6, 19, 14, 0, 0);
  let state = applyOperation(createInitialState(now), {
    type: "note:add",
    title: "格式测试",
    richBody: emptyRichBody(),
  }, now, { randomUUID: () => "rich-note" });
  state = applyOperation(state, {
    type: "note:update",
    id: "rich-note",
    richBody: formattedDocument,
  }, now);

  assert.deepEqual(state.notes["rich-note"].richBody, formattedDocument);
  assert.equal(state.notes["rich-note"].body, "## **研究设计**\n\n- [x] 核对变量");
  assert.deepEqual(searchState(state, "核对变量").notes.map((note) => note.id), ["rich-note"]);
  assert.throws(() => applyOperation(state, {
    type: "note:update",
    id: "rich-note",
    richBody: { type: "doc", content: [{ type: "script" }] },
  }, now), /笔记格式数据无效/);
  assert.throws(() => applyOperation(state, {
    type: "note:add",
    richBody: { type: "doc", content: [{ type: "script" }] },
  }, now), /笔记格式数据无效/);
});
