import { Extension, InputRule } from "@tiptap/core";
import { generateJSON } from "@tiptap/html";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import Image from "@tiptap/extension-image";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { marked } from "marked";
import "katex/dist/katex.min.css";
import richTextModule from "desktop-note/rich-text";
import { attachmentIdFromUrl } from "desktop-note/library-files";

const {
  emptyRichBody,
  isWesternFontCharacter,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  migrateMathInRichBody,
  normalizeRichBody,
  renderNoteFontFamily,
  stepNoteSize,
} = richTextModule;

export const FONT_OPTIONS = Object.freeze([
  { value: "", label: "默认", family: "" },
  { value: "songti", label: "宋体", family: "SimSun" },
  { value: "kaiti", label: "楷体", family: "KaiTi" },
  { value: "simhei", label: "黑体", family: "SimHei" },
  { value: "times-new-roman", label: "Times New Roman", family: "Times New Roman" },
  { value: "monospace", label: "等宽", family: "Cascadia Code" },
]);

export const SIZE_OPTIONS = Object.freeze([
  { value: "", label: "默认", size: "" },
  { value: "12", label: "12", size: "12px" },
  { value: "14", label: "14", size: "14px" },
  { value: "16", label: "16", size: "16px" },
  { value: "20", label: "20", size: "20px" },
  { value: "24", label: "24", size: "24px" },
]);

export const LINE_HEIGHT_OPTIONS = Object.freeze([
  { value: "", label: "默认 1.72" },
  { value: "1", label: "1.0" },
  { value: "1.15", label: "1.15" },
  { value: "1.5", label: "1.5" },
  { value: "2", label: "2.0" },
  { value: "2.5", label: "2.5" },
  { value: "3", label: "3.0" },
]);

export const BLOCK_OPTIONS = Object.freeze([
  { value: "paragraph", label: "正文" },
  { value: "heading-1", label: "标题 1" },
  { value: "heading-2", label: "标题 2" },
  { value: "heading-3", label: "标题 3" },
  { value: "quote", label: "引用" },
  { value: "code-block", label: "代码块" },
]);

const FONT_BY_VALUE = new Map(FONT_OPTIONS.map((option) => [option.value, option]));
const FONT_BY_FAMILY = new Map(FONT_OPTIONS.map((option) => [option.family.toLocaleLowerCase(), option]));
const SIZE_BY_VALUE = new Map(SIZE_OPTIONS.map((option) => [option.value, option]));
const SIZE_BY_SIZE = new Map(SIZE_OPTIONS.map((option) => [option.size, option]));
const LINE_HEIGHT_VALUES = new Set(LINE_HEIGHT_OPTIONS.map((option) => option.value).filter(Boolean));
const STYLE_TOKEN = /\uE000([FS])([+-])(?::([^\uE001]+))?\uE001/g;
const FORBIDDEN_RICH_HTML = "script, style, iframe, object, embed, form, meta, link, base";
const SAFE_HTML_ATTRIBUTES = Object.freeze({
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align"]),
  span: new Set(["data-type", "data-latex"]),
  div: new Set(["data-type", "data-latex"]),
  ul: new Set(["data-type"]),
  li: new Set(["data-type", "data-checked"]),
});

export function fontFamilyFor(value) {
  return FONT_BY_VALUE.get(value)?.family || "";
}

export function fontValueFor(family) {
  return FONT_BY_FAMILY.get(String(family || "").toLocaleLowerCase())?.value || "";
}

export function fontSizeFor(value) {
  return SIZE_BY_VALUE.get(value)?.size || "";
}

export function sizeValueFor(size) {
  return SIZE_BY_SIZE.get(String(size || ""))?.value || "";
}

export function nextFontSizeValue(value, direction, block = "paragraph") {
  return stepNoteSize(value, direction, block);
}

export function stepFontSizeForEditor(editor, direction) {
  if (!editor || editor.isDestroyed || editor.isActive("codeBlock")) return false;
  const state = formatStateForEditor(editor);
  const next = nextFontSizeValue(state.size, direction, state.block);
  if (!next) return false;
  return editor.chain().focus().setFontSize(fontSizeFor(next)).run();
}

const EscapeCancelsPainter = Extension.create({
  name: "noteEscapeCancelsPainter",
  addOptions() {
    return { cancelPainter: () => false };
  },
  addKeyboardShortcuts() {
    return { Escape: () => this.options.cancelPainter() };
  },
});

const NoteInlineMath = InlineMath.extend({
  addInputRules() {
    return [];
  },
});

const NoteBlockMath = BlockMath.extend({
  addInputRules() {
    return [];
  },
});

function setSelectedTextBlockLineHeight(state, dispatch, value) {
  const lineHeight = LINE_HEIGHT_VALUES.has(value) ? value : null;
  const textBlockTypes = new Set(["paragraph", "heading"]);
  const { from, to, empty, $from } = state.selection;
  let transaction = state.tr;
  let changed = false;
  const updateNode = (node, position) => {
    if (!textBlockTypes.has(node.type.name) || node.attrs.lineHeight === lineHeight) return;
    transaction = transaction.setNodeMarkup(position, undefined, { ...node.attrs, lineHeight });
    changed = true;
  };

  if (empty) {
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (!textBlockTypes.has(node.type.name)) continue;
      updateNode(node, $from.before(depth));
      break;
    }
  } else {
    state.doc.nodesBetween(from, to, (node, position) => updateNode(node, position));
  }
  if (changed && dispatch) dispatch(transaction);
  return changed;
}

const NoteParagraphLineHeight = Extension.create({
  name: "noteParagraphLineHeight",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (element) => {
            const value = String(element.style.lineHeight || "").trim();
            return LINE_HEIGHT_VALUES.has(value) ? value : null;
          },
          renderHTML: (attributes) => attributes.lineHeight
            ? { style: `line-height: ${attributes.lineHeight}` }
            : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      setParagraphLineHeight: (value) => ({ state, dispatch }) => setSelectedTextBlockLineHeight(state, dispatch, value),
      unsetParagraphLineHeight: () => ({ state, dispatch }) => setSelectedTextBlockLineHeight(state, dispatch, null),
    };
  },
});

const NoteFontSizeStep = Extension.create({
  name: "noteFontSizeStep",
  addKeyboardShortcuts() {
    return {
      "Mod-[": () => stepFontSizeForEditor(this.editor, "decrease"),
      "Mod-]": () => stepFontSizeForEditor(this.editor, "increase"),
    };
  },
});

const NoteFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return (this.parent?.() || []).map((group) => ({
      ...group,
      attributes: {
        ...group.attributes,
        fontFamily: {
          ...group.attributes.fontFamily,
          renderHTML: (attributes) => attributes.fontFamily
            ? { style: `font-family: ${renderNoteFontFamily(attributes.fontFamily)}` }
            : {},
        },
      },
    }));
  },
});

const NoteTableCell = TableCell.extend({
  content: "paragraph+",
});

const NoteTableHeader = TableHeader.extend({
  content: "paragraph+",
});

function selectedTableDimensions(editor) {
  const $from = editor?.state?.selection?.$from;
  if (!$from) return { rows: 0, columns: 0 };
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "table") continue;
    let columns = 0;
    node.forEach((row) => {
      let rowColumns = 0;
      row.forEach((cell) => {
        rowColumns += Math.max(1, Number(cell.attrs?.colspan) || 1);
      });
      columns = Math.max(columns, rowColumns);
    });
    return { rows: node.childCount, columns };
  }
  return { rows: 0, columns: 0 };
}

const NoteTable = Table.extend({
  addKeyboardShortcuts() {
    const inherited = this.parent?.() || {};
    return {
      ...inherited,
      Tab: () => {
        if (this.editor.commands.goToNextCell()) return true;
        if (selectedTableDimensions(this.editor).rows >= MAX_TABLE_ROWS) return true;
        if (!this.editor.can().addRowAfter()) return false;
        return this.editor.chain().addRowAfter().goToNextCell().run();
      },
    };
  },
});

function replaceTextStyleFont(transaction, markType, from, to, currentAttributes, fontFamily) {
  const currentFont = currentAttributes.fontFamily || null;
  const nextFont = fontFamily || null;
  if (currentFont === nextFont) return false;
  const nextAttributes = { ...currentAttributes, fontFamily: nextFont };
  transaction.removeMark(from, to, markType);
  if (Object.values(nextAttributes).some((value) => value !== null && value !== undefined && value !== "")) {
    transaction.addMark(from, to, markType.create(nextAttributes));
  }
  return true;
}

export function setFontFamilyForEditor(editor, fontFamily) {
  if (!editor || editor.isDestroyed || !fontFamily) return false;
  editor.commands.focus();
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty || fontFamily !== "Times New Roman") {
    return editor.chain().setFontFamily(fontFamily).run();
  }

  const markType = state.schema.marks.textStyle;
  if (!markType) return false;
  const transaction = state.tr;
  let changed = false;
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText || !node.text) return;
    const selectedFrom = Math.max(from, position);
    const selectedTo = Math.min(to, position + node.nodeSize);
    if (selectedFrom >= selectedTo) return;
    const selectedText = node.text.slice(selectedFrom - position, selectedTo - position);
    const textStyleMark = node.marks.find((mark) => mark.type === markType);
    const currentAttributes = textStyleMark?.attrs || {};
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
      const runFrom = selectedFrom + offset;
      const runTo = selectedFrom + runEnd;
      if (western) {
        changed = replaceTextStyleFont(
          transaction,
          markType,
          runFrom,
          runTo,
          currentAttributes,
          fontFamily,
        ) || changed;
      } else if (currentAttributes.fontFamily === "Times New Roman") {
        changed = replaceTextStyleFont(
          transaction,
          markType,
          runFrom,
          runTo,
          currentAttributes,
          null,
        ) || changed;
      }
      offset = runEnd;
    }
  });
  if (!changed) return false;
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

function replaceMathInput({ state, range, latex, type, trailingSpace = false }) {
  const value = String(latex || "").trim();
  if (!value || (type === "inlineMath" && /^\d+(?:[.,]\d+)?$/.test(value))) return;
  const nodeType = state.schema.nodes[type];
  if (!nodeType || state.selection.$from.parent.type.name === "codeBlock") return;
  const { tr } = state;
  if (type === "inlineMath") {
    const nodes = [nodeType.create({ latex: value })];
    if (trailingSpace) nodes.push(state.schema.text(" "));
    tr.replaceWith(range.from, range.to, Fragment.fromArray(nodes));
    return;
  }
  const $from = state.doc.resolve(range.from);
  const consumesHost = $from.depth > 0
    && $from.parent.isTextblock
    && range.from === $from.start()
    && range.to === $from.end();
  const canReplaceHost = consumesHost
    && $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), nodeType);
  const replacement = canReplaceHost ? { from: $from.before(), to: $from.after() } : range;
  tr.replaceWith(replacement.from, replacement.to, nodeType.create({ latex: value }));
}

function convertCurrentMathSource(editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;
  const source = $from.parent.textBetween(0, $from.parent.content.size, "\n", "\n");
  if (!/[\\$]/.test(source)) return false;
  const candidate = migrateMathInRichBody({
    type: "doc",
    content: [$from.parent.toJSON()],
  });
  if (!candidate.changed || !candidate.richBody?.content?.length) return false;
  const replacement = candidate.richBody.content.map((node) => editor.schema.nodeFromJSON(node));
  if (replacement.some((node) => node.type.name === "blockMath")
    && !$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), editor.schema.nodes.blockMath)) return false;
  const tail = editor.schema.nodes.paragraph.create();
  const from = $from.before();
  const to = $from.after();
  const tr = editor.state.tr.replaceWith(from, to, Fragment.fromArray([...replacement, tail]));
  const tailStart = from + replacement.reduce((sum, node) => sum + node.nodeSize, 0);
  tr.setSelection(TextSelection.near(tr.doc.resolve(tailStart + 1), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const NoteMathInput = Extension.create({
  name: "noteMathInput",
  addOptions() {
    return { openMathEditor: () => false };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([\s\S]+?)\$\$\s$/,
        handler: ({ state, range, match }) => replaceMathInput({ state, range, latex: match[1], type: "blockMath" }),
      }),
      new InputRule({
        find: /^\\\[([\s\S]+?)\\\]\s$/,
        handler: ({ state, range, match }) => replaceMathInput({ state, range, latex: match[1], type: "blockMath" }),
      }),
      new InputRule({
        find: /(?<![\\$])\$([^$\n]+?)(?<!\\)\$\s$/,
        handler: ({ state, range, match }) => replaceMathInput({ state, range, latex: match[1], type: "inlineMath", trailingSpace: true }),
      }),
      new InputRule({
        find: /\\\(([^\n]+?)\\\)\s$/,
        handler: ({ state, range, match }) => replaceMathInput({ state, range, latex: match[1], type: "inlineMath", trailingSpace: true }),
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => convertCurrentMathSource(this.editor),
      "Mod-Shift-e": () => this.options.openMathEditor(),
    };
  },
});

const NoteImage = Image.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      resolveAssetUrl: () => "",
    };
  },
  addNodeView() {
    const resolveAssetUrl = this.options.resolveAssetUrl;
    return ({ node }) => {
      const figure = document.createElement("figure");
      figure.className = "rich-note-image";
      const image = document.createElement("img");
      const caption = document.createElement("figcaption");
      const update = (nextNode) => {
        if (nextNode.type.name !== this.name) return false;
        const source = String(nextNode.attrs.src || "");
        const attachmentId = attachmentIdFromUrl(source);
        image.src = attachmentId ? resolveAssetUrl?.(attachmentId) || source : source;
        image.alt = String(nextNode.attrs.alt || "");
        image.title = String(nextNode.attrs.title || "");
        caption.textContent = image.alt;
        caption.hidden = !image.alt;
        return true;
      };
      image.draggable = false;
      image.addEventListener("error", () => figure.classList.add("is-missing"));
      figure.append(image, caption);
      update(node);
      return { dom: figure, update };
    };
  },
});

export function createEditorExtensions({
  resolveAssetUrl = () => "",
  cancelPainter = () => false,
  onMathClick = () => false,
  openMathEditor = () => false,
} = {}) {
  const katexOptions = {
    displayMode: false,
    throwOnError: true,
    strict: "ignore",
    trust: false,
    maxExpand: 1000,
    output: "htmlAndMathml",
  };
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
      },
    }),
    TextStyle,
    NoteFontFamily,
    FontSize,
    NoteFontSizeStep,
    NoteParagraphLineHeight,
    TaskList,
    TaskItem.configure({ nested: true }),
    NoteTable.configure({
      resizable: true,
      handleWidth: 5,
      cellMinWidth: 96,
      lastColumnResizable: true,
      allowTableNodeSelection: false,
    }),
    TableRow,
    NoteTableHeader,
    NoteTableCell,
    NoteInlineMath.configure({ onClick: (node, pos) => onMathClick(node, pos, "inline"), katexOptions }),
    NoteBlockMath.configure({ onClick: (node, pos) => onMathClick(node, pos, "block"), katexOptions }),
    NoteMathInput.configure({ openMathEditor }),
    NoteImage.configure({ inline: false, allowBase64: false, resolveAssetUrl }),
    Placeholder.configure({ placeholder: "写下正文…" }),
    EscapeCancelsPainter.configure({ cancelPainter }),
  ];
}

function styleToken(kind, direction, value = "") {
  return `\uE000${kind}${direction}${value ? `:${value}` : ""}\uE001`;
}

function markdownCodeRanges(source) {
  const ranges = [];
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)].filter((match) => match[0]);
  let fence = null;
  for (const line of lines) {
    const text = line[0].replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (!fence && marker) {
      fence = { start: line.index, character: marker[1][0], length: marker[1].length };
    } else if (fence && marker && marker[1][0] === fence.character && marker[1].length >= fence.length) {
      ranges.push({ start: fence.start, end: line.index + line[0].length });
      fence = null;
    }
  }
  if (fence) ranges.push({ start: fence.start, end: source.length });

  const overlapsRange = (start, end) => ranges.some((range) => start < range.end && end > range.start);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (overlapsRange(line.index, line.index + line[0].length) || !/^(?: {4}|\t)/.test(line[0])) {
      index += 1;
      continue;
    }
    const start = line.index;
    let end = line.index + line[0].length;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (overlapsRange(next.index, next.index + next[0].length) || (!/^(?: {4}|\t)/.test(next[0]) && next[0].trim())) break;
      end = next.index + next[0].length;
      index += 1;
    }
    ranges.push({ start, end });
  }

  for (const match of source.matchAll(/(`+)([\s\S]*?)\1/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!overlapsRange(start, end)) ranges.push({ start, end });
  }
  return ranges;
}

function protectOwnPairs(markdown) {
  const source = String(markdown || "");
  const codeRanges = markdownCodeRanges(source);
  const tokens = [...source.matchAll(/<\/?(?:font|span)\b[^>]*>/gi)]
    .filter((match) => !codeRanges.some((range) => match.index >= range.start && match.index < range.end))
    .map((match) => {
    const raw = match[0];
    const name = /^<\/?(font|span)\b/i.exec(raw)?.[1]?.toLowerCase();
    const font = /^<font\s+data-note-font="(songti|kaiti|simhei|times-new-roman|monospace)"\s*>$/i.exec(raw);
    const size = /^<span\s+data-note-size="(12|14|16|20|24)"\s*>$/i.exec(raw);
    return {
      start: match.index,
      end: match.index + raw.length,
      raw,
      name,
      closing: /^<\//.test(raw),
      own: font ? { kind: "F", value: font[1] } : size ? { kind: "S", value: size[1] } : null,
      replacement: null,
      };
    });
  const stacks = { font: [], span: [] };
  for (const token of tokens) {
    if (!token.name) continue;
    if (!token.closing) {
      stacks[token.name].push(token);
      continue;
    }
    const opening = stacks[token.name].pop();
    if (!opening?.own) continue;
    opening.replacement = styleToken(opening.own.kind, "+", opening.own.value);
    token.replacement = styleToken(opening.own.kind, "-");
  }
  let cursor = 0;
  let prepared = "";
  for (const token of tokens) {
    prepared += source.slice(cursor, token.start);
    prepared += token.replacement ?? (token.own ? "" : token.raw);
    cursor = token.end;
  }
  return prepared + source.slice(cursor);
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mathTokens(source) {
  const codeRanges = markdownCodeRanges(source);
  const overlapsCode = (start, end) => codeRanges.some((range) => start < range.end && end > range.start);
  const tokens = [];
  const addMatches = (pattern, type, latexIndex = 1) => {
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const latex = String(match[latexIndex] || "").trim();
      if (!latex || overlapsCode(start, end) || tokens.some((token) => start < token.end && end > token.start)) continue;
      if (type === "inline" && match[0].startsWith("$") && /^\d+(?:[.,]\d+)?$/.test(latex)) continue;
      tokens.push({ start, end, type, latex });
    }
  };
  addMatches(/\$\$([\s\S]+?)\$\$/g, "block");
  addMatches(/\\\[([\s\S]+?)\\\]/g, "block");
  addMatches(/\\\(([^\n]+?)\\\)/g, "inline");
  addMatches(/(?<![\\$])\$([^$\n]+?)(?<!\\)\$(?!\$)/g, "inline");
  return tokens.sort((left, right) => left.start - right.start);
}

export function containsMathMarkup(value) {
  return mathTokens(String(value || "")).length > 0;
}

function protectMathMarkup(markdown) {
  const source = String(markdown || "");
  const tokens = mathTokens(source);
  if (!tokens.length) return source;
  let cursor = 0;
  let prepared = "";
  for (const token of tokens) {
    prepared += source.slice(cursor, token.start);
    const latex = escapeHtmlAttribute(token.latex);
    prepared += token.type === "block"
      ? `\n\n<div data-type="block-math" data-latex="${latex}"></div>\n\n`
      : `<span data-type="inline-math" data-latex="${latex}"></span>`;
    cursor = token.end;
  }
  return prepared + source.slice(cursor);
}

function sanitizeRichDocument(parsed) {
  parsed.querySelectorAll(FORBIDDEN_RICH_HTML).forEach((node) => node.remove());
  parsed.querySelectorAll('[data-type="inline-math"], [data-type="block-math"]').forEach((node) => {
    const latex = node.getAttribute("data-latex") || "";
    if (!latex.trim()) node.remove();
  });
  parsed.querySelectorAll("a[href]").forEach((anchor) => {
    if (!/^(?:https?:|mailto:)/i.test(anchor.getAttribute("href") || "")) anchor.removeAttribute("href");
  });
  parsed.querySelectorAll('li > input[type="checkbox"]').forEach((input) => {
    const item = input.parentElement;
    const list = item?.parentElement;
    if (!item || !list || list.tagName !== "UL") return;
    list.dataset.type = "taskList";
    item.dataset.type = "taskItem";
    item.dataset.checked = String(input.checked);
    input.remove();
  });
  parsed.body.querySelectorAll("*").forEach((node) => {
    const allowed = SAFE_HTML_ATTRIBUTES[node.tagName.toLowerCase()] || new Set();
    for (const attribute of [...node.attributes]) {
      if (!allowed.has(attribute.name.toLowerCase())) node.removeAttribute(attribute.name);
    }
  });
  return parsed.body.innerHTML;
}

function safeHtmlFromRichHtml(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  return sanitizeRichDocument(parsed);
}

function safeHtmlFromMarkdown(markdown) {
  const prepared = protectMathMarkup(protectOwnPairs(markdown));
  const parsed = new DOMParser().parseFromString(marked.parse(prepared, {
    gfm: true,
    breaks: false,
  }), "text/html");
  return sanitizeRichDocument(parsed);
}

function collectMarkdownTableTokens(tokens, output = []) {
  for (const token of tokens || []) {
    if (token?.type === "table") output.push(token);
    if (Array.isArray(token?.tokens)) collectMarkdownTableTokens(token.tokens, output);
    for (const item of token?.items || []) collectMarkdownTableTokens(item.tokens, output);
  }
  return output;
}

export function markdownTableInfo(markdown) {
  try {
    const tables = collectMarkdownTableTokens(marked.lexer(String(markdown || ""), { gfm: true }));
    const dimensions = tables.map((table) => ({
      rows: 1 + (table.rows?.length || 0),
      columns: table.header?.length || 0,
    }));
    return {
      hasTable: Boolean(tables.length),
      oversized: dimensions.some(({ rows, columns }) => rows > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS),
      tableCount: tables.length,
      maxRows: Math.max(0, ...dimensions.map(({ rows }) => rows)),
      maxColumns: Math.max(0, ...dimensions.map(({ columns }) => columns)),
    };
  } catch {
    return {
      hasTable: false,
      oversized: false,
      tableCount: 0,
      maxRows: 0,
      maxColumns: 0,
    };
  }
}

function richBodyTableInfo(value) {
  const dimensions = [];
  const visit = (node) => {
    if (node?.type === "table") {
      dimensions.push({
        rows: node.content?.length || 0,
        columns: Math.max(0, ...(node.content || []).map((row) => (
          (row.content || []).reduce((count, cell) => count + (Number(cell.attrs?.colspan) || 1), 0)
        ))),
      });
    }
    for (const child of node?.content || []) visit(child);
  };
  visit(value);
  return {
    hasTable: Boolean(dimensions.length),
    oversized: dimensions.some(({ rows, columns }) => rows > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS),
  };
}

function plainTextRichBody(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

function marksWithStyle(marks, state) {
  const next = (marks || []).map((mark) => ({ ...mark, attrs: mark.attrs ? { ...mark.attrs } : undefined }));
  const attributes = {};
  if (state.font.length) attributes.fontFamily = fontFamilyFor(state.font.at(-1));
  if (state.size.length) attributes.fontSize = fontSizeFor(state.size.at(-1));
  if (!attributes.fontFamily && !attributes.fontSize) return next;
  const existing = next.find((mark) => mark.type === "textStyle");
  if (existing) existing.attrs = { ...(existing.attrs || {}), ...attributes };
  else next.push({ type: "textStyle", attrs: attributes });
  return next;
}

function applyStyleSentinels(value) {
  const state = { font: [], size: [] };
  const rewrite = (node) => {
    if (node.type !== "text") {
      const content = [];
      for (const child of node.content || []) content.push(...rewrite(child));
      return [{ ...node, ...(node.content ? { content } : {}) }];
    }
    const nodes = [];
    let cursor = 0;
    STYLE_TOKEN.lastIndex = 0;
    for (const match of node.text.matchAll(STYLE_TOKEN)) {
      if (match.index > cursor) {
        nodes.push({ ...node, text: node.text.slice(cursor, match.index), marks: marksWithStyle(node.marks, state) });
      }
      const target = match[1] === "F" ? state.font : state.size;
      if (match[2] === "+" && match[3]) target.push(match[3]);
      else if (match[2] === "-") target.pop();
      cursor = match.index + match[0].length;
    }
    if (cursor < node.text.length) {
      nodes.push({ ...node, text: node.text.slice(cursor), marks: marksWithStyle(node.marks, state) });
    }
    return nodes.filter((item) => item.text);
  };
  return rewrite(value)[0];
}

export function richBodyFromLegacyMarkdown(markdown, options = {}) {
  if (!String(markdown || "").trim()) return emptyRichBody();
  if (markdownTableInfo(markdown).oversized) return plainTextRichBody(markdown);
  try {
    const value = applyStyleSentinels(generateJSON(
      safeHtmlFromMarkdown(markdown),
      createEditorExtensions(options),
    ));
    if (richBodyTableInfo(value).oversized) return plainTextRichBody(markdown);
    const migrated = migrateMathInRichBody(value);
    return normalizeRichBody(migrated.richBody) || plainTextRichBody(markdown);
  } catch {
    return plainTextRichBody(markdown);
  }
}

export function richBodyFromHtml(html, options = {}) {
  if (!String(html || "").trim()) return null;
  try {
    const value = generateJSON(
      safeHtmlFromRichHtml(html),
      createEditorExtensions(options),
    );
    if (richBodyTableInfo(value).oversized) return null;
    const migrated = migrateMathInRichBody(value);
    return normalizeRichBody(migrated.richBody);
  } catch {
    return null;
  }
}

function paragraphMarkdownLine(node) {
  if (node?.type !== "paragraph") return null;
  let value = "";
  for (const child of node.content || []) {
    if (child.type !== "text") return null;
    value += child.text || "";
  }
  return value;
}

function singleMarkdownTable(value) {
  try {
    const tokens = marked.lexer(String(value || ""), { gfm: true }).filter((token) => token.type !== "space");
    if (tokens.length !== 1 || tokens[0].type !== "table") return false;
    return tokens[0].raw.trim() === String(value || "").trim();
  } catch {
    return false;
  }
}

export function migrateRichBodyTables(value, options = {}) {
  const source = normalizeRichBody(value);
  if (!source) return { richBody: null, changed: false };
  let changed = false;
  const rewrite = (node) => {
    if (!node.content) return node;
    const rewrittenChildren = node.content.map(rewrite);
    if (!["doc", "blockquote", "listItem", "taskItem"].includes(node.type)) {
      return { ...node, content: rewrittenChildren };
    }
    const content = [];
    for (let index = 0; index < rewrittenChildren.length;) {
      const first = paragraphMarkdownLine(rewrittenChildren[index]);
      const second = paragraphMarkdownLine(rewrittenChildren[index + 1]);
      if (!first?.includes("|") || !second?.includes("|")) {
        content.push(rewrittenChildren[index]);
        index += 1;
        continue;
      }
      const lines = [];
      let end = index;
      while (end < rewrittenChildren.length) {
        const line = paragraphMarkdownLine(rewrittenChildren[end]);
        if (line === null || !line.includes("|") || !line.trim()) break;
        lines.push(line);
        end += 1;
      }
      let replacement = null;
      let consumed = 0;
      for (let count = lines.length; count >= 2; count -= 1) {
        const candidate = lines.slice(0, count).join("\n");
        const info = markdownTableInfo(candidate);
        if (!info.hasTable || info.oversized || !singleMarkdownTable(candidate)) continue;
        const converted = richBodyFromLegacyMarkdown(candidate, options);
        if (converted.content?.length !== 1 || converted.content[0].type !== "table") continue;
        [replacement] = converted.content;
        consumed = count;
        break;
      }
      if (!replacement) {
        content.push(rewrittenChildren[index]);
        index += 1;
        continue;
      }
      content.push(replacement);
      index += consumed;
      changed = true;
    }
    return { ...node, content };
  };
  const richBody = rewrite(source);
  return {
    richBody: normalizeRichBody(richBody) || source,
    changed,
  };
}

export function migrateRichBodyMath(value) {
  return migrateMathInRichBody(value);
}

export function migratePastedMathSlice(slice, schema) {
  if (!slice?.content || !schema) return slice;
  const migrated = migrateMathInRichBody({
    type: "doc",
    content: slice.content.toJSON(),
  });
  if (!migrated.changed || !migrated.richBody?.content) return slice;
  try {
    return new Slice(Fragment.fromJSON(schema, migrated.richBody.content), slice.openStart, slice.openEnd);
  } catch {
    return slice;
  }
}

export function clipboardTextFromSlice(slice) {
  const output = [];
  const append = (value) => {
    if (!value) return;
    output.push(value);
  };
  const endBlock = () => {
    const tail = output.at(-1) || "";
    if (!tail.endsWith("\n")) output.push("\n");
  };
  const tableCellText = (node) => {
    const cellOutput = [];
    const visitCell = (child) => {
      const type = child.type?.name;
      if (child.isText) cellOutput.push(child.text || "");
      else if (type === "hardBreak") cellOutput.push("\n");
      else if (type === "inlineMath") cellOutput.push(`$${String(child.attrs?.latex || "").trim()}$`);
      else if (type === "blockMath") cellOutput.push(`$$\n${String(child.attrs?.latex || "").trim()}\n$$`);
      else {
        child.forEach?.((nested) => visitCell(nested));
        if (["paragraph", "heading", "blockquote", "listItem", "taskItem", "codeBlock"].includes(type)) {
          const tail = cellOutput.at(-1) || "";
          if (!tail.endsWith("\n")) cellOutput.push("\n");
        }
      }
    };
    node.forEach?.((child) => visitCell(child));
    return cellOutput.join("").replace(/\n{3,}/g, "\n\n").trimEnd();
  };
  const visit = (node) => {
    const type = node.type?.name;
    if (node.isText) append(node.text || "");
    else if (type === "hardBreak") append("\n");
    else if (type === "inlineMath") append(`$${String(node.attrs?.latex || "").trim()}$`);
    else if (type === "blockMath") {
      append(`$$\n${String(node.attrs?.latex || "").trim()}\n$$`);
      endBlock();
    } else if (type === "table") {
      node.forEach?.((row) => {
        const cells = [];
        row.forEach?.((cell) => cells.push(tableCellText(cell)));
        append(cells.join("\t"));
        endBlock();
      });
    } else {
      node.forEach?.((child) => visit(child));
      if (["paragraph", "heading", "blockquote", "listItem", "taskItem", "codeBlock"].includes(type)) endBlock();
    }
  };
  slice?.content?.forEach((node) => visit(node));
  return output.join("").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function selectedTableHasHeaderRow(editor) {
  const $from = editor?.state?.selection?.$from;
  if (!$from) return false;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "table") continue;
    const firstRow = node.firstChild;
    if (!firstRow?.childCount) return false;
    let allHeaders = true;
    firstRow.forEach((cell) => {
      if (cell.type.name !== "tableHeader") allHeaders = false;
    });
    return allHeaders;
  }
  return false;
}

export function formatStateForEditor(editor, painterActive = false) {
  if (!editor) {
    return {
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      code: false,
      font: "",
      size: "",
      lineHeight: "",
      block: "paragraph",
      canClear: false,
      painterActive,
      inTable: false,
      tableHasHeader: false,
      tableRows: 0,
      tableColumns: 0,
      canAddTableRow: false,
      canAddTableColumn: false,
    };
  }
  const textStyle = editor.getAttributes("textStyle");
  const lineHeightAttrs = editor.isActive("heading")
    ? editor.getAttributes("heading")
    : editor.getAttributes("paragraph");
  const block = editor.isActive("heading", { level: 1 }) ? "heading-1"
    : editor.isActive("heading", { level: 2 }) ? "heading-2"
      : editor.isActive("heading", { level: 3 }) ? "heading-3"
        : editor.isActive("blockquote") ? "quote"
          : editor.isActive("codeBlock") ? "code-block"
            : editor.isActive("taskList") ? "checklist"
              : editor.isActive("bulletList") ? "bullet"
                : editor.isActive("orderedList") ? "numbered"
                  : "paragraph";
  const tableDimensions = selectedTableDimensions(editor);
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    font: fontValueFor(textStyle.fontFamily),
    size: sizeValueFor(textStyle.fontSize),
    lineHeight: LINE_HEIGHT_VALUES.has(lineHeightAttrs.lineHeight) ? lineHeightAttrs.lineHeight : "",
    block,
    canClear: !editor.state.selection.empty,
    painterActive,
    inTable: editor.isActive("table"),
    tableHasHeader: selectedTableHasHeaderRow(editor),
    tableRows: tableDimensions.rows,
    tableColumns: tableDimensions.columns,
    canAddTableRow: tableDimensions.rows > 0 && tableDimensions.rows < MAX_TABLE_ROWS,
    canAddTableColumn: tableDimensions.columns > 0 && tableDimensions.columns < MAX_TABLE_COLUMNS,
  };
}
