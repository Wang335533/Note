import { Extension } from "@tiptap/core";
import { generateJSON } from "@tiptap/html";
import Image from "@tiptap/extension-image";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { marked } from "marked";
import * as richTextModule from "desktop-note/rich-text";
import { attachmentIdFromUrl } from "desktop-note/library-files";

const { emptyRichBody, normalizeRichBody } = richTextModule;

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
const STYLE_TOKEN = /\uE000([FS])([+-])(?::([^\uE001]+))?\uE001/g;

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

const EscapeCancelsPainter = Extension.create({
  name: "noteEscapeCancelsPainter",
  addOptions() {
    return { cancelPainter: () => false };
  },
  addKeyboardShortcuts() {
    return { Escape: () => this.options.cancelPainter() };
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

export function createEditorExtensions({ resolveAssetUrl = () => "", cancelPainter = () => false } = {}) {
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
    FontFamily,
    FontSize,
    TaskList,
    TaskItem.configure({ nested: true }),
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

function safeHtmlFromMarkdown(markdown) {
  const parsed = new DOMParser().parseFromString(marked.parse(protectOwnPairs(markdown), {
    gfm: true,
    breaks: false,
  }), "text/html");
  parsed.querySelectorAll("script, style, iframe, object, embed, form, meta, link").forEach((node) => node.remove());
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
  return parsed.body.innerHTML;
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
  const value = applyStyleSentinels(generateJSON(
    safeHtmlFromMarkdown(markdown),
    createEditorExtensions(options),
  ));
  return normalizeRichBody(value) || emptyRichBody();
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
      block: "paragraph",
      canClear: false,
      painterActive,
    };
  }
  const textStyle = editor.getAttributes("textStyle");
  const block = editor.isActive("heading", { level: 1 }) ? "heading-1"
    : editor.isActive("heading", { level: 2 }) ? "heading-2"
      : editor.isActive("heading", { level: 3 }) ? "heading-3"
        : editor.isActive("blockquote") ? "quote"
          : editor.isActive("codeBlock") ? "code-block"
            : editor.isActive("taskList") ? "checklist"
              : editor.isActive("bulletList") ? "bullet"
                : editor.isActive("orderedList") ? "numbered"
                  : "paragraph";
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    font: fontValueFor(textStyle.fontFamily),
    size: sizeValueFor(textStyle.fontSize),
    block,
    canClear: !editor.state.selection.empty,
    painterActive,
  };
}
