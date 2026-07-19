import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { noteApi } from "../api.js";
import {
  applyBlockFormat,
  applyFormatSnapshot,
  applyInlineFormat,
  captureFormatSnapshot,
  clearSelectedFormatting,
  formatStateAt,
  htmlToNoteMarkdown,
  insertLink,
} from "./formatting.js";
import { livePreviewExtension } from "./markdown-live-preview.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function selectionPayload(view) {
  const range = view.state.selection.main;
  const text = range.empty ? "" : view.state.doc.sliceString(range.from, range.to).trim();
  return { text, from: range.from, to: range.to };
}

function minimalChange(before, after) {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let beforeTo = before.length;
  let afterTo = after.length;
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) {
    beforeTo -= 1;
    afterTo -= 1;
  }
  return { from, to: beforeTo, insert: after.slice(from, afterTo) };
}

function dispatchFormattingResult(view, result) {
  if (!view || !result) return false;
  const before = view.state.doc.toString();
  const change = minimalChange(before, result.doc);
  if (!change) return false;
  view.dispatch({ changes: change, selection: result.selection, scrollIntoView: true });
  view.focus();
  return true;
}

function insertionWithSpacing(documentText, position, markdownText) {
  const before = documentText.slice(0, position);
  const after = documentText.slice(position);
  const prefix = before && !before.endsWith("\n") ? "\n\n" : before.endsWith("\n\n") || !before ? "" : "\n";
  const suffix = after && !after.startsWith("\n") ? "\n\n" : after.startsWith("\n\n") || !after ? "" : "\n";
  return `${prefix}${markdownText}${suffix}`;
}

export const MarkdownEditor = forwardRef(function MarkdownEditor({
  noteId,
  value,
  onChange,
  onBlur,
  onSelectionChange,
  onFormatStateChange,
  onBusyChange,
  showToast,
  readOnly = false,
}, forwardedRef) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const callbacksRef = useRef({ onChange, onBlur, onSelectionChange, onFormatStateChange, onBusyChange, showToast });
  const syncingRef = useRef(false);
  const painterSnapshotRef = useRef(null);
  const painterActiveRef = useRef(false);
  const painterTimerRef = useRef(null);

  callbacksRef.current = { onChange, onBlur, onSelectionChange, onFormatStateChange, onBusyChange, showToast };

  const emitSelectionState = (view) => {
    const payload = selectionPayload(view);
    callbacksRef.current.onSelectionChange?.(payload);
    callbacksRef.current.onFormatStateChange?.({
      ...formatStateAt(view.state.doc.toString(), payload),
      painterActive: painterActiveRef.current,
    });
  };

  const cancelPainter = ({ quiet = false } = {}) => {
    if (!painterActiveRef.current) return false;
    painterActiveRef.current = false;
    painterSnapshotRef.current = null;
    if (viewRef.current) emitSelectionState(viewRef.current);
    if (!quiet) callbacksRef.current.showToast?.("已取消格式刷");
    return true;
  };

  useImperativeHandle(forwardedRef, () => ({
    applyInline(kind, selectedValue = "") {
      const view = viewRef.current;
      if (!view || readOnly) return false;
      const result = applyInlineFormat(view.state.doc.toString(), view.state.selection.main, kind, selectedValue);
      return dispatchFormattingResult(view, result);
    },
    applyBlock(type) {
      const view = viewRef.current;
      if (!view || readOnly) return false;
      const result = applyBlockFormat(view.state.doc.toString(), view.state.selection.main, type);
      return dispatchFormattingResult(view, result);
    },
    clearFormatting() {
      const view = viewRef.current;
      if (!view || readOnly || view.state.selection.main.empty) return false;
      const result = clearSelectedFormatting(view.state.doc.toString(), view.state.selection.main);
      return dispatchFormattingResult(view, result);
    },
    insertLink(url, label = "") {
      const view = viewRef.current;
      if (!view || readOnly) return false;
      const result = insertLink(view.state.doc.toString(), view.state.selection.main, url, label);
      return dispatchFormattingResult(view, result);
    },
    startFormatPainter() {
      const view = viewRef.current;
      if (!view || readOnly) return false;
      painterSnapshotRef.current = captureFormatSnapshot(view.state.doc.toString(), view.state.selection.main);
      painterActiveRef.current = true;
      emitSelectionState(view);
      callbacksRef.current.showToast?.("格式刷已启用：拖选目标文字；Esc 取消");
      view.focus();
      return true;
    },
    cancelFormatPainter() {
      return cancelPainter();
    },
    focus() {
      viewRef.current?.focus();
    },
  }), [readOnly]);

  useEffect(() => {
    if (!hostRef.current) return undefined;

    const addImages = async (files, view, requestedPosition = null) => {
      const images = files.filter((file) => IMAGE_TYPES.has(file.type));
      if (!images.length) {
        callbacksRef.current.showToast?.("首版只接管 PNG、JPEG 和 WebP 图片");
        return;
      }
      callbacksRef.current.onBusyChange?.(true);
      try {
        const snippets = [];
        for (const file of images) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await noteApi.addNoteImage(noteId, {
            bytes,
            mimeType: file.type,
            fileName: file.name || "image",
          });
          if (!result.ok) throw new Error(result.error || "无法添加图片");
          snippets.push(result.markdown);
        }
        const range = view.state.selection.main;
        const position = Number.isInteger(requestedPosition) ? requestedPosition : range.from;
        const to = Number.isInteger(requestedPosition) ? requestedPosition : range.to;
        const insertion = insertionWithSpacing(view.state.doc.toString(), position, snippets.join("\n\n"));
        view.dispatch({
          changes: { from: position, to, insert: insertion },
          selection: { anchor: position + insertion.length },
          scrollIntoView: true,
        });
      } catch (error) {
        callbacksRef.current.showToast?.(error?.message || "无法添加图片");
      } finally {
        callbacksRef.current.onBusyChange?.(false);
      }
    };

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.lineWrapping,
        placeholder("用 Markdown 写下正文…"),
        keymap.of([{
          key: "Escape",
          run() {
            return cancelPainter();
          },
        }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        livePreviewExtension((id) => noteApi.getAssetUrl?.(id) || "", { renderAll: readOnly }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingRef.current) {
            callbacksRef.current.onChange?.(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            emitSelectionState(update.view);
          }
        }),
        EditorView.domEventHandlers({
          paste(event, view) {
            if (readOnly) return false;
            const files = [...(event.clipboardData?.files || [])];
            if (files.some((file) => IMAGE_TYPES.has(file.type))) {
              event.preventDefault();
              void addImages(files, view);
              return true;
            }
            const html = event.clipboardData?.getData("text/html") || "";
            if (!html) return false;
            const converted = htmlToNoteMarkdown(html);
            if (!converted) return false;
            event.preventDefault();
            view.dispatch(view.state.replaceSelection(converted), { scrollIntoView: true });
            return true;
          },
          drop(event, view) {
            if (readOnly) return false;
            const files = [...(event.dataTransfer?.files || [])];
            if (!files.length) return false;
            event.preventDefault();
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
            void addImages(files, view, position ?? view.state.selection.main.from);
            return true;
          },
          focusout() {
            callbacksRef.current.onBlur?.();
            return false;
          },
          mouseup(_event, view) {
            if (!painterActiveRef.current || view.state.selection.main.empty) return false;
            clearTimeout(painterTimerRef.current);
            painterTimerRef.current = setTimeout(() => {
              if (!painterActiveRef.current || !painterSnapshotRef.current || view.state.selection.main.empty) return;
              const result = applyFormatSnapshot(
                view.state.doc.toString(),
                view.state.selection.main,
                painterSnapshotRef.current,
              );
              painterActiveRef.current = false;
              painterSnapshotRef.current = null;
              dispatchFormattingResult(view, result);
              callbacksRef.current.showToast?.("格式已应用");
              emitSelectionState(view);
            }, 0);
            return false;
          },
        }),
        EditorView.contentAttributes.of({
          "aria-label": "Markdown 笔记正文",
          spellcheck: "true",
          autocapitalize: "sentences",
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    emitSelectionState(view);

    return () => {
      clearTimeout(painterTimerRef.current);
      cancelPainter({ quiet: true });
      callbacksRef.current.onBlur?.();
      view.destroy();
      viewRef.current = null;
    };
  }, [noteId, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncingRef.current = false;
  }, [value]);

  return <div ref={hostRef} className="markdown-editor-host" />;
});
