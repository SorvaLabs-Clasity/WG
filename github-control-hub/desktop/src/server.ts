import path from "path";
import fs from "fs";
import http from "http";

let server: http.Server | null = null;

export async function startBackend(
  backendDir: string,
  frontendDir: string,
  port: number,
  isDev: boolean
): Promise<void> {
  const entryPoint = path.join(backendDir, "dist", "server.js");

  if (!fs.existsSync(entryPoint)) {
    throw new Error(
      `Backend not built. Expected: ${entryPoint}\n` +
      `Run 'npm run build:backend' first or 'cd github-control-hub/backend && npx tsc'.`
    );
  }

  process.env.NODE_ENV = "production";
  process.env.__STANDALONE__ = "1";

  const express = require(require.resolve("express", { paths: [backendDir] }));
  const expressApp = require(entryPoint).default;

  if (fs.existsSync(frontendDir)) {
    /**
     * The entry document is never cached; everything it points at always is.
     *
     * Vite fingerprints every asset, so `index-CoGchpD5.js` is safe to keep
     * forever — a new build produces a new name. `index.html` is the pointer to
     * those names, and it is the one file that must not be held.
     *
     * Held, it is how an updated app boots the *previous* frontend against the
     * new backend: Chromium had a fresh-enough copy of the document, asked for
     * the old hashed bundle it named, and got that from cache too. Everything
     * loads, nothing errors, and the first screen whose API response changed
     * shape dies reading a field the old code still expects.
     */
    expressApp.use(express.static(frontendDir, {
      etag: true,
      setHeaders(res: any, filePath: string) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store, must-revalidate");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));

    expressApp.get("*", (req: any, res: any, next: any) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/auth") || req.path.startsWith("/health")) {
        return next();
      }
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.sendFile(path.join(frontendDir, "index.html"));
    });
  } else if (isDev) {
    console.warn(`Frontend not built at ${frontendDir}. Build with: cd github-control-hub/frontend && npm run build`);
  }

  return new Promise((resolve, reject) => {
    // Loopback, not every interface.
    //
    // listen(port) with no host binds 0.0.0.0, which put an administrative API
    // for a GitHub organization and several AWS accounts on whatever network
    // the laptop was joined to. Nothing about this server is meant to be
    // reachable from another machine: the only client is the window in this
    // process, and it asks for http://localhost.
    //
    // A network-facing deployment is the opposite case and binds normally,
    // where reaching it from outside is the entire point and a security
    // group decides who may.
    server = expressApp.listen(port, "127.0.0.1", () => {
      console.log(`[desktop] Backend + Frontend running on http://127.0.0.1:${port}`);
      resolve();
    });
    server!.on("error", reject);
  });
}

export function stopBackend(): void {
  if (server) {
    server.close();
    server = null;
  }
}
