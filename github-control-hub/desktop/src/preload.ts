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
  clearGithubSession: () => ipcRenderer.invoke("clear-github-session"),
  /**
   * Open a link in the user's own browser.
   *
   * Asked for explicitly rather than left to `target="_blank"`. That route
   * depends on the main process intercepting a window-open it may decline —
   * during a sign-in it deliberately allows one instead, and any such branch
   * turns a click into nothing at all, with no error anywhere. A click that
   * silently does nothing is the worst kind of broken: it reads as the app
   * being wrong about the link existing.
   */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke("open-external", url),
});
