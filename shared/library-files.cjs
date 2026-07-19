const { stripOwnFormatMarkers } = require("./rich-text.cjs");

const NOTE_ASSET_URL_PREFIX = "note-asset://local/";
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function noteAssetUrl(id) {
  if (typeof id !== "string" || !id) throw new Error("attachment id is required");
  return `${NOTE_ASSET_URL_PREFIX}${encodeURIComponent(id)}`;
}

function attachmentIdFromUrl(value) {
  if (typeof value !== "string" || !value.startsWith(NOTE_ASSET_URL_PREFIX)) return null;
  try {
    const id = decodeURIComponent(value.slice(NOTE_ASSET_URL_PREFIX.length));
    return id && !id.includes("/") && !id.includes("\\") ? id : null;
  } catch {
    return null;
  }
}

function safeFileSegment(value, fallback = "无标题") {
  let clean = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+/g, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim();
  if (!clean) clean = fallback;
  if (WINDOWS_RESERVED_NAMES.has(clean.toUpperCase())) clean = `${clean}-note`;
  return clean;
}

function baseName(value) {
  return String(value || "").replaceAll("\\", "/").split("/").pop() || "";
}

function fileStem(value) {
  const name = baseName(value);
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 ? name.slice(0, lastDot) : name;
}

function posixJoin(...segments) {
  return segments
    .map((segment) => String(segment || "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function deriveImportedTitle(fileName, markdown) {
  const heading = String(markdown || "").match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (heading) return heading;
  return safeFileSegment(fileStem(fileName), "无标题");
}

function imageExtension(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return "";
}

function uniqueSegment(preferred, used, suffix) {
  let value = preferred;
  let index = 2;
  while (used.has(value.toLocaleLowerCase())) {
    value = `${preferred}--${suffix || index}`;
    index += 1;
  }
  used.add(value.toLocaleLowerCase());
  return value;
}

function rewriteInternalAssetUrls(markdown, note, assetDirectoryName = "assets") {
  const byId = new Map((note.attachments || []).map((attachment) => [attachment.id, attachment]));
  return String(markdown || "").replace(/note-asset:\/\/local\/([^\s)"'<>]+)/g, (match, encodedId) => {
    const id = attachmentIdFromUrl(`${NOTE_ASSET_URL_PREFIX}${encodedId}`);
    const attachment = id ? byId.get(id) : null;
    if (!attachment) return match;
    const fileName = `${safeFileSegment(attachment.id, "image")}${imageExtension(attachment.mimeType)}`;
    return `${assetDirectoryName}/${fileName}`;
  });
}

function createLibraryExportPlan(state) {
  const activeNotebooks = Object.values(state?.notebooks || {})
    .filter((notebook) => !notebook.trashedAt)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const notebookFolderById = new Map();
  const usedFolders = new Set();
  for (const notebook of activeNotebooks) {
    const preferred = safeFileSegment(notebook.name, "笔记本");
    notebookFolderById.set(notebook.id, uniqueSegment(preferred, usedFolders, notebook.id.slice(0, 8)));
  }
  const unfiledFolder = uniqueSegment("未分类", usedFolders, "unfiled");
  const usedNamesByFolder = new Map();
  const notes = [];

  for (const note of Object.values(state?.notes || {}).filter((item) => !item.trashedAt)) {
    const folder = notebookFolderById.get(note.notebookId) || unfiledFolder;
    if (!usedNamesByFolder.has(folder)) usedNamesByFolder.set(folder, new Set());
    const usedNames = usedNamesByFolder.get(folder);
    const preferred = safeFileSegment(note.title || deriveImportedTitle("", note.body), "无标题");
    const fileStem = uniqueSegment(preferred, usedNames, note.id.slice(0, 8));
    const assetDirectory = `${fileStem}.assets`;
    const content = rewriteInternalAssetUrls(stripOwnFormatMarkers(note.body), note, assetDirectory);
    const assets = (note.attachments || []).map((attachment) => ({
      attachmentId: attachment.id,
      sourceRelativePath: attachment.relativePath,
      relativePath: posixJoin(
        folder,
        assetDirectory,
        `${safeFileSegment(attachment.id, "image")}${imageExtension(attachment.mimeType)}`,
      ),
    }));
    notes.push({
      noteId: note.id,
      relativePath: posixJoin(folder, `${fileStem}.md`),
      content,
      assets,
    });
  }
  return { notes };
}

module.exports = {
  NOTE_ASSET_URL_PREFIX,
  attachmentIdFromUrl,
  createLibraryExportPlan,
  deriveImportedTitle,
  imageExtension,
  noteAssetUrl,
  rewriteInternalAssetUrls,
  safeFileSegment,
};
