import { app, BrowserWindow, shell, dialog, ipcMain, session, Menu } from "electron";
import path from "path";
import { autoUpdater } from "electron-updater";
import { bootstrap } from "./bootstrap";
import { startBackend } from "./server";

let mainWindow: BrowserWindow | null = null;

const BACKEND_PORT = 4321;
const isDev = !app.isPackaged;
const DEMO_MODE = process.env.DEMO_MODE === "true";

function getBackendDir(): string {
  if (isDev) {
    return path.resolve(__dirname, "..", "..", "backend");
  }
  return path.join(process.resourcesPath, "backend");
}

function getFrontendDir(): string {
  if (isDev) {
    return path.resolve(__dirname, "..", "..", "frontend", "dist");
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
    // macOS reads the window icon from the app bundle; Windows and Linux need
    // it named here, including when running unpackaged in dev.
    icon: path.join(__dirname, "..", "assets", "icon.png"),
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
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("http://localhost")) {
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
    await clearGitHubCookies();
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

/**
 * Removes GitHub's cookies from the session the app actually signs in with.
 *
 * Signing out used to open the next OAuth attempt in a window with a throwaway
 * partition instead. That did produce a cookie-free login page, but an Electron
 * partition without a "persist:" prefix lives in memory only — so the session
 * created by that login was discarded when the window closed. GitHub then had
 * no record of the account on the next launch, and "Continue with <account>"
 * asked for a password every time even though nothing had been switched.
 *
 * Clearing the real session gets the same fresh login page and lets the
 * resulting session persist, which is what makes Continue continue.
 */
async function clearGitHubCookies(): Promise<void> {
  const ses = session.defaultSession;
  const cookies = await ses.cookies.get({ domain: "github.com" });
  await Promise.all(
    cookies.map((c) => {
      const host = (c.domain ?? "github.com").replace(/^\./, "");
      const url = `${c.secure ? "https" : "http"}://${host}${c.path ?? "/"}`;
      return ses.cookies.remove(url, c.name).catch(() => undefined);
    })
  );
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

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    require("http").get(url, (res: any) => {
      let body = "";
      res.on("data", (chunk: string) => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
      });
    }).on("error", reject);
  });
}

function waitForAwsAuthThenCheckUpdates(): void {
  let checked = false;
  console.log("[updater] Waiting for AWS auth before checking updates...");
  const interval = setInterval(async () => {
    if (checked) { clearInterval(interval); return; }
    try {
      const status = await httpGetJson(`http://localhost:${BACKEND_PORT}/auth/status`);
      if (status.aws?.dynamoReachable) {
        checked = true;
        clearInterval(interval);
        console.log("[updater] AWS authenticated, fetching system token...");
        const tokenRes = await httpGetJson(`http://localhost:${BACKEND_PORT}/auth/system-token`);
        console.log("[updater] Token response:", tokenRes.token ? "got token" : "no token");
        if (!tokenRes.token) {
          sendUpdateStatus("error");
          return;
        }
        process.env.GH_TOKEN = tokenRes.token;
        sendUpdateStatus("checking");
        console.log("[updater] Checking for updates...");
        autoUpdater.checkForUpdates().catch((err) => {
          console.error("[updater] Update check failed:", err.message);
          sendUpdateStatus("error");
        });
      }
    } catch (err: any) {
      console.log("[updater] Waiting...", err?.message || "");
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
