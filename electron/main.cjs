const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createBoundedFileLogger } = require("./file-logger.cjs");
const { isSameDocumentUrl, isTrustedRendererEvent } = require("./ipc-security.cjs");
const { createSerializedWriter, selectLatestValidCandidate } = require("./persistence.cjs");
const {
  WINDOW_METRICS,
  fitWindowBounds,
  requestedWindowRectangle,
} = require("./window-bounds.cjs");
const {
  applyOperation,
  createInitialState,
  ensureCurrentDay,
  isPersistedStateShape,
  localDayKey,
  markdownForState,
  normalizeState,
} = require("../shared/store.cjs");

const LEGACY_WINDOW_RADIUS = 10;
const SHORTCUT_TOGGLE = "CommandOrControl+Alt+N";
const SHORTCUT_CAPTURE = "CommandOrControl+Alt+Space";
const SHORTCUT_LOCK = "CommandOrControl+Alt+L";

let mainWindow = null;
let tray = null;
let state = null;
let stateFile = null;
let backupFile = null;
let tempFile = null;
let dataDirectory = null;
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

if (!app.isPackaged) {
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
  stateFile = path.join(dataDirectory, "state.json");
  backupFile = path.join(dataDirectory, "state.json.bak");
  tempFile = path.join(dataDirectory, "state.json.tmp");
  await fs.mkdir(dataDirectory, { recursive: true });

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
    const raw = structuredClone(selected.raw);
    const legacyFloatingDefault = raw.settings?.windowMode === "floating"
      && raw.settings?.windowModeVersion !== 1;
    if (legacyFloatingDefault) raw.settings.windowMode = "desktop";
    needsStateMigration = legacyFloatingDefault || raw.settings?.windowModeVersion !== 1;
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
    state = applyOperation(state, operation, new Date());
    broadcastState("saving");
    if (operation.type === "settings:set") {
      if (operation.key === "windowMode") await applyWindowMode({ persistFallback: false });
      if (operation.key === "locked") applyLockedState();
      if (operation.key === "launchAtLogin") applyLaunchAtLogin();
      if (["windowMode", "locked", "launchAtLogin"].includes(operation.key)) rebuildTrayMenu();
    }
    const snapshot = state;
    await persistState(snapshot);
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
      click: () => void showWindow({ focusInput: true, temporaryForeground: true }),
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
  tray.setToolTip("Note · 今日清单");
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
    { label: "快速记录", accelerator: SHORTCUT_CAPTURE, action: () => void showWindow({ focusInput: true, temporaryForeground: true }) },
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
  const login = app.getLoginItemSettings(app.isPackaged
    ? { path: loginExecutablePath() }
    : { path: process.execPath, args: [app.getAppPath()] });
  const launchAtLogin = Boolean(login.openAtLogin);
  const needsStartupSave = !primaryCanBeBackedUp
    || needsStateMigration
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
