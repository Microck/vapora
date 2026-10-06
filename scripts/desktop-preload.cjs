const { contextBridge, ipcRenderer } = require("electron");
// Keep Node and unrestricted IPC out of the shared renderer.
contextBridge.exposeInMainWorld("vaporaDesktop", {
  minimize: () => ipcRenderer.invoke("vapora:minimize"),
  maximize: () => ipcRenderer.invoke("vapora:maximize"),
  close: () => ipcRenderer.invoke("vapora:close"),
  openOutputs: (id) => ipcRenderer.invoke("vapora:outputs", id),
});
