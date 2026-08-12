function isUsableWindow(window) {
  return Boolean(window) && !(typeof window.isDestroyed === "function" && window.isDestroyed());
}

function createNativeDialogCoordinator({
  dialog,
  getWindow = () => null,
  beforeOpen = async () => {},
  afterClose = async () => {},
} = {}) {
  if (!dialog || typeof dialog !== "object") throw new TypeError("dialog is required");

  let active = false;

  async function show(method, options, busyResult) {
    if (active) return { ...busyResult, busy: true };
    if (typeof dialog[method] !== "function") throw new TypeError(`${method} is unavailable`);

    active = true;
    const window = getWindow();
    try {
      await beforeOpen(window);
      return isUsableWindow(window)
        ? await dialog[method](window, options)
        : await dialog[method](options);
    } finally {
      try {
        await afterClose(window);
      } finally {
        active = false;
      }
    }
  }

  return {
    isActive: () => active,
    showOpenDialog: (options) => show("showOpenDialog", options, {
      canceled: true,
      filePaths: [],
    }),
    showSaveDialog: (options) => show("showSaveDialog", options, {
      canceled: true,
      filePath: "",
    }),
    showMessageBox: (options) => show("showMessageBox", options, {
      response: Number.isInteger(options?.cancelId) ? options.cancelId : 0,
      checkboxChecked: false,
    }),
  };
}

module.exports = { createNativeDialogCoordinator };
