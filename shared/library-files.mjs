import * as richTextModule from "desktop-note/rich-text";

const { stripOwnFormatMarkers } = richTextModule;

export const NOTE_ASSET_URL_PREFIX = "note-asset://local/";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function noteAssetUrl(id) {
  if (typeof id !== "string" || !id) throw new Error("attachment id is required");
  return `${NOTE_ASSET_URL_PREFIX}${encodeURIComponent(id)}`;
}

export function attachmentIdFromUrl(value) {
  if (typeof value !== "string" || !value.startsWith(NOTE_ASSET_URL_PREFIX)) return null;
  try {
    const id = decodeURIComponent(value.slice(NOTE_ASSET_URL_PREFIX.length));
    return id && !id.includes("/") && !id.includes("\\") ? id : null;
  } catch {
    return null;
  }
}

export function safeFileSegment(value, fallback = "无标题") {
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

export function deriveImportedTitle(fileName, markdown) {
  const heading = String(markdown || "").match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (heading) return heading;
  return safeFileSegment(fileStem(fileName), "无标题");
}

export function imageExtension(mimeType) {
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

export function rewriteInternalAssetUrls(markdown, note, assetDirectoryName = "assets") {
  const byId = new Map((note.attachments || []).map((attachment) => [attachment.id, attachment]));
  return String(markdown || "").replace(/note-asset:\/\/local\/([^\s)"'<>]+)/g, (match, encodedId) => {
    const id = attachmentIdFromUrl(`${NOTE_ASSET_URL_PREFIX}${encodedId}`);
    const attachment = id ? byId.get(id) : null;
    if (!attachment) return match;
    const fileName = `${safeFileSegment(attachment.id, "image")}${imageExtension(attachment.mimeType)}`;
    return `${assetDirectoryName}/${fileName}`;
  });
}

export function createLibraryExportPlan(state) {
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
  const noteFolderById = new Map();
  const usedNoteFoldersByNotebook = new Map();
  for (const folder of Object.values(state?.folders || {}).filter((item) => !item.trashedAt)) {
    const notebookFolder = notebookFolderById.get(folder.notebookId);
    if (!notebookFolder) continue;
    if (!usedNoteFoldersByNotebook.has(folder.notebookId)) usedNoteFoldersByNotebook.set(folder.notebookId, new Set());
    const segment = uniqueSegment(
      safeFileSegment(folder.name, "文件夹"),
      usedNoteFoldersByNotebook.get(folder.notebookId),
      folder.id.slice(0, 8),
    );
    noteFolderById.set(folder.id, posixJoin(notebookFolder, segment));
  }
  const usedNamesByFolder = new Map();
  const notes = [];

  for (const note of Object.values(state?.notes || {}).filter((item) => !item.trashedAt)) {
    const destinationFolder = noteFolderById.get(note.folderId)
      || notebookFolderById.get(note.notebookId)
      || unfiledFolder;
    if (!usedNamesByFolder.has(destinationFolder)) usedNamesByFolder.set(destinationFolder, new Set());
    const usedNames = usedNamesByFolder.get(destinationFolder);
    const preferred = safeFileSegment(note.title || deriveImportedTitle("", note.body), "无标题");
    const noteStem = uniqueSegment(preferred, usedNames, note.id.slice(0, 8));
    const assetDirectory = `${noteStem}.assets`;
    const content = rewriteInternalAssetUrls(stripOwnFormatMarkers(note.body), note, assetDirectory);
    const assets = (note.attachments || []).map((attachment) => ({
      attachmentId: attachment.id,
      sourceRelativePath: attachment.relativePath,
      relativePath: posixJoin(
        destinationFolder,
        assetDirectory,
        `${safeFileSegment(attachment.id, "image")}${imageExtension(attachment.mimeType)}`,
      ),
    }));
    notes.push({
      noteId: note.id,
      relativePath: posixJoin(destinationFolder, `${noteStem}.md`),
      content,
      assets,
    });
  }
  return { notes };
}
