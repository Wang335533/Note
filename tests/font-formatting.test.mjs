import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import {
  applyFontIntentToInsertedText,
  createFontFamilySelectionTransaction,
  selectedTextStyleState,
} from "../src/notes/font-formatting.js";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
  marks: {
    bold: {},
    textStyle: {
      attrs: {
        fontFamily: { default: null },
        fontSize: { default: null },
      },
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
    const textStyle = node.marks.find((mark) => mark.type === schema.marks.textStyle)?.attrs || {};
    segments.push({ text: node.text, fontFamily: textStyle.fontFamily || "", fontSize: textStyle.fontSize || "" });
  });
  return segments;
}

test("Times New Roman normalizes every selected western run without changing East Asian text", () => {
  const kaiTi = schema.marks.textStyle.create({ fontFamily: "KaiTi", fontSize: "16px" });
  const simHei = schema.marks.textStyle.create({ fontFamily: "SimHei", fontSize: "16px" });
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("中文", [kaiTi]),
    schema.text(" Alpha 123", [simHei]),
  ]);
  const doc = schema.nodes.doc.create(null, paragraph);
  const state = stateWithSelection(doc, 1, paragraph.content.size + 1);

  const transaction = createFontFamilySelectionTransaction(state, "Times New Roman");
  const segments = textSegments(state.apply(transaction).doc);
  assert.deepEqual(segments.map(({ text }) => text), ["中文", " Alpha 123"]);
  assert.equal(segments[0].fontFamily, "KaiTi");
  assert.equal(segments[1].fontFamily, "Times New Roman");
  assert.ok(segments.every(({ fontSize }) => fontSize === "16px"));
});

test("font intent formats replacement and continued mixed-script input like Word font slots", () => {
  const paragraph = schema.nodes.paragraph.create(null, schema.text("旧内容"));
  const doc = schema.nodes.doc.create(null, paragraph);
  const state = stateWithSelection(doc, 1, paragraph.content.size + 1);
  const text = "新内容 Alpha 456";
  const transaction = state.tr.insertText(text, state.selection.from, state.selection.to);

  applyFontIntentToInsertedText(transaction, 1, text, {
    fontFamily: "Times New Roman",
    eastAsianFontFamily: "KaiTi",
  });
  const next = state.apply(transaction);
  const segments = textSegments(next.doc);
  assert.deepEqual(segments.map(({ text: value }) => value), ["新内容", " Alpha 456"]);
  assert.equal(segments[0].fontFamily, "KaiTi");
  assert.equal(segments[1].fontFamily, "Times New Roman");
  assert.equal(next.storedMarks.find((mark) => mark.type === schema.marks.textStyle)?.attrs.fontFamily, "Times New Roman");
});

test("mixed western fonts are explicit until one command normalizes the selection", () => {
  const times = schema.marks.textStyle.create({ fontFamily: "Times New Roman" });
  const simHei = schema.marks.textStyle.create({ fontFamily: "SimHei" });
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("中文"),
    schema.text(" Alpha", [times]),
    schema.text(" Beta", [simHei]),
  ]);
  const doc = schema.nodes.doc.create(null, paragraph);
  const state = stateWithSelection(doc, 1, paragraph.content.size + 1);

  assert.deepEqual(selectedTextStyleState(state), {
    fontFamily: "",
    fontMixed: true,
    fontSize: "",
    sizeMixed: false,
  });

  const normalized = state.apply(createFontFamilySelectionTransaction(state, "Times New Roman"));
  assert.deepEqual(selectedTextStyleState(normalized), {
    fontFamily: "Times New Roman",
    fontMixed: false,
    fontSize: "",
    sizeMixed: false,
  });
});
