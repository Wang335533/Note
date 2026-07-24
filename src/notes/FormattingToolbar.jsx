import {
  CaretLeft,
  CaretRight,
  Code,
  Columns,
  ColumnsPlusLeft,
  ColumnsPlusRight,
  DotsThree,
  Eraser,
  LinkSimple,
  ListBullets,
  ListChecks,
  ListNumbers,
  PaintBrush,
  Quotes,
  Rows,
  RowsPlusBottom,
  RowsPlusTop,
  Table as TableIcon,
  TextB,
  TextAlignCenter,
  TextAlignJustify,
  TextAlignLeft,
  TextAlignRight,
  TextIndent,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  BLOCK_OPTIONS,
  FONT_OPTIONS,
  LINE_HEIGHT_OPTIONS,
  nextFontSizeValue,
  SIZE_OPTIONS,
} from "./rich-text.js";

const ALIGNMENT_OPTIONS = Object.freeze([
  { value: "left", label: "左对齐", shortcut: "Ctrl + L", Icon: TextAlignLeft },
  { value: "center", label: "居中", shortcut: "Ctrl + E", Icon: TextAlignCenter },
  { value: "right", label: "右对齐", shortcut: "Ctrl + R", Icon: TextAlignRight },
  { value: "justify", label: "两端对齐", shortcut: "Ctrl + J", Icon: TextAlignJustify },
]);

function FormatButton({ label, active = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      className={`format-tool-button ${active ? "is-active" : ""}`}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      data-format-button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function FormattingToolbar({
  editorRef,
  selection,
  formatState,
  collapsed,
  onToggleCollapsed,
  readOnly = false,
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ rows: 3, columns: 3 });
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const linkInputRef = useRef(null);
  const toolbarShellRef = useRef(null);

  useEffect(() => {
    if (!moreOpen && !linkOpen && !tableOpen && !alignmentOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      setLinkOpen(false);
      setTableOpen(false);
      setAlignmentOpen(false);
      editorRef.current?.cancelFormatPainter?.();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [alignmentOpen, editorRef, linkOpen, moreOpen, tableOpen]);

  useEffect(() => {
    if (!moreOpen && !linkOpen && !tableOpen && !alignmentOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (toolbarShellRef.current?.contains(event.target)) return;
      setMoreOpen(false);
      setLinkOpen(false);
      setTableOpen(false);
      setAlignmentOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [alignmentOpen, linkOpen, moreOpen, tableOpen]);

  useEffect(() => {
    if (linkOpen) requestAnimationFrame(() => linkInputRef.current?.focus());
  }, [linkOpen]);

  if (readOnly) return null;
  if (collapsed) {
    return (
      <div className="format-toolbar-stack">
        <div className="format-toolbar-shell is-collapsed">
          <button
            type="button"
            className="format-collapse-symbol"
            aria-label="展开格式工具栏"
            title="展开格式工具栏"
            onClick={onToggleCollapsed}
          >
            <CaretRight size={15} weight="bold" />
          </button>
        </div>
      </div>
    );
  }

  const applyInline = (kind, value = "") => editorRef.current?.applyInline?.(kind, value);
  const applyBlock = (type) => editorRef.current?.applyBlock?.(type);
  const hasSelection = Number(selection?.to) > Number(selection?.from);
  const paragraphValue = BLOCK_OPTIONS.some((option) => option.value === formatState.block)
    ? formatState.block
    : "paragraph";
  const canDecreaseFont = Boolean(nextFontSizeValue(formatState.size, "decrease", formatState.block));
  const canIncreaseFont = Boolean(nextFontSizeValue(formatState.size, "increase", formatState.block));
  const ActiveAlignmentIcon = ALIGNMENT_OPTIONS.find(({ value }) => value === formatState.textAlign)?.Icon
    || TextAlignLeft;

  const submitLink = (event) => {
    event.preventDefault();
    if (!linkUrl.trim()) return;
    editorRef.current?.insertLink?.(linkUrl, linkLabel);
    setLinkOpen(false);
    setLinkUrl("");
    setLinkLabel("");
  };

  const moveToolbarFocus = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (event.target.matches("select, input")) return;
    const controls = [...event.currentTarget.querySelectorAll("[data-format-button]:not(:disabled)")];
    const index = controls.indexOf(document.activeElement);
    if (index < 0 || !controls.length) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  };

  return (
    <div ref={toolbarShellRef} className={`format-toolbar-stack ${formatState.inTable ? "has-table-context" : ""}`}>
      <div className="format-toolbar-shell">
        <div className="format-toolbar" role="toolbar" aria-label="正文格式" onKeyDown={moveToolbarFocus}>
          <FormatButton label="收起格式工具栏" onClick={onToggleCollapsed}>
            <CaretLeft size={14} weight="bold" />
          </FormatButton>
          <label className="format-select paragraph-format-select" title="段落样式">
            <select value={paragraphValue} aria-label="段落样式" onChange={(event) => applyBlock(event.target.value)}>
              {BLOCK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <span className="format-divider" aria-hidden="true" />
          <FormatButton
            label="缩小一号字体（Ctrl + [）"
            disabled={!canDecreaseFont}
            onClick={() => editorRef.current?.stepFontSize?.("decrease")}
          ><span className="font-step-symbol" aria-hidden="true"><b>A</b><i>↓</i></span></FormatButton>
          <FormatButton
            label="放大一号字体（Ctrl + ]）"
            disabled={!canIncreaseFont}
            onClick={() => editorRef.current?.stepFontSize?.("increase")}
          ><span className="font-step-symbol" aria-hidden="true"><b>A</b><i>↑</i></span></FormatButton>
          <FormatButton label="加粗" active={formatState.bold} onClick={() => applyInline("bold")}><TextB size={16} weight="bold" /></FormatButton>
          <FormatButton label="斜体" active={formatState.italic} onClick={() => applyInline("italic")}><TextItalic size={16} /></FormatButton>
          <FormatButton label="下划线" active={formatState.underline} onClick={() => applyInline("underline")}><TextUnderline size={16} /></FormatButton>
          <FormatButton label="项目符号" active={formatState.block === "bullet"} onClick={() => applyBlock("bullet")}><ListBullets size={17} /></FormatButton>
          <FormatButton label="编号列表" active={formatState.block === "numbered"} onClick={() => applyBlock("numbered")}><ListNumbers size={17} /></FormatButton>
          <FormatButton
            label={formatState.textAlignMixed ? "段落对齐（混合）" : `段落对齐：${ALIGNMENT_OPTIONS.find(({ value }) => value === formatState.textAlign)?.label || "左对齐"}`}
            active={alignmentOpen}
            disabled={!formatState.canTextAlign}
            onClick={() => {
              setLinkOpen(false);
              setTableOpen(false);
              setMoreOpen(false);
              setAlignmentOpen((open) => !open);
            }}
          ><ActiveAlignmentIcon size={17} /></FormatButton>
          <FormatButton label="插入表格" active={tableOpen} disabled={formatState.inTable} onClick={() => {
            setLinkOpen(false);
            setMoreOpen(false);
            setAlignmentOpen(false);
            setTableOpen((open) => !open);
          }}><TableIcon size={17} /></FormatButton>
          <FormatButton label="更多格式" active={moreOpen} onClick={() => {
            setLinkOpen(false);
            setTableOpen(false);
            setAlignmentOpen(false);
            setMoreOpen((open) => !open);
          }}><DotsThree size={17} weight="bold" /></FormatButton>
        </div>
      </div>

      {formatState.inTable ? (
        <div
          className="table-context-toolbar"
          role="toolbar"
          aria-label="表格操作"
          onMouseDown={(event) => {
            if (event.target.closest("button")) event.preventDefault();
          }}
        >
          <span className="table-context-label"><TableIcon size={14} /> 表格</span>
          <button type="button" disabled={!formatState.canAddTableRow} aria-label="在上方添加行" onClick={() => editorRef.current?.applyTableCommand?.("addRowBefore")}><RowsPlusTop size={15} />上行</button>
          <button type="button" disabled={!formatState.canAddTableRow} aria-label="在下方添加行" onClick={() => editorRef.current?.applyTableCommand?.("addRowAfter")}><RowsPlusBottom size={15} />下行</button>
          <button type="button" disabled={!formatState.canAddTableColumn} aria-label="在左侧添加列" onClick={() => editorRef.current?.applyTableCommand?.("addColumnBefore")}><ColumnsPlusLeft size={15} />左列</button>
          <button type="button" disabled={!formatState.canAddTableColumn} aria-label="在右侧添加列" onClick={() => editorRef.current?.applyTableCommand?.("addColumnAfter")}><ColumnsPlusRight size={15} />右列</button>
          <span className="table-context-divider" aria-hidden="true" />
          <button type="button" aria-label="删除当前行" onClick={() => editorRef.current?.applyTableCommand?.("deleteRow")}><Rows size={15} />删行</button>
          <button type="button" aria-label="删除当前列" onClick={() => editorRef.current?.applyTableCommand?.("deleteColumn")}><Columns size={15} />删列</button>
          <button
            type="button"
            className={formatState.tableHasHeader ? "is-active" : ""}
            aria-pressed={formatState.tableHasHeader}
            onClick={() => editorRef.current?.applyTableCommand?.("toggleHeaderRow")}
          >表头</button>
          <button type="button" className="is-danger" onClick={() => editorRef.current?.applyTableCommand?.("deleteTable")}>删表</button>
        </div>
      ) : null}

      {alignmentOpen ? (
        <div className="format-popover alignment-format-popover" aria-label="段落布局">
          <div className="alignment-format-grid" role="group" aria-label="文字对齐">
            {ALIGNMENT_OPTIONS.map(({ value, label, shortcut, Icon }) => (
              <button
                type="button"
                key={value}
                className={!formatState.textAlignMixed && formatState.textAlign === value ? "is-active" : ""}
                aria-label={`${label}（${shortcut}）`}
                aria-pressed={!formatState.textAlignMixed && formatState.textAlign === value}
                title={`${label} · ${shortcut}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  editorRef.current?.applyTextAlign?.(value);
                  setAlignmentOpen(false);
                }}
              >
                <Icon size={17} />
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`first-line-indent-toggle ${formatState.firstLineIndent ? "is-active" : ""}`}
            aria-pressed={formatState.firstLineIndent}
            disabled={!formatState.canFirstLineIndent}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              editorRef.current?.toggleFirstLineIndent?.();
              setAlignmentOpen(false);
            }}
          >
            <TextIndent size={17} />
            <span><strong>首行缩进</strong><small>固定 2 字符</small></span>
          </button>
          <small className="alignment-format-hint">仅正文段落支持首行缩进</small>
        </div>
      ) : null}

      {tableOpen ? (
        <div className="format-popover table-grid-popover" aria-label="选择表格大小">
          <header>
            <span>插入表格</span>
            <strong>{tableHover.rows} × {tableHover.columns}</strong>
          </header>
          <div className="table-grid-picker" role="grid" aria-label="表格行列">
            {Array.from({ length: 8 }, (_, rowIndex) => Array.from({ length: 10 }, (__, columnIndex) => {
              const rows = rowIndex + 1;
              const columns = columnIndex + 1;
              const selected = rows <= tableHover.rows && columns <= tableHover.columns;
              return (
                <button
                  type="button"
                  key={`${rows}-${columns}`}
                  className={selected ? "is-selected" : ""}
                  aria-label={`${rows} 行 ${columns} 列`}
                  onMouseEnter={() => setTableHover({ rows, columns })}
                  onFocus={() => setTableHover({ rows, columns })}
                  onClick={() => {
                    editorRef.current?.insertTable?.(rows, columns);
                    setTableOpen(false);
                  }}
                />
              );
            }))}
          </div>
          <small>首行默认为表头</small>
        </div>
      ) : null}

      {linkOpen ? (
        <form className="format-popover link-format-popover" aria-label="插入链接" onSubmit={submitLink}>
          {!hasSelection ? (
            <label>
              <span>显示文字</span>
              <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="链接文字" />
            </label>
          ) : <p className="format-popover-selection">为“{selection.text.slice(0, 34)}{selection.text.length > 34 ? "…" : ""}”添加链接</p>}
          <label>
            <span>网址</span>
            <input ref={linkInputRef} value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://" />
          </label>
          <div className="format-popover-actions">
            <button type="button" onClick={() => setLinkOpen(false)}>取消</button>
            <button type="submit" className="is-primary" disabled={!linkUrl.trim()}>插入</button>
          </div>
        </form>
      ) : null}

      {moreOpen ? (
        <div className="format-popover more-format-popover" aria-label="更多格式">
          <label className="more-format-field">
            <span>字体</span>
            <select value={formatState.font || ""} onChange={(event) => applyInline("font", event.target.value)}>
              {FONT_OPTIONS.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="more-format-field">
            <span>字号</span>
            <select value={formatState.size || ""} onChange={(event) => applyInline("size", event.target.value)}>
              {SIZE_OPTIONS.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="more-format-field">
            <span>行距</span>
            <select
              value={formatState.lineHeight || ""}
              disabled={formatState.block === "code-block"}
              onChange={(event) => editorRef.current?.applyLineHeight?.(event.target.value)}
            >
              {LINE_HEIGHT_OPTIONS.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div className="more-format-grid">
            <FormatButton label="待办清单" active={formatState.block === "checklist"} onClick={() => applyBlock("checklist")}><ListChecks size={17} /></FormatButton>
            <FormatButton label="插入链接" active={linkOpen} onClick={() => {
              setMoreOpen(false);
              setAlignmentOpen(false);
              setLinkOpen(true);
            }}><LinkSimple size={16} /></FormatButton>
            <FormatButton label="删除线" active={formatState.strike} onClick={() => applyInline("strike")}><TextStrikethrough size={17} /></FormatButton>
            <FormatButton label="引用" active={formatState.block === "quote"} onClick={() => applyBlock("quote")}><Quotes size={17} /></FormatButton>
            <FormatButton label="行内代码" active={formatState.code} onClick={() => applyInline("code")}><Code size={17} /></FormatButton>
            <FormatButton label="插入公式（Ctrl + Shift + E）" onClick={() => {
              editorRef.current?.openMathEditor?.();
              setMoreOpen(false);
            }}><span className="formula-tool-symbol" aria-hidden="true">∑</span></FormatButton>
            <FormatButton label="格式刷（使用一次）" active={formatState.painterActive} onClick={() => {
              editorRef.current?.startFormatPainter?.();
              setMoreOpen(false);
            }}><PaintBrush size={17} /></FormatButton>
            <FormatButton label="清除所选格式" disabled={!hasSelection} onClick={() => editorRef.current?.clearFormatting?.()}><Eraser size={17} /></FormatButton>
          </div>
          <small>{formatState.painterActive ? "拖选目标文字后应用一次；Esc 取消" : "格式刷只应用一次"}</small>
        </div>
      ) : null}
    </div>
  );
}
