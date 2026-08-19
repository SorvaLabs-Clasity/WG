import { app, BrowserWindow, shell, dialog, ipcMain, session, Menu } from "electron";
import path from "path";
import { autoUpdater } from "electron-updater";
import { bootstrap } from "./bootstrap";
import { startBackend } from "./server";

let mainWindow: BrowserWindow | null = null;
/** True between leaving for GitHub and coming back with a code. */
let oauthInFlight = false;

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

/**
 * Is this URL the app's own backend?
 *
 * Every one of these checks used to be `url.startsWith("http://localhost")`,
 * and a prefix is not an origin. `http://localhost.example.com/` starts with
 * that string, and so does `http://localhost:4321@example.com/` — the part
 * before the `@` is userinfo, not a host, so a link can name this app's exact
 * origin and still resolve somewhere else entirely. Either one satisfied the
 * window-open handler, which then loaded the page *inside* this window rather
 * than handing it to the browser: a remote origin running in the same
 * BrowserWindow as the signed-in session, with the preload bridge attached.
 *
 * Parsed and compared instead. `URL` puts the host in `hostname` and refuses
 * to let userinfo or a path masquerade as one, so there is nothing left to
 * spoof. The port is checked too — nothing but this backend is the app.
 */
function isAppUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "http:") return false;
  // Userinfo in a URL aimed at our own origin has no legitimate use and is the
  // shape the prefix check fell for, so it is refused rather than ignored.
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return false;
  return parsed.port === String(BACKEND_PORT);
}

/** The start of a sign-in, judged on the path rather than on the whole string. */
function startsSignIn(url: string): boolean {
  try { return new URL(url).pathname.startsWith("/auth/github"); } catch { return false; }
}

/** The sign-in page this window falls back to when a navigation fails. */
function isLoginUrl(url: string): boolean {
  if (!isAppUrl(url)) return false;
  try { return new URL(url).pathname === "/login"; } catch { return false; }
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
    if (isAppUrl(url)) return { action: "allow" };
    // Some identity providers open a popup for the account chooser or for MFA.
    // Sending that to the system browser strands the flow the same way sending
    // a redirect there did.
    if (oauthInFlight) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Sign-in stays in this window; ordinary outbound links go to the browser.
  //
  // The distinction cannot be drawn by listing hosts. GitHub hands off to
  // whichever identity provider the organization uses — Google, Entra, Okta —
  // and often to an MFA host after that. Allowing only github.com meant the
  // hop to accounts.google.com was pushed into the system browser, which then
  // received half of a flow whose state belonged to this window: Google
  // answered 400, and the app was left on a blank page with no way back.
  //
  // So the question is "are we in the middle of signing in", not "is this host
  // one we recognize". The flow is bounded: it starts at /auth/github and ends
  // when GitHub sends us back to /login.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) {
      // Self-clearing: any navigation to this app that is not the start of a
      // sign-in ends the flow, so an abandoned attempt cannot leave the window
      // permanently willing to load anything.
      oauthInFlight = startsSignIn(url);
      return;
    }
    // github.com is not allowed outright. During sign-in oauthInFlight covers
    // it, and outside sign-in a GitHub link is an ordinary outbound link that
    // belongs in the user's own browser — allowing it here is what put
    // github.com inside the app window.
    if (oauthInFlight) return;

    event.preventDefault();
    shell.openExternal(url);
  });

  // The flag has to be cleared by something that sees a server redirect.
  // will-navigate does not: GitHub sends us back to /auth/callback with a 302,
  // which fires will-redirect instead, so the flag was set on the first sign-in
  // and never lowered. Every outbound link after that opened in this window.
  // did-navigate fires once a navigation has actually completed, whatever
  // caused it.
  mainWindow.webContents.on("did-navigate", (_e, url) => {
    if (isAppUrl(url)) {
      oauthInFlight = startsSignIn(url);
    }
  });

  // A prevented or failed navigation leaves a blank window, which is what made
  // the only way out of the broken flow "quit the app".
  mainWindow.webContents.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted, normal during redirects */) return;
    if (isLoginUrl(failedUrl)) return;
    oauthInFlight = false;
    mainWindow?.loadURL(`http://localhost:${BACKEND_PORT}/login`);
  });

  // Register IPC handler here (not in setupAutoUpdater) so it works in dev mode too
  ipcMain.handle("clear-github-session", async () => {
    await clearGitHubCookies();
  });

  /**
   * Open an outbound link in the user's browser.
   *
   * Scheme-checked before it reaches the shell. `shell.openExternal` will hand
   * anything to the operating system, including `file:` and custom schemes, so
   * a renderer that ever rendered a hostile URL could ask this to launch it.
   * Only http and https, which is all any link in this app is.
   */
  ipcMain.handle("open-external", async (_e, url: unknown) => {
    if (typeof url !== "string") return false;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    await shell.openExternal(url);
    return true;
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

  // The error is reported, not swallowed.
  //
  // This discarded its argument, so every failure — a 404 from the wrong
  // repository, a 401 from a token without access, a network refusal, a
  // malformed latest.yml — arrived on screen as the single word "error" and in
  // the log as nothing at all. There was no way to tell "there is no update"
  // from "the check could not run", which is the difference that matters.
  autoUpdater.on("error", (err) => {
    console.error("[updater] FAILED:", err?.message ?? err);
    if ((err as any)?.stack) console.error((err as any).stack);
    sendUpdateStatus("error", err?.message ?? String(err));
  });

  // electron-updater's own diagnostics, which say which URL it fetched and what
  // came back. Without them the only evidence of a check is whether something
  // happened afterwards.
  (autoUpdater as any).logger = {
    info: (m: any) => console.log("[updater]", m),
    warn: (m: any) => console.warn("[updater]", m),
    error: (m: any) => console.error("[updater]", m),
    debug: (m: any) => console.log("[updater:debug]", m),
  };

  ipcMain.on("install-update", () => {
    autoUpdater.quitAndInstall();
  });

  scheduleUpdateChecks();
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

/**
 * The GitHub App token, read from the backend running inside this process.
 *
 * Not fetched over HTTP. The backend used to expose GET /auth/system-token for
 * exactly this call, unauthenticated, which made an org-wide admin token
 * available to anything that could open a socket to the app. The backend is
 * require()d into this process by startBackend, so the token is a function call
 * away and never crosses a network boundary at all.
 */
function readSystemToken(): string {
  try {
    const clientPath = require.resolve(path.join(getBackendDir(), "dist", "github", "client.js"));
    return require(clientPath).getSystemToken() || "";
  } catch (err: any) {
    // The interval that calls this has already been cleared by the time we get
    // here, so throwing would end the update check with nothing said. An empty
    // token is the caller's existing "no token" path, which reports an error.
    console.error("[updater] Could not read the system token:", err?.message ?? err);
    return "";
  }
}

/** How often to look, once the first check has run. */
const UPDATE_INTERVAL_MS = 30 * 60_000;

/** How long to keep waiting for AWS before saying so and trying again later. */
const AUTH_WAIT_MS = 5 * 60_000;

/**
 * Check for an update, once the credentials to do it exist.
 *
 * The token comes from Secrets Manager, so AWS has to be reachable before
 * GitHub can be asked anything — that coupling is structural and cannot be
 * removed here. What can be removed is the part that made it permanent: this
 * polled for five minutes and then cleared its interval for the lifetime of the
 * process. Signing in to AWS after that window meant no update check until the
 * app was restarted, and nothing on screen said so. An app people leave open
 * for days would never look again.
 *
 * So it keeps its own clock: give up on *this* attempt after five minutes, then
 * try the whole thing again on the ordinary interval.
 */
function scheduleUpdateChecks(): void {
  const attempt = async (): Promise<void> => {
    const deadline = Date.now() + AUTH_WAIT_MS;

    while (Date.now() < deadline) {
      let reachable = false;
      try {
        const status = await httpGetJson(`http://localhost:${BACKEND_PORT}/auth/status`);
        reachable = !!status.aws?.dynamoReachable;
      } catch (err: any) {
        console.log("[updater] backend not answering yet:", err?.message || "");
      }

      if (reachable) {
        const token = readSystemToken();
        if (!token) {
          // Distinct from a failed check: the App credentials are missing or
          // broken, and no amount of retrying this minute will help.
          console.error(
            "[updater] AWS is reachable but there is no GitHub App token, so the update " +
            "check cannot run. Check the App credentials in Secrets Manager.",
          );
          sendUpdateStatus("error", "No GitHub App token — cannot check for updates");
          return;
        }
        process.env.GH_TOKEN = token;
        sendUpdateStatus("checking");
        console.log("[updater] checking for updates…");
        try {
          const result = await autoUpdater.checkForUpdates();
          console.log("[updater] check returned:",
            result?.updateInfo?.version ?? "no version in response");
        } catch (err: any) {
          // The "error" handler above has already reported it; this stops the
          // rejection becoming an unhandled one.
          console.error("[updater] check threw:", err?.message ?? err);
        }
        return;
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    console.warn(
      "[updater] AWS was not reachable within five minutes, so no update check ran. " +
      `Trying again in ${UPDATE_INTERVAL_MS / 60_000} minutes — signing in to AWS will ` +
      "make the next attempt work without restarting.",
    );
  };

  void attempt();
  setInterval(() => { void attempt(); }, UPDATE_INTERVAL_MS);
}

app.whenReady().then(main);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
