import {
  CaretLeft,
  CaretRight,
  Code,
  DotsThree,
  Eraser,
  LinkSimple,
  ListBullets,
  ListChecks,
  ListNumbers,
  PaintBrush,
  Quotes,
  TextB,
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
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const linkInputRef = useRef(null);
  const toolbarShellRef = useRef(null);

  useEffect(() => {
    if (!moreOpen && !linkOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      setLinkOpen(false);
      editorRef.current?.cancelFormatPainter?.();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [editorRef, linkOpen, moreOpen]);

  useEffect(() => {
    if (!moreOpen && !linkOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (toolbarShellRef.current?.contains(event.target)) return;
      setMoreOpen(false);
      setLinkOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [linkOpen, moreOpen]);

  useEffect(() => {
    if (linkOpen) requestAnimationFrame(() => linkInputRef.current?.focus());
  }, [linkOpen]);

  if (readOnly) return null;
  if (collapsed) {
    return (
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
    <div ref={toolbarShellRef} className="format-toolbar-shell">
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
        <FormatButton label="更多格式" active={moreOpen} onClick={() => {
          setLinkOpen(false);
          setMoreOpen((open) => !open);
        }}><DotsThree size={17} weight="bold" /></FormatButton>
      </div>

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
