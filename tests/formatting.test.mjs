import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBlockFormat,
  applyFormatSnapshot,
  applyInlineFormat,
  captureFormatSnapshot,
  clearSelectedFormatting,
  formatStateAt,
  insertLink,
  normalizeLinkUrl,
} from "../src/notes/formatting.js";

test("inline formatting wraps the selection and toggles off without losing text", () => {
  const bold = applyInlineFormat("alpha beta", { from: 0, to: 5 }, "bold");
  assert.equal(bold.doc, "**alpha** beta");
  assert.deepEqual(bold.selection, { from: 2, to: 7 });
  assert.equal(formatStateAt(bold.doc, bold.selection).bold, true);

  const plain = applyInlineFormat(bold.doc, bold.selection, "bold");
  assert.equal(plain.doc, "alpha beta");
  assert.deepEqual(plain.selection, { from: 0, to: 5 });
});

test("an empty selection creates a pending typing range", () => {
  const result = applyInlineFormat("alpha", { from: 5, to: 5 }, "underline");
  assert.equal(result.doc, "alpha<u></u>");
  assert.deepEqual(result.selection, { from: 8, to: 8 });
});

test("font and size markers can nest while remaining independently detectable", () => {
  const font = applyInlineFormat("研究", { from: 0, to: 2 }, "font", "times-new-roman");
  const sized = applyInlineFormat(font.doc, font.selection, "size", "20");
  assert.equal(sized.doc, '<font data-note-font="times-new-roman"><span data-note-size="20">研究</span></font>');
  assert.deepEqual(formatStateAt(sized.doc, sized.selection), {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    font: "times-new-roman",
    size: "20",
    block: "paragraph",
    canClear: true,
  });
});

test("clear formatting only changes the selected formatted text", () => {
  const source = 'before <font data-note-font="simhei">**重点**</font> after';
  const from = source.indexOf("重点");
  const result = clearSelectedFormatting(source, { from, to: from + 2 });
  assert.equal(result.doc, "before 重点 after");
  assert.deepEqual(result.selection, { from: 7, to: 9 });
});

test("block formatting toggles bullets and preserves manual line order", () => {
  const listed = applyBlockFormat("one\ntwo", { from: 0, to: 7 }, "bullet");
  assert.equal(listed.doc, "- one\n- two");
  const plain = applyBlockFormat(listed.doc, listed.selection, "bullet");
  assert.equal(plain.doc, "one\ntwo");
});

test("format painter snapshot applies once-compatible inline and block styles", () => {
  const source = "## **Source**\n\nTarget";
  const sourceFrom = source.indexOf("Source");
  const snapshot = captureFormatSnapshot(source, { from: sourceFrom, to: sourceFrom + 6 });
  assert.equal(snapshot.bold, true);
  assert.equal(snapshot.block, "heading-2");
  const targetFrom = source.indexOf("Target");
  const result = applyFormatSnapshot(source, { from: targetFrom, to: targetFrom + 6 }, snapshot);
  assert.match(result.doc, /## \*\*Target\*\*$/);
});

test("links reject unsafe schemes and normalize ordinary domains", () => {
  assert.equal(normalizeLinkUrl("javascript:alert(1)"), "");
  assert.equal(normalizeLinkUrl("example.com/a b"), "https://example.com/a%20b");
  const result = insertLink("OpenAI", { from: 0, to: 6 }, "openai.com");
  assert.equal(result.doc, "[OpenAI](https://openai.com)");
});
