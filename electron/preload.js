// electron/preload.js — contextBridge IPC surface for the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: () => ipcRenderer.invoke("is-electron"),

  exportNative: (opts) => ipcRenderer.invoke("export-native", opts),

  saveTempImage: (payload) => ipcRenderer.invoke("save-temp-image", payload),
  saveTempAudio: (payload) => ipcRenderer.invoke("save-temp-audio", payload),

  chooseOutput: () => ipcRenderer.invoke("choose-output"),

  cleanupTemp: () => ipcRenderer.invoke("cleanup-temp"),

  cancelExport: () => ipcRenderer.invoke("cancel-export"),

  onExportProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("export-progress", handler);
    return () => ipcRenderer.removeListener("export-progress", handler);
  },

  // Menu accelerators forwarded from the main process.
  onMenu: (channel, callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
