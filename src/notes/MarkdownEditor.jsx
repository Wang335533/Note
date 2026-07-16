import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { noteApi } from "../api.js";
import { livePreviewExtension } from "./markdown-live-preview.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function selectionPayload(view) {
  const range = view.state.selection.main;
  const text = range.empty ? "" : view.state.doc.sliceString(range.from, range.to).trim();
  return { text, from: range.from, to: range.to };
}

function insertionWithSpacing(documentText, position, markdownText) {
  const before = documentText.slice(0, position);
  const after = documentText.slice(position);
  const prefix = before && !before.endsWith("\n") ? "\n\n" : before.endsWith("\n\n") || !before ? "" : "\n";
  const suffix = after && !after.startsWith("\n") ? "\n\n" : after.startsWith("\n\n") || !after ? "" : "\n";
  return `${prefix}${markdownText}${suffix}`;
}

export function MarkdownEditor({
  noteId,
  value,
  onChange,
  onBlur,
  onSelectionChange,
  onBusyChange,
  showToast,
  readOnly = false,
}) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const callbacksRef = useRef({ onChange, onBlur, onSelectionChange, onBusyChange, showToast });
  const syncingRef = useRef(false);

  callbacksRef.current = { onChange, onBlur, onSelectionChange, onBusyChange, showToast };

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
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        livePreviewExtension((id) => noteApi.getAssetUrl?.(id) || "", { renderAll: readOnly }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingRef.current) {
            callbacksRef.current.onChange?.(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            callbacksRef.current.onSelectionChange?.(selectionPayload(update.view));
          }
        }),
        EditorView.domEventHandlers({
          paste(event, view) {
            if (readOnly) return false;
            const files = [...(event.clipboardData?.files || [])];
            if (!files.some((file) => IMAGE_TYPES.has(file.type))) return false;
            event.preventDefault();
            void addImages(files, view);
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
    callbacksRef.current.onSelectionChange?.(selectionPayload(view));

    return () => {
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
}
