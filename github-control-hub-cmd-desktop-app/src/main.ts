import { app, BrowserWindow, shell, dialog } from "electron";
import path from "path";
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
  return path.join(process.resourcesPath, "backend-node_modules");
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
}

function addToModulePaths(dir: string): void {
  const Module = require("module");
  const paths: string[] = Module.globalPaths || [];
  if (!paths.includes(dir)) paths.unshift(dir);
}

app.whenReady().then(main);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
