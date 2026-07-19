const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
  Tray,
} = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { createBoundedFileLogger } = require("./file-logger.cjs");
const { isSameDocumentUrl, isTrustedRendererEvent } = require("./ipc-security.cjs");
const { createSerializedWriter, selectLatestValidCandidate } = require("./persistence.cjs");
const {
  BACKUP_DIRECTORY_NAME,
  completeUpgrade,
  createUpgradeSnapshot,
  restoreUpgradeSnapshot,
} = require("./upgrade-guard.cjs");
const {
  WINDOW_METRICS,
  fitWindowBounds,
  requestedWindowRectangle,
} = require("./window-bounds.cjs");
const {
  SCHEMA_VERSION,
  applyOperation,
  createInitialState,
  ensureCurrentDay,
  isPersistedStateShape,
  localDayKey,
  markdownForState,
  normalizeState,
} = require("../shared/store.cjs");
const {
  createLibraryExportPlan,
  deriveImportedTitle,
  imageExtension,
  noteAssetUrl,
} = require("../shared/library-files.cjs");

const LEGACY_WINDOW_RADIUS = 10;
const SHORTCUT_TOGGLE = "CommandOrControl+Alt+N";
const SHORTCUT_CAPTURE = "CommandOrControl+Alt+Space";
const SHORTCUT_LOCK = "CommandOrControl+Alt+L";
const SHORTCUT_NEW_NOTE = "CommandOrControl+Alt+Shift+N";
const NOTE_ASSET_SCHEME = "note-asset";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMPORTED_MARKDOWN_BYTES = 5 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([{
  scheme: NOTE_ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let mainWindow = null;
let tray = null;
let state = null;
let stateFile = null;
let backupFile = null;
let tempFile = null;
let dataDirectory = null;
let attachmentsDirectory = null;
let primaryCanBeBackedUp = false;
let isQuitting = false;
let quitFlushComplete = false;
let quitFlushInProgress = false;
let quitPreparationInProgress = false;
let quitPreparationTimer = null;
let boundsTimer = null;
let legacyShapeTimer = null;
let dayTimer = null;
let windowRecoveryTimer = null;
let devServerUrl = null;
let shortcutFailures = [];
let startupSaveFailed = false;
let currentSaveStatus = "saved";
let needsStateMigration = false;
let desktopTemporarilyLifted = false;
let nativeModeTransition = false;
let windowModeEpoch = 0;
let desktopHostError = null;
let cachedIcon = null;
let backgroundServicesStarted = false;
let backgroundServicesTimer = null;
let pendingUpgrade = null;

if (process.env.NOTE_SMOKE_USER_DATA && path.isAbsolute(process.env.NOTE_SMOKE_USER_DATA)) {
  const smokeUserData = path.resolve(process.env.NOTE_SMOKE_USER_DATA);
  fsSync.mkdirSync(smokeUserData, { recursive: true });
  app.setPath("userData", smokeUserData);
} else if (!app.isPackaged) {
  const devUserData = path.join(app.getPath("appData"), "desktop-note-dev");
  fsSync.mkdirSync(devUserData, { recursive: true });
  app.setPath("userData", devUserData);
}

const diagnosticLogger = createBoundedFileLogger(
  path.join(app.getPath("userData"), "note-data", "note-error.log"),
);

function reportError(context, error) {
  console.error(context, error);
  void diagnosticLogger.error(context, error);
}

function reportWarning(context, detail) {
  console.warn(context, detail);
  void diagnosticLogger.warn(context, detail);
}

const stateWriter = createSerializedWriter(async ({ payload, shouldBackup, durable }) => {
  await fs.mkdir(dataDirectory, { recursive: true });
  if (shouldBackup) {
    try {
      await fs.copyFile(stateFile, backupFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await fs.writeFile(tempFile, payload, { encoding: "utf8", flush: Boolean(durable) });
  try {
    await fs.rename(tempFile, stateFile);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.rm(stateFile, { force: true });
    await fs.rename(tempFile, stateFile);
  }
}, (error) => reportError("Previous state write failed; retrying with the latest state", error));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function assetPath(...parts) {
  return path.join(app.getAppPath(), "assets", ...parts);
}

function pickIcon() {
  if (cachedIcon) return cachedIcon;
  for (const name of ["note-tray.png", "note.png", "note.svg"]) {
    const candidate = assetPath(name);
    if (fsSync.existsSync(candidate)) {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        cachedIcon = image;
        return cachedIcon;
      }
    }
  }
  cachedIcon = nativeImage.createEmpty();
  return cachedIcon;
}

async function loadState() {
  dataDirectory = path.join(app.getPath("userData"), "note-data");
  attachmentsDirectory = path.join(dataDirectory, "attachments");
  stateFile = path.join(dataDirectory, "state.json");
  backupFile = path.join(dataDirectory, "state.json.bak");
  tempFile = path.join(dataDirectory, "state.json.tmp");
  await Promise.all([
    fs.mkdir(dataDirectory, { recursive: true }),
    fs.mkdir(attachmentsDirectory, { recursive: true }),
  ]);

  const candidateResults = await Promise.all([
    { kind: "primary", file: stateFile },
    { kind: "temporary", file: tempFile },
    { kind: "backup", file: backupFile },
  ].map(async (candidate) => {
    try {
      const raw = JSON.parse(await fs.readFile(candidate.file, "utf8"));
      if (!isPersistedStateShape(raw)) throw new Error("invalid state structure");
      return { ...candidate, raw, error: null };
    } catch (error) {
      return { ...candidate, raw: null, error };
    }
  }));

  const candidates = [];
  const candidateErrors = [];
  for (const candidate of candidateResults) {
    if (!candidate.error) {
      candidates.push(candidate);
      continue;
    }
    if (candidate.error?.code !== "ENOENT") {
      candidateErrors.push({ file: candidate.file, error: candidate.error });
      reportWarning(`Unable to use ${candidate.file}`, candidate.error);
    }
  }

  const selected = selectLatestValidCandidate(candidates, isPersistedStateShape);
  if (selected) {
    pendingUpgrade = await createUpgradeSnapshot({
      dataDirectory,
      rawState: selected.raw,
      sourceKind: selected.kind,
      currentVersion: app.getVersion(),
    });
    const raw = structuredClone(selected.raw);
    const legacySchema = raw.schemaVersion !== SCHEMA_VERSION;
    const legacyFloatingDefault = raw.settings?.windowMode === "floating"
      && raw.settings?.windowModeVersion !== 1;
    if (legacyFloatingDefault) raw.settings.windowMode = "desktop";
    needsStateMigration = legacySchema || legacyFloatingDefault || raw.settings?.windowModeVersion !== 1;
    state = ensureCurrentDay(normalizeState(raw), new Date());
    primaryCanBeBackedUp = selected.kind === "primary";
    if (selected.kind !== "primary") reportWarning("Recovered state from a fallback candidate", selected.kind);
    return;
  }

  if (candidateErrors.length) {
    const details = candidateErrors
      .map(({ file, error }) => `${path.basename(file)}: ${error?.message || error}`)
      .join("; ");
    throw new Error(`发现现有数据文件但无法安全读取，已停止启动以避免覆盖。${details}`);
  }

  pendingUpgrade = await createUpgradeSnapshot({
    dataDirectory,
    rawState: null,
    sourceKind: "new-install",
    currentVersion: app.getVersion(),
  });
  state = createInitialState();
  primaryCanBeBackedUp = false;
}

function persistState(snapshot = state, { durable = false } = {}) {
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  const shouldBackup = primaryCanBeBackedUp;
  return stateWriter.write({ payload, shouldBackup, durable }).then(() => {
    primaryCanBeBackedUp = true;
  });
}

function managedAttachmentPath(relativePath) {
  if (typeof relativePath !== "string" || !/^attachments\/[A-Za-z0-9._-]+$/.test(relativePath)) {
    throw new Error("Invalid managed attachment path");
  }
  const resolved = path.resolve(dataDirectory, ...relativePath.split("/"));
  const root = `${path.resolve(attachmentsDirectory)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error("Attachment path escaped the managed directory");
  return resolved;
}

function attachmentPathMap(snapshot) {
  const files = new Map();
  for (const note of Object.values(snapshot?.notes || {})) {
    for (const attachment of note.attachments || []) {
      try {
        files.set(attachment.id, managedAttachmentPath(attachment.relativePath));
      } catch (error) {
        reportWarning("Ignored an invalid managed attachment path", error);
      }
    }
  }
  return files;
}

async function cleanupRemovedAttachments(beforeSnapshot, afterSnapshot) {
  const before = attachmentPathMap(beforeSnapshot);
  const after = attachmentPathMap(afterSnapshot);
  const removals = [];
  for (const [id, file] of before) {
    if (!after.has(id)) removals.push(fs.rm(file, { force: true }));
  }
  if (removals.length) await Promise.allSettled(removals);
}

async function cleanupOrphanedAttachments(snapshot = state) {
  try {
    const referenced = new Set(attachmentPathMap(snapshot).values());
    const entries = await fs.readdir(attachmentsDirectory, { withFileTypes: true });
    const removals = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(attachmentsDirectory, entry.name))
      .filter((file) => !referenced.has(file))
      .map((file) => fs.rm(file, { force: true }));
    if (removals.length) await Promise.allSettled(removals);
  } catch (error) {
    reportWarning("Unable to clean orphaned Note images", error);
  }
}

function findAttachment(id) {
  if (typeof id !== "string" || !id) return null;
  for (const note of Object.values(state?.notes || {})) {
    const attachment = (note.attachments || []).find((item) => item.id === id);
    if (attachment) return { note, attachment };
  }
  return null;
}

function registerAttachmentProtocol() {
  protocol.handle(NOTE_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "local") throw new Error("Invalid attachment host");
      const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const found = findAttachment(id);
      if (!found) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(managedAttachmentPath(found.attachment.relativePath)).href);
    } catch (error) {
      reportWarning("Unable to serve a Note image", error);
      return new Response("Not found", { status: 404 });
    }
  });
}

function imageTypeFromBytes(buffer) {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function bufferFromRenderer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("无法读取图片数据");
}

async function addNoteImage(noteId, payload) {
  const note = state?.notes?.[noteId];
  if (!note || note.trashedAt) return { ok: false, error: "未找到笔记", state: publicState() };
  let file = null;
  try {
    const bytes = bufferFromRenderer(payload?.bytes);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片必须小于 20 MB");
    const mimeType = imageTypeFromBytes(bytes);
    if (!mimeType || (payload?.mimeType && payload.mimeType !== mimeType)) throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
    const id = randomUUID();
    const extension = imageExtension(mimeType);
    const relativePath = `attachments/${id}${extension}`;
    file = managedAttachmentPath(relativePath);
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, bytes, { flush: true });
    await fs.rename(temporary, file);
    const attachment = {
      id,
      fileName: path.basename(String(payload?.fileName || `image${extension}`)),
      mimeType,
      relativePath,
      createdAt: new Date().toISOString(),
    };
    const result = await mutate({ type: "note:attachment:add", id: noteId, attachment });
    if (!result.ok) {
      const retained = state?.notes?.[noteId]?.attachments?.some((item) => item.id === id);
      if (!retained) await fs.rm(file, { force: true });
      return result;
    }
    return { ...result, attachment, markdown: `![${attachment.fileName}](${noteAssetUrl(id)})` };
  } catch (error) {
    const retained = file && [...attachmentPathMap(state).values()].includes(file);
    if (file && !retained) await fs.rm(file, { force: true }).catch(() => {});
    return { ok: false, error: error?.message || "无法添加图片", state: publicState() };
  }
}

function safeChildPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...String(relativePath).split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Export path escaped the selected directory");
  }
  return resolved;
}

async function uniqueExportDirectory(parent) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const base = `Note-library-${stamp}`;
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(parent, index === 1 ? base : `${base}-${index}`);
    try {
      await fs.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法创建唯一的导出目录");
}

async function exportNotesLibrary() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择笔记库导出位置",
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "导出到这里",
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  const root = await uniqueExportDirectory(result.filePaths[0]);
  const plan = createLibraryExportPlan(state);
  try {
    for (const note of plan.notes) {
      const destination = safeChildPath(root, note.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, note.content, "utf8");
      for (const asset of note.assets) {
        const source = managedAttachmentPath(asset.sourceRelativePath);
        const target = safeChildPath(root, asset.relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      }
    }
    return { ok: true, directory: root, noteCount: plan.notes.length };
  } catch (error) {
    reportError("Unable to export the notes library", error);
    return { ok: false, error: error?.message || "导出笔记库失败" };
  }
}

function markdownLocalImageUrls(markdown) {
  const urls = new Set();
  const pattern = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
  for (const match of String(markdown || "").matchAll(pattern)) {
    const value = match[1] || match[2];
    if (!value || /^(?:https?:|data:|note-asset:|file:)/i.test(value)) continue;
    urls.add(value);
  }
  return [...urls];
}

async function inspectMarkdownImport(filePaths) {
  const records = [];
  let imageBytes = 0;
  let imageCount = 0;
  for (const file of filePaths) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMPORTED_MARKDOWN_BYTES) {
      throw new Error(`Markdown 文件必须小于 5 MB：${path.basename(file)}`);
    }
    const body = await fs.readFile(file, "utf8");
    const sourceRoot = path.resolve(path.dirname(file));
    const images = [];
    for (const rawUrl of markdownLocalImageUrls(body)) {
      if (imageCount >= 100) break;
      let decoded;
      try {
        decoded = decodeURIComponent(rawUrl);
      } catch {
        continue;
      }
      if (path.isAbsolute(decoded)) continue;
      const candidate = path.resolve(sourceRoot, decoded.replaceAll("/", path.sep));
      if (!candidate.startsWith(`${sourceRoot}${path.sep}`)) continue;
      try {
        const imageStat = await fs.stat(candidate);
        if (!imageStat.isFile() || imageStat.size > MAX_IMAGE_BYTES) continue;
        if (imageBytes + imageStat.size > 100 * 1024 * 1024) continue;
        const bytes = await fs.readFile(candidate);
        const mimeType = imageTypeFromBytes(bytes);
        if (!mimeType) continue;
        images.push({ rawUrl, file: candidate, bytes, mimeType });
        imageBytes += bytes.length;
        imageCount += 1;
      } catch {
        // Broken local image references remain unchanged in the imported Markdown.
      }
    }
    records.push({ file, body, images });
  }
  return { records, imageCount };
}

async function importMarkdownFiles(destinationNotebookId = null) {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "导入 Markdown 笔记",
    defaultPath: app.getPath("documents"),
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    properties: ["openFile", "multiSelections"],
    buttonLabel: "选择笔记",
  });
  if (selection.canceled || !selection.filePaths?.length) return { ok: false, canceled: true };

  let inspected;
  try {
    inspected = await inspectMarkdownImport(selection.filePaths);
  } catch (error) {
    return { ok: false, error: error?.message || "无法读取 Markdown 文件", state: publicState() };
  }

  let copyImages = false;
  if (inspected.imageCount) {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "同时导入本地图片？",
      message: `发现 ${inspected.imageCount} 张可复制的本地图片。`,
      detail: "复制后图片由 Note 管理，并会随整库导出。选择“只导入文字”会保留原 Markdown 路径。",
      buttons: ["导入并复制图片", "只导入文字", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (confirmation.response === 2) return { ok: false, canceled: true };
    copyImages = confirmation.response === 0;
  }

  const createdFiles = [];
  const before = state;
  let next = state;
  try {
    for (const record of inspected.records) {
      let body = record.body;
      const attachments = [];
      if (copyImages) {
        for (const image of record.images) {
          const id = randomUUID();
          const extension = imageExtension(image.mimeType);
          const relativePath = `attachments/${id}${extension}`;
          const destination = managedAttachmentPath(relativePath);
          const temporary = `${destination}.tmp`;
          await fs.writeFile(temporary, image.bytes, { flush: true });
          await fs.rename(temporary, destination);
          createdFiles.push(destination);
          body = body.split(image.rawUrl).join(noteAssetUrl(id));
          attachments.push({
            id,
            fileName: path.basename(image.file),
            mimeType: image.mimeType,
            relativePath,
            createdAt: new Date().toISOString(),
          });
        }
      }
      const idsBefore = new Set(Object.keys(next.notes));
      next = applyOperation(next, {
        type: "note:add",
        notebookId: destinationNotebookId,
        title: deriveImportedTitle(path.basename(record.file), body),
        body,
      }, new Date());
      const noteId = Object.keys(next.notes).find((id) => !idsBefore.has(id));
      if (!noteId) throw new Error("无法创建导入笔记");
      for (const attachment of attachments) {
        next = applyOperation(next, { type: "note:attachment:add", id: noteId, attachment }, new Date());
      }
    }
    state = next;
    broadcastState("saving");
    await persistState(next);
    if (state.revision === next.revision) sendSaveStatus("saved");
    return { ok: true, importedCount: inspected.records.length, state: publicState() };
  } catch (error) {
    state = before;
    await Promise.allSettled(createdFiles.map((file) => fs.rm(file, { force: true })));
    broadcastState("error");
    return { ok: false, error: error?.message || "导入 Markdown 失败", state: publicState() };
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function broadcastState(status = "saving") {
  currentSaveStatus = status;
  sendToRenderer("note:state", { state: publicState(), status });
}

function sendSaveStatus(status) {
  currentSaveStatus = status;
  sendToRenderer("note:save-status", status);
}

function publicState() {
  return {
    ...structuredClone(state),
    runtime: {
      shortcutFailures: [...shortcutFailures],
      desktopHostError,
      desktopTemporarilyLifted,
    },
  };
}

function visibleWindow() {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
}

async function showWindow({ focusInput = false, settings = false, temporaryForeground = false } = {}) {
  if (quitPreparationInProgress || quitFlushInProgress) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (state.settings.locked) {
    state = applyOperation(state, { type: "settings:set", key: "locked", value: false });
    mainWindow.setIgnoreMouseEvents(false);
    persistState(state).catch((error) => reportError("Unable to save the unlocked state", error));
    rebuildTrayMenu();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (state.settings.windowMode === "desktop" && temporaryForeground) {
    desktopTemporarilyLifted = true;
    await applyWindowMode({ temporaryForeground: true });
  }
  mainWindow.show();
  mainWindow.focus();
  if (focusInput) sendToRenderer("note:focus-input");
  if (settings) sendToRenderer("note:show-settings");
  rebuildTrayMenu();
}

function toggleWindow() {
  if (visibleWindow() && mainWindow.isFocused()) mainWindow.hide();
  else void showWindow({ temporaryForeground: true });
  rebuildTrayMenu();
}

async function createBlankNoteAndShow() {
  const candidateNotebookId = state?.settings?.notesLastNotebookId;
  const notebook = candidateNotebookId ? state?.notebooks?.[candidateNotebookId] : null;
  const result = await mutate({
    type: "note:add",
    notebookId: notebook && !notebook.trashedAt ? notebook.id : null,
  });
  if (result.ok || state.settings.activeModule === "notes") await showWindow({ temporaryForeground: true });
  return result;
}

async function showTodoCapture() {
  const result = await mutate({ type: "settings:set", key: "activeModule", value: "todo" });
  if (result.ok || state.settings.activeModule === "todo") {
    await showWindow({ focusInput: true, temporaryForeground: true });
  }
  return result;
}

async function applyWindowMode({ temporaryForeground = false, persistFallback = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const epoch = ++windowModeEpoch;
  const mode = state.settings.windowMode;
  let finalStatus = currentSaveStatus;
  nativeModeTransition = true;
  try {
    if (mode === "desktop" && !temporaryForeground) {
      mainWindow.setAlwaysOnTop(false, "normal");
      mainWindow.setSkipTaskbar(true);
      if (epoch !== windowModeEpoch || !mainWindow || mainWindow.isDestroyed()) return;
      desktopTemporarilyLifted = false;
      desktopHostError = null;
    } else {
      if (epoch !== windowModeEpoch || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setSkipTaskbar(mode === "desktop");
      const floating = mode === "floating" || (mode === "desktop" && temporaryForeground);
      mainWindow.setAlwaysOnTop(floating, floating ? "floating" : "normal");
      if (mode !== "desktop") desktopTemporarilyLifted = false;
      desktopHostError = null;
    }
  } catch (error) {
    desktopHostError = error?.message || "无法连接 Windows 桌面层";
    reportError("Unable to apply the requested window layer", error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setAlwaysOnTop(false, "normal");
        mainWindow.setSkipTaskbar(false);
      } catch (fallbackError) {
        reportError("Unable to restore the normal window layer", fallbackError);
      }
    }
    if (mode !== "normal" && state.settings.windowMode === mode) {
      state = applyOperation(state, {
        type: "settings:set",
        key: "windowMode",
        value: "normal",
      });
      desktopTemporarilyLifted = false;
      rebuildTrayMenu();
      if (persistFallback) {
        const fallbackSnapshot = state;
        try {
          await persistState(fallbackSnapshot);
          if (state.revision === fallbackSnapshot.revision) {
            sendSaveStatus("saved");
          }
        } catch (persistError) {
          finalStatus = "error";
          reportError("Unable to save the automatic normal-window fallback", persistError);
          sendSaveStatus("error");
        }
      } else {
        finalStatus = "saving";
      }
    }
  } finally {
    if (epoch === windowModeEpoch) {
      nativeModeTransition = false;
      broadcastState(finalStatus);
    }
  }
}

function applyLockedState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(Boolean(state.settings.locked), { forward: true });
}

function loginExecutablePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function applyLaunchAtLogin() {
  const enabled = Boolean(state.settings.launchAtLogin);
  const settings = app.isPackaged
    ? { openAtLogin: enabled, path: loginExecutablePath() }
    : { openAtLogin: enabled, path: process.execPath, args: [app.getAppPath()] };
  app.setLoginItemSettings(settings);
}

function clampBounds(savedBounds) {
  const requested = requestedWindowRectangle(savedBounds);
  const display = savedBounds
    ? screen.getDisplayMatching(requested)
    : screen.getPrimaryDisplay();
  return fitWindowBounds(savedBounds, display.workArea);
}

function needsLegacyRoundedShape() {
  if (process.platform !== "win32") return false;
  const build = Number.parseInt(os.release().split(".")[2] || "0", 10);
  return build > 0 && build < 22000;
}

function roundedWindowShape(width, height, radius = LEGACY_WINDOW_RADIUS) {
  const safeRadius = Math.max(1, Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)));
  const rects = [{ x: 0, y: safeRadius, width, height: height - safeRadius * 2 }];
  for (let y = 0; y < safeRadius; y += 1) {
    const distance = safeRadius - y - 0.5;
    const inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt((safeRadius ** 2) - (distance ** 2))));
    const row = { x: inset, width: width - inset * 2, height: 1 };
    rects.push({ ...row, y });
    rects.push({ ...row, y: height - y - 1 });
  }
  return rects;
}

function applyLegacyRoundedShape(window, width, height) {
  if (!needsLegacyRoundedShape() || typeof window?.setShape !== "function") return;
  try {
    window.setShape(roundedWindowShape(width, height));
  } catch (error) {
    reportWarning("Unable to apply the Windows 10 Note window shape", error);
  }
}

function scheduleLegacyRoundedShape() {
  if (!needsLegacyRoundedShape() || legacyShapeTimer) return;
  legacyShapeTimer = setTimeout(() => {
    legacyShapeTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { width, height } = mainWindow.getBounds();
    applyLegacyRoundedShape(mainWindow, width, height);
  }, 16);
}

function resolveDevServerUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return null;
  try {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (url.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function packagedEntryUrl() {
  return pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href;
}

function isAllowedRendererUrl(value) {
  try {
    if (devServerUrl) {
      const actual = new URL(value);
      const expected = new URL(devServerUrl);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    }
    const expected = packagedEntryUrl();
    return value === expected || value.startsWith(`${expected}?`) || value.startsWith(`${expected}#`);
  } catch {
    return false;
  }
}

function createWindow() {
  const initialBounds = clampBounds(state.settings.windowBounds);
  const icon = pickIcon();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: WINDOW_METRICS.minWidth,
    minHeight: WINDOW_METRICS.minHeight,
    maxWidth: WINDOW_METRICS.maxWidth,
    maxHeight: WINDOW_METRICS.maxHeight,
    show: false,
    frame: false,
    roundedCorners: true,
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: true,
    backgroundColor: "#f7f3ef",
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  applyLegacyRoundedShape(mainWindow, initialBounds.width, initialBounds.height);

  applyLockedState();

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const editable = Boolean(params.isEditable);
    const hasSelection = Boolean(params.selectionText);
    if (!editable && !hasSelection) return;
    const flags = params.editFlags || {};
    const template = editable ? [
      { label: "撤销", role: "undo", enabled: Boolean(flags.canUndo) },
      { label: "重做", role: "redo", enabled: Boolean(flags.canRedo) },
      { type: "separator" },
      { label: "剪切", role: "cut", enabled: Boolean(flags.canCut) },
      { label: "复制", role: "copy", enabled: Boolean(flags.canCopy) },
      { label: "粘贴", role: "paste", enabled: Boolean(flags.canPaste) },
      { label: "粘贴为纯文本", role: "pasteAndMatchStyle", enabled: Boolean(flags.canPaste) },
      { type: "separator" },
      { label: "全选", role: "selectAll", enabled: Boolean(flags.canSelectAll) },
    ] : [
      { label: "复制", role: "copy", enabled: hasSelection },
      { label: "全选", role: "selectAll" },
    ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    reportError("Note renderer stopped", details?.reason || "unknown reason");
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  if (devServerUrl) mainWindow.loadURL(devServerUrl);
  else mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));

  let revealRequested = false;
  const revealWindow = () => {
    if (revealRequested || !mainWindow || mainWindow.isDestroyed()) return;
    revealRequested = true;
    void applyWindowMode().finally(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
      if (state.settings.locked) mainWindow.setIgnoreMouseEvents(true, { forward: true });
      if (startupSaveFailed) sendSaveStatus("error");
      setImmediate(startBackgroundServices);
    });
  };
  mainWindow.webContents.once("dom-ready", revealWindow);
  mainWindow.once("ready-to-show", revealWindow);

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      app.quit();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (isQuitting || quitFlushInProgress || quitPreparationInProgress) return;
    clearTimeout(windowRecoveryTimer);
    windowRecoveryTimer = setTimeout(() => {
      if (!mainWindow && !isQuitting) createWindow();
    }, 800);
  });

  const scheduleWindowBoundsSave = () => {
    if (nativeModeTransition) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const { x, y, width, height } = mainWindow.getBounds();
      const saved = state.settings.windowBounds;
      if (saved?.x === x
        && saved?.y === y
        && saved?.width === width
        && saved?.height === height) return;
      state = applyOperation(state, {
        type: "settings:set",
        key: "windowBounds",
        value: { x, y, width, height },
      });
      broadcastState();
      const snapshot = state;
      try {
        await persistState(snapshot);
        if (state.revision === snapshot.revision) sendSaveStatus("saved");
      } catch (error) {
        reportError("Unable to save window bounds", error);
        sendSaveStatus("error");
      }
    }, 350);
  };

  mainWindow.on("move", scheduleWindowBoundsSave);
  mainWindow.on("resize", () => {
    scheduleLegacyRoundedShape();
    scheduleWindowBoundsSave();
  });

  mainWindow.on("blur", () => {
    if (!desktopTemporarilyLifted || state.settings.windowMode !== "desktop") return;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!desktopTemporarilyLifted || state.settings.windowMode !== "desktop") return;
      void applyWindowMode();
    }, 180);
  });
}

async function mutate(operation) {
  if (quitFlushInProgress) {
    return { ok: false, error: "Note 正在退出", state: publicState() };
  }
  try {
    const before = state;
    const next = applyOperation(before, operation, new Date());
    state = next;
    if (next.revision === before.revision) {
      return { ok: true, unchanged: true, state: publicState() };
    }
    broadcastState("saving");
    if (operation.type === "settings:set") {
      if (operation.key === "windowMode") await applyWindowMode({ persistFallback: false });
      if (operation.key === "locked") applyLockedState();
      if (operation.key === "launchAtLogin") applyLaunchAtLogin();
      if (["windowMode", "locked", "launchAtLogin"].includes(operation.key)) rebuildTrayMenu();
    }
    const snapshot = state;
    await persistState(snapshot);
    await cleanupRemovedAttachments(before, snapshot);
    if (state.revision === snapshot.revision) sendSaveStatus("saved");
    return { ok: true, state: publicState() };
  } catch (error) {
    sendSaveStatus("error");
    return { ok: false, error: error?.message || "操作失败", state: publicState() };
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: visibleWindow() ? "隐藏 Note" : "显示 Note",
      click: toggleWindow,
    },
    {
      label: "快速记录",
      accelerator: SHORTCUT_CAPTURE,
      click: () => void showTodoCapture(),
    },
    {
      label: "新建笔记",
      accelerator: SHORTCUT_NEW_NOTE,
      click: () => void createBlankNoteAndShow(),
    },
    ...(shortcutFailures.length ? [{
      label: `快捷键被占用：${shortcutFailures.join("、")}（仍可使用托盘）`,
      enabled: false,
    }] : []),
    { type: "separator" },
    {
      label: "桌面底层",
      type: "radio",
      checked: state.settings.windowMode === "desktop",
      click: () => mutate({ type: "settings:set", key: "windowMode", value: "desktop" }),
    },
    {
      label: "普通窗口",
      type: "radio",
      checked: state.settings.windowMode === "normal",
      click: () => mutate({ type: "settings:set", key: "windowMode", value: "normal" }),
    },
    {
      label: "常驻最前",
      type: "radio",
      checked: state.settings.windowMode === "floating",
      click: () => mutate({ type: "settings:set", key: "windowMode", value: "floating" }),
    },
    {
      label: "锁定在桌面（鼠标穿透）",
      type: "checkbox",
      checked: Boolean(state.settings.locked),
      click: (item) => mutate({ type: "settings:set", key: "locked", value: item.checked }),
    },
    {
      label: "开机启动",
      type: "checkbox",
      checked: Boolean(state.settings.launchAtLogin),
      click: (item) => mutate({ type: "settings:set", key: "launchAtLogin", value: item.checked }),
    },
    { type: "separator" },
    {
      label: "设置…",
      click: () => void showWindow({ settings: true, temporaryForeground: true }),
    },
    {
      label: "打开数据文件夹",
      click: () => shell.openPath(dataDirectory),
    },
    { type: "separator" },
    {
      label: "退出 Note",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip("Note · Todo 与笔记");
}

function createTray() {
  const icon = pickIcon();
  tray = new Tray(icon);
  tray.on("click", () => void showWindow({ temporaryForeground: true }));
}

function startBackgroundServices() {
  if (backgroundServicesStarted || isQuitting || quitPreparationInProgress || quitFlushInProgress) return;
  clearTimeout(backgroundServicesTimer);
  backgroundServicesTimer = null;
  try {
    if (!tray) createTray();
    registerShortcuts();
    backgroundServicesStarted = true;
  } catch (error) {
    reportError("Unable to initialize tray and global shortcuts", error);
    backgroundServicesTimer = setTimeout(startBackgroundServices, 3000);
  }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutFailures = [];
  const shortcuts = [
    { label: "显示/隐藏", accelerator: SHORTCUT_TOGGLE, action: toggleWindow },
    { label: "快速记录", accelerator: SHORTCUT_CAPTURE, action: () => void showTodoCapture() },
    { label: "新建笔记", accelerator: SHORTCUT_NEW_NOTE, action: () => void createBlankNoteAndShow() },
    {
      label: "锁定/解锁",
      accelerator: SHORTCUT_LOCK,
      action: () => mutate({ type: "settings:set", key: "locked", value: !state.settings.locked }),
    },
  ];
  for (const shortcut of shortcuts) {
    try {
      if (!globalShortcut.register(shortcut.accelerator, shortcut.action)) {
        shortcutFailures.push(`${shortcut.label} ${shortcut.accelerator}`);
      }
    } catch {
      shortcutFailures.push(`${shortcut.label} ${shortcut.accelerator}`);
    }
  }
  rebuildTrayMenu();
  broadcastState(currentSaveStatus);
}

function isTrustedIpcEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const currentRendererUrl = mainWindow.webContents.getURL();
  return isTrustedRendererEvent(
    event,
    mainWindow.webContents,
    (senderUrl) => isSameDocumentUrl(senderUrl, currentRendererUrl),
  );
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event)) throw new Error("Unauthorized IPC sender");
    return handler(...args);
  });
}

function registerIpc() {
  handleTrustedIpc("note:get-state", () => ({ ok: true, state: publicState() }));
  handleTrustedIpc("note:mutate", (operation) => mutate(operation));
  handleTrustedIpc("note:open-settings", () => {
    void showWindow({ settings: true, temporaryForeground: true });
    return { ok: true };
  });
  handleTrustedIpc("note:open-data-folder", async () => ({ ok: true, error: await shell.openPath(dataDirectory) }));
  handleTrustedIpc("note:open-backup-folder", async () => {
    const backupDirectory = path.join(dataDirectory, BACKUP_DIRECTORY_NAME);
    await fs.mkdir(backupDirectory, { recursive: true });
    return { ok: true, error: await shell.openPath(backupDirectory) };
  });
  handleTrustedIpc("note:add-image", (noteId, payload) => addNoteImage(noteId, payload));
  handleTrustedIpc("note:export-library", () => exportNotesLibrary());
  handleTrustedIpc("note:import-markdown", (notebookId) => importMarkdownFiles(notebookId));
  handleTrustedIpc("note:export-markdown", async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出 Note",
      defaultPath: path.join(app.getPath("documents"), `Note-${state.activeDay}.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fs.writeFile(result.filePath, markdownForState(state), "utf8");
    return { ok: true, filePath: result.filePath };
  });
  handleTrustedIpc("note:set-window-mode", (mode) => mutate({
    type: "settings:set",
    key: "windowMode",
    value: mode,
  }));
  handleTrustedIpc("note:set-locked", (locked) => mutate({
    type: "settings:set",
    key: "locked",
    value: locked,
  }));
  handleTrustedIpc("note:set-launch-at-login", (enabled) => mutate({
    type: "settings:set",
    key: "launchAtLogin",
    value: enabled,
  }));
  handleTrustedIpc("note:quit-ready", () => {
    beginQuitFlush();
    return { ok: true };
  });
}

function captureWindowBoundsInMemory() {
  if (!state || !mainWindow || mainWindow.isDestroyed()) return;
  const { x, y, width, height } = mainWindow.getBounds();
  const saved = state.settings.windowBounds;
  if (saved?.x === x
    && saved?.y === y
    && saved?.width === width
    && saved?.height === height) return;
  state = applyOperation(state, {
    type: "settings:set",
    key: "windowBounds",
    value: { x, y, width, height },
  });
}

function cleanupRuntime() {
  clearInterval(dayTimer);
  clearTimeout(boundsTimer);
  clearTimeout(legacyShapeTimer);
  clearTimeout(backgroundServicesTimer);
  clearTimeout(quitPreparationTimer);
  clearTimeout(windowRecoveryTimer);
  globalShortcut.unregisterAll();
}

function beginQuitFlush() {
  if (quitFlushComplete || quitFlushInProgress || !state) return;
  clearTimeout(quitPreparationTimer);
  quitPreparationTimer = null;
  quitPreparationInProgress = false;
  quitFlushInProgress = true;
  void flushBeforeQuit();
}

function prepareToQuit() {
  if (quitPreparationInProgress || quitFlushInProgress || !state) return;
  quitPreparationInProgress = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setEnabled(false);
    sendToRenderer("note:prepare-quit");
  }
  quitPreparationTimer = setTimeout(beginQuitFlush, 1200);
}

async function flushBeforeQuit() {
  clearTimeout(boundsTimer);
  captureWindowBoundsInMemory();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  rebuildTrayMenu();
  sendSaveStatus("saving");
  try {
    await persistState(state, { durable: true });
    await diagnosticLogger.flush();
    quitFlushComplete = true;
    isQuitting = true;
    cleanupRuntime();
    app.quit();
  } catch (error) {
    reportError("Unable to save before quit", error);
    await diagnosticLogger.flush();
    quitFlushInProgress = false;
    sendSaveStatus("error");
    const options = {
      type: "warning",
      title: "Note 尚未保存",
      message: "最后一次修改还没有写入磁盘。",
      detail: "建议返回 Note 后检查磁盘空间或数据目录权限；也可以选择仍然退出。",
      buttons: ["返回 Note", "仍然退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 1) {
      quitFlushComplete = true;
      isQuitting = true;
      cleanupRuntime();
      app.quit();
    } else {
      isQuitting = false;
      quitPreparationInProgress = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true);
      void showWindow({ temporaryForeground: true });
    }
  }
}

if (gotLock) {
app.on("second-instance", () => void showWindow({ temporaryForeground: true }));

app.whenReady().then(async () => {
  devServerUrl = resolveDevServerUrl();
  await loadState();
  let startupStateCommitted = false;
  if (pendingUpgrade?.required) {
    try {
      if (!primaryCanBeBackedUp || needsStateMigration) {
        await persistState(state, { durable: true });
        startupStateCommitted = true;
        needsStateMigration = false;
      }
      await completeUpgrade(dataDirectory, app.getVersion());
    } catch (error) {
      let restored = false;
      if (pendingUpgrade.hasSnapshot) {
        try {
          await restoreUpgradeSnapshot(dataDirectory, stateFile);
          restored = true;
        } catch (restoreError) {
          reportError("Unable to restore the pre-upgrade state", restoreError);
        }
      }
      const recoveryMessage = restored
        ? "已自动恢复升级前快照。"
        : pendingUpgrade.hasSnapshot
          ? "自动恢复未完成，升级快照仍保留在数据目录中。"
          : "尚未写入任何旧数据。";
      throw new Error(`升级数据时发生错误，${recoveryMessage}${error?.message || error}`);
    }
  }
  await cleanupOrphanedAttachments(state);
  registerAttachmentProtocol();
  const login = app.getLoginItemSettings(app.isPackaged
    ? { path: loginExecutablePath() }
    : { path: process.execPath, args: [app.getAppPath()] });
  const launchAtLogin = Boolean(login.openAtLogin);
  const needsStartupSave = (!startupStateCommitted && (!primaryCanBeBackedUp || needsStateMigration))
    || state.settings.launchAtLogin !== launchAtLogin;
  state.settings.launchAtLogin = launchAtLogin;
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  backgroundServicesTimer = setTimeout(startBackgroundServices, 1500);
  if (needsStartupSave) {
    const startupSnapshot = state;
    broadcastState("saving");
    void persistState(startupSnapshot).then(() => {
      if (state.revision === startupSnapshot.revision) sendSaveStatus("saved");
    }).catch((error) => {
      reportError("Unable to persist startup state", error);
      startupSaveFailed = true;
      sendSaveStatus("error");
    });
  }
  dayTimer = setInterval(async () => {
    if (quitFlushInProgress) return;
    const now = new Date();
    if (localDayKey(now, state.settings.dayBoundaryHour) === state.activeDay) return;
    const next = ensureCurrentDay(state, now);
    if (next.revision !== state.revision) {
      state = next;
      broadcastState();
      const snapshot = state;
      try {
        await persistState(snapshot);
        if (state.revision === snapshot.revision) sendSaveStatus("saved");
      } catch (error) {
        reportError("Unable to save day rollover", error);
        sendSaveStatus("error");
      }
    }
  }, 60_000);
}).catch(async (error) => {
  reportError("Note failed to start", error);
  await diagnosticLogger.flush();
  dialog.showErrorBox("Note 无法启动", `无法初始化窗口或数据目录。\n\n${error?.message || error}`);
  quitFlushComplete = true;
  isQuitting = true;
  cleanupRuntime();
  app.quit();
});

app.on("activate", () => void showWindow({ temporaryForeground: true }));
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (quitFlushComplete) {
    isQuitting = true;
    cleanupRuntime();
    return;
  }
  event.preventDefault();
  if (quitPreparationInProgress || quitFlushInProgress) return;
  if (!state) {
    quitFlushComplete = true;
    isQuitting = true;
    cleanupRuntime();
    app.quit();
    return;
  }
  prepareToQuit();
});
}
