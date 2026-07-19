import storeModule from "desktop-note/store";
import {
  createLibraryExportPlan,
  deriveImportedTitle,
  imageExtension,
  noteAssetUrl,
} from "desktop-note/library-files";
const {
  SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  applyOperation,
  ensureCurrentDay,
  formatTimeRange,
  localDayKey,
  markdownForState,
  normalizeState,
  normalizeTimeRange,
} = storeModule;
export { formatTimeRange, normalizeTimeRange };
export const dayKey = localDayKey;

function applyBrowserOperation(state, operation, {
  now = new Date(),
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  return applyOperation(state, operation, now, { randomUUID });
}

export function makeFixture(now = new Date()) {
  const activeDayKey = localDayKey(now);
  const timestamp = now.toISOString();
  const items = [
    ["整理回归结果", "focus", true, { start: "09:00", end: "10:30" }],
    ["修改引言的研究动机", "focus", true, null],
    ["核对参考文献", "focus", true, { start: "23:00", end: "01:00" }],
    ["更新专利数据", "today", false, { start: "14:00", end: "15:15" }],
    ["回复合作者", "today", false, null],
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    activeDay: activeDayKey,
    days: {
      [activeDayKey]: {
        key: activeDayKey,
        tasks: items.map(([text, section, done, timeRange], index) => ({
          id: `fixture-${index + 1}`,
          text,
          section,
          order: section === "focus" ? index : index - 3,
          done,
          timeRange,
          noteId: index === 0 ? "fixture-note-method" : null,
          createdAt: timestamp,
          completedAt: done ? timestamp : null,
        })),
      },
    },
    pendingRollover: null,
    notebooks: {
      "fixture-notebook-research": {
        id: "fixture-notebook-research",
        name: "研究",
        order: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
      },
      "fixture-notebook-life": {
        id: "fixture-notebook-life",
        name: "日常",
        order: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
      },
    },
    notes: {
      "fixture-note-method": {
        id: "fixture-note-method",
        title: "专利数据口径",
        body: "## 当前口径\n\n- 申请年份按最早优先权日\n- 企业名称先统一社会信用代码\n\n> 下一步：核对 2012 年前缺失比例。",
        richBody: null,
        notebookId: "fixture-notebook-research",
        pinnedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
        trashedFromNotebookId: null,
        attachments: [],
      },
      "fixture-note-writing": {
        id: "fixture-note-writing",
        title: "引言修改思路",
        body: "# 引言修改思路\n\n先收紧研究问题，再解释制度背景。\n\n### 待补证据\n\n1. 行业层面的描述统计\n2. 机制变量的定义",
        richBody: null,
        notebookId: "fixture-notebook-research",
        pinnedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
        trashedFromNotebookId: null,
        attachments: [],
      },
      "fixture-note-reading": {
        id: "fixture-note-reading",
        title: "本周阅读",
        body: "- [ ] 重新读识别策略\n- [x] 整理变量定义\n- [ ] 记录可复现问题",
        richBody: null,
        notebookId: null,
        pinnedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
        trashedFromNotebookId: null,
        attachments: [],
      },
    },
    settings: {
      ...DEFAULT_SETTINGS,
      windowMode: "floating",
      notesLastNotebookId: "fixture-notebook-research",
      notesLastNoteId: "fixture-note-method",
      notesPane: "list",
    },
  };
}

export function createBrowserApi(browserWindow, {
  now = () => new Date(),
  randomUUID = () => browserWindow.crypto.randomUUID(),
} = {}) {
  if (!browserWindow) throw new TypeError("browserWindow is required");
  const fixtureMode = new URLSearchParams(browserWindow.location?.search || "").get("fixture") === "reference";
  const storageKey = "desktop-note-state-v1";
  const assetStorageKey = "desktop-note-assets-v1";
  const stateListeners = new Set();
  const saveListeners = new Set();
  const focusListeners = new Set();
  const settingsListeners = new Set();
  const quitListeners = new Set();
  const initialNow = now();

  let raw;
  try {
    raw = fixtureMode
      ? makeFixture(initialNow)
      : JSON.parse(browserWindow.localStorage.getItem(storageKey)) || makeFixture(initialNow);
  } catch {
    raw = makeFixture(initialNow);
  }
  if (!raw || typeof raw !== "object") raw = makeFixture(initialNow);

  let assetData = {};
  try {
    assetData = JSON.parse(browserWindow.localStorage.getItem(assetStorageKey)) || {};
  } catch {
    assetData = {};
  }
  if (!assetData || typeof assetData !== "object" || Array.isArray(assetData)) assetData = {};

  let state = normalizeState(raw, initialNow, { randomUUID });
  const initialRevision = state.revision;
  state = ensureCurrentDay(state, initialNow);
  if (!fixtureMode && state.revision !== initialRevision) {
    try {
      browserWindow.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Keep the recovered state in memory; a later mutation will report storage failures.
    }
  }

  function emit(status = "saved") {
    stateListeners.forEach((listener) => listener({ state: structuredClone(state), status }));
    saveListeners.forEach((listener) => listener(status));
  }

  function pruneAssetData() {
    const used = new Set(Object.values(state.notes || {}).flatMap((note) => (
      note.attachments || []
    ).map((attachment) => attachment.id)));
    assetData = Object.fromEntries(Object.entries(assetData).filter(([id]) => used.has(id)));
  }

  async function commit(next, nextAssetData = assetData) {
    if (next.revision === state.revision) {
      return { ok: true, unchanged: true, state: structuredClone(state) };
    }
    state = next;
    assetData = nextAssetData;
    pruneAssetData();
    emit("saving");
    try {
      if (!fixtureMode) {
        browserWindow.localStorage.setItem(storageKey, JSON.stringify(state));
        browserWindow.localStorage.setItem(assetStorageKey, JSON.stringify(assetData));
      }
      emit("saved");
      return { ok: true, state: structuredClone(state) };
    } catch (error) {
      emit("error");
      return { ok: false, error: error?.message || "保存失败", state: structuredClone(state) };
    }
  }

  async function mutate(operation) {
    let next;
    try {
      next = applyBrowserOperation(state, operation, { now: now(), randomUUID });
    } catch (error) {
      return { ok: false, error: error?.message || "操作失败", state: structuredClone(state) };
    }

    return commit(next);
  }

  function bytesFromPayload(payload) {
    const source = payload?.bytes;
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    throw new Error("无法读取图片数据");
  }

  function detectedImageType(bytes) {
    if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
    return null;
  }

  async function addNoteImage(noteId, payload) {
    try {
      const note = state.notes?.[noteId];
      if (!note || note.trashedAt) throw new Error("未找到笔记");
      const bytes = bytesFromPayload(payload);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("图片必须小于 20 MB");
      const mimeType = detectedImageType(bytes);
      if (!mimeType || (payload?.mimeType && payload.mimeType !== mimeType)) {
        throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
      }
      const id = randomUUID();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const encoder = browserWindow.btoa || globalThis.btoa;
      if (!encoder) throw new Error("当前预览环境无法保存图片");
      const attachment = {
        id,
        fileName: String(payload?.fileName || `image${imageExtension(mimeType)}`).split(/[\\/]/).pop(),
        mimeType,
        relativePath: `attachments/${id}${imageExtension(mimeType)}`,
        createdAt: now().toISOString(),
      };
      const next = applyBrowserOperation(state, { type: "note:attachment:add", id: noteId, attachment }, {
        now: now(),
        randomUUID,
      });
      const result = await commit(next, {
        ...assetData,
        [id]: `data:${mimeType};base64,${encoder(binary)}`,
      });
      return result.ok
        ? { ...result, attachment, markdown: `![${attachment.fileName}](${noteAssetUrl(id)})` }
        : result;
    } catch (error) {
      return { ok: false, error: error?.message || "无法添加图片", state: structuredClone(state) };
    }
  }

  function chooseMarkdownFiles() {
    if (!browserWindow.document?.createElement) return Promise.resolve(null);
    return new Promise((resolve) => {
      const input = browserWindow.document.createElement("input");
      input.type = "file";
      input.accept = ".md,.markdown,text/markdown,text/plain";
      input.multiple = true;
      let settled = false;
      const finish = (files) => {
        if (settled) return;
        settled = true;
        resolve(files);
      };
      input.addEventListener("change", () => finish([...input.files]));
      input.addEventListener("cancel", () => finish([]));
      input.click();
    });
  }

  async function importMarkdown(notebookId = null) {
    try {
      const files = await chooseMarkdownFiles();
      if (files === null) return { ok: false, error: "当前预览环境无法导入" };
      if (!files.length) return { ok: false, canceled: true };
      let next = state;
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) throw new Error(`Markdown 文件必须小于 5 MB：${file.name}`);
        const body = await file.text();
        next = applyBrowserOperation(next, {
          type: "note:add",
          notebookId,
          title: deriveImportedTitle(file.name, body),
          body,
        }, { now: now(), randomUUID });
      }
      const result = await commit(next);
      return result.ok ? { ...result, importedCount: files.length, textOnly: true } : result;
    } catch (error) {
      return { ok: false, error: error?.message || "导入 Markdown 失败", state: structuredClone(state) };
    }
  }

  function downloadHref(href, name) {
    const anchor = browserWindow.document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.click();
  }

  function downloadText(content, name) {
    const url = browserWindow.URL.createObjectURL(
      new browserWindow.Blob([content], { type: "text/markdown" }),
    );
    downloadHref(url, name);
    browserWindow.URL.revokeObjectURL(url);
  }

  async function exportLibrary() {
    if (!browserWindow.document || !browserWindow.Blob || !browserWindow.URL) {
      return { ok: false, error: "当前预览环境无法导出" };
    }
    const plan = createLibraryExportPlan(state);
    for (const note of plan.notes) {
      let content = note.content;
      for (const asset of note.assets) {
        const flatAssetName = asset.relativePath.replaceAll("/", "__");
        const reference = asset.relativePath.split("/").slice(-2).join("/");
        content = content.split(reference).join(flatAssetName);
        if (assetData[asset.attachmentId]) downloadHref(assetData[asset.attachmentId], flatAssetName);
      }
      downloadText(content, note.relativePath.replaceAll("/", "__"));
    }
    return { ok: true, noteCount: plan.notes.length, adapted: true };
  }

  return {
    getState: async () => ({ ok: true, state: structuredClone(state) }),
    mutate,
    openSettings: async () => {
      settingsListeners.forEach((listener) => listener());
      return { ok: true };
    },
    openDataFolder: async () => ({ ok: true }),
    openBackupFolder: async () => ({ ok: true }),
    addNoteImage,
    getAssetUrl: (id) => assetData[id] || "",
    exportLibrary,
    importMarkdown,
    exportMarkdown: async () => {
      if (!browserWindow.document || !browserWindow.Blob || !browserWindow.URL) {
        return { ok: false, error: "当前预览环境无法导出" };
      }
      const url = browserWindow.URL.createObjectURL(
        new browserWindow.Blob([markdownForState(state)], { type: "text/markdown" }),
      );
      const anchor = browserWindow.document.createElement("a");
      anchor.href = url;
      anchor.download = `Note-${state.activeDay}.md`;
      anchor.click();
      browserWindow.URL.revokeObjectURL(url);
      return { ok: true };
    },
    setWindowMode: (mode) => mutate({ type: "settings:set", key: "windowMode", value: mode }),
    setLocked: (locked) => mutate({ type: "settings:set", key: "locked", value: locked }),
    setLaunchAtLogin: (enabled) => mutate({ type: "settings:set", key: "launchAtLogin", value: enabled }),
    quitReady: async () => ({ ok: true }),
    onState: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    onSaveStatus: (listener) => { saveListeners.add(listener); return () => saveListeners.delete(listener); },
    onFocusInput: (listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); },
    onOpenSettings: (listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); },
    onPrepareQuit: (listener) => { quitListeners.add(listener); return () => quitListeners.delete(listener); },
  };
}

const browserWindow = typeof window !== "undefined" ? window : null;
const browserPreviewEnabled = import.meta.env?.DEV ?? true;
export const noteApi = browserWindow?.noteDesktop
  || (browserWindow && browserPreviewEnabled ? createBrowserApi(browserWindow) : null);
export const isDesktop = Boolean(browserWindow?.noteDesktop)
  || new URLSearchParams(browserWindow?.location?.search || "").get("runtime") === "desktop";
