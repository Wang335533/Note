import {
  Asterisk,
  AppWindow,
  ArrowDown,
  CaretDown,
  CaretRight,
  Check,
  Desktop,
  DotsSixVertical,
  DownloadSimple,
  FolderOpen,
  Keyboard,
  Minus,
  Plus,
  PushPin,
  Star,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDesktop, noteApi } from "./api.js";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const QUICK_DRAFT_KEY = "desktop-note-quick-draft-v1";

function loadQuickDraft() {
  try {
    return localStorage.getItem(QUICK_DRAFT_KEY) || "";
  } catch {
    return "";
  }
}

function keepQuickDraft(value) {
  try {
    if (value) localStorage.setItem(QUICK_DRAFT_KEY, value);
    else localStorage.removeItem(QUICK_DRAFT_KEY);
  } catch {
    // The task is still kept in React state when browser storage is unavailable.
  }
}

function formatDay(key) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  return `${month}月${day}日 ${WEEKDAYS[date.getDay()]}`;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

function AppCheckbox({ checked, onChange, label }) {
  return (
    <button
      type="button"
      className={`task-check ${checked ? "is-checked" : ""}`}
      aria-label={label}
      aria-pressed={checked}
      onClick={onChange}
    >
      {checked ? <Check size={16} weight="bold" aria-hidden="true" /> : null}
    </button>
  );
}

function EditableTaskText({ task, mutate, onDraftState }) {
  const [draft, setDraft] = useState(task.text);
  const editing = useRef(false);
  const canceled = useRef(false);
  const initialValue = useRef(task.text);
  const saveTimer = useRef(null);
  const lastSubmitted = useRef(task.text);

  useEffect(() => {
    if (!editing.current) {
      setDraft(task.text);
      lastSubmitted.current = task.text;
    }
  }, [task.text]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const save = useCallback(async (value) => {
    const clean = value.trim();
    if (!clean) {
      setDraft(task.text);
      onDraftState(task.id, false);
      return { ok: true };
    }
    if (clean === lastSubmitted.current) {
      onDraftState(task.id, false);
      return { ok: true };
    }
    const previous = lastSubmitted.current;
    lastSubmitted.current = clean;
    const result = await mutate({ type: "task:text", id: task.id, text: clean });
    if (!result.ok && lastSubmitted.current === clean) lastSubmitted.current = previous;
    if (result.ok) onDraftState(task.id, false);
    return result;
  }, [mutate, onDraftState, task.id, task.text]);

  return (
    <input
      className={`task-text ${task.done ? "is-done" : ""}`}
      value={draft}
      aria-label={`编辑任务：${task.text}`}
      spellCheck="false"
      onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        onDraftState(task.id, true);
        clearTimeout(saveTimer.current);
        if (value.trim()) {
          saveTimer.current = setTimeout(() => {
            void save(value);
          }, 420);
        }
      }}
      onFocus={() => {
        editing.current = true;
        canceled.current = false;
        initialValue.current = task.text;
        lastSubmitted.current = task.text;
      }}
      onBlur={() => {
        clearTimeout(saveTimer.current);
        editing.current = false;
        if (canceled.current) {
          canceled.current = false;
          setDraft(task.text);
          return;
        }
        void save(draft);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          clearTimeout(saveTimer.current);
          canceled.current = true;
          setDraft(initialValue.current);
          onDraftState(task.id, false);
          void save(initialValue.current);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function TaskRow({
  task,
  mutate,
  onToggle,
  onDelete,
  onMove,
  openMenu,
  setOpenMenu,
  onDragStart,
  onDragEnd,
  onDrop,
  onDraftState,
  compact = false,
}) {
  const menuOpen = openMenu === task.id;
  return (
    <div
      className={`task-row section-${task.section} ${task.done ? "is-done" : ""} ${compact ? "is-compact" : ""}`}
      data-task-id={task.id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.stopPropagation();
        onDrop?.(event, task);
      }}
    >
      <AppCheckbox
        checked={task.done}
        label={task.done ? `恢复任务：${task.text}` : `完成任务：${task.text}`}
        onChange={() => onToggle(task)}
      />
      <EditableTaskText task={task} mutate={mutate} onDraftState={onDraftState} />
      {!compact ? (
        <div className="task-actions">
          <button
            type="button"
            className="icon-button row-handle"
            draggable
            aria-label={`移动或管理：${task.text}`}
            aria-expanded={menuOpen}
            onClick={() => setOpenMenu(menuOpen ? null : task.id)}
            onDragStart={(event) => onDragStart?.(event, task)}
            onDragEnd={() => onDragEnd?.()}
          >
            <DotsSixVertical size={19} weight="bold" aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div className="task-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => onMove(task)}>
                {task.section === "focus" ? <ArrowDown size={16} /> : <Star size={16} />}
                {task.section === "focus" ? "移到今天" : "设为今日三件"}
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => onDelete(task)}>
                <Trash size={16} />
                删除
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children, className = "", onDropEnd }) {
  return (
    <section
      className={`task-section ${className}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDropEnd?.(event)}
    >
      <h2>{title}</h2>
      <div className="task-list">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      className={`switch ${checked ? "is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingsSheet({ state, close, mutate, showToast }) {
  const settings = state.settings;
  const shortcutFailures = state.runtime?.shortcutFailures || [];

  const setWindowMode = async (mode) => {
    const result = await noteApi.setWindowMode(mode);
    if (!result.ok) showToast(result.error || "无法切换窗口模式");
  };

  const setLaunch = async (enabled) => {
    const result = await noteApi.setLaunchAtLogin(enabled);
    if (!result.ok) showToast(result.error || "无法修改开机启动");
  };

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-label="设置">
        <header className="sheet-header">
          <div>
            <p className="eyebrow">NOTE</p>
            <h2>设置</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭设置" onClick={close}>
            <X size={20} />
          </button>
        </header>

        <div className="setting-block">
          <p className="setting-label">窗口模式</p>
          <div className="segmented-control">
            <button
              type="button"
              className={settings.windowMode === "desktop" ? "is-active" : ""}
              onClick={() => setWindowMode("desktop")}
            >
              <Desktop size={17} /> 桌面
            </button>
            <button
              type="button"
              className={settings.windowMode === "floating" ? "is-active" : ""}
              onClick={() => setWindowMode("floating")}
            >
              <PushPin size={17} /> 置顶
            </button>
            <button
              type="button"
              className={settings.windowMode === "normal" ? "is-active" : ""}
              onClick={() => setWindowMode("normal")}
            >
              <AppWindow size={17} /> 普通
            </button>
          </div>
          <p className="setting-help">桌面模式不占任务栏，其他软件会自然盖住 Note；快捷记录时临时到前台，失去焦点后自动回落。</p>
        </div>

        <div className="setting-row">
          <div>
            <strong>开机自动出现</strong>
            <span>登录 Windows 后直接回到今天</span>
          </div>
          <Toggle checked={settings.launchAtLogin} onChange={setLaunch} label="开机自动出现" />
        </div>

        <div className="setting-row">
          <div>
            <strong>减少动态效果</strong>
            <span>保留状态变化，减少位移和回弹</span>
          </div>
          <Toggle
            checked={settings.reducedMotion}
            onChange={(value) => mutate({ type: "settings:set", key: "reducedMotion", value })}
            label="减少动态效果"
          />
        </div>

        <div className="setting-row">
          <div>
            <strong>提高背景不透明度</strong>
            <span>桌面较花时让文字更清楚</span>
          </div>
          <Toggle
            checked={settings.reducedTransparency}
            onChange={(value) => mutate({ type: "settings:set", key: "reducedTransparency", value })}
            label="提高背景不透明度"
          />
        </div>

        <label className="setting-row boundary-setting">
          <div>
            <strong>一天从几点开始</strong>
            <span>夜里仍算作前一天，避免午夜被打断</span>
          </div>
          <select
            value={settings.dayBoundaryHour}
            onChange={(event) => mutate({ type: "settings:set", key: "dayBoundaryHour", value: Number(event.target.value) })}
          >
            <option value="0">00:00</option>
            <option value="2">02:00</option>
            <option value="4">04:00</option>
            <option value="6">06:00</option>
          </select>
        </label>

        <div className="shortcut-card">
          <Keyboard size={20} />
          <div>
            <strong>全局快捷键</strong>
            <span><kbd>Ctrl</kbd><b>+</b><kbd>Alt</kbd><b>+</b><kbd>N</kbd> 显示 / 隐藏</span>
            <span><kbd>Ctrl</kbd><b>+</b><kbd>Alt</kbd><b>+</b><kbd>Space</kbd> 立即记录</span>
          </div>
        </div>

        {shortcutFailures.length ? (
          <div className="shortcut-warning" role="status">
            <WarningCircle size={20} weight="fill" />
            <div>
              <strong>有快捷键被其他软件占用</strong>
              <span>{shortcutFailures.join("；")}。你仍可从系统托盘使用全部功能。</span>
            </div>
          </div>
        ) : null}

        <div className="sheet-actions two-up">
          <button type="button" className="secondary-button" onClick={() => noteApi.openDataFolder()}>
            <FolderOpen size={18} /> 数据位置
          </button>
          <button type="button" className="secondary-button" onClick={async () => {
            const result = await noteApi.exportMarkdown();
            if (result.ok) showToast("已导出 Markdown");
          }}>
            <DownloadSimple size={18} /> 导出
          </button>
        </div>
      </section>
    </div>
  );
}

function RolloverSheet({ state, mutate, showToast }) {
  const pending = state.pendingRollover;
  const candidates = pending
    ? (state.days[pending.fromDay]?.tasks || []).filter(
      (task) => pending.taskIds.includes(task.id) && !task.done,
    )
    : [];
  const candidateIds = candidates.map((task) => task.id).join("|");
  const [selected, setSelected] = useState(() => new Set(candidates.map((task) => task.id)));

  useEffect(() => {
    setSelected(new Set(candidates.map((task) => task.id)));
  }, [pending?.fromDay, pending?.toDay, candidateIds]);

  if (!pending) return null;
  return (
    <div className="sheet-backdrop rollover-backdrop">
      <section className="rollover-sheet" role="dialog" aria-modal="true" aria-label="整理昨天的任务">
        <p className="eyebrow">新的一天</p>
        <h2>整理昨天</h2>
        <p className="rollover-copy">还有 {candidates.length} 件没有完成。只把仍值得做的移到今天。</p>
        <div className="rollover-list">
          {candidates.map((task) => (
            <label key={task.id}>
              <AppCheckbox
                checked={selected.has(task.id)}
                label={`选择：${task.text}`}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(task.id)) next.delete(task.id);
                  else next.add(task.id);
                  setSelected(next);
                }}
              />
              <span>{task.text}</span>
            </label>
          ))}
        </div>
        <div className="sheet-actions">
          <button type="button" className="secondary-button" onClick={() => mutate({ type: "rollover:dismiss" })}>
            留在原日
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!selected.size}
            onClick={async () => {
              await mutate({ type: "rollover:move", taskIds: [...selected] });
              showToast(`已移到今天 ${selected.size} 件`);
            }}
          >
            移到今天 {selected.size ? `(${selected.size})` : ""}
          </button>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [state, setState] = useState(null);
  const [saveStatus, setSaveStatus] = useState("saved");
  const [newTask, setNewTask] = useState(loadQuickDraft);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);
  const [recentlyCompleted, setRecentlyCompleted] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [editingDrafts, setEditingDrafts] = useState(() => new Set());
  const inputRef = useRef(null);
  const toastTimer = useRef(null);
  const submittingRef = useRef(false);
  const newTaskRef = useRef(newTask);
  const quickEntryTouched = useRef(false);
  const pendingMutations = useRef(new Set());

  const showToast = useCallback((message, actionLabel = null, action = null) => {
    clearTimeout(toastTimer.current);
    setToast({ message, actionLabel, action });
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const setEditingDraftState = useCallback((id, dirty) => {
    setEditingDrafts((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    let active = true;
    noteApi.getState().then((result) => {
      if (active && result.ok) setState(result.state);
    });
    const unsubState = noteApi.onState(({ state: next, status }) => {
      setState(next);
      if (status) setSaveStatus(status);
    });
    const unsubSave = noteApi.onSaveStatus(setSaveStatus);
    const unsubFocus = noteApi.onFocusInput(() => setTimeout(() => inputRef.current?.focus(), 30));
    const unsubSettings = noteApi.onOpenSettings(() => setSettingsOpen(true));
    return () => {
      active = false;
      unsubState?.();
      unsubSave?.();
      unsubFocus?.();
      unsubSettings?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setSettingsOpen(false);
        setClearConfirm(false);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const mutate = useCallback((operation) => {
    setSaveStatus("saving");
    const request = Promise.resolve()
      .then(() => noteApi.mutate(operation))
      .then((result) => {
        if (!result.ok) {
          setSaveStatus("error");
          showToast(result.error || "操作没有完成");
          return result;
        }
        if (result.state) setState(result.state);
        return result;
      })
      .catch((error) => {
        setSaveStatus("error");
        showToast(error?.message || "操作没有完成");
        return { ok: false, error: error?.message || "操作没有完成" };
      });
    pendingMutations.current.add(request);
    void request.finally(() => pendingMutations.current.delete(request));
    return request;
  }, [showToast]);

  useEffect(() => noteApi.onPrepareQuit?.(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled([...pendingMutations.current]);
    await noteApi.quitReady?.();
  }), []);

  const submitNewTask = useCallback(async (refocus = true) => {
    const text = newTask.trim();
    if (!text || submittingRef.current) return;
    const beforeIds = new Set(
      state?.days[state.activeDay]?.tasks?.map((task) => task.id) || [],
    );
    submittingRef.current = true;
    setSubmittingTask(true);
    try {
      const result = await mutate({ type: "task:add", text });
      if (result.ok) {
        if (newTaskRef.current.trim() === text) {
          newTaskRef.current = "";
          quickEntryTouched.current = false;
          setNewTask("");
          keepQuickDraft("");
        }
        const resultTasks = result.state?.days?.[result.state.activeDay]?.tasks || [];
        const addedTask = resultTasks.find((task) => !beforeIds.has(task.id));
        setTimeout(() => {
          if (addedTask) {
            document.querySelector(`[data-task-id="${addedTask.id}"]`)?.scrollIntoView({ block: "nearest" });
          }
          if (refocus) inputRef.current?.focus();
        }, 0);
      }
      return result;
    } finally {
      submittingRef.current = false;
      setSubmittingTask(false);
    }
  }, [mutate, newTask, state]);

  const activeTasks = useMemo(() => {
    if (!state) return [];
    return state.days[state.activeDay]?.tasks || [];
  }, [state]);

  const focusTasks = useMemo(
    () => sortTasks(activeTasks.filter((task) => task.section === "focus" && !task.hidden)),
    [activeTasks],
  );
  const todayTasks = useMemo(
    () => sortTasks(activeTasks.filter((task) => task.section === "today" && !task.hidden && (!task.done || recentlyCompleted.has(task.id)))),
    [activeTasks, recentlyCompleted],
  );
  const completedTasks = useMemo(
    () => [...activeTasks].filter((task) => task.done && !task.hidden).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
    [activeTasks],
  );

  const onToggle = useCallback(async (task) => {
    if (!task.done && task.section === "today") {
      setRecentlyCompleted((current) => new Set(current).add(task.id));
      setTimeout(() => {
        setRecentlyCompleted((current) => {
          const next = new Set(current);
          next.delete(task.id);
          return next;
        });
      }, state?.settings.reducedMotion ? 120 : 720);
    }
    await mutate({ type: "task:toggle", id: task.id, done: !task.done });
    if (!task.done) {
      showToast("已完成", "撤销", () => mutate({ type: "task:toggle", id: task.id, done: false }));
    }
  }, [mutate, showToast, state?.settings.reducedMotion]);

  const onDelete = useCallback(async (task) => {
    setOpenMenu(null);
    await mutate({ type: "task:delete", id: task.id });
    showToast("已删除", "撤销", () => mutate({ type: "task:restore", dayKey: state.activeDay, task }));
  }, [mutate, showToast, state?.activeDay]);

  const onMove = useCallback(async (task) => {
    setOpenMenu(null);
    const target = task.section === "focus" ? "today" : "focus";
    await mutate({ type: "task:move", id: task.id, toSection: target, toIndex: 99 });
  }, [mutate]);

  const onDragStart = useCallback((event, task) => {
    setDragging(task);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
  }, []);

  const dropOn = useCallback(async (event, targetTask, section = targetTask?.section) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || dragging?.id;
    if (!id || !section) {
      setDragging(null);
      return;
    }
    const targetIndex = targetTask ? targetTask.order : 99;
    await mutate({ type: "task:move", id, toSection: section, toIndex: targetIndex });
    setDragging(null);
  }, [dragging, mutate]);

  if (!state) {
    return (
      <main className={`preview-shell ${isDesktop ? "desktop-runtime" : ""}`}>
        <div className="note-frame">
          <section className="note-card loading-card"><span>Note</span></section>
        </div>
      </main>
    );
  }

  const completedCount = completedTasks.length;
  const totalCount = activeTasks.length;
  const rowProps = {
    mutate,
    onToggle,
    onDelete,
    onMove,
    openMenu,
    setOpenMenu,
    onDragStart,
    onDragEnd: () => setDragging(null),
    onDrop: dropOn,
    onDraftState: setEditingDraftState,
  };

  return (
    <main
      className={`preview-shell ${isDesktop ? "desktop-runtime" : ""} ${state.settings.reducedMotion ? "reduce-motion" : ""}`}
      onClick={(event) => {
        if (!event.target.closest(".task-actions")) setOpenMenu(null);
        if (quickEntryTouched.current
          && !event.target.closest(".quick-entry")
          && newTaskRef.current.trim()) {
          void submitNewTask(false);
        }
      }}
    >
      <div className="note-frame">
        <section
          className={`note-card ${state.settings.reducedTransparency ? "opaque-card" : ""}`}
          aria-label="Note 今日清单"
          onContextMenu={(event) => {
            event.preventDefault();
            setSettingsOpen(true);
          }}
        >
        <header className="app-header">
          <button type="button" className="wordmark" onClick={() => setSettingsOpen(true)} title="打开设置">
            <Asterisk size={18} weight="bold" aria-hidden="true" />
            <span>Note</span>
          </button>
          <div className="header-tools">
            <div className="window-grip" title="拖动窗口">
              <DotsSixVertical size={20} weight="bold" aria-hidden="true" />
            </div>
            <button
              type="button"
              className="icon-button clear-button"
              aria-label="清空今天已完成的任务"
              disabled={!completedCount}
              onClick={() => setClearConfirm(true)}
            >
              <Trash size={22} />
            </button>
          </div>
        </header>

        <div className="date-block">
          <h1>{formatDay(state.activeDay)}</h1>
          <p><strong>{completedCount}</strong><span>/ {totalCount} 已完成</span></p>
        </div>

        <div className="content-scroll">
          <Section title="今日三件" className="focus-section" onDropEnd={(event) => dropOn(event, null, "focus")}>
            {focusTasks.length ? focusTasks.map((task) => <TaskRow key={task.id} task={task} {...rowProps} />) : (
              <p className="empty-hint">先写下今天最重要的一件事</p>
            )}
          </Section>

          <Section title="今天" onDropEnd={(event) => dropOn(event, null, "today")}>
            {todayTasks.length ? todayTasks.map((task) => <TaskRow key={task.id} task={task} {...rowProps} />) : (
              <p className="empty-hint">前三件之后的任务会排在这里</p>
            )}
          </Section>

          <section className={`completed-section ${completedOpen ? "is-open" : ""}`}>
            <button
              type="button"
              className="completed-toggle"
              aria-expanded={completedOpen}
              onClick={() => setCompletedOpen((value) => !value)}
            >
              <CaretDown size={20} />
              <span>已完成 {completedCount}</span>
              <span className="completed-spacer" />
              {completedOpen ? <Minus size={18} /> : <CaretRight size={18} />}
            </button>
            {completedOpen ? (
              <div className="completed-list">
                {completedTasks.length
                  ? completedTasks.map((task) => <TaskRow key={`done-${task.id}`} task={task} {...rowProps} compact />)
                  : <p className="empty-hint">完成一件后，会安静地收进这里</p>}
              </div>
            ) : null}
          </section>
        </div>

        <form
          className="quick-entry"
          onSubmit={async (event) => {
            event.preventDefault();
            await submitNewTask(true);
          }}
        >
          <button
            type="submit"
            className="quick-add-button"
            aria-label="添加任务"
            disabled={!newTask.trim() || submittingTask}
          >
            <Plus size={23} aria-hidden="true" />
          </button>
          <input
            ref={inputRef}
            value={newTask}
            spellCheck="false"
            aria-label="写下下一件事"
            placeholder="写下下一件事…"
            onChange={(event) => {
              const value = event.target.value;
              newTaskRef.current = value;
              quickEntryTouched.current = true;
              setNewTask(value);
              keepQuickDraft(value);
            }}
            onBlur={() => {
              if (quickEntryTouched.current && newTask.trim()) void submitNewTask(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitNewTask(true);
              }
            }}
          />
        </form>

        <footer className="save-status" aria-live="polite">
          <span className={`status-dot ${saveStatus === "saving" || submittingTask || editingDrafts.size ? "is-saving" : ""} ${saveStatus === "error" ? "is-error" : ""}`} />
          {submittingTask
            ? "正在添加…"
            : newTask.trim()
              ? "草稿已保留 · 回车添加"
              : saveStatus === "error"
                ? "保存失败"
                : editingDrafts.size
                  ? "正在输入，稍后保存…"
                  : saveStatus === "saving" ? "正在保存…" : "已保存"}
        </footer>

        {toast ? (
          <div className="toast" role="status">
            <span>{toast.message}</span>
            {toast.actionLabel ? (
              <button type="button" onClick={() => {
                toast.action?.();
                setToast(null);
              }}>
                {toast.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}

        {clearConfirm ? (
          <div className="sheet-backdrop confirm-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setClearConfirm(false)}>
            <section className="confirm-sheet" role="dialog" aria-modal="true" aria-label="清空已完成任务">
              <h2>收起今天的完成记录？</h2>
              <p>这会从今天移除 {completedCount} 件已完成任务，你可以立即撤销。</p>
              <div className="sheet-actions">
                <button type="button" className="secondary-button" onClick={() => setClearConfirm(false)}>取消</button>
                <button type="button" className="danger-button" onClick={async () => {
                  const removed = completedTasks.map((task) => structuredClone(task));
                  setClearConfirm(false);
                  await mutate({ type: "tasks:clearCompleted" });
                  showToast(`已清空 ${removed.length} 项`, "撤销", () => mutate({
                    type: "tasks:restore",
                    dayKey: state.activeDay,
                    tasks: removed,
                  }));
                }}>清空</button>
              </div>
            </section>
          </div>
        ) : null}

        {settingsOpen ? (
          <SettingsSheet state={state} close={() => setSettingsOpen(false)} mutate={mutate} showToast={showToast} />
        ) : null}
          <RolloverSheet state={state} mutate={mutate} showToast={showToast} />
        </section>
      </div>
    </main>
  );
}
