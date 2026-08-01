import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import {
  captureFormatPainterSnapshot,
  createFormatPainterLayoutTransaction,
  createFormatPainterTextTransaction,
  formatPainterTargetRange,
} from "../src/notes/format-painter.js";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: {
        lineHeight: { default: null },
        textAlign: { default: null },
        firstLineIndent: { default: null },
      },
    },
    heading: {
      content: "inline*",
      group: "block",
      attrs: {
        level: { default: 1 },
        lineHeight: { default: null },
        textAlign: { default: null },
        firstLineIndent: { default: null },
      },
    },
    codeBlock: { content: "text*", group: "block", marks: "" },
    blockquote: { content: "block+", group: "block" },
    bulletList: { content: "listItem+", group: "block" },
    orderedList: { content: "listItem+", group: "block" },
    taskList: { content: "listItem+", group: "block" },
    listItem: { content: "paragraph block*" },
    text: { group: "inline" },
  },
  marks: {
    bold: {},
    italic: {},
    underline: {},
    strike: {},
    code: { excludes: "_" },
    textStyle: {
      attrs: {
        fontFamily: { default: null },
        fontSize: { default: null },
      },
    },
    link: {
      attrs: { href: { default: null } },
      inclusive: false,
    },
  },
});

function stateWithSelection(doc, from, to = from) {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

function textSegments(doc) {
  const segments = [];
  doc.descendants((node) => {
    if (!node.isText) return;
    segments.push({
      text: node.text,
      marks: Object.fromEntries(node.marks.map((mark) => [mark.type.name, mark.attrs])),
    });
  });
  return segments;
}

test("format painter separates character and paragraph capture like Word", () => {
  const textStyle = schema.marks.textStyle.create({ fontFamily: "Times New Roman", fontSize: "20px" });
  const paragraph = schema.nodes.paragraph.create(
    { lineHeight: "2", textAlign: "center", firstLineIndent: true },
    schema.text("Alpha beta", [schema.marks.bold.create(), schema.marks.link.create({ href: "https://example.com" }), textStyle]),
  );
  const doc = schema.nodes.doc.create(null, paragraph);

  const partial = captureFormatPainterSnapshot(stateWithSelection(doc, 1, 6));
  assert.equal(partial.kind, "character");
  assert.equal(partial.paragraph, null);
  assert.equal(partial.marks.bold, true);
  assert.equal(partial.marks.fontFamily, "Times New Roman");
  assert.equal(Object.hasOwn(partial.marks, "link"), false);

  const full = captureFormatPainterSnapshot(stateWithSelection(doc, 1, paragraph.content.size + 1));
  assert.equal(full.kind, "paragraph");
  assert.deepEqual(full.paragraph, {
    block: "paragraph",
    lineHeight: "2",
    textAlign: "center",
    firstLineIndent: true,
  });

  const caret = captureFormatPainterSnapshot(stateWithSelection(doc, 3));
  assert.equal(caret.kind, "paragraph");
});

test("mixed source capture follows the first character while retaining Word's western font slot", () => {
  const simHei = schema.marks.textStyle.create({ fontFamily: "SimHei" });
  const times = schema.marks.textStyle.create({ fontFamily: "Times New Roman" });
  const simHeiDoc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [
    schema.text("中"),
    schema.text("文", [simHei]),
  ]));
  const simHeiSnapshot = captureFormatPainterSnapshot(stateWithSelection(simHeiDoc, 1, 3));
  assert.equal(simHeiSnapshot.marks.fontFamily, "");

  const timesDoc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [
    schema.text("中"),
    schema.text("A", [times]),
  ]));
  const timesSnapshot = captureFormatPainterSnapshot(stateWithSelection(timesDoc, 1, 3));
  assert.equal(timesSnapshot.marks.fontFamily, "Times New Roman");
});

test("format painter preserves links and applies Times New Roman only to western text", () => {
  const link = schema.marks.link.create({ href: "https://example.com" });
  const oldStyle = schema.marks.textStyle.create({ fontFamily: "SimHei", fontSize: "14px" });
  const paragraph = schema.nodes.paragraph.create(null, schema.text("中文 A1", [link, schema.marks.italic.create(), oldStyle]));
  const doc = schema.nodes.doc.create(null, paragraph);
  const state = stateWithSelection(doc, 1, paragraph.content.size + 1);
  const snapshot = {
    kind: "character",
    marks: {
      bold: true,
      italic: false,
      underline: false,
      strike: false,
      code: false,
      fontFamily: "Times New Roman",
      fontSize: "20px",
    },
    paragraph: null,
  };

  const transaction = createFormatPainterTextTransaction(state, snapshot, {
    from: state.selection.from,
    to: state.selection.to,
  });
  const next = state.apply(transaction);
  const segments = textSegments(next.doc);
  assert.deepEqual(segments.map(({ text }) => text), ["中文", " A1"]);
  for (const segment of segments) {
    assert.equal(segment.marks.link.href, "https://example.com");
    assert.ok(segment.marks.bold);
    assert.equal(segment.marks.italic, undefined);
    assert.equal(segment.marks.textStyle.fontSize, "20px");
  }
  assert.equal(segments[0].marks.textStyle.fontFamily, null);
  assert.equal(segments[1].marks.textStyle.fontFamily, "Times New Roman");
});

test("inline code formatting never removes a target hyperlink", () => {
  const link = schema.marks.link.create({ href: "https://example.com" });
  const paragraph = schema.nodes.paragraph.create(null, schema.text("linked", [link, schema.marks.bold.create()]));
  const doc = schema.nodes.doc.create(null, paragraph);
  const state = stateWithSelection(doc, 1, paragraph.content.size + 1);
  const transaction = createFormatPainterTextTransaction(state, {
    kind: "character",
    marks: { bold: false, italic: false, underline: false, strike: false, code: true, fontFamily: "", fontSize: "" },
  }, { from: state.selection.from, to: state.selection.to });
  const [segment] = textSegments(state.apply(transaction).doc);
  assert.equal(segment.marks.link.href, "https://example.com");
  assert.equal(segment.marks.code, undefined);
});

test("paragraph painter supports click targets and copies layout attributes", () => {
  const paragraph = schema.nodes.paragraph.create(
    { lineHeight: null, textAlign: "right", firstLineIndent: null },
    schema.text("Target paragraph"),
  );
  const doc = schema.nodes.doc.create(null, paragraph);
  const state = stateWithSelection(doc, 4);
  const snapshot = {
    kind: "paragraph",
    marks: { bold: false, italic: false, underline: false, strike: false, code: false, fontFamily: "", fontSize: "" },
    paragraph: { block: "paragraph", lineHeight: "1.5", textAlign: "center", firstLineIndent: true },
  };
  assert.deepEqual(formatPainterTargetRange(state, snapshot), {
    from: 1,
    to: paragraph.content.size + 1,
  });
  const selected = state.apply(state.tr.setSelection(TextSelection.create(
    doc,
    1,
    paragraph.content.size + 1,
  )));
  const transaction = createFormatPainterLayoutTransaction(selected, snapshot);
  const updated = selected.apply(transaction).doc.firstChild;
  assert.equal(updated.attrs.lineHeight, "1.5");
  assert.equal(updated.attrs.textAlign, "center");
  assert.equal(updated.attrs.firstLineIndent, true);
});
