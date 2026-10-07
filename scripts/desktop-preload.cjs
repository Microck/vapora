const { contextBridge, ipcRenderer } = require("electron");
// Keep Node and unrestricted IPC out of the shared renderer.
contextBridge.exposeInMainWorld("vaporaDesktop", {
  minimize: () => ipcRenderer.invoke("vapora:minimize"),
  maximize: () => ipcRenderer.invoke("vapora:maximize"),
  isMaximized: () => ipcRenderer.invoke("vapora:maximized"),
  onMaximized: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on("vapora:maximized-changed", listener);
    return () => ipcRenderer.removeListener("vapora:maximized-changed", listener);
  },
  close: () => ipcRenderer.invoke("vapora:close"),
  openOutputs: (id) => ipcRenderer.invoke("vapora:outputs", id),
});
