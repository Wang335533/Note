import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import richTextModule from "desktop-note/rich-text";

const { isWesternFontCharacter } = richTextModule;
const TIMES_NEW_ROMAN = "Times New Roman";
const STRONG_WESTERN_CHARACTER = /[\p{Letter}\p{Number}]/u;
const fontIntentKey = new PluginKey("noteFontIntent");

function textStyleAttributes(marks, markType) {
  return marks.find((mark) => mark.type === markType)?.attrs || {};
}

function hasTextStyleAttributes(attributes) {
  return Object.values(attributes).some((value) => value !== null && value !== undefined && value !== "");
}

function marksWithFontFamily(marks, markType, fontFamily) {
  const attributes = {
    ...textStyleAttributes(marks, markType),
    fontFamily: fontFamily || null,
  };
  let next = marks.filter((mark) => mark.type !== markType);
  if (hasTextStyleAttributes(attributes)) next = markType.create(attributes).addToSet(next);
  return next;
}

function replaceTextStyleFont(transaction, markType, from, to, currentAttributes, fontFamily) {
  const currentFont = currentAttributes.fontFamily || null;
  const nextFont = fontFamily || null;
  if (currentFont === nextFont) return false;
  const nextAttributes = { ...currentAttributes, fontFamily: nextFont };
  transaction.removeMark(from, to, markType);
  if (hasTextStyleAttributes(nextAttributes)) {
    transaction.addMark(from, to, markType.create(nextAttributes));
  }
  return true;
}

function firstEastAsianFontFamily(state) {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const fontFamily = textStyleAttributes(state.storedMarks || $from.marks(), state.schema.marks.textStyle).fontFamily;
    return fontFamily && fontFamily !== TIMES_NEW_ROMAN ? fontFamily : "";
  }

  let first = "";
  state.doc.nodesBetween(from, to, (node, position) => {
    if (first || !node.isText || !node.text) return;
    const selectedFrom = Math.max(from, position);
    const selectedTo = Math.min(to, position + node.nodeSize);
    if (selectedFrom >= selectedTo) return;
    const selectedText = node.text.slice(selectedFrom - position, selectedTo - position);
    if (![...selectedText].some((character) => !isWesternFontCharacter(character))) return;
    const fontFamily = textStyleAttributes(node.marks, state.schema.marks.textStyle).fontFamily;
    if (fontFamily && fontFamily !== TIMES_NEW_ROMAN) first = fontFamily;
  });
  return first;
}

function fontIntent(state, fontFamily) {
  return {
    fontFamily,
    eastAsianFontFamily: fontFamily === TIMES_NEW_ROMAN ? firstEastAsianFontFamily(state) : "",
  };
}

function applyFontToRange(transaction, from, to, intent) {
  const markType = transaction.doc.type.schema.marks.textStyle;
  if (!markType || from >= to) return false;
  let changed = false;

  transaction.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText || !node.text) return;
    const selectedFrom = Math.max(from, position);
    const selectedTo = Math.min(to, position + node.nodeSize);
    if (selectedFrom >= selectedTo) return;
    const currentAttributes = textStyleAttributes(node.marks, markType);

    if (intent.fontFamily !== TIMES_NEW_ROMAN) {
      changed = replaceTextStyleFont(
        transaction,
        markType,
        selectedFrom,
        selectedTo,
        currentAttributes,
        intent.fontFamily,
      ) || changed;
      return;
    }

    const selectedText = node.text.slice(selectedFrom - position, selectedTo - position);
    let offset = 0;
    while (offset < selectedText.length) {
      const character = String.fromCodePoint(selectedText.codePointAt(offset));
      const western = isWesternFontCharacter(character);
      let runEnd = offset + character.length;
      while (runEnd < selectedText.length) {
        const nextCharacter = String.fromCodePoint(selectedText.codePointAt(runEnd));
        if (isWesternFontCharacter(nextCharacter) !== western) break;
        runEnd += nextCharacter.length;
      }

      const nextFont = western
        ? TIMES_NEW_ROMAN
        : currentAttributes.fontFamily === TIMES_NEW_ROMAN || !currentAttributes.fontFamily
          ? intent.eastAsianFontFamily || null
          : currentAttributes.fontFamily;
      changed = replaceTextStyleFont(
        transaction,
        markType,
        selectedFrom + offset,
        selectedFrom + runEnd,
        currentAttributes,
        nextFont,
      ) || changed;
      offset = runEnd;
    }
  });
  return changed;
}

export function createFontFamilySelectionTransaction(state, fontFamily) {
  if (!state || state.selection.empty || !fontFamily) return null;
  const intent = fontIntent(state, fontFamily);
  const transaction = state.tr.setMeta(fontIntentKey, intent);
  applyFontToRange(transaction, state.selection.from, state.selection.to, intent);
  return transaction;
}

export function applyFontIntentToInsertedText(transaction, from, text, intent) {
  if (!transaction || !intent?.fontFamily || !text) return transaction;
  const to = Math.min(transaction.doc.content.size, from + text.length);
  applyFontToRange(transaction, from, to, intent);

  const markType = transaction.doc.type.schema.marks.textStyle;
  if (markType && to <= transaction.doc.content.size) {
    const marks = transaction.doc.resolve(to).marks();
    transaction.setStoredMarks(marksWithFontFamily(marks, markType, intent.fontFamily));
  }
  transaction.setMeta(fontIntentKey, intent);
  return transaction;
}

export function setFontFamilyForEditor(editor, fontFamily) {
  if (!editor || editor.isDestroyed) return false;
  const family = String(fontFamily || "").trim();
  if (!family) {
    return editor.chain()
      .focus()
      .unsetFontFamily()
      .removeEmptyTextStyle()
      .setMeta(fontIntentKey, null)
      .run();
  }

  editor.commands.focus();
  const { state } = editor;
  const intent = fontIntent(state, family);
  if (state.selection.empty || family !== TIMES_NEW_ROMAN) {
    return editor.chain()
      .setFontFamily(family)
      .setMeta(fontIntentKey, intent)
      .run();
  }

  const transaction = createFontFamilySelectionTransaction(state, family);
  if (!transaction) return false;
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

export function clearFontIntentForEditor(editor) {
  if (!editor || editor.isDestroyed) return false;
  editor.view.dispatch(editor.state.tr.setMeta(fontIntentKey, null));
  return true;
}

export function fontIntentForEditor(editor) {
  if (!editor || editor.isDestroyed) return null;
  return fontIntentKey.getState(editor.state) || null;
}

export function selectedTextStyleState(state, intent = null) {
  if (!state) return {
    fontFamily: "",
    fontMixed: false,
    fontSize: "",
    sizeMixed: false,
  };
  const markType = state.schema.marks.textStyle;
  const { from, to, empty, $from } = state.selection;
  if (!markType) return {
    fontFamily: "",
    fontMixed: false,
    fontSize: "",
    sizeMixed: false,
  };

  if (empty) {
    const attributes = textStyleAttributes(state.storedMarks || $from.marks(), markType);
    return {
      fontFamily: intent?.fontFamily || attributes.fontFamily || "",
      fontMixed: false,
      fontSize: attributes.fontSize || "",
      sizeMixed: false,
    };
  }

  const westernFonts = new Set();
  const neutralWesternFonts = new Set();
  const eastAsianFonts = new Set();
  const sizes = new Set();
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText || !node.text) return;
    const selectedFrom = Math.max(from, position);
    const selectedTo = Math.min(to, position + node.nodeSize);
    if (selectedFrom >= selectedTo) return;
    const attributes = textStyleAttributes(node.marks, markType);
    const family = attributes.fontFamily || "";
    sizes.add(attributes.fontSize || "");
    for (const character of node.text.slice(selectedFrom - position, selectedTo - position)) {
      if (!isWesternFontCharacter(character)) {
        eastAsianFonts.add(family === TIMES_NEW_ROMAN ? "" : family);
      } else if (STRONG_WESTERN_CHARACTER.test(character)) {
        westernFonts.add(family);
      } else {
        neutralWesternFonts.add(family);
      }
    }
  });

  const fonts = westernFonts.size
    ? westernFonts
    : eastAsianFonts.size
      ? eastAsianFonts
      : neutralWesternFonts;
  return {
    fontFamily: fonts.size === 1 ? [...fonts][0] : "",
    fontMixed: fonts.size > 1,
    fontSize: sizes.size === 1 ? [...sizes][0] : "",
    sizeMixed: sizes.size > 1,
  };
}

export const NoteFontIntent = Extension.create({
  name: "noteFontIntent",
  priority: 50,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: fontIntentKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const explicit = transaction.getMeta(fontIntentKey);
          if (explicit !== undefined) return explicit;
          if (["cut", "drop", "paste"].includes(transaction.getMeta("uiEvent"))) return null;
          if (transaction.selectionSet && !transaction.docChanged) return null;
          return current;
        },
      },
      props: {
        handleTextInput(view, from, to, text, defaultTransaction) {
          const intent = fontIntentKey.getState(view.state);
          if (!intent?.fontFamily || !text) return false;
          const transaction = typeof defaultTransaction === "function"
            ? defaultTransaction()
            : view.state.tr.insertText(text, from, to).scrollIntoView();
          applyFontIntentToInsertedText(transaction, from, text, intent);
          view.dispatch(transaction);
          return true;
        },
      },
    })];
  },
});
