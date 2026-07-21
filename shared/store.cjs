const {
  emptyRichBody,
  isRichBody,
  markdownFromRichBody,
  normalizeRichBody,
  plainTextFromRichBody,
  stripOwnFormatMarkers,
} = require("./rich-text.cjs");

const SCHEMA_VERSION = 4;
const LEGACY_SCHEMA_VERSION = 1;
const MARKDOWN_NOTES_SCHEMA_VERSION = 2;
const RICH_TEXT_NOTES_SCHEMA_VERSION = 3;
const TIME_VALUE_PATTERN = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
const NOTE_SYSTEM_VIEWS = Object.freeze(["all", "unfiled", "trash"]);
const NOTE_IMAGE_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_SETTINGS = Object.freeze({
  windowMode: "desktop",
  windowModeVersion: 1,
  locked: false,
  launchAtLogin: false,
  dayBoundaryHour: 4,
  reducedMotion: false,
  reducedTransparency: false,
  windowBounds: null,
  windowMaximized: false,
  activeModule: "todo",
  notesLastNotebookId: "all",
  notesLastFolderId: null,
  notesLastNoteId: null,
  notesPane: "list",
  notesSidebarCollapsed: false,
  notesToolbarCollapsed: false,
  resumeModuleAfterRollover: null,
});

function localDayKey(date = new Date(), boundaryHour = 4) {
  const adjusted = new Date(date);
  adjusted.setHours(adjusted.getHours() - boundaryHour);
  const year = adjusted.getFullYear();
  const month = String(adjusted.getMonth() + 1).padStart(2, "0");
  const day = String(adjusted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createDay(key) {
  return { key, tasks: [] };
}

function createInitialState(now = new Date()) {
  const settings = { ...DEFAULT_SETTINGS };
  const activeDay = localDayKey(now, settings.dayBoundaryHour);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    activeDay,
    days: { [activeDay]: createDay(activeDay) },
    pendingRollover: null,
    notebooks: {},
    folders: {},
    notes: {},
    settings,
  };
}

function clone(value) {
  return structuredClone(value);
}

function defaultRandomUUID() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("当前环境不支持安全 UUID");
  }
  return globalThis.crypto.randomUUID();
}

function normalizeTimeRange(value) {
  if (!value || typeof value !== "object") return null;
  const start = typeof value.start === "string" ? value.start : "";
  const end = typeof value.end === "string" ? value.end : "";
  if (!TIME_VALUE_PATTERN.test(start) || !TIME_VALUE_PATTERN.test(end) || start === end) return null;
  return { start, end };
}

function formatTimeRange(value) {
  const range = normalizeTimeRange(value);
  if (!range) return "";
  return `${range.start}–${range.end < range.start ? "次日 " : ""}${range.end}`;
}

function normalizeWindowBounds(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  const hasWidth = Object.prototype.hasOwnProperty.call(value, "width");
  const hasHeight = Object.prototype.hasOwnProperty.call(value, "height");
  if (hasWidth !== hasHeight) return null;
  const bounds = { x: Math.trunc(value.x), y: Math.trunc(value.y) };
  if (!hasWidth) return bounds;
  if (!Number.isFinite(value.width)
    || !Number.isFinite(value.height)
    || value.width <= 0
    || value.height <= 0) return null;
  return {
    ...bounds,
    width: Math.trunc(value.width),
    height: Math.trunc(value.height),
  };
}

function normalizeTask(task, fallbackOrder = 0, now = new Date(), randomUUID = defaultRandomUUID) {
  if (!task || typeof task !== "object") return null;
  const text = String(task.text || "").trim();
  if (!text) return null;
  return {
    id: typeof task.id === "string" ? task.id : randomUUID(),
    text,
    section: task.section === "focus" ? "focus" : "today",
    order: Number.isFinite(task.order) ? task.order : fallbackOrder,
    done: Boolean(task.done),
    timeRange: normalizeTimeRange(task.timeRange),
    createdAt: typeof task.createdAt === "string" ? task.createdAt : now.toISOString(),
    completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
    noteId: typeof task.noteId === "string" && task.noteId ? task.noteId : null,
  };
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isPersistedTaskShape(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return false;
  if (typeof task.id !== "string" || !task.id) return false;
  if (typeof task.text !== "string" || !task.text.trim()) return false;
  if (!["focus", "today"].includes(task.section)) return false;
  if (!Number.isFinite(task.order) || typeof task.done !== "boolean") return false;
  if (task.timeRange !== undefined && task.timeRange !== null && !normalizeTimeRange(task.timeRange)) return false;
  if (task.noteId !== undefined && !isNullableString(task.noteId)) return false;
  return true;
}

function isPersistedNotebookShape(notebook, id) {
  return Boolean(notebook)
    && typeof notebook === "object"
    && !Array.isArray(notebook)
    && notebook.id === id
    && typeof notebook.name === "string"
    && Boolean(notebook.name.trim())
    && Number.isFinite(notebook.order)
    && typeof notebook.createdAt === "string"
    && typeof notebook.updatedAt === "string"
    && isNullableString(notebook.trashedAt);
}

function isPersistedFolderShape(folder, id) {
  return Boolean(folder)
    && typeof folder === "object"
    && !Array.isArray(folder)
    && folder.id === id
    && typeof folder.name === "string"
    && Boolean(folder.name.trim())
    && isNullableString(folder.notebookId)
    && isNullableString(folder.parentFolderId)
    && folder.parentFolderId === null
    && Number.isFinite(folder.order)
    && typeof folder.createdAt === "string"
    && typeof folder.updatedAt === "string"
    && isNullableString(folder.trashedAt)
    && isNullableString(folder.trashedFromNotebookId);
}

function isPersistedAttachmentShape(attachment) {
  return Boolean(attachment)
    && typeof attachment === "object"
    && !Array.isArray(attachment)
    && typeof attachment.id === "string"
    && Boolean(attachment.id)
    && typeof attachment.fileName === "string"
    && Boolean(attachment.fileName)
    && NOTE_IMAGE_MIME_TYPES.includes(attachment.mimeType)
    && typeof attachment.relativePath === "string"
    && /^attachments\/[A-Za-z0-9._-]+$/.test(attachment.relativePath)
    && typeof attachment.createdAt === "string";
}

function isPersistedNoteShape(note, id, schemaVersion = SCHEMA_VERSION) {
  const common = Boolean(note)
    && typeof note === "object"
    && !Array.isArray(note)
    && note.id === id
    && typeof note.title === "string"
    && typeof note.body === "string"
    && isNullableString(note.notebookId)
    && isNullableString(note.pinnedAt)
    && typeof note.createdAt === "string"
    && typeof note.updatedAt === "string"
    && isNullableString(note.trashedAt)
    && isNullableString(note.trashedFromNotebookId)
    && Array.isArray(note.attachments)
    && note.attachments.every(isPersistedAttachmentShape);
  if (!common) return false;
  if (schemaVersion === MARKDOWN_NOTES_SCHEMA_VERSION) return note.richBody === undefined;
  if (schemaVersion >= SCHEMA_VERSION
    && (!isNullableString(note.folderId) || !isNullableString(note.trashedFromFolderId))) return false;
  return note.richBody === null || isRichBody(note.richBody);
}

function isPersistedStateShape(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (![LEGACY_SCHEMA_VERSION, MARKDOWN_NOTES_SCHEMA_VERSION, RICH_TEXT_NOTES_SCHEMA_VERSION, SCHEMA_VERSION].includes(raw.schemaVersion)) return false;
  if (!Number.isInteger(raw.revision) || raw.revision < 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.activeDay || "")) return false;
  if (!raw.days || typeof raw.days !== "object" || Array.isArray(raw.days)) return false;
  if (!raw.settings || typeof raw.settings !== "object" || Array.isArray(raw.settings)) return false;
  if (!raw.days[raw.activeDay] || !Array.isArray(raw.days[raw.activeDay].tasks)) return false;
  if (raw.settings.windowBounds !== undefined
    && raw.settings.windowBounds !== null
    && !normalizeWindowBounds(raw.settings.windowBounds)) return false;
  if (raw.settings.windowMaximized !== undefined && typeof raw.settings.windowMaximized !== "boolean") return false;

  for (const [key, day] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !day || !Array.isArray(day.tasks)) return false;
    if (!day.tasks.every(isPersistedTaskShape)) return false;
  }

  if (raw.schemaVersion === LEGACY_SCHEMA_VERSION) return true;
  if (!raw.notebooks || typeof raw.notebooks !== "object" || Array.isArray(raw.notebooks)) return false;
  if (!raw.notes || typeof raw.notes !== "object" || Array.isArray(raw.notes)) return false;
  if (!Object.entries(raw.notebooks).every(([id, notebook]) => isPersistedNotebookShape(notebook, id))) return false;
  if (!Object.entries(raw.notes).every(([id, note]) => isPersistedNoteShape(note, id, raw.schemaVersion))) return false;
  if (raw.schemaVersion >= SCHEMA_VERSION) {
    if (!raw.folders || typeof raw.folders !== "object" || Array.isArray(raw.folders)) return false;
    if (!Object.entries(raw.folders).every(([id, folder]) => isPersistedFolderShape(folder, id))) return false;
  }
  return true;
}

function normalizeAttachment(value, now = new Date(), randomUUID = defaultRandomUUID) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mimeType = NOTE_IMAGE_MIME_TYPES.includes(value.mimeType) ? value.mimeType : null;
  const fileName = typeof value.fileName === "string" ? value.fileName.trim() : "";
  const relativePath = typeof value.relativePath === "string" ? value.relativePath.trim() : "";
  if (!mimeType || !fileName || !/^attachments\/[A-Za-z0-9._-]+$/.test(relativePath)) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    fileName,
    mimeType,
    relativePath,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now.toISOString(),
  };
}

function normalizeNotebook(value, fallbackOrder = 0, now = new Date(), randomUUID = defaultRandomUUID) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = String(value.name || "").trim();
  if (!name) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    name,
    order: Number.isFinite(value.order) ? value.order : fallbackOrder,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now.toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now.toISOString(),
    trashedAt: typeof value.trashedAt === "string" ? value.trashedAt : null,
  };
}

function normalizeFolder(value, fallbackOrder = 0, now = new Date(), randomUUID = defaultRandomUUID) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = String(value.name || "").trim();
  if (!name) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    name,
    notebookId: typeof value.notebookId === "string" && value.notebookId ? value.notebookId : null,
    parentFolderId: null,
    order: Number.isFinite(value.order) ? value.order : fallbackOrder,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now.toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now.toISOString(),
    trashedAt: typeof value.trashedAt === "string" ? value.trashedAt : null,
    trashedFromNotebookId: typeof value.trashedFromNotebookId === "string" && value.trashedFromNotebookId
      ? value.trashedFromNotebookId
      : null,
  };
}

function normalizeNote(value, now = new Date(), randomUUID = defaultRandomUUID) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    title: typeof value.title === "string" ? value.title.trim() : "",
    body: typeof value.body === "string" ? value.body : "",
    richBody: normalizeRichBody(value.richBody),
    notebookId: typeof value.notebookId === "string" && value.notebookId ? value.notebookId : null,
    folderId: typeof value.folderId === "string" && value.folderId ? value.folderId : null,
    pinnedAt: typeof value.pinnedAt === "string" ? value.pinnedAt : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now.toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now.toISOString(),
    trashedAt: typeof value.trashedAt === "string" ? value.trashedAt : null,
    trashedFromNotebookId: typeof value.trashedFromNotebookId === "string" && value.trashedFromNotebookId
      ? value.trashedFromNotebookId
      : null,
    trashedFromFolderId: typeof value.trashedFromFolderId === "string" && value.trashedFromFolderId
      ? value.trashedFromFolderId
      : null,
    attachments: Array.isArray(value.attachments)
      ? value.attachments.map((item) => normalizeAttachment(item, now, randomUUID)).filter(Boolean)
      : [],
  };
}

function normalizeState(raw, now = new Date(), { randomUUID = defaultRandomUUID } = {}) {
  if (!raw || typeof raw !== "object") return createInitialState(now);
  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    locked: Boolean(rawSettings.locked),
    launchAtLogin: Boolean(rawSettings.launchAtLogin),
    reducedMotion: Boolean(rawSettings.reducedMotion),
    reducedTransparency: Boolean(rawSettings.reducedTransparency),
    notesSidebarCollapsed: Boolean(rawSettings.notesSidebarCollapsed),
    notesToolbarCollapsed: Boolean(rawSettings.notesToolbarCollapsed),
    windowBounds: normalizeWindowBounds(rawSettings.windowBounds),
    windowMaximized: Boolean(rawSettings.windowMaximized),
  };
  settings.dayBoundaryHour = [0, 2, 4, 6].includes(Number(rawSettings.dayBoundaryHour))
    ? Number(rawSettings.dayBoundaryHour)
    : 4;
  settings.windowMode = ["desktop", "normal", "floating"].includes(rawSettings.windowMode)
    ? rawSettings.windowMode
    : "desktop";
  settings.windowModeVersion = 1;
  settings.activeModule = rawSettings.activeModule === "notes" ? "notes" : "todo";
  settings.notesLastNotebookId = typeof rawSettings.notesLastNotebookId === "string"
    ? rawSettings.notesLastNotebookId
    : "all";
  settings.notesLastFolderId = typeof rawSettings.notesLastFolderId === "string"
    ? rawSettings.notesLastFolderId
    : null;
  settings.notesLastNoteId = typeof rawSettings.notesLastNoteId === "string"
    ? rawSettings.notesLastNoteId
    : null;
  settings.notesPane = rawSettings.notesPane === "editor" ? "editor" : "list";
  settings.resumeModuleAfterRollover = rawSettings.resumeModuleAfterRollover === "notes" ? "notes" : null;

  const notebooks = {};
  if (raw.notebooks && typeof raw.notebooks === "object" && !Array.isArray(raw.notebooks)) {
    for (const [key, value] of Object.entries(raw.notebooks)) {
      const notebook = normalizeNotebook({ ...value, id: value?.id || key }, Object.keys(notebooks).length, now, randomUUID);
      if (notebook && !notebooks[notebook.id]) notebooks[notebook.id] = notebook;
    }
  }
  Object.values(notebooks)
    .filter((notebook) => !notebook.trashedAt)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .forEach((notebook, index) => { notebook.order = index; });

  const folders = {};
  if (raw.folders && typeof raw.folders === "object" && !Array.isArray(raw.folders)) {
    for (const [key, value] of Object.entries(raw.folders)) {
      const folder = normalizeFolder({ ...value, id: value?.id || key }, Object.keys(folders).length, now, randomUUID);
      if (!folder || folders[folder.id]) continue;
      if (folder.trashedAt) {
        folder.notebookId = null;
      } else if (!folder.notebookId || !notebooks[folder.notebookId] || notebooks[folder.notebookId].trashedAt) {
        continue;
      }
      folders[folder.id] = folder;
    }
  }
  for (const notebook of Object.values(notebooks)) {
    Object.values(folders)
      .filter((folder) => !folder.trashedAt && folder.notebookId === notebook.id)
      .sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt))
      .forEach((folder, index) => { folder.order = index; });
  }

  const notes = {};
  if (raw.notes && typeof raw.notes === "object" && !Array.isArray(raw.notes)) {
    for (const [key, value] of Object.entries(raw.notes)) {
      const note = normalizeNote({ ...value, id: value?.id || key }, now, randomUUID);
      if (!note || notes[note.id]) continue;
      if (note.trashedAt) {
        note.notebookId = null;
        note.folderId = null;
      } else if (note.notebookId && (!notebooks[note.notebookId] || notebooks[note.notebookId].trashedAt)) {
        note.notebookId = null;
        note.folderId = null;
      } else if (note.folderId) {
        const folder = folders[note.folderId];
        if (!folder || folder.trashedAt || folder.notebookId !== note.notebookId) note.folderId = null;
      }
      notes[note.id] = note;
    }
  }

  const days = {};
  if (raw.days && typeof raw.days === "object") {
    for (const [key, day] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const tasks = Array.isArray(day?.tasks)
        ? day.tasks.map((task, index) => normalizeTask(task, index, now, randomUUID)).filter(Boolean)
        : [];
      days[key] = { key, tasks };
      normalizeOrders(days[key]);
    }
  }
  for (const day of Object.values(days)) {
    for (const task of day.tasks) {
      if (task.noteId && !notes[task.noteId]) task.noteId = null;
    }
  }
  const fallbackDay = localDayKey(now, settings.dayBoundaryHour);
  const activeDay = /^\d{4}-\d{2}-\d{2}$/.test(raw.activeDay) ? raw.activeDay : fallbackDay;
  if (!days[activeDay]) days[activeDay] = createDay(activeDay);
  if (!NOTE_SYSTEM_VIEWS.includes(settings.notesLastNotebookId)
    && (!notebooks[settings.notesLastNotebookId]
      || notebooks[settings.notesLastNotebookId].trashedAt)) settings.notesLastNotebookId = "all";
  if (settings.notesLastFolderId) {
    const folder = folders[settings.notesLastFolderId];
    if (!folder || folder.trashedAt || folder.notebookId !== settings.notesLastNotebookId) settings.notesLastFolderId = null;
  }
  if (settings.notesLastNoteId && !notes[settings.notesLastNoteId]) settings.notesLastNoteId = null;
  if (settings.notesLastNoteId) {
    const selectedNote = notes[settings.notesLastNoteId];
    if (selectedNote.trashedAt) {
      settings.notesLastNotebookId = "trash";
      settings.notesLastFolderId = null;
    }
    else if (settings.notesLastNotebookId === "trash"
      || (settings.notesLastNotebookId === "unfiled" && selectedNote.notebookId !== null)
      || (!NOTE_SYSTEM_VIEWS.includes(settings.notesLastNotebookId)
        && selectedNote.notebookId !== settings.notesLastNotebookId)) {
      settings.notesLastNotebookId = "all";
      settings.notesLastFolderId = null;
    } else if (!NOTE_SYSTEM_VIEWS.includes(settings.notesLastNotebookId)) {
      settings.notesLastFolderId = selectedNote.folderId || null;
    }
  }
  if (!settings.notesLastNoteId) settings.notesPane = "list";
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    activeDay,
    days,
    pendingRollover: normalizeRollover(raw.pendingRollover),
    notebooks,
    folders,
    notes,
    settings,
  };
}

function normalizeRollover(value) {
  if (!value || typeof value !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.fromDay || "")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.toDay || "")) return null;
  return {
    fromDay: value.fromDay,
    toDay: value.toDay,
    taskIds: Array.isArray(value.taskIds) ? value.taskIds.filter((id) => typeof id === "string") : [],
  };
}

function normalizeOrders(day) {
  for (const section of ["focus", "today"]) {
    day.tasks
      .filter((task) => task.section === section)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .forEach((task, index) => {
        task.order = index;
      });
  }
}

function ensureCurrentDay(state, now = new Date()) {
  const current = localDayKey(now, state.settings.dayBoundaryHour);
  if (current === state.activeDay && state.days?.[current]) return state;
  const next = clone(state);
  if (!next.days[current]) next.days[current] = createDay(current);
  if (current === next.activeDay) return next;

  if (next.pendingRollover?.taskIds?.length) {
    next.pendingRollover.toDay = current;
    next.activeDay = current;
    if (next.settings.activeModule === "notes") {
      next.settings.resumeModuleAfterRollover = "notes";
      next.settings.activeModule = "todo";
    }
    next.revision += 1;
    return next;
  }

  const previous = next.days[next.activeDay] || createDay(next.activeDay);
  const unfinished = previous.tasks.filter((task) => !task.done).map((task) => task.id);
  next.pendingRollover = unfinished.length
    ? { fromDay: next.activeDay, toDay: current, taskIds: unfinished }
    : null;
  if (unfinished.length && next.settings.activeModule === "notes") {
    next.settings.resumeModuleAfterRollover = "notes";
    next.settings.activeModule = "todo";
  }
  next.activeDay = current;
  next.revision += 1;
  return next;
}

function restoreModuleAfterRollover(state) {
  if (state.settings.resumeModuleAfterRollover === "notes") state.settings.activeModule = "notes";
  state.settings.resumeModuleAfterRollover = null;
}

function getTask(state, id) {
  for (const [dayKey, day] of Object.entries(state.days)) {
    const task = day.tasks.find((item) => item.id === id);
    if (task) return { task, day, dayKey };
  }
  return null;
}

function activeDay(state) {
  if (!state.days[state.activeDay]) state.days[state.activeDay] = createDay(state.activeDay);
  return state.days[state.activeDay];
}

function getNotebook(state, id) {
  return typeof id === "string" ? state.notebooks[id] || null : null;
}

function getFolder(state, id) {
  return typeof id === "string" ? state.folders[id] || null : null;
}

function getNote(state, id) {
  return typeof id === "string" ? state.notes[id] || null : null;
}

function requireNotebook(state, id, { trashed = false } = {}) {
  const notebook = getNotebook(state, id);
  if (!notebook || Boolean(notebook.trashedAt) !== trashed) throw new Error("未找到笔记本");
  return notebook;
}

function requireFolder(state, id, { trashed = false } = {}) {
  const folder = getFolder(state, id);
  if (!folder || Boolean(folder.trashedAt) !== trashed) throw new Error("未找到文件夹");
  return folder;
}

function requireNote(state, id, { trashed = false } = {}) {
  const note = getNote(state, id);
  if (!note || Boolean(note.trashedAt) !== trashed) throw new Error("未找到笔记");
  return note;
}

function validateTargetNotebook(state, id) {
  if (id === null || id === undefined || id === "") return null;
  return requireNotebook(state, id).id;
}

function validateNoteLocation(state, notebookId, folderId) {
  const requestedNotebookId = validateTargetNotebook(state, notebookId);
  if (folderId === null || folderId === undefined || folderId === "") {
    return { notebookId: requestedNotebookId, folderId: null };
  }
  const folder = requireFolder(state, folderId);
  if (requestedNotebookId && folder.notebookId !== requestedNotebookId) throw new Error("文件夹不属于目标笔记本");
  return { notebookId: folder.notebookId, folderId: folder.id };
}

function notebookNameExists(state, name, exceptId = null) {
  const folded = name.toLocaleLowerCase();
  return Object.values(state.notebooks).some(
    (notebook) => !notebook.trashedAt
      && notebook.id !== exceptId
      && notebook.name.toLocaleLowerCase() === folded,
  );
}

function folderNameExists(state, notebookId, name, exceptId = null) {
  const folded = name.toLocaleLowerCase();
  return Object.values(state.folders).some(
    (folder) => !folder.trashedAt
      && folder.notebookId === notebookId
      && folder.id !== exceptId
      && folder.name.toLocaleLowerCase() === folded,
  );
}

function normalizeNotebookOrders(state) {
  Object.values(state.notebooks)
    .filter((notebook) => !notebook.trashedAt)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .forEach((notebook, index) => { notebook.order = index; });
}

function normalizeFolderOrders(state, notebookId) {
  Object.values(state.folders)
    .filter((folder) => !folder.trashedAt && folder.notebookId === notebookId)
    .sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt))
    .forEach((folder, index) => { folder.order = index; });
}

function clearTaskNoteLinks(state, noteIds) {
  const ids = noteIds instanceof Set ? noteIds : new Set(noteIds);
  if (!ids.size) return;
  for (const day of Object.values(state.days)) {
    for (const task of day.tasks) {
      if (task.noteId && ids.has(task.noteId)) task.noteId = null;
    }
  }
}

function resetMissingNoteNavigation(state) {
  const selected = state.settings.notesLastNoteId;
  if (selected && !state.notes[selected]) state.settings.notesLastNoteId = null;
  if (!state.settings.notesLastNoteId) state.settings.notesPane = "list";
  const notebookId = state.settings.notesLastNotebookId;
  if (!NOTE_SYSTEM_VIEWS.includes(notebookId)
    && (!state.notebooks[notebookId] || state.notebooks[notebookId].trashedAt)) {
    state.settings.notesLastNotebookId = "all";
    state.settings.notesLastFolderId = null;
  }
  const folderId = state.settings.notesLastFolderId;
  if (folderId) {
    const folder = state.folders[folderId];
    if (!folder || folder.trashedAt || folder.notebookId !== state.settings.notesLastNotebookId) {
      state.settings.notesLastFolderId = null;
    }
  }
}

function applyOperation(state, operation, now = new Date(), { randomUUID = defaultRandomUUID } = {}) {
  if (!operation || typeof operation.type !== "string") throw new Error("无效操作");
  const next = ensureCurrentDay(normalizeState(state, now, { randomUUID }), now);
  const day = activeDay(next);
  const timestamp = now.toISOString();
  let changed = true;

  switch (operation.type) {
    case "task:add": {
      const text = String(operation.text || "").trim();
      if (!text) throw new Error("任务内容不能为空");
      const timeRange = normalizeTimeRange(operation.timeRange);
      if (operation.timeRange != null && !timeRange) throw new Error("请选择有效的开始和结束时间");
      const noteId = typeof operation.noteId === "string" && operation.noteId ? operation.noteId : null;
      if (noteId && (!next.notes[noteId] || next.notes[noteId].trashedAt)) throw new Error("未找到可关联的笔记");
      const focusCount = day.tasks.filter((task) => task.section === "focus").length;
      let section = operation.section === "today" || operation.section === "focus"
        ? operation.section
        : focusCount < 3 ? "focus" : "today";
      if (section === "focus" && focusCount >= 3) section = "today";
      const order = day.tasks.filter((task) => task.section === section).length;
      day.tasks.push({
        id: randomUUID(),
        text,
        section,
        order,
        done: false,
        timeRange,
        createdAt: timestamp,
        completedAt: null,
        noteId,
      });
      break;
    }
    case "task:text": {
      const found = getTask(next, operation.id);
      if (!found) throw new Error("未找到任务");
      const text = String(operation.text || "").trim();
      if (!text) {
        found.day.tasks = found.day.tasks.filter((task) => task.id !== operation.id);
      } else if (found.task.text === text) {
        changed = false;
      } else {
        found.task.text = text;
      }
      normalizeOrders(found.day);
      break;
    }
    case "task:toggle": {
      const found = getTask(next, operation.id);
      if (!found) throw new Error("未找到任务");
      const done = typeof operation.done === "boolean" ? operation.done : !found.task.done;
      if (found.task.done === done) changed = false;
      else {
        found.task.done = done;
        found.task.completedAt = done ? timestamp : null;
      }
      break;
    }
    case "task:time": {
      const found = getTask(next, operation.id);
      if (!found) throw new Error("未找到任务");
      const timeRange = normalizeTimeRange(operation.timeRange);
      if (operation.timeRange != null && !timeRange) throw new Error("请选择有效的开始和结束时间");
      if (JSON.stringify(found.task.timeRange) === JSON.stringify(timeRange)) changed = false;
      else found.task.timeRange = timeRange;
      break;
    }
    case "task:linkNote": {
      const found = getTask(next, operation.id);
      if (!found) throw new Error("未找到任务");
      const noteId = typeof operation.noteId === "string" && operation.noteId ? operation.noteId : null;
      if (noteId && (!next.notes[noteId] || next.notes[noteId].trashedAt)) throw new Error("未找到可关联的笔记");
      if (found.task.noteId === noteId) changed = false;
      else found.task.noteId = noteId;
      break;
    }
    case "task:delete": {
      const found = getTask(next, operation.id);
      if (!found) throw new Error("未找到任务");
      found.day.tasks = found.day.tasks.filter((task) => task.id !== operation.id);
      normalizeOrders(found.day);
      break;
    }
    case "task:restore": {
      const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(operation.dayKey || "")
        ? operation.dayKey
        : next.activeDay;
      if (!next.days[dayKey]) next.days[dayKey] = createDay(dayKey);
      const restored = normalizeTask(operation.task, next.days[dayKey].tasks.length, now, randomUUID);
      if (!restored) throw new Error("无法恢复任务");
      if (restored.noteId && !next.notes[restored.noteId]) restored.noteId = null;
      if (!getTask(next, restored.id)) next.days[dayKey].tasks.push(restored);
      else changed = false;
      normalizeOrders(next.days[dayKey]);
      break;
    }
    case "tasks:restore": {
      const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(operation.dayKey || "")
        ? operation.dayKey
        : next.activeDay;
      if (!next.days[dayKey]) next.days[dayKey] = createDay(dayKey);
      let restoredCount = 0;
      for (const item of Array.isArray(operation.tasks) ? operation.tasks : []) {
        const restored = normalizeTask(item, next.days[dayKey].tasks.length, now, randomUUID);
        if (restored?.noteId && !next.notes[restored.noteId]) restored.noteId = null;
        if (restored && !getTask(next, restored.id)) {
          next.days[dayKey].tasks.push(restored);
          restoredCount += 1;
        }
      }
      if (!restoredCount) changed = false;
      normalizeOrders(next.days[dayKey]);
      break;
    }
    case "task:move": {
      const found = getTask(next, operation.id);
      if (!found || found.dayKey !== next.activeDay) throw new Error("只能移动今天的任务");
      const toSection = operation.toSection === "focus" ? "focus" : "today";
      const focusTasks = day.tasks.filter((task) => task.section === "focus");
      if (toSection === "focus" && found.task.section !== "focus" && focusTasks.length >= 3) {
        throw new Error("今日三件最多只能放 3 项");
      }
      const oldSection = found.task.section;
      const oldList = day.tasks
        .filter((task) => task.section === oldSection && task.id !== found.task.id)
        .sort((a, b) => a.order - b.order);
      found.task.section = toSection;
      const newList = day.tasks
        .filter((task) => task.section === toSection && task.id !== found.task.id)
        .sort((a, b) => a.order - b.order);
      const index = Math.max(0, Math.min(Number(operation.toIndex) || 0, newList.length));
      newList.splice(index, 0, found.task);
      oldList.forEach((task, order) => { task.order = order; });
      newList.forEach((task, order) => { task.order = order; });
      normalizeOrders(day);
      break;
    }
    case "tasks:clearCompleted": {
      const before = day.tasks.length;
      day.tasks = day.tasks.filter((task) => !task.done);
      if (day.tasks.length === before) changed = false;
      normalizeOrders(day);
      break;
    }
    case "rollover:move": {
      const pending = next.pendingRollover;
      if (!pending) {
        changed = false;
        break;
      }
      const selected = new Set(Array.isArray(operation.taskIds) ? operation.taskIds : []);
      const pendingIds = new Set(pending.taskIds);
      const from = next.days[pending.fromDay];
      const to = next.days[pending.toDay] || createDay(pending.toDay);
      next.days[pending.toDay] = to;
      if (from) {
        const moving = from.tasks.filter(
          (task) => pendingIds.has(task.id) && selected.has(task.id) && !task.done,
        );
        const movingIds = new Set(moving.map((task) => task.id));
        from.tasks = from.tasks.filter((task) => !movingIds.has(task.id));
        let focusCount = to.tasks.filter((task) => task.section === "focus").length;
        for (const task of moving) {
          if (task.section === "focus") {
            if (focusCount >= 3) task.section = "today";
            else focusCount += 1;
          }
          task.order = to.tasks.filter((item) => item.section === task.section).length;
          to.tasks.push(task);
        }
        normalizeOrders(from);
        normalizeOrders(to);
      }
      next.pendingRollover = null;
      restoreModuleAfterRollover(next);
      break;
    }
    case "rollover:dismiss": {
      if (!next.pendingRollover) changed = false;
      else {
        next.pendingRollover = null;
        restoreModuleAfterRollover(next);
      }
      break;
    }
    case "notes:navigate": {
      if (next.pendingRollover) throw new Error("请先整理昨天的任务");
      const viewId = operation.viewId === undefined
        ? next.settings.notesLastNotebookId
        : operation.viewId;
      if (!NOTE_SYSTEM_VIEWS.includes(viewId)) requireNotebook(next, viewId);
      const hasFolderId = Object.prototype.hasOwnProperty.call(operation, "folderId");
      const folderId = NOTE_SYSTEM_VIEWS.includes(viewId)
        ? null
        : hasFolderId
          ? (operation.folderId === null ? null : String(operation.folderId || ""))
          : viewId === next.settings.notesLastNotebookId ? next.settings.notesLastFolderId : null;
      if (folderId) {
        const folder = requireFolder(next, folderId);
        if (folder.notebookId !== viewId) throw new Error("文件夹不属于当前笔记本");
      }
      const hasNoteId = Object.prototype.hasOwnProperty.call(operation, "noteId");
      const noteId = hasNoteId
        ? (operation.noteId === null ? null : String(operation.noteId || ""))
        : next.settings.notesLastNoteId;
      const note = noteId ? getNote(next, noteId) : null;
      if (noteId && !note) throw new Error("未找到笔记");
      if (note) {
        const matchesView = viewId === "trash"
          ? Boolean(note.trashedAt)
          : !note.trashedAt && (
            viewId === "all"
            || (viewId === "unfiled" && note.notebookId === null)
            || (note.notebookId === viewId && (folderId ? note.folderId === folderId : note.folderId === null))
          );
        if (!matchesView) throw new Error("笔记不在当前视图中");
      }
      const pane = operation.pane || (noteId ? "editor" : "list");
      if (!["list", "editor"].includes(pane) || (pane === "editor" && !noteId)) {
        throw new Error("无效的笔记面板");
      }
      const beforeNavigation = JSON.stringify({
        activeModule: next.settings.activeModule,
        viewId: next.settings.notesLastNotebookId,
        folderId: next.settings.notesLastFolderId,
        noteId: next.settings.notesLastNoteId,
        pane: next.settings.notesPane,
      });
      next.settings.activeModule = "notes";
      next.settings.notesLastNotebookId = viewId;
      next.settings.notesLastFolderId = folderId;
      next.settings.notesLastNoteId = noteId;
      next.settings.notesPane = pane;
      changed = beforeNavigation !== JSON.stringify({
        activeModule: next.settings.activeModule,
        viewId: next.settings.notesLastNotebookId,
        folderId: next.settings.notesLastFolderId,
        noteId: next.settings.notesLastNoteId,
        pane: next.settings.notesPane,
      });
      break;
    }
    case "notebook:add": {
      const name = String(operation.name || "").trim();
      if (!name) throw new Error("笔记本名称不能为空");
      if (notebookNameExists(next, name)) throw new Error("已存在同名笔记本");
      const id = randomUUID();
      next.notebooks[id] = {
        id,
        name,
        order: Object.values(next.notebooks).filter((notebook) => !notebook.trashedAt).length,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
      };
      next.settings.notesLastNotebookId = id;
      next.settings.notesLastFolderId = null;
      break;
    }
    case "notebook:rename": {
      const notebook = requireNotebook(next, operation.id);
      const name = String(operation.name || "").trim();
      if (!name) throw new Error("笔记本名称不能为空");
      if (notebookNameExists(next, name, notebook.id)) throw new Error("已存在同名笔记本");
      if (notebook.name === name) changed = false;
      else {
        notebook.name = name;
        notebook.updatedAt = timestamp;
      }
      break;
    }
    case "notebook:move": {
      const notebook = requireNotebook(next, operation.id);
      const list = Object.values(next.notebooks)
        .filter((item) => !item.trashedAt && item.id !== notebook.id)
        .sort((a, b) => a.order - b.order);
      const index = Math.max(0, Math.min(Number(operation.toIndex) || 0, list.length));
      list.splice(index, 0, notebook);
      const previous = notebook.order;
      list.forEach((item, order) => { item.order = order; });
      if (notebook.order === previous) changed = false;
      break;
    }
    case "notebook:trash": {
      const notebook = requireNotebook(next, operation.id);
      notebook.trashedAt = timestamp;
      notebook.updatedAt = timestamp;
      for (const folder of Object.values(next.folders)) {
        if (!folder.trashedAt && folder.notebookId === notebook.id) {
          folder.trashedAt = timestamp;
          folder.trashedFromNotebookId = notebook.id;
          folder.notebookId = null;
          folder.updatedAt = timestamp;
        }
      }
      for (const note of Object.values(next.notes)) {
        if (!note.trashedAt && note.notebookId === notebook.id) {
          note.trashedAt = timestamp;
          note.trashedFromNotebookId = notebook.id;
          note.trashedFromFolderId = note.folderId;
          note.notebookId = null;
          note.folderId = null;
        }
      }
      normalizeNotebookOrders(next);
      if (next.settings.notesLastNotebookId === notebook.id) {
        next.settings.notesLastNotebookId = "all";
        next.settings.notesLastFolderId = null;
      }
      if (next.settings.notesLastNoteId && next.notes[next.settings.notesLastNoteId]?.trashedAt) {
        next.settings.notesLastNoteId = null;
        next.settings.notesPane = "list";
      }
      break;
    }
    case "notebook:restore": {
      const notebook = requireNotebook(next, operation.id, { trashed: true });
      notebook.trashedAt = null;
      notebook.updatedAt = timestamp;
      notebook.order = Object.values(next.notebooks).filter((item) => !item.trashedAt && item.id !== notebook.id).length;
      for (const folder of Object.values(next.folders)) {
        if (folder.trashedAt && folder.trashedFromNotebookId === notebook.id) {
          folder.trashedAt = null;
          folder.trashedFromNotebookId = null;
          folder.notebookId = notebook.id;
          folder.updatedAt = timestamp;
        }
      }
      normalizeFolderOrders(next, notebook.id);
      for (const note of Object.values(next.notes)) {
        if (note.trashedAt && note.trashedFromNotebookId === notebook.id) {
          note.trashedAt = null;
          note.trashedFromNotebookId = null;
          note.notebookId = notebook.id;
          const folder = getFolder(next, note.trashedFromFolderId);
          note.folderId = folder && !folder.trashedAt && folder.notebookId === notebook.id ? folder.id : null;
          note.trashedFromFolderId = null;
        }
      }
      normalizeNotebookOrders(next);
      break;
    }
    case "notebook:deletePermanent": {
      const notebook = requireNotebook(next, operation.id, { trashed: true });
      const removedNoteIds = new Set();
      for (const note of Object.values(next.notes)) {
        if (note.trashedAt && note.trashedFromNotebookId === notebook.id) {
          removedNoteIds.add(note.id);
          delete next.notes[note.id];
        }
      }
      for (const folder of Object.values(next.folders)) {
        if (folder.trashedAt && folder.trashedFromNotebookId === notebook.id) delete next.folders[folder.id];
      }
      delete next.notebooks[notebook.id];
      clearTaskNoteLinks(next, removedNoteIds);
      resetMissingNoteNavigation(next);
      break;
    }
    case "folder:add": {
      const notebookId = validateTargetNotebook(next, operation.notebookId);
      if (!notebookId) throw new Error("请选择笔记本");
      if (operation.parentFolderId !== undefined && operation.parentFolderId !== null) throw new Error("目前仅支持一级文件夹");
      const name = String(operation.name || "").trim();
      if (!name) throw new Error("文件夹名称不能为空");
      if (folderNameExists(next, notebookId, name)) throw new Error("当前笔记本中已存在同名文件夹");
      const id = randomUUID();
      next.folders[id] = {
        id,
        name,
        notebookId,
        parentFolderId: null,
        order: Object.values(next.folders).filter((folder) => !folder.trashedAt && folder.notebookId === notebookId).length,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
        trashedFromNotebookId: null,
      };
      next.settings.activeModule = "notes";
      next.settings.notesLastNotebookId = notebookId;
      next.settings.notesLastFolderId = id;
      next.settings.notesLastNoteId = null;
      next.settings.notesPane = "list";
      break;
    }
    case "folder:rename": {
      const folder = requireFolder(next, operation.id);
      const name = String(operation.name || "").trim();
      if (!name) throw new Error("文件夹名称不能为空");
      if (folderNameExists(next, folder.notebookId, name, folder.id)) throw new Error("当前笔记本中已存在同名文件夹");
      if (folder.name === name) changed = false;
      else {
        folder.name = name;
        folder.updatedAt = timestamp;
      }
      break;
    }
    case "folder:move": {
      const folder = requireFolder(next, operation.id);
      const notebookId = validateTargetNotebook(next, operation.notebookId);
      if (!notebookId) throw new Error("请选择笔记本");
      if (folderNameExists(next, notebookId, folder.name, folder.id)) throw new Error("目标笔记本中已存在同名文件夹");
      if (folder.notebookId === notebookId) changed = false;
      else {
        const previousNotebookId = folder.notebookId;
        folder.notebookId = notebookId;
        folder.order = Object.values(next.folders).filter((item) => !item.trashedAt && item.notebookId === notebookId && item.id !== folder.id).length;
        folder.updatedAt = timestamp;
        for (const note of Object.values(next.notes)) {
          if (!note.trashedAt && note.folderId === folder.id) {
            note.notebookId = notebookId;
            note.updatedAt = timestamp;
          }
        }
        normalizeFolderOrders(next, previousNotebookId);
        normalizeFolderOrders(next, notebookId);
        if (next.settings.notesLastFolderId === folder.id) next.settings.notesLastNotebookId = notebookId;
      }
      break;
    }
    case "folder:trash": {
      const folder = requireFolder(next, operation.id);
      const notebookId = folder.notebookId;
      folder.trashedAt = timestamp;
      folder.trashedFromNotebookId = notebookId;
      folder.notebookId = null;
      folder.updatedAt = timestamp;
      for (const note of Object.values(next.notes)) {
        if (!note.trashedAt && note.folderId === folder.id) {
          note.trashedAt = timestamp;
          note.trashedFromNotebookId = notebookId;
          note.trashedFromFolderId = folder.id;
          note.notebookId = null;
          note.folderId = null;
        }
      }
      normalizeFolderOrders(next, notebookId);
      if (next.settings.notesLastFolderId === folder.id) {
        next.settings.notesLastFolderId = null;
        next.settings.notesLastNoteId = null;
        next.settings.notesPane = "list";
      }
      break;
    }
    case "folder:restore": {
      const folder = requireFolder(next, operation.id, { trashed: true });
      const notebook = getNotebook(next, folder.trashedFromNotebookId);
      if (!notebook || notebook.trashedAt) throw new Error("请先恢复原笔记本");
      folder.notebookId = notebook.id;
      folder.trashedAt = null;
      folder.trashedFromNotebookId = null;
      folder.order = Object.values(next.folders).filter((item) => !item.trashedAt && item.notebookId === notebook.id && item.id !== folder.id).length;
      folder.updatedAt = timestamp;
      for (const note of Object.values(next.notes)) {
        if (note.trashedAt && note.trashedFromFolderId === folder.id) {
          note.trashedAt = null;
          note.trashedFromNotebookId = null;
          note.trashedFromFolderId = null;
          note.notebookId = notebook.id;
          note.folderId = folder.id;
        }
      }
      normalizeFolderOrders(next, notebook.id);
      break;
    }
    case "folder:deletePermanent": {
      const folder = requireFolder(next, operation.id, { trashed: true });
      const removedNoteIds = new Set();
      for (const note of Object.values(next.notes)) {
        if (note.trashedAt && note.trashedFromFolderId === folder.id) {
          removedNoteIds.add(note.id);
          delete next.notes[note.id];
        }
      }
      delete next.folders[folder.id];
      clearTaskNoteLinks(next, removedNoteIds);
      resetMissingNoteNavigation(next);
      break;
    }
    case "note:add": {
      const { notebookId, folderId } = validateNoteLocation(next, operation.notebookId, operation.folderId);
      const id = randomUUID();
      const hasRichBody = Object.prototype.hasOwnProperty.call(operation, "richBody");
      const richBody = hasRichBody
        ? normalizeRichBody(operation.richBody)
        : (typeof operation.body === "string" && operation.body ? null : emptyRichBody());
      if (hasRichBody && !richBody) throw new Error("笔记格式数据无效");
      next.notes[id] = {
        id,
        title: typeof operation.title === "string" ? operation.title.trim() : "",
        body: typeof operation.body === "string" ? operation.body : "",
        richBody,
        notebookId,
        folderId,
        pinnedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        trashedAt: null,
        trashedFromNotebookId: null,
        trashedFromFolderId: null,
        attachments: [],
      };
      next.settings.activeModule = "notes";
      next.settings.notesLastNotebookId = notebookId || "unfiled";
      next.settings.notesLastFolderId = folderId;
      next.settings.notesLastNoteId = id;
      next.settings.notesPane = "editor";
      break;
    }
    case "note:update": {
      const note = requireNote(next, operation.id);
      const hasTitle = Object.prototype.hasOwnProperty.call(operation, "title");
      const hasBody = Object.prototype.hasOwnProperty.call(operation, "body");
      const hasRichBody = Object.prototype.hasOwnProperty.call(operation, "richBody");
      if (!hasTitle && !hasBody && !hasRichBody) throw new Error("没有可保存的笔记内容");
      const title = hasTitle ? String(operation.title || "").trim() : note.title;
      const richBody = hasRichBody ? normalizeRichBody(operation.richBody) : (hasBody ? null : note.richBody);
      if (hasRichBody && !richBody) throw new Error("笔记格式数据无效");
      const body = hasRichBody
        ? markdownFromRichBody(richBody)
        : hasBody && typeof operation.body === "string" ? operation.body : note.body;
      const sameRichBody = JSON.stringify(richBody) === JSON.stringify(note.richBody);
      if (title === note.title && body === note.body && sameRichBody) changed = false;
      else {
        note.title = title;
        note.body = body;
        note.richBody = richBody;
        note.updatedAt = timestamp;
      }
      break;
    }
    case "note:move": {
      const note = requireNote(next, operation.id);
      const { notebookId, folderId } = validateNoteLocation(next, operation.notebookId, operation.folderId);
      if (note.notebookId === notebookId && note.folderId === folderId) changed = false;
      else {
        note.notebookId = notebookId;
        note.folderId = folderId;
        note.updatedAt = timestamp;
      }
      break;
    }
    case "note:pin": {
      const note = requireNote(next, operation.id);
      if (typeof operation.pinned !== "boolean") throw new Error("无效的置顶状态");
      const pinnedAt = operation.pinned ? timestamp : null;
      if (Boolean(note.pinnedAt) === operation.pinned) changed = false;
      else note.pinnedAt = pinnedAt;
      break;
    }
    case "note:trash": {
      const note = requireNote(next, operation.id);
      note.trashedAt = timestamp;
      note.trashedFromNotebookId = note.notebookId;
      note.trashedFromFolderId = note.folderId;
      note.notebookId = null;
      note.folderId = null;
      if (next.settings.notesLastNoteId === note.id) {
        next.settings.notesLastNoteId = null;
        next.settings.notesPane = "list";
      }
      break;
    }
    case "note:restore": {
      const note = requireNote(next, operation.id, { trashed: true });
      const sourceNotebook = getNotebook(next, note.trashedFromNotebookId);
      note.notebookId = sourceNotebook && !sourceNotebook.trashedAt ? sourceNotebook.id : null;
      const sourceFolder = getFolder(next, note.trashedFromFolderId);
      note.folderId = sourceFolder && !sourceFolder.trashedAt && sourceFolder.notebookId === note.notebookId
        ? sourceFolder.id
        : null;
      note.trashedAt = null;
      note.trashedFromNotebookId = null;
      note.trashedFromFolderId = null;
      break;
    }
    case "note:deletePermanent": {
      const note = requireNote(next, operation.id, { trashed: true });
      delete next.notes[note.id];
      clearTaskNoteLinks(next, new Set([note.id]));
      resetMissingNoteNavigation(next);
      break;
    }
    case "trash:empty": {
      const removedNoteIds = new Set();
      for (const note of Object.values(next.notes)) {
        if (note.trashedAt) {
          removedNoteIds.add(note.id);
          delete next.notes[note.id];
        }
      }
      let removedNotebooks = 0;
      for (const notebook of Object.values(next.notebooks)) {
        if (notebook.trashedAt) {
          delete next.notebooks[notebook.id];
          removedNotebooks += 1;
        }
      }
      let removedFolders = 0;
      for (const folder of Object.values(next.folders)) {
        if (folder.trashedAt) {
          delete next.folders[folder.id];
          removedFolders += 1;
        }
      }
      if (!removedNoteIds.size && !removedNotebooks && !removedFolders) changed = false;
      clearTaskNoteLinks(next, removedNoteIds);
      resetMissingNoteNavigation(next);
      break;
    }
    case "note:attachment:add": {
      const note = requireNote(next, operation.id);
      const attachment = normalizeAttachment(operation.attachment, now, randomUUID);
      if (!attachment) throw new Error("无效的笔记图片");
      if (note.attachments.some((item) => item.id === attachment.id)) throw new Error("图片已存在");
      note.attachments.push(attachment);
      note.updatedAt = timestamp;
      break;
    }
    case "note:attachment:remove": {
      const note = requireNote(next, operation.id);
      const before = note.attachments.length;
      note.attachments = note.attachments.filter((item) => item.id !== operation.attachmentId);
      if (note.attachments.length === before) changed = false;
      else note.updatedAt = timestamp;
      break;
    }
    case "settings:set": {
      const key = operation.key;
      const allowed = new Set([
        "windowMode", "locked", "launchAtLogin", "dayBoundaryHour",
        "reducedMotion", "reducedTransparency", "windowBounds", "windowMaximized", "activeModule",
        "notesLastNotebookId", "notesLastFolderId", "notesLastNoteId", "notesPane",
        "notesSidebarCollapsed", "notesToolbarCollapsed",
      ]);
      if (!allowed.has(key)) throw new Error("不支持的设置");
      if (key === "windowMode") {
        if (!["desktop", "normal", "floating"].includes(operation.value)) throw new Error("无效的窗口模式");
        if (next.settings[key] === operation.value) changed = false;
        else next.settings[key] = operation.value;
        next.settings.windowModeVersion = 1;
      }
      else if (key === "dayBoundaryHour") {
        if (![0, 2, 4, 6].includes(operation.value)) throw new Error("无效的换日时间");
        if (next.settings[key] === operation.value) changed = false;
        else next.settings[key] = operation.value;
      }
      else if (key === "windowBounds") {
        const bounds = normalizeWindowBounds(operation.value);
        if (operation.value !== null && !bounds) throw new Error("无效的窗口位置或大小");
        if (JSON.stringify(next.settings[key]) === JSON.stringify(bounds)) changed = false;
        else next.settings[key] = bounds;
      }
      else if (key === "activeModule") {
        if (!["todo", "notes"].includes(operation.value)) throw new Error("无效的模块");
        if (next.pendingRollover && operation.value === "notes") throw new Error("请先整理昨天的任务");
        if (next.settings[key] === operation.value) changed = false;
        else next.settings[key] = operation.value;
      }
      else if (key === "notesLastNotebookId") {
        const value = operation.value;
        if (!NOTE_SYSTEM_VIEWS.includes(value) && (!getNotebook(next, value) || getNotebook(next, value).trashedAt)) {
          throw new Error("无效的笔记本位置");
        }
        if (next.settings[key] === value) changed = false;
        else {
          next.settings[key] = value;
          next.settings.notesLastFolderId = null;
        }
      }
      else if (key === "notesLastFolderId") {
        const value = operation.value === null ? null : String(operation.value || "");
        if (value) {
          const folder = getFolder(next, value);
          if (!folder || folder.trashedAt || folder.notebookId !== next.settings.notesLastNotebookId) {
            throw new Error("无效的文件夹位置");
          }
        }
        if (next.settings[key] === value) changed = false;
        else next.settings[key] = value;
      }
      else if (key === "notesLastNoteId") {
        const value = operation.value === null ? null : String(operation.value || "");
        if (value && !getNote(next, value)) throw new Error("无效的笔记位置");
        if (next.settings[key] === value) changed = false;
        else next.settings[key] = value;
      }
      else if (key === "notesPane") {
        if (!["list", "editor"].includes(operation.value)) throw new Error("无效的笔记面板");
        if (operation.value === "editor" && !next.settings.notesLastNoteId) throw new Error("请先选择笔记");
        if (next.settings[key] === operation.value) changed = false;
        else next.settings[key] = operation.value;
      }
      else {
        if (typeof operation.value !== "boolean") throw new Error("无效的开关设置");
        if (next.settings[key] === operation.value) changed = false;
        else next.settings[key] = operation.value;
      }
      break;
    }
    default:
      throw new Error(`未知操作: ${operation.type}`);
  }

  next.schemaVersion = SCHEMA_VERSION;
  if (changed) next.revision += 1;
  return next;
}

function markdownForState(state) {
  const lines = ["# Note", ""];
  const dayKeys = Object.keys(state.days).sort().reverse();
  for (const key of dayKeys) {
    lines.push(`## ${key}`, "");
    const tasks = [...state.days[key].tasks].sort((a, b) => a.order - b.order);
    for (const task of tasks) {
      const time = formatTimeRange(task.timeRange);
      lines.push(`- [${task.done ? "x" : " "}] ${time ? `${time} ` : ""}${task.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function foldSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function searchState(state, query, { limit = 100 } = {}) {
  const needle = foldSearchText(query).trim();
  const empty = { notes: [], openTasks: [], completedTasks: [] };
  if (!needle) return empty;

  const notes = Object.values(state?.notes || {})
    .filter((note) => {
      if (note.trashedAt) return false;
      const bodyText = note.richBody ? plainTextFromRichBody(note.richBody) : stripOwnFormatMarkers(note.body);
      return foldSearchText(`${note.title}\n${bodyText}`).includes(needle);
    })
    .sort((a, b) => {
      if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt) || a.createdAt.localeCompare(b.createdAt);
    })
    .slice(0, limit)
    .map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      notebookId: note.notebookId,
      folderId: note.folderId,
      pinnedAt: note.pinnedAt,
      updatedAt: note.updatedAt,
    }));

  const openTasks = [];
  const completedTasks = [];
  for (const [dayKey, day] of Object.entries(state?.days || {})) {
    for (const task of day.tasks || []) {
      if (!foldSearchText(task.text).includes(needle)) continue;
      const result = {
        id: task.id,
        text: task.text,
        dayKey,
        section: task.section,
        done: task.done,
        timeRange: task.timeRange,
        noteId: task.noteId || null,
      };
      if (task.done) completedTasks.push(result);
      else openTasks.push(result);
    }
  }
  const taskSort = (a, b) => b.dayKey.localeCompare(a.dayKey) || a.section.localeCompare(b.section) || a.text.localeCompare(b.text);
  openTasks.sort(taskSort);
  completedTasks.sort(taskSort);

  return {
    notes,
    openTasks: openTasks.slice(0, limit),
    completedTasks: completedTasks.slice(0, limit),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  NOTE_IMAGE_MIME_TYPES,
  NOTE_SYSTEM_VIEWS,
  SCHEMA_VERSION,
  applyOperation,
  createInitialState,
  ensureCurrentDay,
  formatTimeRange,
  isPersistedStateShape,
  localDayKey,
  markdownForState,
  normalizeTimeRange,
  normalizeWindowBounds,
  normalizeState,
  searchState,
};
