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

  const express = require(require.resolve("express", { paths: [backendDir] }));
  const expressApp = require(entryPoint).default;

  if (fs.existsSync(frontendDir)) {
    expressApp.use(express.static(frontendDir));

    expressApp.get("*", (req: any, res: any, next: any) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/auth") || req.path.startsWith("/health")) {
        return next();
      }
      res.sendFile(path.join(frontendDir, "index.html"));
    });
  } else if (isDev) {
    console.warn(`Frontend not built at ${frontendDir}. Build with: cd github-control-hub/frontend && npm run build`);
  }

  return new Promise((resolve, reject) => {
    server = expressApp.listen(port, () => {
      console.log(`[desktop] Backend + Frontend running on http://localhost:${port}`);
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
