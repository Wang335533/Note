const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noteDesktop", {
  getState: () => ipcRenderer.invoke("note:get-state"),
  mutate: (operation) => ipcRenderer.invoke("note:mutate", operation),
  openSettings: () => ipcRenderer.invoke("note:open-settings"),
  openDataFolder: () => ipcRenderer.invoke("note:open-data-folder"),
  exportMarkdown: () => ipcRenderer.invoke("note:export-markdown"),
  setWindowMode: (mode) => ipcRenderer.invoke("note:set-window-mode", mode),
  setLocked: (locked) => ipcRenderer.invoke("note:set-locked", locked),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("note:set-launch-at-login", enabled),
  quitReady: () => ipcRenderer.invoke("note:quit-ready"),
  onState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("note:state", handler);
    return () => ipcRenderer.removeListener("note:state", handler);
  },
  onSaveStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("note:save-status", handler);
    return () => ipcRenderer.removeListener("note:save-status", handler);
  },
  onFocusInput: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("note:focus-input", handler);
    return () => ipcRenderer.removeListener("note:focus-input", handler);
  },
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("note:show-settings", handler);
    return () => ipcRenderer.removeListener("note:show-settings", handler);
  },
  onPrepareQuit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("note:prepare-quit", handler);
    return () => ipcRenderer.removeListener("note:prepare-quit", handler);
  },
});
