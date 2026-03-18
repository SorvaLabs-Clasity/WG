import { app, BrowserWindow, shell, dialog, ipcMain, session, Menu } from "electron";
import path from "path";
import { autoUpdater } from "electron-updater";
import { bootstrap } from "./bootstrap";
import { startBackend } from "./server";

let mainWindow: BrowserWindow | null = null;
let pendingOAuthClear = false;

const BACKEND_PORT = 4321;
const isDev = !app.isPackaged;
const DEMO_MODE = process.env.DEMO_MODE === "true";

function getBackendDir(): string {
  if (isDev) {
    return path.resolve(__dirname, "..", "..", "github-control-hub", "backend");
  }
  return path.join(process.resourcesPath, "backend");
}

function getFrontendDir(): string {
  if (isDev) {
    return path.resolve(__dirname, "..", "..", "github-control-hub", "frontend", "dist");
  }
  return path.join(process.resourcesPath, "frontend");
}

function getBackendNodeModules(): string {
  if (isDev) {
    return path.join(getBackendDir(), "node_modules");
  }
  return path.join(process.resourcesPath, "backend", "node_modules");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "GitHub Control Hub",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}${DEMO_MODE ? "/" : "/login"}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://localhost")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Allow GitHub OAuth flow to happen inside the Electron window
  // but open other external URLs in the system browser.
  // When pendingOAuthClear is set (user signed out), open the OAuth flow
  // in a fresh window with a temporary session so there are no GitHub cookies.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("http://localhost")) {
      // If this is the OAuth start URL and user signed out, intercept it
      if (pendingOAuthClear && url.includes("/auth/github")) {
        event.preventDefault();
        pendingOAuthClear = false;
        openFreshOAuthWindow(`http://localhost:${BACKEND_PORT}/auth/github`);
        return;
      }
      return; // allow normal localhost navigations
    }
    if (url.includes("github.com")) {
      return; // allow GitHub navigations within the main window
    }
    event.preventDefault();
    shell.openExternal(url);
  });

  // Register IPC handler here (not in setupAutoUpdater) so it works in dev mode too
  ipcMain.handle("clear-github-session", async () => {
    pendingOAuthClear = true;
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function main(): Promise<void> {
  Menu.setApplicationMenu(null);

  try {
    await bootstrap();
  } catch (err: any) {
    console.error("Bootstrap failed:", err.message);
  }

  const frontendDir = getFrontendDir();
  const backendDir = getBackendDir();

  process.env.PORT = String(BACKEND_PORT);
  process.env.FRONTEND_URL = `http://localhost:${BACKEND_PORT}`;
  process.env.BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

  const backendModules = getBackendNodeModules();
  if (isDev) {
    addToModulePaths(path.join(backendDir, "node_modules"));
  } else {
    addToModulePaths(backendModules);
  }

  try {
    await startBackend(backendDir, frontendDir, BACKEND_PORT, isDev);
  } catch (err: any) {
    dialog.showErrorBox(
      "GitHub Control Hub — Backend Error",
      `Failed to start the backend server:\n\n${err.message}\n\nMake sure you have valid AWS credentials.`
    );
  }

  createWindow();
  setupAutoUpdater();
}

function openFreshOAuthWindow(startUrl: string): void {
  // Use a unique partition so the window has zero cookies (fresh GitHub login)
  const partition = `oauth-${Date.now()}`;
  let oauthCompleted = false;

  const oauthWin = new BrowserWindow({
    width: 600,
    height: 700,
    title: "Sign in with GitHub",
    parent: mainWindow || undefined,
    modal: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });

  oauthWin.loadURL(startUrl);

  // Catch the server-side redirect from /auth/callback → /login?code=...
  // and forward the full URL (with auth code) to the main window
  const handleUrl = (_event: any, url: string) => {
    if (oauthCompleted) return;
    if (url.startsWith(`http://localhost:${BACKEND_PORT}/login`)) {
      oauthCompleted = true;
      // Load the full URL (including ?code= param) in the main window
      mainWindow?.loadURL(url);
      oauthWin.close();
    }
  };

  oauthWin.webContents.on("will-navigate", handleUrl);
  oauthWin.webContents.on("did-navigate", handleUrl);
  oauthWin.webContents.on("will-redirect", handleUrl);

  oauthWin.on("closed", () => {
    if (!oauthCompleted) {
      mainWindow?.loadURL(`http://localhost:${BACKEND_PORT}/login`);
    }
  });
}

function addToModulePaths(dir: string): void {
  const Module = require("module");
  const paths: string[] = Module.globalPaths || [];
  if (!paths.includes(dir)) paths.unshift(dir);
}

function sendUpdateStatus(status: string, detail?: string): void {
  mainWindow?.webContents.send("update-status", status, detail);
}

function setupAutoUpdater(): void {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  (autoUpdater as any).verifyUpdateCodeSignature = () => Promise.resolve(null);

  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus("downloading", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    sendUpdateStatus("up-to-date");
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendUpdateStatus("installing", info.version);
    setTimeout(() => autoUpdater.quitAndInstall(), 2000);
  });

  autoUpdater.on("error", () => {
    sendUpdateStatus("error");
  });

  ipcMain.on("install-update", () => {
    autoUpdater.quitAndInstall();
  });

  waitForAwsAuthThenCheckUpdates();
}

function waitForAwsAuthThenCheckUpdates(): void {
  let checked = false;
  const interval = setInterval(async () => {
    if (checked) { clearInterval(interval); return; }
    try {
      const http = await import("http");
      const data: string = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${BACKEND_PORT}/auth/status`, (res) => {
          let body = "";
          res.on("data", (chunk: string) => body += chunk);
          res.on("end", () => resolve(body));
        }).on("error", reject);
      });
      const status = JSON.parse(data);
      if (status.aws?.dynamoReachable) {
        checked = true;
        clearInterval(interval);
        let ghToken = process.env.SYSTEM_GITHUB_TOKEN;
        try {
          const { getSystemToken } = require("../../github-control-hub/backend/src/github/client");
          ghToken = getSystemToken() || ghToken;
        } catch { /* fallback to env var */ }
        if (ghToken) {
          process.env.GH_TOKEN = ghToken;
        }
        if (!ghToken) {
          sendUpdateStatus("error");
          return;
        }
        sendUpdateStatus("checking");
        autoUpdater.checkForUpdates().catch(() => {
          sendUpdateStatus("error");
        });
      }
    } catch {
      // Backend not ready yet or AWS not authenticated — keep waiting
    }
  }, 5000);

  setTimeout(() => { clearInterval(interval); }, 300_000);
}

app.whenReady().then(main);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
