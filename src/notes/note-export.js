function actionErrorMessage(error, fallback) {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return message || fallback;
}

export async function flushNoteDrafts(saveTitle, saveBody) {
  if (typeof saveTitle !== "function" || typeof saveBody !== "function") {
    throw new TypeError("笔记保存流程不可用");
  }
  return Promise.all([saveTitle(), saveBody()]);
}

export async function exportNoteAfterFlush({ flush, exportNote, noteId } = {}) {
  try {
    if (typeof flush !== "function" || typeof exportNote !== "function") {
      throw new TypeError("笔记导出流程不可用");
    }
    const saveResults = await flush();
    if (!Array.isArray(saveResults)) throw new TypeError("笔记保存流程未返回结果");

    const failedSave = saveResults.find((item) => !item?.ok);
    if (failedSave) {
      return {
        ok: false,
        saveFailed: true,
        error: failedSave.error || "请先完成保存再导出",
      };
    }

    const result = await exportNote(noteId);
    if (!result || typeof result !== "object") throw new TypeError("笔记导出未返回结果");
    return result;
  } catch (error) {
    return { ok: false, error: actionErrorMessage(error, "导出没有完成") };
  }
}
