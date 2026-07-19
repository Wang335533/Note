import {
  ArrowCounterClockwise,
  ArrowLeft,
  CaretDown,
  Check,
  DotsThree,
  DownloadSimple,
  FileText,
  FolderOpen,
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
import { MarkdownEditor } from "./MarkdownEditor.jsx";

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

function NoteListItem({ note, selected, notebookName, onOpen, trashed = false }) {
  return (
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
  );
}

function NoteEditorPane({ note, notebooks, state, mutate, navigate, showToast, saveStatus, linkedTaskCount, requestPermanentDelete }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [selection, setSelection] = useState({ text: "", from: 0, to: 0 });
  const [formatState, setFormatState] = useState({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    font: "",
    size: "",
    block: "paragraph",
    canClear: false,
    painterActive: false,
  });
  const [imageBusy, setImageBusy] = useState(false);
  const editorRef = useRef(null);
  const titleRef = useRef(note.title);
  const bodyRef = useRef(note.body);
  const savedTitleRef = useRef(note.title);
  const savedBodyRef = useRef(note.body);
  const titleTimer = useRef(null);
  const bodyTimer = useRef(null);

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    titleRef.current = note.title;
    bodyRef.current = note.body;
    savedTitleRef.current = note.title;
    savedBodyRef.current = note.body;
    setSelection({ text: "", from: 0, to: 0 });
    setFormatState((current) => ({ ...current, painterActive: false }));
  }, [note.id]);

  useEffect(() => {
    if (note.title === titleRef.current) savedTitleRef.current = note.title;
  }, [note.title]);

  useEffect(() => {
    if (note.body === bodyRef.current) savedBodyRef.current = note.body;
  }, [note.body]);

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
    const next = bodyRef.current;
    if (next === savedBodyRef.current) return { ok: true, unchanged: true };
    const result = await mutate({ type: "note:update", id: note.id, body: next });
    if (result.ok) savedBodyRef.current = next;
    return result;
  }, [mutate, note.id]);

  const flush = useCallback(async () => {
    await Promise.all([saveTitle(), saveBody()]);
  }, [saveBody, saveTitle]);

  const suggestedTitle = !title.trim() ? titleSuggestion(body) : "";
  const isDirty = title.trim() !== savedTitleRef.current || body !== savedBodyRef.current;
  const trashed = Boolean(note.trashedAt);

  const moveNote = async (notebookId) => {
    await flush();
    const target = notebookId || null;
    const result = await mutate({ type: "note:move", id: note.id, notebookId: target });
    if (result.ok) await navigate(target || "unfiled", note.id, "editor");
  };

  return (
    <section className={`note-editor-pane ${trashed ? "is-trashed" : ""}`} aria-label="笔记编辑器">
      <header className="note-editor-toolbar">
        <button type="button" className="icon-button note-back-button" aria-label="返回笔记列表" onClick={() => navigate(state.settings.notesLastNotebookId, note.id, "list")}>
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
            <select value={note.notebookId || ""} aria-label="移动到笔记本" onChange={(event) => void moveNote(event.target.value)}>
              <option value="">未分类</option>
              {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
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

      <MarkdownEditor
        ref={editorRef}
        key={note.id}
        noteId={note.id}
        value={body}
        readOnly={trashed}
        onChange={(next) => {
          bodyRef.current = next;
          setBody(next);
          clearTimeout(bodyTimer.current);
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
                await navigate(destination, note.id, "editor");
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

function LibraryDialog({ dialog, close, onConfirm, notebooks }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(dialog?.type === "rename" ? dialog.notebook.name : dialog?.type === "import" ? (dialog.destination || "") : "");
  }, [dialog]);

  if (!dialog) return null;
  const isNameDialog = dialog.type === "create" || dialog.type === "rename";
  const titles = {
    create: "新建笔记本",
    rename: "重命名笔记本",
    trashNotebook: "移到废纸篓？",
    permanentNotebook: "永久删除笔记本？",
    permanentNote: "永久删除笔记？",
    emptyTrash: "清空废纸篓？",
    import: "导入 Markdown",
  };
  const danger = ["trashNotebook", "permanentNotebook", "permanentNote", "emptyTrash"].includes(dialog.type);

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
          <input autoFocus value={value} maxLength={80} placeholder="笔记本名称" onChange={(event) => setValue(event.target.value)} />
        ) : dialog.type === "import" ? (
          <label className="import-destination">
            <span>导入到</span>
            <select autoFocus value={value} onChange={(event) => setValue(event.target.value)}>
              <option value="">未分类</option>
              {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
            </select>
            <small>可一次选择多个 .md 文件；桌面版会另行确认是否复制可解析的本地图片。</small>
          </label>
        ) : (
          <p>{dialog.message}</p>
        )}
        <div className="sheet-actions">
          <button type="button" className="secondary-button" onClick={close}>取消</button>
          <button type="submit" className={danger ? "danger-button" : "primary-button"} disabled={isNameDialog && !value.trim()}>
            {dialog.type === "import" ? "选择文件" : danger ? "确认" : "完成"}
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
  const [dialog, setDialog] = useState(null);
  const viewId = state.settings.notesLastNotebookId;
  const selectedNoteId = state.settings.notesLastNoteId;
  const notebooks = useMemo(() => Object.values(state.notebooks)
    .filter((notebook) => !notebook.trashedAt)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, "zh-CN")), [state.notebooks]);
  const trashedNotebooks = useMemo(() => Object.values(state.notebooks)
    .filter((notebook) => notebook.trashedAt)
    .sort((left, right) => right.trashedAt.localeCompare(left.trashedAt)), [state.notebooks]);

  const notebookNames = useMemo(() => new Map(Object.values(state.notebooks).map((notebook) => [notebook.id, notebook.name])), [state.notebooks]);
  const activeNotes = useMemo(() => Object.values(state.notes).filter((note) => !note.trashedAt), [state.notes]);
  const trashedNotes = useMemo(() => Object.values(state.notes).filter((note) => note.trashedAt), [state.notes]);
  const notesInView = useMemo(() => {
    if (viewId === "trash") return trashedNotes;
    if (viewId === "all") return activeNotes;
    if (viewId === "unfiled") return activeNotes.filter((note) => note.notebookId === null);
    return activeNotes.filter((note) => note.notebookId === viewId);
  }, [activeNotes, trashedNotes, viewId]);
  const pinned = useMemo(() => sortNotes(notesInView.filter((note) => note.pinnedAt && !note.trashedAt), sortMode), [notesInView, sortMode]);
  const unpinned = useMemo(() => sortNotes(notesInView.filter((note) => !note.pinnedAt), sortMode), [notesInView, sortMode]);
  const selectedNote = selectedNoteId ? state.notes[selectedNoteId] || null : null;
  const currentLabel = SYSTEM_VIEWS[viewId] || state.notebooks[viewId]?.name || "全部笔记";

  const navigate = useCallback((targetViewId, noteId = null, pane = noteId ? "editor" : "list") => mutate({
    type: "notes:navigate",
    viewId: targetViewId,
    noteId,
    pane,
  }), [mutate]);

  const createNote = async () => {
    const notebook = state.notebooks[viewId];
    await mutate({ type: "note:add", notebookId: notebook && !notebook.trashedAt ? notebook.id : null });
  };

  const openView = async (target) => {
    setDrawerOpen(false);
    setNotebookMenu(null);
    await navigate(target, null, "list");
  };

  const confirmDialog = async (request, value) => {
    let result = { ok: false };
    if (request.type === "create") result = await mutate({ type: "notebook:add", name: value });
    if (request.type === "rename") result = await mutate({ type: "notebook:rename", id: request.notebook.id, name: value });
    if (request.type === "trashNotebook") result = await mutate({ type: "notebook:trash", id: request.notebook.id });
    if (request.type === "permanentNotebook") result = await mutate({ type: "notebook:deletePermanent", id: request.notebook.id });
    if (request.type === "permanentNote") result = await mutate({ type: "note:deletePermanent", id: request.note.id });
    if (request.type === "emptyTrash") result = await mutate({ type: "trash:empty" });
    if (request.type === "import") result = await noteApi.importMarkdown(value || null);
    if (result.ok) {
      setDialog(null);
      if (request.type === "create") showToast("笔记本已创建");
      if (request.type === "rename") showToast("笔记本已重命名");
      if (request.type === "trashNotebook") showToast("笔记本已移到废纸篓", "撤销", () => mutate({ type: "notebook:restore", id: request.notebook.id }));
      if (request.type === "import") showToast(`已导入 ${result.importedCount || 0} 篇笔记${result.textOnly ? "（预览模式仅文字）" : ""}`);
    } else if (!result.canceled) showToast(result.error || "操作没有完成");
  };

  const linkedTaskCount = selectedNote ? Object.values(state.days).reduce((count, day) => (
    count + day.tasks.filter((task) => task.noteId === selectedNote.id).length
  ), 0) : 0;

  const groupedTrashNoteIds = new Set(trashedNotebooks.flatMap((notebook) => trashedNotes
    .filter((note) => note.trashedFromNotebookId === notebook.id)
    .map((note) => note.id)));
  const looseTrashNotes = unpinned.filter((note) => !groupedTrashNoteIds.has(note.id));

  return (
    <div className={`notes-workspace pane-${state.settings.notesPane} ${state.settings.notesSidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      <section className="notes-master" aria-label="笔记列表">
        <header className="notes-list-toolbar">
          <button type="button" className="notebook-trigger" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            <FolderOpen size={17} />
            <span>{currentLabel}</span>
            <CaretDown size={13} />
          </button>
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
                {(trashedNotes.length || trashedNotebooks.length) ? (
                  <button type="button" onClick={() => setDialog({
                    type: "emptyTrash",
                    message: `将永久删除 ${trashedNotes.length} 篇笔记和 ${trashedNotebooks.length} 个笔记本，以及受管图片。此操作无法撤销。`,
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
              {pinned.length ? <p className="note-list-section-label">置顶</p> : null}
              {pinned.map((note) => <NoteListItem key={note.id} note={note} selected={note.id === selectedNoteId} notebookName={notebookNames.get(note.notebookId)} onOpen={(item) => navigate(viewId, item.id, "editor")} />)}
              {pinned.length && unpinned.length ? <p className="note-list-section-label">笔记</p> : null}
              {unpinned.map((note) => <NoteListItem key={note.id} note={note} selected={note.id === selectedNoteId} notebookName={notebookNames.get(note.notebookId)} onOpen={(item) => navigate(viewId, item.id, "editor")} />)}
            </>
          )}
          {!notesInView.length && !(viewId === "trash" && trashedNotebooks.length) ? (
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
              <button type="button" className={viewId === "trash" ? "is-active" : ""} onClick={() => void openView("trash")}><Trash size={17} /><span>废纸篓</span><b>{trashedNotes.length + trashedNotebooks.length}</b></button>
            </nav>
            <footer>
              <button type="button" onClick={() => setDialog({ type: "import", destination: state.notebooks[viewId] ? viewId : "" })}><UploadSimple size={16} /> 导入 Markdown</button>
              <button type="button" onClick={async () => {
                const result = await noteApi.exportLibrary();
                if (result.ok) showToast(`已导出 ${result.noteCount} 篇笔记`);
                else if (!result.canceled) showToast(result.error || "导出没有完成");
              }}><DownloadSimple size={16} /> 导出整库</button>
            </footer>
          </aside>
        </div>
      ) : null}

      <LibraryDialog dialog={dialog} close={() => setDialog(null)} onConfirm={confirmDialog} notebooks={notebooks} />
    </div>
  );
}
