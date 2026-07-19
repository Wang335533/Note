export const FONT_OPTIONS = Object.freeze([
  { value: "", label: "默认", cssClass: "" },
  { value: "songti", label: "宋体", cssClass: "cm-live-font-songti" },
  { value: "kaiti", label: "楷体", cssClass: "cm-live-font-kaiti" },
  { value: "simhei", label: "黑体", cssClass: "cm-live-font-simhei" },
  { value: "times-new-roman", label: "Times New Roman", cssClass: "cm-live-font-times" },
  { value: "monospace", label: "等宽", cssClass: "cm-live-font-mono" },
]);

export const SIZE_OPTIONS = Object.freeze([
  { value: "", label: "默认" },
  { value: "12", label: "12" },
  { value: "14", label: "14" },
  { value: "16", label: "16" },
  { value: "20", label: "20" },
  { value: "24", label: "24" },
]);

export const BLOCK_OPTIONS = Object.freeze([
  { value: "paragraph", label: "正文" },
  { value: "heading-1", label: "标题 1" },
  { value: "heading-2", label: "标题 2" },
  { value: "heading-3", label: "标题 3" },
  { value: "quote", label: "引用" },
  { value: "code-block", label: "代码块" },
]);

const FONT_VALUES = new Set(FONT_OPTIONS.map((option) => option.value).filter(Boolean));
const SIZE_VALUES = new Set(SIZE_OPTIONS.map((option) => option.value).filter(Boolean));
const INLINE_KINDS = ["bold", "italic", "underline", "strike", "code", "font", "size"];

function clampSelection(doc, selection = {}) {
  const length = doc.length;
  const from = Math.max(0, Math.min(Number(selection.from) || 0, length));
  const to = Math.max(from, Math.min(Number(selection.to) || from, length));
  return { from, to };
}

export function editorSelectionFor(doc, selection = {}) {
  const safe = clampSelection(doc, selection);
  return { anchor: safe.from, head: safe.to };
}

function markerFor(kind, value = "") {
  if (kind === "bold") return { open: "**", close: "**" };
  if (kind === "italic") return { open: "*", close: "*" };
  if (kind === "underline") return { open: "<u>", close: "</u>" };
  if (kind === "strike") return { open: "~~", close: "~~" };
  if (kind === "code") return { open: "`", close: "`" };
  if (kind === "font" && FONT_VALUES.has(value)) {
    return { open: `<font data-note-font="${value}">`, close: "</font>" };
  }
  if (kind === "size" && SIZE_VALUES.has(value)) {
    return { open: `<span data-note-size="${value}">`, close: "</span>" };
  }
  return null;
}

function collectMatches(doc, regexp, toContainer) {
  const matches = [];
  regexp.lastIndex = 0;
  for (const match of doc.matchAll(regexp)) matches.push(toContainer(match));
  return matches;
}

function containersFor(doc, kind) {
  if (kind === "bold") {
    return collectMatches(doc, /\*\*([^\n]*?)\*\*/g, (match) => ({
      openFrom: match.index,
      openTo: match.index + 2,
      contentFrom: match.index + 2,
      contentTo: match.index + match[0].length - 2,
      closeFrom: match.index + match[0].length - 2,
      closeTo: match.index + match[0].length,
      value: true,
    }));
  }
  if (kind === "italic") {
    return collectMatches(doc, /(^|[^*])\*([^*\n]+?)\*(?!\*)/gm, (match) => {
      const prefix = match[1] ? match[1].length : 0;
      const openFrom = match.index + prefix;
      return {
        openFrom,
        openTo: openFrom + 1,
        contentFrom: openFrom + 1,
        contentTo: match.index + match[0].length - 1,
        closeFrom: match.index + match[0].length - 1,
        closeTo: match.index + match[0].length,
        value: true,
      };
    });
  }
  if (kind === "underline") {
    return collectMatches(doc, /<u>([^\n]*?)<\/u>/g, (match) => ({
      openFrom: match.index,
      openTo: match.index + 3,
      contentFrom: match.index + 3,
      contentTo: match.index + match[0].length - 4,
      closeFrom: match.index + match[0].length - 4,
      closeTo: match.index + match[0].length,
      value: true,
    }));
  }
  if (kind === "strike") {
    return collectMatches(doc, /~~([^\n]*?)~~/g, (match) => ({
      openFrom: match.index,
      openTo: match.index + 2,
      contentFrom: match.index + 2,
      contentTo: match.index + match[0].length - 2,
      closeFrom: match.index + match[0].length - 2,
      closeTo: match.index + match[0].length,
      value: true,
    }));
  }
  if (kind === "code") {
    return collectMatches(doc, /`([^`\n]*?)`/g, (match) => ({
      openFrom: match.index,
      openTo: match.index + 1,
      contentFrom: match.index + 1,
      contentTo: match.index + match[0].length - 1,
      closeFrom: match.index + match[0].length - 1,
      closeTo: match.index + match[0].length,
      value: true,
    }));
  }
  if (kind === "font") {
    return collectMatches(doc, /<font data-note-font="([a-z-]+)">([^\n]*?)<\/font>/g, (match) => {
      const openLength = match[0].indexOf(">") + 1;
      return {
        openFrom: match.index,
        openTo: match.index + openLength,
        contentFrom: match.index + openLength,
        contentTo: match.index + match[0].length - 7,
        closeFrom: match.index + match[0].length - 7,
        closeTo: match.index + match[0].length,
        value: FONT_VALUES.has(match[1]) ? match[1] : "",
      };
    });
  }
  if (kind === "size") {
    return collectMatches(doc, /<span data-note-size="(12|14|16|20|24)">([^\n]*?)<\/span>/g, (match) => {
      const openLength = match[0].indexOf(">") + 1;
      return {
        openFrom: match.index,
        openTo: match.index + openLength,
        contentFrom: match.index + openLength,
        contentTo: match.index + match[0].length - 7,
        closeFrom: match.index + match[0].length - 7,
        closeTo: match.index + match[0].length,
        value: match[1],
      };
    });
  }
  return [];
}

function enclosingContainer(doc, selection, kind) {
  const { from, to } = clampSelection(doc, selection);
  return containersFor(doc, kind)
    .filter((item) => item.contentFrom <= from && item.contentTo >= to)
    .sort((left, right) => (left.contentTo - left.contentFrom) - (right.contentTo - right.contentFrom))[0] || null;
}

function lineBounds(doc, position) {
  const safe = Math.max(0, Math.min(position, doc.length));
  const from = doc.lastIndexOf("\n", safe - 1) + 1;
  const nextBreak = doc.indexOf("\n", safe);
  return { from, to: nextBreak === -1 ? doc.length : nextBreak };
}

function isInsideCodeBlock(doc, position) {
  const before = doc.slice(0, position).split(/\r?\n/);
  return before.reduce((count, line) => count + (/^\s*```/.test(line) ? 1 : 0), 0) % 2 === 1;
}

export function blockTypeAt(doc, position) {
  if (isInsideCodeBlock(doc, position)) return "code-block";
  const line = doc.slice(lineBounds(doc, position).from, lineBounds(doc, position).to);
  const heading = line.match(/^\s*(#{1,3})\s+/);
  if (heading) return `heading-${heading[1].length}`;
  if (/^\s*>\s?/.test(line)) return "quote";
  if (/^\s*[-+*]\s+\[[ xX]\]\s+/.test(line)) return "checklist";
  if (/^\s*[-+*]\s+/.test(line)) return "bullet";
  if (/^\s*\d+[.)]\s+/.test(line)) return "numbered";
  return "paragraph";
}

export function formatStateAt(doc, selection = {}) {
  const safe = clampSelection(doc, selection);
  const state = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    font: "",
    size: "",
    block: blockTypeAt(doc, safe.from),
    canClear: safe.to > safe.from,
  };
  for (const kind of INLINE_KINDS) {
    const container = enclosingContainer(doc, safe, kind);
    if (!container) continue;
    if (kind === "font" || kind === "size") state[kind] = container.value;
    else state[kind] = true;
  }
  return state;
}

function withMinimalSelection(doc, selection) {
  const safe = clampSelection(doc, selection);
  return { doc, selection: safe };
}

export function applyInlineFormat(doc, selection, kind, value = "") {
  const safe = clampSelection(doc, selection);
  if (!INLINE_KINDS.includes(kind)) return withMinimalSelection(doc, safe);
  if (kind === "font" && value && !FONT_VALUES.has(value)) return withMinimalSelection(doc, safe);
  if (kind === "size" && value && !SIZE_VALUES.has(value)) return withMinimalSelection(doc, safe);
  const current = enclosingContainer(doc, safe, kind);
  const dynamic = kind === "font" || kind === "size";

  if (current) {
    if (dynamic && value && value !== current.value) {
      const nextMarker = markerFor(kind, value);
      const before = doc.slice(0, current.openFrom);
      const after = doc.slice(current.openTo);
      const delta = nextMarker.open.length - (current.openTo - current.openFrom);
      return {
        doc: `${before}${nextMarker.open}${after}`,
        selection: { from: safe.from + delta, to: safe.to + delta },
      };
    }
    const openLength = current.openTo - current.openFrom;
    const nextDoc = `${doc.slice(0, current.openFrom)}${doc.slice(current.openTo, current.closeFrom)}${doc.slice(current.closeTo)}`;
    return {
      doc: nextDoc,
      selection: { from: safe.from - openLength, to: safe.to - openLength },
    };
  }

  if (dynamic && !value) return withMinimalSelection(doc, safe);
  const marker = markerFor(kind, value);
  if (!marker) return withMinimalSelection(doc, safe);
  const selected = doc.slice(safe.from, safe.to);
  const replacement = `${marker.open}${selected}${marker.close}`;
  return {
    doc: `${doc.slice(0, safe.from)}${replacement}${doc.slice(safe.to)}`,
    selection: safe.from === safe.to
      ? { from: safe.from + marker.open.length, to: safe.from + marker.open.length }
      : { from: safe.from + marker.open.length, to: safe.to + marker.open.length },
  };
}

function stripBlockPrefix(line) {
  return line
    .replace(/^(\s*)#{1,6}\s+/, "$1")
    .replace(/^(\s*)>\s?/, "$1")
    .replace(/^(\s*)[-+*]\s+\[[ xX]\]\s+/, "$1")
    .replace(/^(\s*)[-+*]\s+/, "$1")
    .replace(/^(\s*)\d+[.)]\s+/, "$1");
}

function blockPrefix(type, index) {
  if (type === "heading-1") return "# ";
  if (type === "heading-2") return "## ";
  if (type === "heading-3") return "### ";
  if (type === "quote") return "> ";
  if (type === "bullet") return "- ";
  if (type === "numbered") return `${index + 1}. `;
  if (type === "checklist") return "- [ ] ";
  return "";
}

function selectedLineRange(doc, selection) {
  const safe = clampSelection(doc, selection);
  const start = lineBounds(doc, safe.from).from;
  const lastPosition = safe.to > safe.from && doc[safe.to - 1] === "\n" ? safe.to - 1 : safe.to;
  const end = lineBounds(doc, lastPosition).to;
  return { ...safe, start, end };
}

export function applyBlockFormat(doc, selection, type) {
  const allowed = new Set(["paragraph", "heading-1", "heading-2", "heading-3", "quote", "bullet", "numbered", "checklist", "code-block"]);
  if (!allowed.has(type)) return withMinimalSelection(doc, selection);
  const range = selectedLineRange(doc, selection);
  const segment = doc.slice(range.start, range.end);

  if (type === "code-block") {
    const fenced = /^```[^\n]*\n[\s\S]*\n```$/.test(segment);
    const replacement = fenced
      ? segment.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "")
      : `\`\`\`\n${segment}\n\`\`\``;
    const prefix = fenced ? 0 : 4;
    return {
      doc: `${doc.slice(0, range.start)}${replacement}${doc.slice(range.end)}`,
      selection: { from: range.start + prefix, to: range.start + replacement.length - (fenced ? 0 : 4) },
    };
  }

  const lines = segment.split("\n");
  const currentTypes = lines.filter((line) => line.trim()).map((line) => blockTypeAt(line, 0));
  const target = currentTypes.length && currentTypes.every((item) => item === type) ? "paragraph" : type;
  const replacement = lines.map((line, index) => {
    if (!line.trim()) return line;
    const indentation = line.match(/^\s*/)?.[0] || "";
    const content = stripBlockPrefix(line).slice(indentation.length);
    return `${indentation}${blockPrefix(target, index)}${content}`;
  }).join("\n");
  const delta = replacement.length - segment.length;
  const nextSelection = range.from === range.to
    ? { from: Math.max(range.start, range.from + delta), to: Math.max(range.start, range.from + delta) }
    : { from: range.start, to: range.start + replacement.length };
  return {
    doc: `${doc.slice(0, range.start)}${replacement}${doc.slice(range.end)}`,
    selection: nextSelection,
  };
}

export function clearSelectedFormatting(doc, selection) {
  const safe = clampSelection(doc, selection);
  if (safe.from === safe.to) return withMinimalSelection(doc, safe);
  let result = { doc, selection: safe };
  for (const kind of INLINE_KINDS) {
    if (enclosingContainer(result.doc, result.selection, kind)) {
      result = applyInlineFormat(result.doc, result.selection, kind, "");
    }
  }
  const selected = result.doc.slice(result.selection.from, result.selection.to)
    .replace(/<(?:span data-note-size|font data-note-font)="[^"]+">/g, "")
    .replace(/<\/span>/g, "")
    .replace(/<\/font>/g, "")
    .replace(/<\/?u>/g, "")
    .replace(/\*\*([^\n]*?)\*\*/g, "$1")
    .replace(/~~([^\n]*?)~~/g, "$1")
    .replace(/`([^`\n]*?)`/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/gm, "$1$2");
  return {
    doc: `${result.doc.slice(0, result.selection.from)}${selected}${result.doc.slice(result.selection.to)}`,
    selection: { from: result.selection.from, to: result.selection.from + selected.length },
  };
}

export function captureFormatSnapshot(doc, selection) {
  const state = formatStateAt(doc, selection);
  return {
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    strike: state.strike,
    code: state.code,
    font: state.font,
    size: state.size,
    block: state.block,
  };
}

export function applyFormatSnapshot(doc, selection, snapshot) {
  const safe = clampSelection(doc, selection);
  if (safe.from === safe.to || !snapshot) return withMinimalSelection(doc, safe);
  let result = clearSelectedFormatting(doc, safe);
  for (const kind of ["bold", "italic", "underline", "strike", "code"]) {
    if (snapshot[kind]) result = applyInlineFormat(result.doc, result.selection, kind);
  }
  if (snapshot.font) result = applyInlineFormat(result.doc, result.selection, "font", snapshot.font);
  if (snapshot.size) result = applyInlineFormat(result.doc, result.selection, "size", snapshot.size);
  if (snapshot.block) result = applyBlockFormat(result.doc, result.selection, snapshot.block);
  return result;
}

export function normalizeLinkUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(?:https?:|mailto:)/i.test(raw)) return raw.replace(/\s/g, "%20");
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return "";
  return `https://${raw.replace(/\s/g, "%20")}`;
}

export function insertLink(doc, selection, url, label = "") {
  const safe = clampSelection(doc, selection);
  const normalizedUrl = normalizeLinkUrl(url);
  if (!normalizedUrl) return withMinimalSelection(doc, safe);
  const selected = doc.slice(safe.from, safe.to);
  const text = selected || String(label || "").trim() || normalizedUrl;
  const replacement = `[${text.replace(/[\[\]]/g, "")}](${normalizedUrl})`;
  return {
    doc: `${doc.slice(0, safe.from)}${replacement}${doc.slice(safe.to)}`,
    selection: { from: safe.from + 1, to: safe.from + 1 + text.replace(/[\[\]]/g, "").length },
  };
}

function wrapInline(content, open, close) {
  const trimmed = content.trim();
  if (!trimmed) return content;
  const start = content.indexOf(trimmed);
  return `${content.slice(0, start)}${open}${trimmed}${close}${content.slice(start + trimmed.length)}`;
}

function fontFromStyle(value) {
  const font = String(value || "").toLocaleLowerCase();
  if (/times new roman|times/.test(font)) return "times-new-roman";
  if (/simhei|黑体/.test(font)) return "simhei";
  if (/kaiti|楷体|kai/.test(font)) return "kaiti";
  if (/simsun|宋体|songti/.test(font)) return "songti";
  if (/consolas|cascadia|monaco|courier|monospace/.test(font)) return "monospace";
  return "";
}

function sizeFromStyle(value) {
  const match = String(value || "").match(/[\d.]+/);
  if (!match) return "";
  let pixels = Number(match[0]);
  if (/pt/i.test(value)) pixels *= 4 / 3;
  if (!Number.isFinite(pixels)) return "";
  return [12, 14, 16, 20, 24].reduce((closest, size) => (
    Math.abs(size - pixels) < Math.abs(closest - pixels) ? size : closest
  ), 14).toString();
}

function convertChildren(node, context) {
  return [...(node.childNodes || [])].map((child) => convertNode(child, context)).join("");
}

function convertList(node, ordered, context) {
  let index = 0;
  return [...(node.children || [])].filter((child) => child.tagName?.toLocaleLowerCase() === "li").map((item) => {
    index += 1;
    const checkbox = item.querySelector?.('input[type="checkbox"]');
    const marker = checkbox ? `- [${checkbox.checked ? "x" : " "}] ` : ordered ? `${index}. ` : "- ";
    const content = convertChildren(item, { ...context, inList: true }).replace(/^\s+|\s+$/g, "");
    return `${marker}${content.replace(/\n+/g, "\n  ")}`;
  }).join("\n") + "\n\n";
}

function convertNode(node, context = {}) {
  if (node.nodeType === 3) return String(node.nodeValue || "").replace(/\u00a0/g, " ");
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toLocaleLowerCase();
  if (["script", "style", "meta", "link", "svg", "canvas", "iframe", "object", "input"].includes(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "img") return "";
  if (tag === "ul") return convertList(node, false, context);
  if (tag === "ol") return convertList(node, true, context);
  if (tag === "pre") {
    const text = node.textContent || "";
    return `\n\n\`\`\`\n${text.replace(/^\n|\n$/g, "")}\n\`\`\`\n\n`;
  }
  if (tag === "blockquote") {
    const content = convertChildren(node, context).trim();
    return `${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  }

  let content = convertChildren(node, context);
  const style = node.getAttribute?.("style") || "";
  const styleValue = (name) => style.match(new RegExp(`${name}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim() || "";
  const weight = styleValue("font-weight");
  const decoration = styleValue("text-decoration");
  const fontStyle = styleValue("font-style");
  const font = fontFromStyle(styleValue("font-family") || node.getAttribute?.("face"));
  const htmlSize = node.getAttribute?.("size");
  const legacySizeMap = { 1: "12", 2: "14", 3: "16", 4: "20", 5: "24", 6: "24", 7: "24" };
  const size = styleValue("font-size")
    ? sizeFromStyle(styleValue("font-size"))
    : legacySizeMap[htmlSize] || "";

  if (["strong", "b"].includes(tag) || /bold|[6-9]00/.test(weight)) content = wrapInline(content, "**", "**");
  if (["em", "i"].includes(tag) || /italic/i.test(fontStyle)) content = wrapInline(content, "*", "*");
  if (tag === "u" || /underline/i.test(decoration)) content = wrapInline(content, "<u>", "</u>");
  if (["s", "strike", "del"].includes(tag) || /line-through/i.test(decoration)) content = wrapInline(content, "~~", "~~");
  if (tag === "code" && node.parentElement?.tagName?.toLocaleLowerCase() !== "pre") content = wrapInline(content, "`", "`");
  if (font) content = wrapInline(content, `<font data-note-font="${font}">`, "</font>");
  if (size) content = wrapInline(content, `<span data-note-size="${size}">`, "</span>");

  if (tag === "a") {
    const href = normalizeLinkUrl(node.getAttribute?.("href"));
    if (href && content.trim()) content = `[${content.trim()}](${href})`;
  }
  const heading = tag.match(/^h([1-3])$/);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${content.trim()}\n\n`;
  if (["p", "div", "section", "article", "header", "footer"].includes(tag)) return `${content.trim()}\n\n`;
  return content;
}

export function htmlToNoteMarkdown(html) {
  if (typeof DOMParser !== "function" || !String(html || "").trim()) return "";
  const parsed = new DOMParser().parseFromString(String(html), "text/html");
  return convertChildren(parsed.body, {})
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
