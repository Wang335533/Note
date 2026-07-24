import {
  ArrowCounterClockwise,
  ArrowLeft,
  CaretDown,
  Check,
  CaretRight,
  DotsThree,
  DownloadSimple,
  FileText,
  FolderOpen,
  FolderSimple,
  ListChecks,
  Plus,
  PushPin,
  SidebarSimple,
  SortAscending,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { noteApi } from "../api.js";
import { FormattingToolbar } from "./FormattingToolbar.jsx";
import { RichTextEditor } from "./RichTextEditor.jsx";

const SYSTEM_VIEWS = {
  all: "全部笔记",
  unfiled: "未分类",
  trash: "废纸篓",
};

function visibleTitle(note) {
  if (note.title.trim()) return note.title.trim();
  const firstLine = note.body.split(/\r?\n/).find((line) => line.trim()) || "";
  const clean = firstLine
    .replace(/<\/?(?:u|font)(?:\s[^>]*)?>/gi, "")
    .replace(/<\/?span(?:\s[^>]*)?>/gi, "")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/[*_`~[\]()>]/g, "")
    .trim();
  return clean.slice(0, 64) || "无标题";
}

function titleSuggestion(body) {
  const first = String(body || "").split(/\r?\n/).find((line) => line.trim());
  if (!first) return "";
  return first
    .replace(/<\/?(?:u|font)(?:\s[^>]*)?>/gi, "")
    .replace(/<\/?span(?:\s[^>]*)?>/gi, "")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim()
    .slice(0, 80);
}

function noteExcerpt(note) {
  return note.body
    .replace(/<\/?(?:u|font)(?:\s[^>]*)?>/gi, "")
    .replace(/<\/?span(?:\s[^>]*)?>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/\[[ xX]\]\s+/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 112);
}

function formatNoteDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function sortNotes(notes, mode) {
  return [...notes].sort((left, right) => {
    if (mode === "title") return visibleTitle(left).localeCompare(visibleTitle(right), "zh-CN");
    if (mode === "created") return right.createdAt.localeCompare(left.createdAt);
    return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt);
  });
}

function noteDestinationValue(note) {
  if (note.folderId) return `folder:${note.folderId}`;
  if (note.notebookId) return `notebook:${note.notebookId}`;
  return "";
}

function NoteListItem({ note, selected, notebookName, onOpen, onRequestMove, trashed = false }) {
  return (
    <div
      className="note-list-item-wrap"
      onContextMenu={(event) => {
        if (!onRequestMove || trashed) return;
        event.preventDefault();
        onRequestMove(note);
      }}
    >
      <button
        type="button"
        className={`note-list-item ${selected ? "is-selected" : ""}`}
        onClick={() => onOpen(note)}
      >
        <span className="note-list-item-topline">
          <strong>{visibleTitle(note)}</strong>
          {note.pinnedAt && !trashed ? <PushPin size={13} weight="fill" aria-label="已置顶" /> : null}
        </span>
        <span className="note-list-excerpt">{noteExcerpt(note) || "空白笔记"}</span>
        <span className="note-list-meta">
          <time dateTime={note.updatedAt}>{formatNoteDate(note.updatedAt)}</time>
          <i aria-hidden="true" />
          <span>{notebookName || (trashed ? "已删除" : "未分类")}</span>
        </span>
      </button>
      {onRequestMove && !trashed ? (
        <button
          type="button"
          className="note-list-move"
          aria-label={`移动笔记 ${visibleTitle(note)}`}
          title="移动到…"
          onClick={() => onRequestMove(note)}
        ><DotsThree size={17} weight="bold" /></button>
      ) : null}
    </div>
  );
}

function NoteEditorPane({ note, notebooks, folders, state, mutate, navigate, showToast, saveStatus, linkedTaskCount, requestPermanentDelete }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [richBody, setRichBody] = useState(note.richBody);
  const [richBodyKey, setRichBodyKey] = useState(() => JSON.stringify(note.richBody));
  const [selection, setSelection] = useState({ text: "", from: 0, to: 0 });
  const [formatState, setFormatState] = useState({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    font: "",
    size: "",
    lineHeight: "",
    textAlign: "left",
    textAlignMixed: false,
    canTextAlign: false,
    firstLineIndent: false,
    canFirstLineIndent: false,
    block: "paragraph",
    canClear: false,
    painterActive: false,
    inTable: false,
    tableHasHeader: false,
    tableRows: 0,
    tableColumns: 0,
    canAddTableRow: false,
    canAddTableColumn: false,
  });
  const [imageBusy, setImageBusy] = useState(false);
  const editorRef = useRef(null);
  const titleRef = useRef(note.title);
  const bodyRef = useRef(note.body);
  const richBodyRef = useRef(note.richBody);
  const savedTitleRef = useRef(note.title);
  const savedRichBodyKeyRef = useRef(JSON.stringify(note.richBody));
  const titleTimer = useRef(null);
  const bodyTimer = useRef(null);

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    setRichBody(note.richBody);
    setRichBodyKey(JSON.stringify(note.richBody));
    titleRef.current = note.title;
    bodyRef.current = note.body;
    richBodyRef.current = note.richBody;
    savedTitleRef.current = note.title;
    savedRichBodyKeyRef.current = JSON.stringify(note.richBody);
    setSelection({ text: "", from: 0, to: 0 });
    setFormatState((current) => ({ ...current, painterActive: false }));
  }, [note.id]);

  useEffect(() => {
    if (note.title === titleRef.current) savedTitleRef.current = note.title;
  }, [note.title]);

  useEffect(() => {
    const nextKey = JSON.stringify(note.richBody);
    if (nextKey === JSON.stringify(richBodyRef.current)) savedRichBodyKeyRef.current = nextKey;
  }, [note.richBody]);

  useEffect(() => () => {
    clearTimeout(titleTimer.current);
    clearTimeout(bodyTimer.current);
  }, [note.id]);

  const saveTitle = useCallback(async () => {
    clearTimeout(titleTimer.current);
    const next = titleRef.current.trim();
    if (next === savedTitleRef.current) return { ok: true, unchanged: true };
    const result = await mutate({ type: "note:update", id: note.id, title: next });
    if (result.ok) savedTitleRef.current = next;
    return result;
  }, [mutate, note.id]);

  const saveBody = useCallback(async () => {
    clearTimeout(bodyTimer.current);
    const next = richBodyRef.current;
    const nextKey = JSON.stringify(next);
    if (!next || nextKey === savedRichBodyKeyRef.current) return { ok: true, unchanged: true };
    const result = await mutate({ type: "note:update", id: note.id, richBody: next });
    if (result.ok) savedRichBodyKeyRef.current = nextKey;
    return result;
  }, [mutate, note.id]);

  const flush = useCallback(async () => {
    await Promise.all([saveTitle(), saveBody()]);
  }, [saveBody, saveTitle]);

  const suggestedTitle = !title.trim() ? titleSuggestion(body) : "";
  const isDirty = title.trim() !== savedTitleRef.current || richBodyKey !== savedRichBodyKeyRef.current;
  const trashed = Boolean(note.trashedAt);

  const moveNote = async (destination) => {
    await flush();
    const [kind, id] = String(destination || "").split(":");
    const targetFolder = kind === "folder" ? folders.find((folder) => folder.id === id) : null;
    const notebookId = targetFolder?.notebookId || (kind === "notebook" ? id : null);
    const folderId = targetFolder?.id || null;
    const result = await mutate({ type: "note:move", id: note.id, notebookId, folderId });
    if (result.ok) await navigate(notebookId || "unfiled", note.id, "editor", folderId);
  };

  return (
    <section className={`note-editor-pane ${trashed ? "is-trashed" : ""}`} aria-label="笔记编辑器">
      <header className="note-editor-toolbar">
        <button type="button" className="icon-button note-back-button" aria-label="返回笔记列表" onClick={() => navigate(state.settings.notesLastNotebookId, note.id, "list", state.settings.notesLastFolderId)}>
          <ArrowLeft size={19} />
        </button>
        <button
          type="button"
          className={`icon-button note-sidebar-toggle ${state.settings.notesSidebarCollapsed ? "is-accent" : ""}`}
          aria-label={state.settings.notesSidebarCollapsed ? "显示笔记列表" : "收起笔记列表"}
          title={state.settings.notesSidebarCollapsed ? "显示笔记列表" : "收起笔记列表"}
          onClick={() => mutate({
            type: "settings:set",
            key: "notesSidebarCollapsed",
            value: !state.settings.notesSidebarCollapsed,
          })}
        >
          <SidebarSimple size={17} weight={state.settings.notesSidebarCollapsed ? "fill" : "regular"} />
        </button>
        {trashed ? (
          <span className="trash-location"><Trash size={14} /> 废纸篓</span>
        ) : (
          <label className="note-location-select">
            <FolderOpen size={15} aria-hidden="true" />
            <select
              value={note.folderId ? `folder:${note.folderId}` : note.notebookId ? `notebook:${note.notebookId}` : ""}
              aria-label="移动笔记到"
              onChange={(event) => void moveNote(event.target.value)}
            >
              <option value="">未分类</option>
              {notebooks.map((notebook) => (
                <optgroup key={notebook.id} label={notebook.name}>
                  <option value={`notebook:${notebook.id}`}>{notebook.name}（根目录）</option>
                  {folders.filter((folder) => folder.notebookId === notebook.id).map((folder) => (
                    <option key={folder.id} value={`folder:${folder.id}`}>　{folder.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <CaretDown size={12} aria-hidden="true" />
          </label>
        )}
        <span className="note-editor-toolbar-spacer" />
        {!trashed ? (
          <>
            <button
              type="button"
              className={`icon-button ${note.pinnedAt ? "is-accent" : ""}`}
              aria-label={note.pinnedAt ? "取消置顶" : "置顶笔记"}
              onClick={() => mutate({ type: "note:pin", id: note.id, pinned: !note.pinnedAt })}
            >
              <PushPin size={17} weight={note.pinnedAt ? "fill" : "regular"} />
            </button>
            <button type="button" className="icon-button" aria-label="移到废纸篓" onClick={async () => {
              await flush();
              const result = await mutate({ type: "note:trash", id: note.id });
              if (result.ok) showToast("已移到废纸篓", "撤销", () => mutate({ type: "note:restore", id: note.id }));
            }}>
              <Trash size={18} />
            </button>
          </>
        ) : null}
      </header>

      <FormattingToolbar
        editorRef={editorRef}
        selection={selection}
        formatState={formatState}
        collapsed={state.settings.notesToolbarCollapsed}
        readOnly={trashed}
        onToggleCollapsed={() => mutate({
          type: "settings:set",
          key: "notesToolbarCollapsed",
          value: !state.settings.notesToolbarCollapsed,
        })}
      />

      <div className="note-editor-title-wrap">
        <input
          className="note-title-input"
          value={title}
          readOnly={trashed}
          autoFocus={!trashed && !note.title && !note.body}
          aria-label="笔记标题"
          placeholder="无标题"
          onChange={(event) => {
            const next = event.target.value;
            titleRef.current = next;
            setTitle(next);
            clearTimeout(titleTimer.current);
            titleTimer.current = setTimeout(() => void saveTitle(), 420);
          }}
          onBlur={() => void saveTitle()}
        />
        {suggestedTitle && !trashed ? (
          <button type="button" className="title-suggestion" onClick={() => {
            titleRef.current = suggestedTitle;
            setTitle(suggestedTitle);
            void saveTitle();
          }}>
            建议标题：{suggestedTitle}
          </button>
        ) : null}
      </div>

      <RichTextEditor
        ref={editorRef}
        key={note.id}
        noteId={note.id}
        richBody={richBody}
        legacyMarkdown={note.body}
        readOnly={trashed}
        onChange={(next, options = {}) => {
          bodyRef.current = next.body;
          richBodyRef.current = next.richBody;
          setBody(next.body);
          setRichBody(next.richBody);
          const nextKey = JSON.stringify(next.richBody);
          setRichBodyKey(nextKey);
          clearTimeout(bodyTimer.current);
          if (options.migrated) {
            void mutate({ type: "note:update", id: note.id, richBody: next.richBody }).then((result) => {
              if (result.ok) savedRichBodyKeyRef.current = nextKey;
            });
            return;
          }
          bodyTimer.current = setTimeout(() => void saveBody(), 520);
        }}
        onBlur={() => void saveBody()}
        onSelectionChange={setSelection}
        onFormatStateChange={setFormatState}
        onBusyChange={setImageBusy}
        showToast={showToast}
      />

      <footer className="note-editor-footer">
        {trashed ? (
          <>
            <button type="button" className="secondary-button compact-button" onClick={async () => {
              const result = await mutate({ type: "note:restore", id: note.id });
              if (result.ok) {
                const restored = result.state?.notes?.[note.id];
                const destination = restored?.notebookId || "unfiled";
                showToast(restored?.notebookId ? "笔记已恢复" : "笔记已恢复到未分类");
                await navigate(destination, note.id, "editor", restored?.folderId || null);
              }
            }}><ArrowCounterClockwise size={15} /> 恢复</button>
            <button type="button" className="danger-text-button" onClick={() => requestPermanentDelete(note)}>永久删除</button>
          </>
        ) : (
          <>
            <span className={`note-save-state ${saveStatus === "error" ? "is-error" : ""}`}>
              <i />
              {imageBusy ? "正在接管图片…" : isDirty || saveStatus === "saving" ? "正在保存…" : saveStatus === "error" ? "保存失败" : "已保存"}
            </span>
            <span className="note-footer-spacer" />
            {linkedTaskCount ? <span className="linked-task-count"><ListChecks size={14} /> {linkedTaskCount} 个 Todo</span> : null}
            {selection.text ? (
              <button type="button" className="selection-to-todo" onClick={async () => {
                await saveBody();
                const text = selection.text.replace(/\s+/g, " ").slice(0, 240);
                const result = await mutate({ type: "task:add", text, noteId: note.id });
                if (result.ok) showToast("已加入 Todo", "查看", () => mutate({ type: "settings:set", key: "activeModule", value: "todo" }));
              }}>
                <Plus size={14} /> 加入 Todo
              </button>
            ) : null}
          </>
        )}
      </footer>
    </section>
  );
}

function LibraryDialog({ dialog, close, onConfirm, notebooks, folders }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (["rename", "renameFolder"].includes(dialog?.type)) {
      setValue(dialog.notebook?.name || dialog.folder?.name || "");
    } else if (["import", "moveFolder", "moveNote"].includes(dialog?.type)) {
      setValue(dialog.destination || "");
    } else setValue("");
  }, [dialog]);

  if (!dialog) return null;
  const isNameDialog = ["create", "rename", "createFolder", "renameFolder"].includes(dialog.type);
  const titles = {
    create: "新建笔记本",
    rename: "重命名笔记本",
    createFolder: "新建文件夹",
    renameFolder: "重命名文件夹",
    moveFolder: "移动文件夹",
    moveNote: "移动笔记",
    trashNotebook: "移到废纸篓？",
    trashFolder: "移到废纸篓？",
    permanentNotebook: "永久删除笔记本？",
    permanentFolder: "永久删除文件夹？",
    permanentNote: "永久删除笔记？",
    emptyTrash: "清空废纸篓？",
    import: "导入 Markdown",
  };
  const danger = ["trashNotebook", "trashFolder", "permanentNotebook", "permanentFolder", "permanentNote", "emptyTrash"].includes(dialog.type);
  const isDestinationDialog = ["import", "moveFolder", "moveNote"].includes(dialog.type);

  return (
    <div className="sheet-backdrop library-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <form className="library-dialog" role="dialog" aria-modal="true" aria-label={titles[dialog.type]} onSubmit={(event) => {
        event.preventDefault();
        void onConfirm(dialog, value);
      }}>
        <header>
          <h2>{titles[dialog.type]}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={close}><X size={18} /></button>
        </header>
        {isNameDialog ? (
          <input
            autoFocus
            value={value}
            maxLength={80}
            placeholder={dialog.type.includes("Folder") ? "文件夹名称" : "笔记本名称"}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : isDestinationDialog ? (
          <label className="import-destination">
            <span>{dialog.type === "import" ? "导入到" : "移动到"}</span>
            <select autoFocus value={value} onChange={(event) => setValue(event.target.value)}>
              {dialog.type !== "moveFolder" ? <option value="">未分类</option> : null}
              {notebooks.map((notebook) => (
                <optgroup key={notebook.id} label={notebook.name}>
                  <option value={`notebook:${notebook.id}`}>{notebook.name}（根目录）</option>
                  {dialog.type !== "moveFolder" ? folders.filter((folder) => folder.notebookId === notebook.id).map((folder) => (
                    <option key={folder.id} value={`folder:${folder.id}`}>　{folder.name}</option>
                  )) : null}
                </optgroup>
              ))}
            </select>
            {dialog.type === "import" ? <small>可一次选择多个 .md 文件；桌面版会另行确认是否复制可解析的本地图片。</small> : null}
          </label>
        ) : (
          <p>{dialog.message}</p>
        )}
        <div className="sheet-actions">
          <button type="button" className="secondary-button" onClick={close}>取消</button>
          <button type="submit" className={danger ? "danger-button" : "primary-button"} disabled={isNameDialog && !value.trim()}>
            {dialog.type === "import" ? "选择文件" : ["moveFolder", "moveNote"].includes(dialog.type) ? "移动" : danger ? "确认" : "完成"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function NotesWorkspace({ state, mutate, showToast, saveStatus }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sortMode, setSortMode] = useState("updated");
  const [notebookMenu, setNotebookMenu] = useState(null);
  const [folderMenu, setFolderMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const viewId = state.settings.notesLastNotebookId;
  const activeFolderId = state.settings.notesLastFolderId;
  const selectedNoteId = state.settings.notesLastNoteId;
  const notebooks = useMemo(() => Object.values(state.notebooks)
    .filter((notebook) => !notebook.trashedAt)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, "zh-CN")), [state.notebooks]);
  const trashedNotebooks = useMemo(() => Object.values(state.notebooks)
    .filter((notebook) => notebook.trashedAt)
    .sort((left, right) => right.trashedAt.localeCompare(left.trashedAt)), [state.notebooks]);
  const folders = useMemo(() => Object.values(state.folders || {})
    .filter((folder) => !folder.trashedAt)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, "zh-CN")), [state.folders]);
  const trashedFolders = useMemo(() => Object.values(state.folders || {})
    .filter((folder) => folder.trashedAt)
    .sort((left, right) => right.trashedAt.localeCompare(left.trashedAt)), [state.folders]);

  const notebookNames = useMemo(() => new Map(Object.values(state.notebooks).map((notebook) => [notebook.id, notebook.name])), [state.notebooks]);
  const activeNotes = useMemo(() => Object.values(state.notes).filter((note) => !note.trashedAt), [state.notes]);
  const trashedNotes = useMemo(() => Object.values(state.notes).filter((note) => note.trashedAt), [state.notes]);
  const notesInView = useMemo(() => {
    if (viewId === "trash") return trashedNotes;
    if (viewId === "all") return activeNotes;
    if (viewId === "unfiled") return activeNotes.filter((note) => note.notebookId === null);
    return activeNotes.filter((note) => note.notebookId === viewId && note.folderId === (activeFolderId || null));
  }, [activeFolderId, activeNotes, trashedNotes, viewId]);
  const pinned = useMemo(() => sortNotes(notesInView.filter((note) => note.pinnedAt && !note.trashedAt), sortMode), [notesInView, sortMode]);
  const unpinned = useMemo(() => sortNotes(notesInView.filter((note) => !note.pinnedAt), sortMode), [notesInView, sortMode]);
  const selectedNote = selectedNoteId ? state.notes[selectedNoteId] || null : null;
  const currentNotebook = state.notebooks[viewId] || null;
  const activeFolder = activeFolderId ? state.folders?.[activeFolderId] || null : null;
  const foldersInView = currentNotebook
    ? folders.filter((folder) => folder.notebookId === currentNotebook.id)
    : [];
  const currentLabel = SYSTEM_VIEWS[viewId] || currentNotebook?.name || "全部笔记";

  const navigate = useCallback((targetViewId, noteId = null, pane = noteId ? "editor" : "list", folderId = null) => mutate({
    type: "notes:navigate",
    viewId: targetViewId,
    folderId,
    noteId,
    pane,
  }), [mutate]);

  const createNote = async () => {
    const notebook = state.notebooks[viewId];
    await mutate({
      type: "note:add",
      notebookId: notebook && !notebook.trashedAt ? notebook.id : null,
      folderId: notebook && !notebook.trashedAt ? activeFolderId : null,
    });
  };

  const openView = async (target, folderId = null) => {
    setDrawerOpen(false);
    setNotebookMenu(null);
    setFolderMenu(null);
    await navigate(target, null, "list", folderId);
  };

  const confirmDialog = async (request, value) => {
    let result = { ok: false };
    if (request.type === "create") result = await mutate({ type: "notebook:add", name: value });
    if (request.type === "rename") result = await mutate({ type: "notebook:rename", id: request.notebook.id, name: value });
    if (request.type === "createFolder") result = await mutate({ type: "folder:add", notebookId: request.notebook.id, name: value });
    if (request.type === "renameFolder") result = await mutate({ type: "folder:rename", id: request.folder.id, name: value });
    if (request.type === "moveFolder") {
      const notebookId = String(value || "").replace(/^notebook:/, "");
      result = await mutate({ type: "folder:move", id: request.folder.id, notebookId });
    }
    if (request.type === "moveNote") {
      const [kind, id] = String(value || "").split(":");
      const folder = kind === "folder" ? state.folders?.[id] : null;
      const notebookId = folder?.notebookId || (kind === "notebook" ? id : null);
      result = await mutate({ type: "note:move", id: request.note.id, notebookId, folderId: folder?.id || null });
      if (result.ok) await navigate(notebookId || "unfiled", request.note.id, "editor", folder?.id || null);
    }
    if (request.type === "trashNotebook") result = await mutate({ type: "notebook:trash", id: request.notebook.id });
    if (request.type === "trashFolder") result = await mutate({ type: "folder:trash", id: request.folder.id });
    if (request.type === "permanentNotebook") result = await mutate({ type: "notebook:deletePermanent", id: request.notebook.id });
    if (request.type === "permanentFolder") result = await mutate({ type: "folder:deletePermanent", id: request.folder.id });
    if (request.type === "permanentNote") result = await mutate({ type: "note:deletePermanent", id: request.note.id });
    if (request.type === "emptyTrash") result = await mutate({ type: "trash:empty" });
    if (request.type === "import") {
      const [kind, id] = String(value || "").split(":");
      const folder = kind === "folder" ? state.folders?.[id] : null;
      const notebookId = folder?.notebookId || (kind === "notebook" ? id : null);
      result = await noteApi.importMarkdown(notebookId, folder?.id || null);
    }
    if (result.ok) {
      setDialog(null);
      if (request.type === "create") showToast("笔记本已创建");
      if (request.type === "rename") showToast("笔记本已重命名");
      if (request.type === "createFolder") showToast("文件夹已创建");
      if (request.type === "renameFolder") showToast("文件夹已重命名");
      if (request.type === "moveFolder") showToast("文件夹已移动");
      if (request.type === "moveNote") showToast("笔记已移动");
      if (request.type === "trashNotebook") showToast("笔记本已移到废纸篓", "撤销", () => mutate({ type: "notebook:restore", id: request.notebook.id }));
      if (request.type === "trashFolder") showToast("文件夹已移到废纸篓", "撤销", () => mutate({ type: "folder:restore", id: request.folder.id }));
      if (request.type === "import") showToast(`已导入 ${result.importedCount || 0} 篇笔记${result.textOnly ? "（预览模式仅文字）" : ""}`);
    } else if (!result.canceled) showToast(result.error || "操作没有完成");
  };

  const linkedTaskCount = selectedNote ? Object.values(state.days).reduce((count, day) => (
    count + day.tasks.filter((task) => task.noteId === selectedNote.id).length
  ), 0) : 0;

  const groupedTrashNoteIds = new Set(trashedNotebooks.flatMap((notebook) => trashedNotes
    .filter((note) => note.trashedFromNotebookId === notebook.id)
    .map((note) => note.id)));
  for (const folder of trashedFolders) {
    for (const note of trashedNotes.filter((item) => item.trashedFromFolderId === folder.id)) groupedTrashNoteIds.add(note.id);
  }
  const looseTrashNotes = unpinned.filter((note) => !groupedTrashNoteIds.has(note.id));
  const standaloneTrashedFolders = trashedFolders.filter((folder) => !state.notebooks[folder.trashedFromNotebookId]?.trashedAt);

  return (
    <div className={`notes-workspace pane-${state.settings.notesPane} ${state.settings.notesSidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      <section className="notes-master" aria-label="笔记列表">
        <header className="notes-list-toolbar">
          <div className="notes-location-breadcrumb">
            <button
              type="button"
              className="notebook-trigger"
              aria-expanded={drawerOpen}
              onClick={() => activeFolder ? void openView(viewId) : setDrawerOpen(true)}
            >
              <FolderOpen size={17} />
              <span>{currentLabel}</span>
              {activeFolder ? null : <CaretDown size={13} />}
            </button>
            {activeFolder ? (
              <>
                <CaretRight size={12} aria-hidden="true" />
                <button type="button" className="folder-crumb" onClick={() => setDrawerOpen(true)}>{activeFolder.name}</button>
              </>
            ) : null}
          </div>
          <span className="notes-count">{notesInView.length}</span>
          <label className="notes-sort">
            <SortAscending size={16} />
            <select value={sortMode} aria-label="笔记排序" onChange={(event) => setSortMode(event.target.value)}>
              <option value="updated">最近更新</option>
              <option value="title">按标题</option>
              <option value="created">创建时间</option>
            </select>
          </label>
        </header>

        <div className="notes-list-scroll">
          {viewId === "trash" ? (
            <>
              <div className="trash-list-heading">
                <span>内容不会自动过期</span>
                {(trashedNotes.length || trashedNotebooks.length || trashedFolders.length) ? (
                  <button type="button" onClick={() => setDialog({
                    type: "emptyTrash",
                    message: `将永久删除 ${trashedNotes.length} 篇笔记、${trashedFolders.length} 个文件夹和 ${trashedNotebooks.length} 个笔记本，以及受管图片。此操作无法撤销。`,
                  })}>清空</button>
                ) : null}
              </div>
              {trashedNotebooks.map((notebook) => {
                const contained = sortNotes(trashedNotes.filter((note) => note.trashedFromNotebookId === notebook.id), sortMode);
                return (
                  <section key={notebook.id} className="trashed-notebook-group">
                    <header>
                      <div><FolderOpen size={16} /><strong>{notebook.name}</strong><span>{contained.length} 篇</span></div>
                      <div>
                        <button type="button" aria-label={`恢复笔记本 ${notebook.name}`} onClick={() => mutate({ type: "notebook:restore", id: notebook.id })}><ArrowCounterClockwise size={15} /></button>
                        <button type="button" aria-label={`永久删除笔记本 ${notebook.name}`} onClick={() => setDialog({
                          type: "permanentNotebook",
                          notebook,
                          message: `将永久删除“${notebook.name}”以及其中仍在废纸篓的 ${contained.length} 篇笔记和受管图片。`,
                        })}><Trash size={15} /></button>
                      </div>
                    </header>
                    {contained.map((note) => (
                      <div key={note.id} className="trash-note-row">
                        <NoteListItem note={note} trashed selected={note.id === selectedNoteId} notebookName={notebook.name} onOpen={(item) => navigate("trash", item.id, "editor")} />
                        <button type="button" className="trash-row-delete" aria-label={`永久删除 ${visibleTitle(note)}`} onClick={() => setDialog({
                          type: "permanentNote",
                          note,
                          message: `将永久删除“${visibleTitle(note)}”和其中的受管图片。此操作无法撤销。`,
                        })}><Trash size={15} /></button>
                      </div>
                    ))}
                  </section>
                );
              })}
              {standaloneTrashedFolders.map((folder) => {
                const contained = sortNotes(trashedNotes.filter((note) => note.trashedFromFolderId === folder.id), sortMode);
                const origin = state.notebooks[folder.trashedFromNotebookId];
                return (
                  <section key={folder.id} className="trashed-notebook-group trashed-folder-group">
                    <header>
                      <div><FolderSimple size={16} /><strong>{folder.name}</strong><span>{origin?.name || "原笔记本"} · {contained.length} 篇</span></div>
                      <div>
                        <button type="button" aria-label={`恢复文件夹 ${folder.name}`} onClick={() => mutate({ type: "folder:restore", id: folder.id })}><ArrowCounterClockwise size={15} /></button>
                        <button type="button" aria-label={`永久删除文件夹 ${folder.name}`} onClick={() => setDialog({
                          type: "permanentFolder",
                          folder,
                          message: `将永久删除“${folder.name}”以及其中 ${contained.length} 篇笔记和受管图片。`,
                        })}><Trash size={15} /></button>
                      </div>
                    </header>
                    {contained.map((note) => (
                      <div key={note.id} className="trash-note-row">
                        <NoteListItem note={note} trashed selected={note.id === selectedNoteId} notebookName={folder.name} onOpen={(item) => navigate("trash", item.id, "editor")} />
                        <button type="button" className="trash-row-delete" aria-label={`永久删除 ${visibleTitle(note)}`} onClick={() => setDialog({
                          type: "permanentNote",
                          note,
                          message: `将永久删除“${visibleTitle(note)}”和其中的受管图片。此操作无法撤销。`,
                        })}><Trash size={15} /></button>
                      </div>
                    ))}
                  </section>
                );
              })}
              {looseTrashNotes.length ? <p className="note-list-section-label">单篇笔记</p> : null}
              {looseTrashNotes.map((note) => (
                <div key={note.id} className="trash-note-row">
                  <NoteListItem note={note} trashed selected={note.id === selectedNoteId} notebookName={notebookNames.get(note.trashedFromNotebookId)} onOpen={(item) => navigate("trash", item.id, "editor")} />
                  <button type="button" className="trash-row-delete" aria-label={`永久删除 ${visibleTitle(note)}`} onClick={() => setDialog({
                    type: "permanentNote",
                    note,
                    message: `将永久删除“${visibleTitle(note)}”和其中的受管图片。此操作无法撤销。`,
                  })}><Trash size={15} /></button>
                </div>
              ))}
            </>
          ) : (
            <>
              {currentNotebook && !activeFolder ? (
                <section className="directory-section" aria-label="文件夹">
                  <div className="directory-section-heading">
                    <span>文件夹</span>
                    <button type="button" aria-label="在当前笔记本新建文件夹" onClick={() => setDialog({ type: "createFolder", notebook: currentNotebook })}><Plus size={15} /></button>
                  </div>
                  {foldersInView.map((folder) => {
                    const count = activeNotes.filter((note) => note.folderId === folder.id).length;
                    return (
                      <div key={folder.id} className="folder-list-row">
                        <button type="button" className="folder-list-open" onClick={() => void openView(currentNotebook.id, folder.id)}>
                          <FolderSimple size={17} />
                          <span>{folder.name}</span>
                          <b>{count}</b>
                        </button>
                        <button type="button" className="folder-list-more" aria-label={`管理文件夹 ${folder.name}`} onClick={() => setFolderMenu(folderMenu === folder.id ? null : folder.id)}><DotsThree size={18} weight="bold" /></button>
                        {folderMenu === folder.id ? (
                          <div className="folder-list-menu">
                            <button type="button" onClick={() => { setDialog({ type: "renameFolder", folder }); setFolderMenu(null); }}>重命名</button>
                            <button type="button" onClick={() => { setDialog({ type: "moveFolder", folder, destination: `notebook:${folder.notebookId}` }); setFolderMenu(null); }}>移动到…</button>
                            <button type="button" className="danger" onClick={() => {
                              setDialog({ type: "trashFolder", folder, message: `“${folder.name}”和其中 ${count} 篇笔记将一起移到废纸篓。` });
                              setFolderMenu(null);
                            }}>移到废纸篓</button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              ) : null}
              <div className="directory-section-heading note-create-heading">
                <span>笔记</span>
                <button type="button" aria-label="在当前位置新建笔记" onClick={() => void createNote()}><Plus size={15} /></button>
              </div>
              {pinned.length ? <p className="note-list-section-label">置顶</p> : null}
              {pinned.map((note) => <NoteListItem key={note.id} note={note} selected={note.id === selectedNoteId} notebookName={activeFolder?.name || notebookNames.get(note.notebookId)} onOpen={(item) => navigate(viewId, item.id, "editor", activeFolderId)} onRequestMove={(item) => setDialog({ type: "moveNote", note: item, destination: noteDestinationValue(item) })} />)}
              {pinned.length && unpinned.length ? <p className="note-list-section-label">笔记</p> : null}
              {unpinned.map((note) => <NoteListItem key={note.id} note={note} selected={note.id === selectedNoteId} notebookName={activeFolder?.name || notebookNames.get(note.notebookId)} onOpen={(item) => navigate(viewId, item.id, "editor", activeFolderId)} onRequestMove={(item) => setDialog({ type: "moveNote", note: item, destination: noteDestinationValue(item) })} />)}
            </>
          )}
          {!notesInView.length && !(viewId === "trash" && (trashedNotebooks.length || trashedFolders.length)) ? (
            <div className="notes-empty-state">
              <FileText size={27} />
              <strong>{viewId === "trash" ? "废纸篓是空的" : "这里还没有笔记"}</strong>
              <span>{viewId === "trash" ? "删除的内容会留在这里，直到你明确清理。" : "创建一篇空白笔记，先从第一句话开始。"}</span>
              {viewId !== "trash" ? <button type="button" onClick={() => void createNote()}><Plus size={15} /> 新建笔记</button> : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="notes-detail" aria-label="笔记内容">
        {selectedNote ? (
          <NoteEditorPane
            key={selectedNote.id}
            note={selectedNote}
            notebooks={notebooks}
            folders={folders}
            state={state}
            mutate={mutate}
            navigate={navigate}
            showToast={showToast}
            saveStatus={saveStatus}
            linkedTaskCount={linkedTaskCount}
            requestPermanentDelete={(note) => setDialog({
              type: "permanentNote",
              note,
              message: `将永久删除“${visibleTitle(note)}”和其中的受管图片。此操作无法撤销。`,
            })}
          />
        ) : (
          <div className="notes-detail-empty">
            <FileText size={30} />
            <strong>选择一篇笔记</strong>
            <span>列表与编辑器会保留各自的位置。</span>
            {state.settings.notesSidebarCollapsed ? (
              <button type="button" className="show-notes-list-button" onClick={() => mutate({
                type: "settings:set",
                key: "notesSidebarCollapsed",
                value: false,
              })}><SidebarSimple size={16} /> 显示笔记列表</button>
            ) : null}
          </div>
        )}
      </section>

      {drawerOpen ? (
        <div className="notes-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDrawerOpen(false)}>
          <aside className="notes-drawer" aria-label="笔记本导航">
            <header>
              <div><span>笔记库</span><small>{activeNotes.length} 篇笔记</small></div>
              <button type="button" className="icon-button" aria-label="关闭笔记本导航" onClick={() => setDrawerOpen(false)}><X size={18} /></button>
            </header>
            <nav>
              <button type="button" className={viewId === "all" ? "is-active" : ""} onClick={() => void openView("all")}><FileText size={17} /><span>全部笔记</span><b>{activeNotes.length}</b></button>
              <button type="button" className={viewId === "unfiled" ? "is-active" : ""} onClick={() => void openView("unfiled")}><FolderOpen size={17} /><span>未分类</span><b>{activeNotes.filter((note) => note.notebookId === null).length}</b></button>
            </nav>
            <div className="drawer-section-heading">
              <span>笔记本</span>
              <button type="button" aria-label="新建笔记本" onClick={() => setDialog({ type: "create" })}><Plus size={15} /></button>
            </div>
            <div className="drawer-notebooks">
              {notebooks.map((notebook) => (
                <div key={notebook.id} className="drawer-notebook-row">
                  <button type="button" className={viewId === notebook.id ? "is-active" : ""} onClick={() => void openView(notebook.id)}>
                    <FolderOpen size={17} />
                    <span>{notebook.name}</span>
                    <b>{activeNotes.filter((note) => note.notebookId === notebook.id).length}</b>
                  </button>
                  <button type="button" className="notebook-more" aria-label={`管理笔记本 ${notebook.name}`} onClick={() => setNotebookMenu(notebookMenu === notebook.id ? null : notebook.id)}><DotsThree size={18} weight="bold" /></button>
                  {notebookMenu === notebook.id ? (
                    <div className="notebook-menu">
                      <button type="button" onClick={() => { setDialog({ type: "rename", notebook }); setNotebookMenu(null); }}>重命名</button>
                      <button type="button" className="danger" onClick={() => {
                        const count = activeNotes.filter((note) => note.notebookId === notebook.id).length;
                        setDialog({ type: "trashNotebook", notebook, message: `“${notebook.name}”和其中 ${count} 篇笔记将一起移到废纸篓，可在永久删除前恢复。` });
                        setNotebookMenu(null);
                      }}>移到废纸篓</button>
                    </div>
                  ) : null}
                </div>
              ))}
              {!notebooks.length ? <p>还没有笔记本</p> : null}
            </div>
            <nav className="drawer-trash-link">
              <button type="button" className={viewId === "trash" ? "is-active" : ""} onClick={() => void openView("trash")}><Trash size={17} /><span>废纸篓</span><b>{trashedNotes.length + trashedFolders.length + trashedNotebooks.length}</b></button>
            </nav>
            <footer>
              <button type="button" onClick={() => setDialog({
                type: "import",
                destination: activeFolderId
                  ? `folder:${activeFolderId}`
                  : state.notebooks[viewId] ? `notebook:${viewId}` : "",
              })}><UploadSimple size={16} /> 导入 Markdown</button>
              <button type="button" onClick={async () => {
                const result = await noteApi.exportLibrary();
                if (result.ok) showToast(`已导出 ${result.noteCount} 篇笔记`);
                else if (!result.canceled) showToast(result.error || "导出没有完成");
              }}><DownloadSimple size={16} /> 导出整库</button>
            </footer>
          </aside>
        </div>
      ) : null}

      <LibraryDialog dialog={dialog} close={() => setDialog(null)} onConfirm={confirmDialog} notebooks={notebooks} folders={folders} />
    </div>
  );
}
