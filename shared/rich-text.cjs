const RICH_BODY_VERSION = 1;

const RICH_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "hardBreak",
  "horizontalRule",
  "image",
  "text",
]);

const RICH_MARK_TYPES = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "textStyle",
]);

const NOTE_FONT_VALUES = new Set(["songti", "kaiti", "simhei", "times-new-roman", "monospace"]);
const NOTE_SIZE_VALUES = new Set(["12", "14", "16", "20", "24"]);
const NOTE_FONT_FAMILIES = new Set(["SimSun", "KaiTi", "SimHei", "Times New Roman", "Cascadia Code"]);
const NOTE_FONT_SIZES = new Set(["12px", "14px", "16px", "20px", "24px"]);
const BLOCK_NODE_TYPES = new Set(["paragraph", "heading", "blockquote", "bulletList", "orderedList", "taskList", "codeBlock", "horizontalRule", "image"]);
const INLINE_NODE_TYPES = new Set(["text", "hardBreak"]);
const MAX_RICH_NODES = 50000;
const MAX_RICH_TEXT = 5 * 1024 * 1024;

function emptyRichBody() {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function hasSafeAttributes(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => (
    /^[A-Za-z][A-Za-z0-9]*$/.test(key)
    && isScalar(item)
    && (typeof item !== "string" || item.length <= MAX_RICH_TEXT)
    && (typeof item !== "number" || Number.isFinite(item))
  ));
}

function hasOnlyKeys(value, keys) {
  return value === undefined || (hasSafeAttributes(value) && Object.keys(value).every((key) => keys.includes(key)));
}

function isSafeStoredUrl(value, { image = false } = {}) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f\s]/.test(value)) return false;
  if (image && /^note-asset:\/\/local\/[A-Za-z0-9._-]+$/i.test(value)) return true;
  if (/^https?:\/\/[^\s]+$/i.test(value) || (!image && /^mailto:[^\s]+$/i.test(value))) return true;
  return !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value) && !value.startsWith("//");
}

function validNodeAttributes(node) {
  const attrs = node.attrs;
  if (node.type === "heading") return hasOnlyKeys(attrs, ["level"]) && [1, 2, 3].includes(attrs?.level);
  if (node.type === "orderedList") return hasOnlyKeys(attrs, ["start", "type"])
    && (attrs?.start === undefined || (Number.isInteger(attrs.start) && attrs.start >= 1))
    && (attrs?.type === undefined || attrs.type === null || typeof attrs.type === "string");
  if (node.type === "taskItem") return hasOnlyKeys(attrs, ["checked"]) && typeof attrs?.checked === "boolean";
  if (node.type === "codeBlock") return hasOnlyKeys(attrs, ["language"]) && (attrs?.language === undefined || attrs.language === null || typeof attrs.language === "string");
  if (node.type === "image") {
    if (!hasOnlyKeys(attrs, ["src", "alt", "title", "width", "height"]) || typeof attrs?.src !== "string") return false;
    if (!isSafeStoredUrl(attrs.src, { image: true })) return false;
    return ["alt", "title"].every((key) => attrs[key] === undefined || attrs[key] === null || typeof attrs[key] === "string")
      && ["width", "height"].every((key) => attrs[key] === undefined || attrs[key] === null || (Number.isFinite(attrs[key]) && attrs[key] > 0));
  }
  return hasOnlyKeys(attrs, []);
}

function validMarkAttributes(mark) {
  const attrs = mark.attrs;
  if (mark.type === "textStyle") {
    if (!hasOnlyKeys(attrs, ["fontFamily", "fontSize"])) return false;
    if (attrs?.fontFamily !== undefined && attrs.fontFamily !== null && !NOTE_FONT_FAMILIES.has(attrs.fontFamily)) return false;
    if (attrs?.fontSize !== undefined && attrs.fontSize !== null && !NOTE_FONT_SIZES.has(attrs.fontSize)) return false;
    return Boolean(attrs?.fontFamily || attrs?.fontSize);
  }
  if (mark.type === "link") {
    if (!hasOnlyKeys(attrs, ["href", "target", "rel", "class"]) || typeof attrs?.href !== "string") return false;
    if (!isSafeStoredUrl(attrs.href)) return false;
    return ["target", "rel", "class"].every((key) => attrs[key] === undefined || attrs[key] === null || typeof attrs[key] === "string");
  }
  return hasOnlyKeys(attrs, []);
}

function validChildType(parentType, childType) {
  if (parentType === "doc" || parentType === "blockquote") return BLOCK_NODE_TYPES.has(childType);
  if (parentType === "paragraph" || parentType === "heading") return INLINE_NODE_TYPES.has(childType);
  if (parentType === "bulletList" || parentType === "orderedList") return childType === "listItem";
  if (parentType === "taskList") return childType === "taskItem";
  if (parentType === "listItem" || parentType === "taskItem") return BLOCK_NODE_TYPES.has(childType);
  if (parentType === "codeBlock") return childType === "text";
  return false;
}

function validateRichNode(node, budget, depth = 0, parentType = null) {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > 32) return false;
  if (!RICH_NODE_TYPES.has(node.type)) return false;
  if ((depth === 0 && node.type !== "doc") || (depth > 0 && !validChildType(parentType, node.type))) return false;
  budget.nodes += 1;
  if (budget.nodes > MAX_RICH_NODES) return false;
  if (!validNodeAttributes(node)) return false;

  if (node.type === "text") {
    if (typeof node.text !== "string") return false;
    budget.text += node.text.length;
    if (budget.text > MAX_RICH_TEXT) return false;
    if (node.content !== undefined) return false;
  } else if (node.text !== undefined) {
    return false;
  }

  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks) || node.type !== "text") return false;
    if (parentType === "codeBlock" && node.marks.length) return false;
    for (const mark of node.marks) {
      if (!mark || typeof mark !== "object" || Array.isArray(mark) || !RICH_MARK_TYPES.has(mark.type)) return false;
      if (!validMarkAttributes(mark)) return false;
    }
  }

  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return false;
    if (!node.content.every((child) => validateRichNode(child, budget, depth + 1, node.type))) return false;
  }
  if (["doc", "blockquote", "bulletList", "orderedList", "taskList", "listItem", "taskItem"].includes(node.type)
    && (!Array.isArray(node.content) || !node.content.length)) return false;
  if (["listItem", "taskItem"].includes(node.type) && node.content[0]?.type !== "paragraph") return false;
  if (["hardBreak", "horizontalRule", "image"].includes(node.type) && node.content !== undefined) return false;
  return true;
}

function isRichBody(value) {
  return Boolean(value)
    && value.type === "doc"
    && validateRichNode(value, { nodes: 0, text: 0 });
}

function normalizeRichBody(value) {
  return isRichBody(value) ? structuredClone(value) : null;
}

function stripOwnFormatMarkers(value) {
  const stack = [];
  return String(value || "").replace(/<\/?(?:font|span)\b[^>]*>/gi, (token) => {
    const closing = /^<\//.test(token);
    const name = /^<\/?(font|span)\b/i.exec(token)?.[1]?.toLowerCase();
    if (!name) return token;
    if (!closing) {
      const own = name === "font"
        ? /^<font\s+data-note-font="(?:songti|kaiti|simhei|times-new-roman|monospace)"\s*>$/i.test(token)
        : /^<span\s+data-note-size="(?:12|14|16|20|24)"\s*>$/i.test(token);
      stack.push({ name, own });
      return own ? "" : token;
    }
    const index = stack.findLastIndex((entry) => entry.name === name);
    if (index < 0) return token;
    const [{ own }] = stack.splice(index, 1);
    return own ? "" : token;
  });
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]<>])/g, "\\$1");
}

function codeSpan(value) {
  const text = String(value || "");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padded = /^\s|\s$|^`|`$/.test(text) ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function inlineMarkdown(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "image") {
    const alt = String(node.attrs?.alt || "").replace(/[\[\]]/g, "");
    const src = String(node.attrs?.src || "").replace(/[\s<>]/g, (part) => encodeURIComponent(part));
    return src ? `![${alt}](${src})` : "";
  }
  if (node.type !== "text") return (node.content || []).map(inlineMarkdown).join("");

  const marks = Array.isArray(node.marks) ? node.marks : [];
  const code = marks.find((mark) => mark.type === "code");
  let text = code ? codeSpan(node.text) : escapeMarkdownText(node.text);
  if (code) return text;
  if (marks.some((mark) => mark.type === "bold")) text = `**${text}**`;
  if (marks.some((mark) => mark.type === "italic")) text = `*${text}*`;
  if (marks.some((mark) => mark.type === "strike")) text = `~~${text}~~`;
  const link = marks.find((mark) => mark.type === "link" && typeof mark.attrs?.href === "string");
  if (link) text = `[${text}](${link.attrs.href.replace(/\s/g, "%20")})`;
  return text;
}

function inlineContent(node) {
  return (node?.content || []).map(inlineMarkdown).join("");
}

function prefixLines(value, firstPrefix, restPrefix) {
  return String(value || "").split("\n").map((line, index) => `${index ? restPrefix : firstPrefix}${line}`).join("\n");
}

function blockMarkdown(node, context = {}) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "paragraph") return inlineContent(node);
  if (node.type === "heading") return `${"#".repeat(Math.max(1, Math.min(3, Number(node.attrs?.level) || 1)))} ${inlineContent(node)}`;
  if (node.type === "codeBlock") {
    const language = typeof node.attrs?.language === "string" ? node.attrs.language.replace(/[^A-Za-z0-9_-]/g, "") : "";
    const raw = (node.content || []).map((child) => child.text || "").join("");
    return `\`\`\`${language}\n${raw}\n\`\`\``;
  }
  if (node.type === "horizontalRule") return "---";
  if (node.type === "image") return inlineMarkdown(node);
  if (node.type === "blockquote") {
    const content = (node.content || []).map((child) => blockMarkdown(child)).filter(Boolean).join("\n\n");
    return prefixLines(content, "> ", "> ");
  }
  if (["bulletList", "orderedList", "taskList"].includes(node.type)) {
    return (node.content || []).map((child, index) => blockMarkdown(child, {
      listType: node.type,
      index,
      start: Number(node.attrs?.start) || 1,
    })).filter(Boolean).join("\n");
  }
  if (["listItem", "taskItem"].includes(node.type)) {
    const childBlocks = (node.content || []).map((child) => blockMarkdown(child)).filter((item) => item !== "");
    const content = childBlocks.join("\n");
    const prefix = context.listType === "orderedList"
      ? `${context.start + context.index}. `
      : context.listType === "taskList"
        ? `- [${node.attrs?.checked ? "x" : " "}] `
        : "- ";
    return prefixLines(content, prefix, "  ");
  }
  if (node.type === "doc") {
    return (node.content || []).map((child) => blockMarkdown(child)).filter((item) => item !== "").join("\n\n");
  }
  return inlineContent(node);
}

function markdownFromRichBody(value) {
  const richBody = normalizeRichBody(value);
  if (!richBody) return "";
  return blockMarkdown(richBody).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function plainTextFromRichBody(value) {
  const richBody = normalizeRichBody(value);
  if (!richBody) return "";
  const parts = [];
  const visit = (node) => {
    if (node.type === "text") parts.push(node.text);
    else if (node.type === "image" && node.attrs?.alt) parts.push(String(node.attrs.alt));
    else {
      for (const child of node.content || []) visit(child);
      if (["paragraph", "heading", "blockquote", "listItem", "taskItem", "codeBlock"].includes(node.type)) parts.push("\n");
    }
  };
  visit(richBody);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  NOTE_FONT_VALUES,
  NOTE_SIZE_VALUES,
  RICH_BODY_VERSION,
  emptyRichBody,
  isRichBody,
  markdownFromRichBody,
  normalizeRichBody,
  plainTextFromRichBody,
  stripOwnFormatMarkers,
};
