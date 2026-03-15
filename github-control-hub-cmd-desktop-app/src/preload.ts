import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on("deep-link", (_event, url: string) => callback(url));
  },
  onUpdateStatus: (callback: (status: string, detail?: string) => void) => {
    ipcRenderer.on("update-status", (_event, status: string, detail?: string) => callback(status, detail));
  },
  installUpdate: () => {
    ipcRenderer.send("install-update");
  },
});
