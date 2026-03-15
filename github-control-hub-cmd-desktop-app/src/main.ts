import { app, BrowserWindow, shell, dialog, ipcMain } from "electron";
import path from "path";
import { autoUpdater } from "electron-updater";
import { bootstrap } from "./bootstrap";
import { startBackend } from "./server";

let mainWindow: BrowserWindow | null = null;

const BACKEND_PORT = 4321;
const isDev = !app.isPackaged;

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

  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}/login`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://localhost")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Allow GitHub OAuth flow to happen inside the Electron window
  // but open other external URLs in the system browser
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("http://localhost") || url.includes("github.com/login/oauth")) {
      return; // allow OAuth and localhost navigations
    }
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function main(): Promise<void> {
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

function addToModulePaths(dir: string): void {
  const Module = require("module");
  const paths: string[] = Module.globalPaths || [];
  if (!paths.includes(dir)) paths.unshift(dir);
}

function setupAutoUpdater(): void {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] Update available: ${info.version}`);
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log(`[updater] No update. Current: ${app.getVersion()}, Latest: ${info.version}`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] Downloaded ${info.version}, restarting...`);
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on("error", (err) => {
    console.error(`[updater] Error: ${err.message}`);
  });

  ipcMain.on("install-update", () => {
    autoUpdater.quitAndInstall();
  });

  // Wait for AWS auth, then check for updates with the GitHub token
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
        const ghToken = process.env.SYSTEM_GITHUB_TOKEN;
        if (ghToken) {
          process.env.GH_TOKEN = ghToken;
        }
        console.log(`[updater] AWS OK. Checking updates... Version: ${app.getVersion()}`);
        autoUpdater.checkForUpdates().catch((err) => {
          console.error(`[updater] Check failed: ${err.message}`);
        });
      }
    } catch {
      // Backend not ready yet or AWS not authenticated — keep waiting
    }
  }, 5000); // Check every 5 seconds

  // Stop trying after 5 minutes
  setTimeout(() => { clearInterval(interval); }, 300_000);
}

app.whenReady().then(main);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
