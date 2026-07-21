const test = require("node:test");
const assert = require("node:assert/strict");
const {
  emptyRichBody,
  isRichBody,
  markdownFromRichBody,
  migrateMathInRichBody,
  plainTextFromRichBody,
  stepNoteSize,
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

test("Word-style font stepping follows the supported size scale and block defaults", () => {
  assert.equal(stepNoteSize("", "increase", "paragraph"), "16");
  assert.equal(stepNoteSize("", "decrease", "paragraph"), "12");
  assert.equal(stepNoteSize("16", "increase", "paragraph"), "20");
  assert.equal(stepNoteSize("16", "decrease", "paragraph"), "14");
  assert.equal(stepNoteSize("", "decrease", "heading-1"), "20");
  assert.equal(stepNoteSize("", "increase", "heading-2"), "24");
  assert.equal(stepNoteSize("24", "increase", "paragraph"), null);
  assert.equal(stepNoteSize("12", "decrease", "paragraph"), null);
});

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

test("paragraph line spacing is strictly validated and stays out of Markdown", () => {
  const spaced = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2, lineHeight: "1.5" }, content: [{ type: "text", text: "标题" }] },
      { type: "paragraph", attrs: { lineHeight: "2" }, content: [{ type: "text", text: "正文" }] },
    ],
  };
  assert.equal(isRichBody(spaced), true);
  assert.equal(markdownFromRichBody(spaced), "## 标题\n\n正文");
  assert.equal(isRichBody({
    type: "doc",
    content: [{ type: "paragraph", attrs: { lineHeight: "9" }, content: [{ type: "text", text: "坏数据" }] }],
  }), false);
  assert.equal(isRichBody({
    type: "doc",
    content: [{ type: "codeBlock", attrs: { language: null, lineHeight: "2" }, content: [{ type: "text", text: "code" }] }],
  }), false);
});

test("Tiptap inline leaf nodes keep supported formatting across hard breaks", () => {
  const textStyle = { type: "textStyle", attrs: { fontFamily: "KaiTi", fontSize: null } };
  assert.equal(isRichBody({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "第一行", marks: [textStyle] },
        { type: "hardBreak", marks: [textStyle] },
        { type: "text", text: "第二行", marks: [textStyle] },
        { type: "inlineMath", attrs: { latex: "x^2" }, marks: [{ type: "bold" }] },
      ],
    }],
  }), true);
  assert.equal(isRichBody({
    type: "doc",
    marks: [{ type: "bold" }],
    content: [{ type: "paragraph" }],
  }), false);
});

test("Tiptap link attributes accept title without weakening URL validation", () => {
  const linkedText = (attrs) => ({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: "链接", marks: [{ type: "link", attrs }] }],
    }],
  });
  assert.equal(isRichBody(linkedText({
    href: "https://example.com/research",
    target: "_blank",
    rel: "noopener noreferrer nofollow",
    class: null,
    title: null,
  })), true);
  assert.equal(isRichBody(linkedText({ href: "javascript:alert(1)", title: null })), false);
  assert.equal(isRichBody(linkedText({ href: "https://example.com", download: true })), false);
});

test("clean Markdown export keeps semantics and drops visual-only font metadata", () => {
  const markdown = markdownFromRichBody(formattedDocument);
  assert.equal(markdown, "## **研究设计**\n\n- [x] 核对变量");
  assert.doesNotMatch(markdown, /font|span|Times New Roman|20px|<u>/i);
  assert.equal(plainTextFromRichBody(formattedDocument), "研究设计\n核对变量");
});

test("math nodes validate, remain searchable, and export as portable Markdown", () => {
  const document = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "行内 " },
          { type: "inlineMath", attrs: { latex: "x^2" } },
        ],
      },
      { type: "blockMath", attrs: { latex: "y=\\begin{cases}1&\\text{是}\\\\0&\\text{否}\\end{cases}" } },
    ],
  };
  assert.equal(isRichBody(document), true);
  assert.equal(markdownFromRichBody(document), "行内 $x^2$\n\n$$\ny=\\begin{cases}1&\\text{是}\\\\0&\\text{否}\\end{cases}\n$$");
  assert.match(plainTextFromRichBody(document), /begin\{cases\}/);
  assert.equal(isRichBody({ type: "doc", content: [{ type: "blockMath", attrs: { latex: "" } }] }), false);
  assert.equal(isRichBody({ type: "doc", content: [{ type: "inlineMath", attrs: { latex: "x", onclick: "bad" } }] }), false);
});

test("existing rich text migrates standard delimiters and only strong legacy bracket formulas", () => {
  const legacy = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "结果为 $x^2$，金额 $100$ 不转换。" }] },
      { type: "paragraph", content: [{ type: "text", text: "\\[y=\\begin{cases}1 & \\text{是}\\\\0 & \\text{否}\\end{cases}\\]" }] },
      { type: "paragraph", content: [{ type: "text", text: "[普通括号]" }] },
      {
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "$$列表中的原文$$" }] }],
        }],
      },
      { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "$code$" }] },
    ],
  };
  const migrated = migrateMathInRichBody(legacy);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.richBody.content[0].content[1].type, "inlineMath");
  assert.equal(
    migrated.richBody.content[0].content.filter((node) => node.type === "text").map((node) => node.text).join(""),
    "结果为 ，金额 $100$ 不转换。",
  );
  assert.equal(migrated.richBody.content[1].type, "blockMath");
  assert.equal(migrated.richBody.content[2].content[0].text, "[普通括号]");
  assert.equal(migrated.richBody.content[3].content[0].content[0].content[0].text, "$$列表中的原文$$");
  assert.equal(migrated.richBody.content[4].content[0].text, "$code$");
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
