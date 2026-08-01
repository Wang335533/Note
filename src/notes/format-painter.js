import { TextSelection } from "@tiptap/pm/state";
import richTextModule from "desktop-note/rich-text";

const { isWesternFontCharacter } = richTextModule;

const TEXT_BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const CONTROLLED_MARK_TYPES = Object.freeze([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "textStyle",
]);
const LIST_BLOCKS = Object.freeze([
  ["taskList", "checklist"],
  ["bulletList", "bullet"],
  ["orderedList", "numbered"],
]);

function selectedTextBlocks(state) {
  const blocks = [];
  const { from, to, empty } = state.selection;
  state.doc.descendants((node, position, parent) => {
    if (!TEXT_BLOCK_TYPES.has(node.type.name)) return true;
    const start = position + 1;
    const end = position + node.nodeSize - 1;
    const selected = empty
      ? from >= start && from <= end
      : from < end && to > start;
    if (selected || (empty && start === end && from === start)) {
      blocks.push({ node, position, parent, start, end });
    }
    return false;
  });
  return blocks;
}

function marksAtSource(state) {
  const { selection } = state;
  if (selection.empty) return state.storedMarks || selection.$from.marks();
  let marks = null;
  state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (marks || !node.isText) return;
    const overlapFrom = Math.max(selection.from, position);
    const overlapTo = Math.min(selection.to, position + node.nodeSize);
    if (overlapFrom < overlapTo) marks = node.marks;
  });
  return marks || selection.$from.marks();
}

function selectedTimesNewRomanSlot(state) {
  const { from, to, empty } = state.selection;
  if (empty) return "";
  let fontFamily = "";
  state.doc.nodesBetween(from, to, (node, position) => {
    if (fontFamily || !node.isText) return;
    const overlapFrom = Math.max(from, position);
    const overlapTo = Math.min(to, position + node.nodeSize);
    if (overlapFrom >= overlapTo) return;
    const candidate = node.marks.find((mark) => mark.type.name === "textStyle")?.attrs?.fontFamily || "";
    if (candidate === "Times New Roman") fontFamily = candidate;
  });
  return fontFamily;
}

function controlledMarksFrom(state) {
  const sourceMarks = marksAtSource(state);
  const byName = new Map(sourceMarks.map((mark) => [mark.type.name, mark]));
  const textStyle = byName.get("textStyle")?.attrs || {};
  return {
    bold: byName.has("bold"),
    italic: byName.has("italic"),
    underline: byName.has("underline"),
    strike: byName.has("strike"),
    code: byName.has("code"),
    fontFamily: textStyle.fontFamily || selectedTimesNewRomanSlot(state),
    fontSize: textStyle.fontSize || "",
  };
}

function blockTypeAt(state, block) {
  if (block.node.type.name === "codeBlock") return "code-block";
  const $position = state.doc.resolve(Math.min(block.start, state.doc.content.size));
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const name = $position.node(depth).type.name;
    if (name === "blockquote") return "quote";
    const list = LIST_BLOCKS.find(([nodeName]) => nodeName === name);
    if (list) return list[1];
  }
  if (block.node.type.name === "heading") return `heading-${block.node.attrs.level || 1}`;
  return "paragraph";
}

function selectionCoversWholeBlocks(state, blocks) {
  if (state.selection.empty) return true;
  if (!blocks.length) return false;
  const { from, to } = state.selection;
  return blocks.every(({ start, end }) => from <= start && to >= end);
}

export function captureFormatPainterSnapshot(state) {
  if (!state?.selection || state.selection.node?.isTextblock === false) return null;
  const blocks = selectedTextBlocks(state);
  if (!blocks.length) return null;
  const paragraphMode = selectionCoversWholeBlocks(state, blocks);
  const firstBlock = blocks[0];
  return {
    kind: paragraphMode ? "paragraph" : "character",
    marks: controlledMarksFrom(state),
    paragraph: paragraphMode ? {
      block: blockTypeAt(state, firstBlock),
      lineHeight: firstBlock.node.attrs.lineHeight || "",
      textAlign: firstBlock.node.attrs.textAlign || "left",
      firstLineIndent: firstBlock.node.attrs.firstLineIndent === true,
    } : null,
  };
}

export function formatPainterTargetRange(state, snapshot) {
  const { selection } = state;
  if (!selection.empty) return { from: selection.from, to: selection.to };
  if (snapshot?.kind !== "paragraph") return null;
  const [block] = selectedTextBlocks(state);
  return block ? { from: block.start, to: block.end } : null;
}

export function selectFormatPainterTarget(state, range) {
  if (!range || (state.selection.from === range.from && state.selection.to === range.to)) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to));
}

function addMarkIfAvailable(transaction, schema, name, from, to, attributes = undefined) {
  const type = schema.marks[name];
  if (!type || from >= to) return;
  transaction.addMark(from, to, type.create(attributes));
}

function selectedTextRuns(state, range, visitor) {
  state.doc.nodesBetween(range.from, range.to, (node, position) => {
    if (!node.isText || !node.text) return;
    const from = Math.max(range.from, position);
    const to = Math.min(range.to, position + node.nodeSize);
    if (from < to) visitor(node, position, from, to);
  });
}

function addTextStyle(transaction, state, range, marks) {
  const type = state.schema.marks.textStyle;
  if (!type || marks.code || (!marks.fontFamily && !marks.fontSize)) return;
  selectedTextRuns(state, range, (node, position, from, to) => {
    const text = node.text.slice(from - position, to - position);
    if (marks.fontFamily !== "Times New Roman") {
      transaction.addMark(from, to, type.create({
        fontFamily: marks.fontFamily || null,
        fontSize: marks.fontSize || null,
      }));
      return;
    }
    let offset = 0;
    while (offset < text.length) {
      const character = String.fromCodePoint(text.codePointAt(offset));
      const western = isWesternFontCharacter(character);
      let runEnd = offset + character.length;
      while (runEnd < text.length) {
        const nextCharacter = String.fromCodePoint(text.codePointAt(runEnd));
        if (isWesternFontCharacter(nextCharacter) !== western) break;
        runEnd += nextCharacter.length;
      }
      const attributes = {
        fontFamily: western ? marks.fontFamily : null,
        fontSize: marks.fontSize || null,
      };
      if (attributes.fontFamily || attributes.fontSize) {
        transaction.addMark(from + offset, from + runEnd, type.create(attributes));
      }
      offset = runEnd;
    }
  });
}

export function createFormatPainterTextTransaction(state, snapshot, range) {
  if (!state || !snapshot?.marks || !range || range.from >= range.to) return null;
  const transaction = state.tr;
  for (const name of CONTROLLED_MARK_TYPES) {
    const type = state.schema.marks[name];
    if (type) transaction.removeMark(range.from, range.to, type);
  }

  const { marks } = snapshot;
  if (marks.code) {
    selectedTextRuns(state, range, (node, _position, from, to) => {
      if (!node.marks.some((mark) => mark.type.name === "link")) {
        addMarkIfAvailable(transaction, state.schema, "code", from, to);
      }
    });
  } else {
    for (const name of ["bold", "italic", "underline", "strike"]) {
      if (marks[name]) addMarkIfAvailable(transaction, state.schema, name, range.from, range.to);
    }
    addTextStyle(transaction, state, range, marks);
  }
  return transaction.steps.length ? transaction : null;
}

export function createFormatPainterLayoutTransaction(state, snapshot) {
  if (!state || snapshot?.kind !== "paragraph" || !snapshot.paragraph) return null;
  const blocks = selectedTextBlocks(state);
  if (!blocks.length) return null;
  const transaction = state.tr;
  for (const { node, position, parent } of blocks) {
    if (!['paragraph', 'heading'].includes(node.type.name)) continue;
    const attributes = { ...node.attrs };
    if (Object.hasOwn(attributes, "lineHeight")) {
      attributes.lineHeight = snapshot.paragraph.lineHeight || null;
    }
    if (Object.hasOwn(attributes, "textAlign")) {
      attributes.textAlign = snapshot.paragraph.textAlign === "left"
        ? null
        : snapshot.paragraph.textAlign;
    }
    if (Object.hasOwn(attributes, "firstLineIndent") && node.type.name === "paragraph" && parent?.type?.name === "doc") {
      attributes.firstLineIndent = snapshot.paragraph.firstLineIndent ? true : null;
    }
    if (JSON.stringify(attributes) !== JSON.stringify(node.attrs)) {
      transaction.setNodeMarkup(position, undefined, attributes);
    }
  }
  return transaction.steps.length ? transaction : null;
}

export function formatPainterSelectionIsInTable(state) {
  const positions = [state?.selection?.$from, state?.selection?.$to].filter(Boolean);
  return positions.some(($position) => {
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      if ($position.node(depth).type.name === "table") return true;
    }
    return false;
  });
}

export function formatPainterSelectionHasLink(state) {
  if (!state?.selection) return false;
  const { from, to, empty, $from } = state.selection;
  if (empty) return $from.marks().some((mark) => mark.type.name === "link");
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!found && node.isText) found = node.marks.some((mark) => mark.type.name === "link");
  });
  return found;
}
