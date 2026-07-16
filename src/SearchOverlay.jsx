import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  ClockCounterClockwise,
  FileText,
  ListChecks,
  MagnifyingGlass,
  Plus,
  X,
} from "@phosphor-icons/react";
import storeModule from "desktop-note/store";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatTimeRange } from "./api.js";

const { searchState } = storeModule;
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function formatDay(key) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  return `${year}年${month}月${day}日 ${WEEKDAYS[date.getDay()]}`;
}

function noteTitle(note) {
  if (note.title.trim()) return note.title;
  const first = note.body.split(/\r?\n/).find((line) => line.trim()) || "";
  return first.replace(/^\s*(?:#{1,6}|>|[-+*])\s+/, "").replace(/[*_`~]/g, "").trim().slice(0, 60) || "无标题";
}

function excerpt(value, query) {
  const clean = String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query) return clean.slice(0, 100);
  const index = clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index - 32);
  return `${start ? "…" : ""}${clean.slice(start, start + 112)}${start + 112 < clean.length ? "…" : ""}`;
}

function SearchGroup({ title, icon, children }) {
  return (
    <section className="search-result-group">
      <h3>{icon}<span>{title}</span></h3>
      <div>{children}</div>
    </section>
  );
}

export function SearchOverlay({ state, close, mutate, showToast, openHistory, revealActiveTask }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const results = useMemo(() => searchState(state, query, { limit: 50 }), [query, state]);
  const flatResults = useMemo(() => [
    ...results.notes.map((item) => ({ type: "note", item })),
    ...results.openTasks.map((item) => ({ type: "openTask", item })),
    ...results.completedTasks.map((item) => ({ type: "completedTask", item })),
  ], [results]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => setActiveIndex(0), [query]);

  const openResult = async (entry) => {
    if (!entry) return;
    if (entry.type === "note") {
      close();
      await mutate({ type: "notes:navigate", viewId: "all", noteId: entry.item.id, pane: "editor" });
      return;
    }
    if (entry.item.dayKey === state.activeDay) {
      close();
      await revealActiveTask(entry.item);
      return;
    }
    close();
    openHistory(entry.item.dayKey, entry.item.id);
  };

  const hasResults = flatResults.length > 0;

  return (
    <div className="search-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="search-panel" role="dialog" aria-modal="true" aria-label="搜索 Note">
        <header className="search-input-row">
          <MagnifyingGlass size={20} />
          <input
            ref={inputRef}
            value={query}
            aria-label="搜索笔记和 Todo"
            placeholder="搜索笔记与所有日期的 Todo…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
              if (event.key === "ArrowDown" && flatResults.length) {
                event.preventDefault();
                setActiveIndex((index) => (index + 1) % flatResults.length);
              }
              if (event.key === "ArrowUp" && flatResults.length) {
                event.preventDefault();
                setActiveIndex((index) => (index - 1 + flatResults.length) % flatResults.length);
              }
              if (event.key === "Enter" && flatResults.length) {
                event.preventDefault();
                void openResult(flatResults[activeIndex]);
              }
            }}
          />
          <kbd>Ctrl K</kbd>
          <button type="button" aria-label="关闭搜索" onClick={close}><X size={18} /></button>
        </header>

        <div className="search-results" role="listbox" aria-label="搜索结果">
          {!query.trim() ? (
            <div className="search-idle">
              <MagnifyingGlass size={28} />
              <strong>一个入口，找到所有内容</strong>
              <span>搜索笔记标题、Markdown 正文，以及每个工作日的 Todo。历史任务只会以只读方式打开。</span>
            </div>
          ) : !hasResults ? (
            <div className="search-idle">
              <FileText size={27} />
              <strong>没有找到“{query.trim()}”</strong>
              <span>可以换一个关键词，或检查笔记是否仍在废纸篓。</span>
            </div>
          ) : (
            <>
              {results.notes.length ? (
                <SearchGroup title={`笔记 ${results.notes.length}`} icon={<FileText size={14} />}>
                  {results.notes.map((note) => {
                    const index = flatResults.findIndex((entry) => entry.type === "note" && entry.item.id === note.id);
                    return (
                      <button key={note.id} type="button" role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : ""} onMouseEnter={() => setActiveIndex(index)} onClick={() => void openResult({ type: "note", item: note })}>
                        <span className="search-result-icon"><FileText size={16} /></span>
                        <span className="search-result-copy"><strong>{noteTitle(note)}</strong><small>{excerpt(note.body, query)}</small></span>
                        <ArrowSquareOut size={15} />
                      </button>
                    );
                  })}
                </SearchGroup>
              ) : null}
              {results.openTasks.length ? (
                <SearchGroup title={`未完成 Todo ${results.openTasks.length}`} icon={<ListChecks size={14} />}>
                  {results.openTasks.map((task) => {
                    const index = flatResults.findIndex((entry) => entry.type === "openTask" && entry.item.id === task.id && entry.item.dayKey === task.dayKey);
                    return (
                      <button key={`${task.dayKey}-${task.id}`} type="button" role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : ""} onMouseEnter={() => setActiveIndex(index)} onClick={() => void openResult({ type: "openTask", item: task })}>
                        <span className="search-result-icon task"><i /></span>
                        <span className="search-result-copy"><strong>{task.text}</strong><small>{task.dayKey === state.activeDay ? "今天" : formatDay(task.dayKey)}{task.timeRange ? ` · ${formatTimeRange(task.timeRange)}` : ""}</small></span>
                        {task.dayKey === state.activeDay ? <ArrowSquareOut size={15} /> : <ClockCounterClockwise size={15} />}
                      </button>
                    );
                  })}
                </SearchGroup>
              ) : null}
              {results.completedTasks.length ? (
                <SearchGroup title={`已完成 Todo ${results.completedTasks.length}`} icon={<CheckCircle size={14} />}>
                  {results.completedTasks.map((task) => {
                    const index = flatResults.findIndex((entry) => entry.type === "completedTask" && entry.item.id === task.id && entry.item.dayKey === task.dayKey);
                    return (
                      <button key={`${task.dayKey}-${task.id}`} type="button" role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : ""} onMouseEnter={() => setActiveIndex(index)} onClick={() => void openResult({ type: "completedTask", item: task })}>
                        <span className="search-result-icon completed"><CheckCircle size={16} weight="fill" /></span>
                        <span className="search-result-copy"><strong>{task.text}</strong><small>{task.dayKey === state.activeDay ? "今天" : formatDay(task.dayKey)}{task.timeRange ? ` · ${formatTimeRange(task.timeRange)}` : ""}</small></span>
                        {task.dayKey === state.activeDay ? <ArrowSquareOut size={15} /> : <ClockCounterClockwise size={15} />}
                      </button>
                    );
                  })}
                </SearchGroup>
              ) : null}
            </>
          )}
        </div>
        {query.trim() && hasResults ? <footer>↑↓ 选择 · Enter 打开 · Esc 关闭</footer> : null}
      </section>
    </div>
  );
}

export function HistoryReview({ state, dayKey, taskId, close, mutate, showToast }) {
  const day = state.days[dayKey];
  const tasks = useMemo(() => [...(day?.tasks || [])].sort((left, right) => {
    if (left.section !== right.section) return left.section === "focus" ? -1 : 1;
    return left.order - right.order;
  }), [day]);
  const matched = tasks.find((task) => task.id === taskId);

  return (
    <div className="history-backdrop">
      <section className="history-panel" role="dialog" aria-modal="true" aria-label={`${dayKey} 历史任务回看`}>
        <header>
          <button type="button" className="icon-button" aria-label="关闭历史回看" onClick={close}><ArrowLeft size={19} /></button>
          <div><span>只读回看</span><h2>{formatDay(dayKey)}</h2></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={close}><X size={18} /></button>
        </header>
        <p className="history-notice"><ClockCounterClockwise size={15} /> 这里不会改变当前工作日，也不会改写历史内容。</p>
        <div className="history-task-list">
          {tasks.map((task) => (
            <article key={task.id} className={`${task.id === taskId ? "is-match" : ""} ${task.done ? "is-done" : ""}`}>
              <span className="history-check">{task.done ? <CheckCircle size={18} weight="fill" /> : <i />}</span>
              <div><strong>{task.text}</strong>{task.timeRange ? <small>{formatTimeRange(task.timeRange)}</small> : null}</div>
              {task.id === taskId ? <em>匹配</em> : null}
            </article>
          ))}
          {!tasks.length ? <div className="history-empty">这个工作日没有保留任务。</div> : null}
        </div>
        {matched ? (
          <footer>
            {matched.noteId && state.notes[matched.noteId] ? (
              <button type="button" className="secondary-button" onClick={async () => {
                const note = state.notes[matched.noteId];
                close();
                await mutate({ type: "notes:navigate", viewId: note.trashedAt ? "trash" : "all", noteId: note.id, pane: "editor" });
              }}><FileText size={16} /> 打开关联笔记</button>
            ) : <span />}
            <button type="button" className="primary-button" onClick={async () => {
              const result = await mutate({
                type: "task:add",
                text: matched.text,
                timeRange: matched.timeRange,
                noteId: matched.noteId && !state.notes[matched.noteId]?.trashedAt ? matched.noteId : null,
              });
              if (result.ok) showToast("已复制到今天", "查看", async () => {
                close();
                await mutate({ type: "settings:set", key: "activeModule", value: "todo" });
              });
            }}><Plus size={16} /> 复制到今天</button>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
