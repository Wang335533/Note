import { EditorContent, useEditor } from "@tiptap/react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import * as richTextModule from "desktop-note/rich-text";
import { noteAssetUrl } from "desktop-note/library-files";
import { noteApi } from "../api.js";
import {
  createEditorExtensions,
  fontFamilyFor,
  fontSizeFor,
  formatStateForEditor,
  richBodyFromLegacyMarkdown,
} from "./rich-text.js";

const { markdownFromRichBody, plainTextFromRichBody } = richTextModule;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

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
  const painterSnapshotRef = useRef(null);
  const painterActiveRef = useRef(false);
  const migratedRef = useRef(!richBody);
  const mountedContentEmittedRef = useRef(false);

  callbacksRef.current = { onChange, onBlur, onSelectionChange, onFormatStateChange, onBusyChange, showToast };

  const initialContent = useMemo(() => (
    richBody || richBodyFromLegacyMarkdown(legacyMarkdown, { resolveAssetUrl: (id) => noteApi.getAssetUrl?.(id) || "" })
  ), [noteId]);

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

  const editor = useEditor({
    extensions: createEditorExtensions({
      resolveAssetUrl: (id) => noteApi.getAssetUrl?.(id) || "",
      cancelPainter: () => cancelPainter(),
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
      handlePaste(_view, event) {
        if (readOnly) return false;
        const files = [...(event.clipboardData?.files || [])];
        if (!files.some((file) => IMAGE_TYPES.has(file.type))) return false;
        event.preventDefault();
        void addImages(files);
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

  editorRef.current = editor;

  useEffect(() => {
    if (!editor || mountedContentEmittedRef.current) return;
    mountedContentEmittedRef.current = true;
    if (migratedRef.current) {
      migratedRef.current = false;
      emitContent(editor, { migrated: true });
    } else emitSelection(editor);
  }, [editor, noteId]);

  useEffect(() => {
    if (!editor || !richBody) return;
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(richBody)) return;
    editor.commands.setContent(richBody, { emitUpdate: false });
    emitSelection(editor);
  }, [editor, richBody]);

  useEffect(() => () => cancelPainter({ quiet: true }), [noteId]);

  useImperativeHandle(forwardedRef, () => ({
    applyInline(kind, value = "") {
      if (!editor || readOnly) return false;
      let chain = editor.chain().focus();
      if (kind === "bold") chain = chain.toggleBold();
      else if (kind === "italic") chain = chain.toggleItalic();
      else if (kind === "underline") chain = chain.toggleUnderline();
      else if (kind === "strike") chain = chain.toggleStrike();
      else if (kind === "code") chain = chain.toggleCode();
      else if (kind === "font") chain = value ? chain.setFontFamily(fontFamilyFor(value)) : chain.unsetFontFamily().removeEmptyTextStyle();
      else if (kind === "size") chain = value ? chain.setFontSize(fontSizeFor(value)) : chain.unsetFontSize().removeEmptyTextStyle();
      else return false;
      return chain.run();
    },
    applyBlock(type) {
      if (!editor || readOnly) return false;
      let chain = editor.chain().focus();
      if (type === "quote") chain = editor.isActive("blockquote") ? chain.unsetBlockquote() : chain.setBlockquote();
      else if (type === "code-block") chain = editor.isActive("codeBlock") ? chain.setParagraph() : chain.setCodeBlock();
      else chain = applyBlockToChain(chain, type);
      return chain.run();
    },
    clearFormatting() {
      if (!editor || readOnly || editor.state.selection.empty) return false;
      return editor.chain().focus().unsetAllMarks().removeEmptyTextStyle().run();
    },
    insertLink(url, label = "") {
      if (!editor || readOnly) return false;
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
    startFormatPainter() {
      if (!editor || readOnly) return false;
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
      editor?.commands.focus();
    },
  }), [editor, readOnly]);

  return <EditorContent editor={editor} className="rich-note-editor-host" />;
});
