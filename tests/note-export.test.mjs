import assert from "node:assert/strict";
import test from "node:test";
import { exportNoteAfterFlush, flushNoteDrafts } from "../src/notes/note-export.js";

test("flushNoteDrafts returns both ordered save results", async () => {
  const calls = [];
  const results = await flushNoteDrafts(
    async () => { calls.push("title"); return { ok: true, unchanged: true }; },
    async () => { calls.push("body"); return { ok: true }; },
  );

  assert.deepEqual(calls, ["title", "body"]);
  assert.deepEqual(results, [{ ok: true, unchanged: true }, { ok: true }]);
});

test("exportNoteAfterFlush reaches export only after both saves succeed", async () => {
  let exportedNoteId = null;
  const result = await exportNoteAfterFlush({
    flush: async () => [{ ok: true }, { ok: true, unchanged: true }],
    exportNote: async (noteId) => {
      exportedNoteId = noteId;
      return { ok: true, filePath: "example.md" };
    },
    noteId: "note-1",
  });

  assert.equal(exportedNoteId, "note-1");
  assert.deepEqual(result, { ok: true, filePath: "example.md" });
});

test("exportNoteAfterFlush stops on a failed save", async () => {
  let exportCalled = false;
  const result = await exportNoteAfterFlush({
    flush: async () => [{ ok: true }, { ok: false, error: "保存失败" }],
    exportNote: async () => { exportCalled = true; return { ok: true }; },
    noteId: "note-1",
  });

  assert.equal(exportCalled, false);
  assert.deepEqual(result, { ok: false, saveFailed: true, error: "保存失败" });
});

test("exportNoteAfterFlush converts broken or rejected event work into visible errors", async () => {
  const missingResults = await exportNoteAfterFlush({
    flush: async () => undefined,
    exportNote: async () => ({ ok: true }),
    noteId: "note-1",
  });
  const rejectedExport = await exportNoteAfterFlush({
    flush: async () => [{ ok: true }, { ok: true }],
    exportNote: async () => { throw new Error("IPC 不可用"); },
    noteId: "note-1",
  });

  assert.deepEqual(missingResults, { ok: false, error: "笔记保存流程未返回结果" });
  assert.deepEqual(rejectedExport, { ok: false, error: "IPC 不可用" });
});
