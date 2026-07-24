import { EditorContent, useEditor } from "@tiptap/react";
import { Fragment } from "@tiptap/pm/model";
import katex from "katex";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import richTextModule from "desktop-note/rich-text";
import { noteAssetUrl } from "desktop-note/library-files";
import { noteApi } from "../api.js";
import {
  createEditorExtensions,
  clipboardTextFromSlice,
  containsMathMarkup,
  fontFamilyFor,
  fontSizeFor,
  formatStateForEditor,
  migrateRichBodyMath,
  migrateRichBodyTables,
  migratePastedMathSlice,
  markdownTableInfo,
  normalizePastedParagraphLayoutSlice,
  richBodyFromHtml,
  richBodyFromLegacyMarkdown,
  setFontFamilyForEditor,
  stepFontSizeForEditor,
} from "./rich-text.js";

const {
  markdownFromRichBody,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  plainTextFromRichBody,
} = richTextModule;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PARAGRAPH_LAYOUT_HTML = /<(?:p|h[1-3])\b[^>]*(?:\balign\s*=|\bstyle\s*=\s*["'][^"']*(?:text-align|text-indent|mso-char-indent-count))/i;
const TABLE_COMMANDS = new Set([
  "addRowBefore",
  "addRowAfter",
  "deleteRow",
  "addColumnBefore",
  "addColumnAfter",
  "deleteColumn",
  "toggleHeaderRow",
  "deleteTable",
]);
const KATEX_PREVIEW_OPTIONS = Object.freeze({
  throwOnError: true,
  strict: "ignore",
  trust: false,
  maxExpand: 1000,
  output: "htmlAndMathml",
});

function normalizeLinkUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(?:https?:|mailto:)/i.test(raw)) return raw.replace(/\s/g, "%20");
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return "";
  return `https://${raw.replace(/\s/g, "%20")}`;
}

function selectionPayload(editor) {
  const { from, to } = editor.state.selection;
  return {
    from,
    to,
    text: from === to ? "" : editor.state.doc.textBetween(from, to, " ").trim(),
  };
}

function snapshotForPainter(editor) {
  const textStyle = editor.getAttributes("textStyle");
  const state = formatStateForEditor(editor);
  return {
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    strike: state.strike,
    code: state.code,
    fontFamily: textStyle.fontFamily || "",
    fontSize: textStyle.fontSize || "",
    lineHeight: state.lineHeight || "",
    textAlign: state.textAlign || "left",
    firstLineIndent: state.firstLineIndent,
    block: state.block,
  };
}

function applyBlockToChain(chain, type) {
  if (type === "heading-1") return chain.setHeading({ level: 1 });
  if (type === "heading-2") return chain.setHeading({ level: 2 });
  if (type === "heading-3") return chain.setHeading({ level: 3 });
  if (type === "quote") return chain.setBlockquote();
  if (type === "code-block") return chain.setCodeBlock();
  if (type === "bullet") return chain.toggleBulletList();
  if (type === "numbered") return chain.toggleOrderedList();
  if (type === "checklist") return chain.toggleTaskList();
  return chain.setParagraph();
}

function mathAnchor(editor, pos = null) {
  if (!editor?.view) return { left: 24, top: 80, bottom: 80, width: 0 };
  const dom = Number.isInteger(pos) ? editor.view.nodeDOM(pos) : null;
  const rectangle = dom instanceof Element
    ? dom.getBoundingClientRect()
    : editor.view.coordsAtPos(editor.state.selection.from);
  return {
    left: rectangle.left,
    top: rectangle.top,
    bottom: rectangle.bottom,
    width: rectangle.width || 0,
  };
}

function MathEditorPopover({ draft, onChange, onCommit, onCancel, onTypeChange, popoverRef }) {
  const previewRef = useRef(null);
  const inputRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [draft.id]);

  useEffect(() => {
    if (!previewRef.current) return;
    const latex = draft.latex.trim();
    if (!latex) {
      previewRef.current.textContent = "输入 LaTeX 后在这里预览";
      setError("");
      return;
    }
    try {
      katex.render(latex, previewRef.current, {
        ...KATEX_PREVIEW_OPTIONS,
        displayMode: draft.type === "block",
      });
      setError("");
    } catch (renderError) {
      previewRef.current.textContent = latex;
      setError(renderError?.message?.replace(/^KaTeX parse error:\s*/i, "") || "公式暂时无法编译");
    }
  }, [draft.latex, draft.type]);

  const width = Math.min(360, Math.max(280, window.innerWidth - 24));
  const estimatedHeight = 250;
  const left = Math.max(12, Math.min(draft.anchor.left, window.innerWidth - width - 12));
  const below = draft.anchor.bottom + 8;
  const top = below + estimatedHeight <= window.innerHeight
    ? below
    : Math.max(12, draft.anchor.top - estimatedHeight - 8);

  return createPortal(
    <div
      ref={popoverRef}
      className={`math-editor-popover ${error ? "has-error" : ""}`}
      style={{ left, top, width }}
      role="dialog"
      aria-label="编辑公式"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onCommit();
        }
      }}
    >
      <header>
        <div className="math-type-switch" aria-label="公式类型">
          <button type="button" className={draft.type === "inline" ? "is-active" : ""} onClick={() => onTypeChange("inline")}>行内</button>
          <button type="button" className={draft.type === "block" ? "is-active" : ""} onClick={() => onTypeChange("block")}>独立</button>
        </div>
        <span>LaTeX</span>
      </header>
      <div ref={previewRef} className="math-editor-preview" aria-live="polite" />
      <textarea
        ref={inputRef}
        value={draft.latex}
        spellCheck="false"
        aria-label="LaTeX 源码"
        placeholder="例如：x=\\begin{cases}1 & \\text{是}\\\\0 & \\text{否}\\end{cases}"
        onChange={(event) => onChange(event.target.value)}
      />
      <footer>
        <span className="math-editor-status">{error ? `源码已保留 · ${error}` : "Ctrl + Enter 确认 · Esc 取消"}</span>
        <div>
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="is-primary" onClick={onCommit}>{draft.latex.trim() ? "完成" : draft.existing ? "删除" : "取消"}</button>
        </div>
      </footer>
    </div>,
    document.body,
  );
}

function replaceMathNode(editor, draft, latex) {
  const node = editor.state.doc.nodeAt(draft.pos);
  if (!node || !["inlineMath", "blockMath"].includes(node.type.name)) return false;
  if (!latex) {
    return node.type.name === "inlineMath"
      ? editor.commands.deleteInlineMath({ pos: draft.pos })
      : editor.commands.deleteBlockMath({ pos: draft.pos });
  }
  const targetName = draft.type === "inline" ? "inlineMath" : "blockMath";
  if (node.type.name === targetName) {
    return targetName === "inlineMath"
      ? editor.commands.updateInlineMath({ pos: draft.pos, latex })
      : editor.commands.updateBlockMath({ pos: draft.pos, latex });
  }
  const { tr, schema } = editor.state;
  if (node.type.name === "blockMath") {
    const paragraph = schema.nodes.paragraph.create(null, schema.nodes.inlineMath.create({ latex }));
    tr.replaceWith(draft.pos, draft.pos + node.nodeSize, paragraph);
  } else {
    const $pos = tr.doc.resolve(draft.pos);
    const parent = $pos.parent;
    const before = parent.content.cut(0, $pos.parentOffset);
    const after = parent.content.cut($pos.parentOffset + node.nodeSize);
    const blocks = [];
    if (before.size) blocks.push(parent.type.create(parent.attrs, before));
    blocks.push(schema.nodes.blockMath.create({ latex }));
    if (after.size) blocks.push(parent.type.create(parent.attrs, after));
    if (!$pos.node(-1).canReplace($pos.index(-1), $pos.indexAfter(-1), Fragment.fromArray(blocks))) return false;
    tr.replaceWith($pos.before(), $pos.after(), Fragment.fromArray(blocks));
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

function editorIsReady(editor) {
  return Boolean(editor && !editor.isDestroyed);
}

export const RichTextEditor = forwardRef(function RichTextEditor({
  noteId,
  richBody,
  legacyMarkdown,
  onChange,
  onBlur,
  onSelectionChange,
  onFormatStateChange,
  onBusyChange,
  showToast,
  readOnly = false,
}, forwardedRef) {
  const callbacksRef = useRef({ onChange, onBlur, onSelectionChange, onFormatStateChange, onBusyChange, showToast });
  const editorRef = useRef(null);
  const editorShellRef = useRef(null);
  const mathPopoverRef = useRef(null);
  const painterSnapshotRef = useRef(null);
  const painterActiveRef = useRef(false);
  const preparedContent = useMemo(() => {
    if (!richBody) {
      return {
        content: richBodyFromLegacyMarkdown(legacyMarkdown, { resolveAssetUrl: (id) => noteApi.getAssetUrl?.(id) || "" }),
        migrated: true,
      };
    }
    const tableMigration = migrateRichBodyTables(richBody, {
      resolveAssetUrl: (id) => noteApi.getAssetUrl?.(id) || "",
    });
    const tableContent = tableMigration.richBody || richBody;
    const mathMigration = migrateRichBodyMath(tableContent);
    return {
      content: mathMigration.richBody || tableContent,
      migrated: tableMigration.changed || mathMigration.changed,
    };
  }, [noteId]);
  const migratedRef = useRef(preparedContent.migrated);
  const pendingMigrationSourceRef = useRef(preparedContent.migrated ? JSON.stringify(richBody) : null);
  const mountedContentEmittedRef = useRef(false);
  const [mathDraft, setMathDraft] = useState(null);

  callbacksRef.current = { onChange, onBlur, onSelectionChange, onFormatStateChange, onBusyChange, showToast };

  const initialContent = preparedContent.content;

  const emitSelection = (editor) => {
    callbacksRef.current.onSelectionChange?.(selectionPayload(editor));
    callbacksRef.current.onFormatStateChange?.(formatStateForEditor(editor, painterActiveRef.current));
  };

  const emitContent = (editor, options = {}) => {
    const nextRichBody = editor.getJSON();
    callbacksRef.current.onChange?.({
      richBody: nextRichBody,
      body: markdownFromRichBody(nextRichBody),
      plainText: plainTextFromRichBody(nextRichBody),
    }, options);
    emitSelection(editor);
  };

  const cancelPainter = ({ quiet = false } = {}) => {
    if (!painterActiveRef.current) return false;
    painterActiveRef.current = false;
    painterSnapshotRef.current = null;
    if (editorRef.current) emitSelection(editorRef.current);
    if (!quiet) callbacksRef.current.showToast?.("已取消格式刷");
    return true;
  };

  const applyPainter = () => {
    const editor = editorRef.current;
    const snapshot = painterSnapshotRef.current;
    if (!editor || !snapshot || editor.state.selection.empty) return false;
    painterActiveRef.current = false;
    painterSnapshotRef.current = null;
    let chain = editor.chain().focus().unsetAllMarks().clearNodes();
    if (snapshot.bold) chain = chain.setBold();
    if (snapshot.italic) chain = chain.setItalic();
    if (snapshot.underline) chain = chain.setUnderline();
    if (snapshot.strike) chain = chain.setStrike();
    if (snapshot.code) chain = chain.setCode();
    if (snapshot.fontFamily) chain = chain.setFontFamily(snapshot.fontFamily);
    if (snapshot.fontSize) chain = chain.setFontSize(snapshot.fontSize);
    chain = applyBlockToChain(chain, snapshot.block);
    chain = snapshot.lineHeight
      ? chain.setParagraphLineHeight(snapshot.lineHeight)
      : chain.unsetParagraphLineHeight();
    chain = snapshot.textAlign && snapshot.textAlign !== "left"
      ? chain.setTextAlign(snapshot.textAlign)
      : chain.unsetTextAlign();
    chain = snapshot.firstLineIndent
      ? chain.setFirstLineIndent()
      : chain.unsetFirstLineIndent();
    const applied = chain.run();
    callbacksRef.current.showToast?.("格式已应用");
    emitSelection(editor);
    return applied;
  };

  const addImages = async (files, position = null) => {
    const editor = editorRef.current;
    const images = files.filter((file) => IMAGE_TYPES.has(file.type));
    if (!editor || !images.length) return false;
    callbacksRef.current.onBusyChange?.(true);
    try {
      if (Number.isInteger(position)) editor.commands.setTextSelection(position);
      for (const file of images) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await noteApi.addNoteImage(noteId, {
          bytes,
          mimeType: file.type,
          fileName: file.name || "image",
        });
        if (!result.ok) throw new Error(result.error || "无法添加图片");
        editor.chain().focus().setImage({
          src: noteAssetUrl(result.attachment.id),
          alt: result.attachment.fileName,
        }).run();
      }
      return true;
    } catch (error) {
      callbacksRef.current.showToast?.(error?.message || "无法添加图片");
      return false;
    } finally {
      callbacksRef.current.onBusyChange?.(false);
    }
  };

  const openExistingMath = (node, pos, type) => {
    if (readOnly || !editorRef.current) return false;
    setMathDraft({
      id: `${type}-${pos}-${Date.now()}`,
      existing: true,
      type,
      pos,
      range: null,
      latex: String(node.attrs?.latex || ""),
      anchor: mathAnchor(editorRef.current, pos),
    });
    return true;
  };

  const openNewMath = () => {
    const currentEditor = editorRef.current;
    if (readOnly || !currentEditor) return false;
    const { from, to } = currentEditor.state.selection;
    const selected = from === to ? "" : currentEditor.state.doc.textBetween(from, to, " ").trim();
    setMathDraft({
      id: `new-${Date.now()}`,
      existing: false,
      type: selected ? "inline" : "block",
      pos: null,
      range: { from, to },
      latex: selected,
      anchor: mathAnchor(currentEditor),
    });
    return true;
  };

  const commitMathDraft = () => {
    const currentEditor = editorRef.current;
    const draft = mathDraft;
    if (!currentEditor || !draft) return false;
    const latex = draft.latex.trim();
    let applied = false;
    if (draft.existing) applied = replaceMathNode(currentEditor, draft, latex);
    else if (latex) {
      const node = { type: draft.type === "inline" ? "inlineMath" : "blockMath", attrs: { latex } };
      applied = currentEditor.chain().focus().setTextSelection(draft.range).insertContent(node).run();
    } else applied = true;
    setMathDraft(null);
    return applied;
  };

  const editor = useEditor({
    extensions: createEditorExtensions({
      resolveAssetUrl: (id) => noteApi.getAssetUrl?.(id) || "",
      cancelPainter: () => cancelPainter(),
      onMathClick: openExistingMath,
      openMathEditor: openNewMath,
    }),
    content: initialContent,
    editable: !readOnly,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        class: "rich-note-prosemirror",
        role: "textbox",
        "aria-label": "笔记正文",
        spellcheck: "true",
        autocapitalize: "sentences",
      },
      clipboardTextSerializer: clipboardTextFromSlice,
      transformPasted(slice, view) {
        const migrated = migratePastedMathSlice(slice, view.state.schema);
        const { $from } = view.state.selection;
        const allowFirstLineIndent = $from.depth === 1
          && $from.parent.type.name === "paragraph";
        return normalizePastedParagraphLayoutSlice(migrated, view.state.schema, {
          allowFirstLineIndent,
        });
      },
      handlePaste(view, event, slice) {
        if (readOnly) return false;
        const files = [...(event.clipboardData?.files || [])];
        if (files.some((file) => IMAGE_TYPES.has(file.type))) {
          event.preventDefault();
          void addImages(files);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") || "";
        const html = event.clipboardData?.getData("text/html") || "";
        const options = { resolveAssetUrl: (id) => noteApi.getAssetUrl?.(id) || "" };
        const {
          $from,
          $to,
          empty,
          from,
          to,
        } = view.state.selection;
        const inOneDirectParagraph = $from.depth === 1
          && $to.depth === 1
          && $from.sameParent($to)
          && $from.parent.type.name === "paragraph";
        const replacesDirectParagraph = inOneDirectParagraph && (
          (empty && $from.parent.content.size === 0)
          || (!empty && from === $from.start() && to === $from.end())
        );
        if (
          replacesDirectParagraph
          && PARAGRAPH_LAYOUT_HTML.test(html)
          && slice?.content?.childCount
          && view.state.doc.canReplace(
            $from.index(0),
            $from.indexAfter(0),
            slice.content,
          )
        ) {
          event.preventDefault();
          view.dispatch(view.state.tr
            .replaceWith($from.before(1), $from.after(1), slice.content)
            .scrollIntoView());
          return true;
        }
        const hasHtmlTable = /<table(?:\s|>)/i.test(html);
        if (hasHtmlTable) {
          const content = richBodyFromHtml(html, options);
          event.preventDefault();
          if (!content?.content?.some((node) => node.type === "table")) {
            const fallback = richBodyFromLegacyMarkdown(text, options);
            editorRef.current?.chain().focus().insertContent(fallback.content || []).run();
            callbacksRef.current.showToast?.("表格过大或包含暂不支持的内容，已保留为文本");
            return true;
          }
          editorRef.current?.chain().focus().insertContent(content.content || []).run();
          return true;
        }
        const tableInfo = markdownTableInfo(text);
        if (tableInfo.oversized) {
          event.preventDefault();
          const fallback = richBodyFromLegacyMarkdown(text, options);
          editorRef.current?.chain().focus().insertContent(fallback.content || []).run();
          callbacksRef.current.showToast?.(`表格超过 ${tableInfo.maxRows} × ${tableInfo.maxColumns}，已保留为文本`);
          return true;
        }
        if (!tableInfo.hasTable && !containsMathMarkup(text)) return false;
        const content = richBodyFromLegacyMarkdown(text, options);
        event.preventDefault();
        editorRef.current?.chain().focus().insertContent(content.content || []).run();
        return true;
      },
      handleDrop(view, event) {
        if (readOnly) return false;
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.some((file) => IMAGE_TYPES.has(file.type))) return false;
        event.preventDefault();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void addImages(files, position);
        return true;
      },
      handleDOMEvents: {
        mouseup() {
          if (!painterActiveRef.current) return false;
          setTimeout(() => applyPainter(), 0);
          return false;
        },
      },
    },
    onCreate({ editor: createdEditor }) {
      editorRef.current = createdEditor;
    },
    onUpdate({ editor: updatedEditor }) {
      emitContent(updatedEditor);
    },
    onSelectionUpdate({ editor: updatedEditor }) {
      emitSelection(updatedEditor);
    },
    onBlur() {
      callbacksRef.current.onBlur?.();
    },
  }, [noteId, readOnly]);

  editorRef.current = editorIsReady(editor) ? editor : null;

  useEffect(() => {
    if (!editorIsReady(editor) || mountedContentEmittedRef.current) return;
    mountedContentEmittedRef.current = true;
    if (migratedRef.current) {
      migratedRef.current = false;
      emitContent(editor, { migrated: true });
    } else emitSelection(editor);
  }, [editor, noteId]);

  useEffect(() => {
    // useEditor may expose the previous instance for one render while a keyed
    // editor is being replaced. Tiptap clears commandManager during destroy,
    // so never synchronize content through that stale instance.
    if (!editorIsReady(editor) || !richBody) return;
    if (pendingMigrationSourceRef.current === JSON.stringify(richBody)) return;
    pendingMigrationSourceRef.current = null;
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(richBody)) return;
    editor.commands.setContent(richBody, { emitUpdate: false });
    emitSelection(editor);
  }, [editor, richBody]);

  useEffect(() => () => cancelPainter({ quiet: true }), [noteId]);

  useEffect(() => {
    if (!mathDraft) return undefined;
    const closeOnOutside = (event) => {
      if (mathPopoverRef.current?.contains(event.target)) return;
      commitMathDraft();
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    return () => document.removeEventListener("pointerdown", closeOnOutside, true);
  }, [mathDraft]);

  useEffect(() => {
    if (!mathDraft) return undefined;
    const reposition = () => setMathDraft((current) => current ? {
      ...current,
      anchor: mathAnchor(editorRef.current, current.existing ? current.pos : null),
    } : current);
    const host = editorShellRef.current?.querySelector(".rich-note-editor-host");
    window.addEventListener("resize", reposition);
    host?.addEventListener("scroll", reposition, { passive: true });
    return () => {
      window.removeEventListener("resize", reposition);
      host?.removeEventListener("scroll", reposition);
    };
  }, [mathDraft?.id]);

  useImperativeHandle(forwardedRef, () => ({
    applyInline(kind, value = "") {
      if (!editorIsReady(editor) || readOnly) return false;
      let chain = editor.chain().focus();
      if (kind === "bold") chain = chain.toggleBold();
      else if (kind === "italic") chain = chain.toggleItalic();
      else if (kind === "underline") chain = chain.toggleUnderline();
      else if (kind === "strike") chain = chain.toggleStrike();
      else if (kind === "code") chain = chain.toggleCode();
      else if (kind === "font") {
        if (value) return setFontFamilyForEditor(editor, fontFamilyFor(value));
        chain = chain.unsetFontFamily().removeEmptyTextStyle();
      }
      else if (kind === "size") chain = value ? chain.setFontSize(fontSizeFor(value)) : chain.unsetFontSize().removeEmptyTextStyle();
      else return false;
      return chain.run();
    },
    applyBlock(type) {
      if (!editorIsReady(editor) || readOnly) return false;
      let chain = editor.chain().focus();
      if (formatStateForEditor(editor).canFirstLineIndent) chain = chain.unsetFirstLineIndent();
      if (type === "quote") chain = editor.isActive("blockquote") ? chain.unsetBlockquote() : chain.setBlockquote();
      else if (type === "code-block") chain = editor.isActive("codeBlock") ? chain.setParagraph() : chain.setCodeBlock();
      else chain = applyBlockToChain(chain, type);
      return chain.run();
    },
    applyLineHeight(value = "") {
      if (!editorIsReady(editor) || readOnly || editor.isActive("codeBlock")) return false;
      const chain = editor.chain().focus();
      return value
        ? chain.setParagraphLineHeight(value).run()
        : chain.unsetParagraphLineHeight().run();
    },
    applyTextAlign(value = "left") {
      if (!editorIsReady(editor) || readOnly) return false;
      const chain = editor.chain().focus();
      return value === "left"
        ? chain.unsetTextAlign().run()
        : chain.setTextAlign(value).run();
    },
    toggleFirstLineIndent() {
      if (!editorIsReady(editor) || readOnly) return false;
      return editor.chain().focus().toggleFirstLineIndent().run();
    },
    stepFontSize(direction) {
      if (!editorIsReady(editor) || readOnly) return false;
      return stepFontSizeForEditor(editor, direction);
    },
    clearFormatting() {
      if (!editorIsReady(editor) || readOnly || editor.state.selection.empty) return false;
      return editor.chain()
        .focus()
        .unsetAllMarks()
        .removeEmptyTextStyle()
        .unsetParagraphLineHeight()
        .unsetTextAlign()
        .unsetFirstLineIndent()
        .run();
    },
    insertLink(url, label = "") {
      if (!editorIsReady(editor) || readOnly) return false;
      const href = normalizeLinkUrl(url);
      if (!href) return false;
      if (editor.state.selection.empty) {
        const text = String(label || "").trim() || href;
        return editor.chain().focus().insertContent({
          type: "text",
          text,
          marks: [{ type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer nofollow", class: null } }],
        }).run();
      }
      return editor.chain().focus().setLink({ href }).run();
    },
    openMathEditor() {
      return openNewMath();
    },
    insertTable(rows = 3, columns = 3) {
      if (!editorIsReady(editor) || readOnly) return false;
      const safeRows = Math.max(1, Math.min(8, Math.trunc(Number(rows) || 3)));
      const safeColumns = Math.max(1, Math.min(10, Math.trunc(Number(columns) || 3)));
      return editor.chain().focus().insertTable({
        rows: safeRows,
        cols: safeColumns,
        withHeaderRow: true,
      }).run();
    },
    applyTableCommand(command) {
      if (!editorIsReady(editor) || readOnly || !TABLE_COMMANDS.has(command)) return false;
      const tableState = formatStateForEditor(editor);
      if (["addRowBefore", "addRowAfter"].includes(command) && tableState.tableRows >= MAX_TABLE_ROWS) {
        callbacksRef.current.showToast?.(`单个表格最多 ${MAX_TABLE_ROWS} 行`);
        return false;
      }
      if (["addColumnBefore", "addColumnAfter"].includes(command) && tableState.tableColumns >= MAX_TABLE_COLUMNS) {
        callbacksRef.current.showToast?.(`单个表格最多 ${MAX_TABLE_COLUMNS} 列`);
        return false;
      }
      const chain = editor.chain().focus();
      const tableCommand = chain[command];
      return typeof tableCommand === "function" ? tableCommand.call(chain).run() : false;
    },
    startFormatPainter() {
      if (!editorIsReady(editor) || readOnly) return false;
      painterSnapshotRef.current = snapshotForPainter(editor);
      painterActiveRef.current = true;
      emitSelection(editor);
      callbacksRef.current.showToast?.("格式刷已启用：拖选目标文字；Esc 取消");
      editor.commands.focus();
      return true;
    },
    cancelFormatPainter() {
      return cancelPainter();
    },
    focus() {
      if (editorIsReady(editor)) editor.commands.focus();
    },
  }), [editor, readOnly]);

  return (
    <div ref={editorShellRef} className="rich-note-editor-shell">
      <EditorContent editor={editor} className="rich-note-editor-host" />
      {mathDraft ? (
        <MathEditorPopover
          draft={mathDraft}
          popoverRef={mathPopoverRef}
          onChange={(latex) => setMathDraft((current) => current ? { ...current, latex } : current)}
          onTypeChange={(type) => setMathDraft((current) => current ? { ...current, type } : current)}
          onCommit={commitMathDraft}
          onCancel={() => setMathDraft(null)}
        />
      ) : null}
    </div>
  );
});
