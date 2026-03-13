import { Command } from "commander";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { heading, success, info, warn, error, chalk } from "../utils/output";

function findWgRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "github-control-hub-cmd")) || fs.existsSync(path.join(dir, "github-control-hub"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..", "..");
}

const WG_ROOT = findWgRoot();
const BACKEND_DIR = path.join(WG_ROOT, "github-control-hub", "backend");
const FRONTEND_DIR = path.join(WG_ROOT, "github-control-hub", "frontend");

export function registerServeCommands(program: Command): void {
  program
    .command("serve")
    .description("Start the full UI locally (backend + frontend, no Lambda)")
    .option("--backend-port <port>", "Backend port", "4000")
    .option("--frontend-port <port>", "Frontend port", "5173")
    .option("--backend-only", "Only start the backend server")
    .option("--frontend-only", "Only start the frontend dev server")
    .action(async (opts) => {
      heading("GitHub Control Hub — Local Server");

      if (!fs.existsSync(BACKEND_DIR)) {
        error(`Backend not found at: ${BACKEND_DIR}`);
        error("Make sure the github-control-hub directory is alongside github-control-hub-cmd.");
        return;
      }

      if (!opts.backendOnly && !fs.existsSync(FRONTEND_DIR)) {
        error(`Frontend not found at: ${FRONTEND_DIR}`);
        error("Make sure the github-control-hub directory is alongside github-control-hub-cmd.");
        return;
      }

      const backendUrl = `http://localhost:${opts.backendPort}`;
      const frontendUrl = `http://localhost:${opts.frontendPort}`;

      const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        PORT: opts.backendPort,
        FRONTEND_URL: frontendUrl,
        BACKEND_URL: backendUrl,
      };

      // Don't set NODE_ENV=production so server.ts calls listen()
      delete envVars.NODE_ENV;

      const children: ChildProcess[] = [];

      const cleanup = () => {
        children.forEach((c) => {
          try { c.kill(); } catch {}
        });
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      if (!opts.frontendOnly) {
        info(`Starting backend on ${chalk.bold(backendUrl)}…`);

        const backendEntry = fs.existsSync(path.join(BACKEND_DIR, "dist", "server.js"))
          ? path.join(BACKEND_DIR, "dist", "server.js")
          : null;

        if (!backendEntry) {
          warn("Backend not built. Building now…");
          const build = spawn("npx", ["tsc"], {
            cwd: BACKEND_DIR,
            stdio: "inherit",
            shell: true,
          });
          await new Promise<void>((resolve, reject) => {
            build.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Backend build failed (code ${code})`)));
          });
        }

        const backend = spawn("node", ["dist/server.js"], {
          cwd: BACKEND_DIR,
          env: envVars,
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
        });
        children.push(backend);

        backend.stdout?.on("data", (d) => {
          const line = d.toString().trim();
          if (line) console.log(chalk.cyan("[backend]"), line);
        });
        backend.stderr?.on("data", (d) => {
          const line = d.toString().trim();
          if (line) console.log(chalk.red("[backend]"), line);
        });
        backend.on("close", (code) => {
          if (code !== null && code !== 0) {
            error(`Backend exited with code ${code}`);
          }
        });
      }

      if (!opts.backendOnly) {
        info(`Starting frontend on ${chalk.bold(frontendUrl)}…`);

        const frontend = spawn("npx", ["vite", "--port", opts.frontendPort], {
          cwd: FRONTEND_DIR,
          env: {
            ...envVars,
            VITE_API_URL: `${backendUrl}/api`,
          },
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
        });
        children.push(frontend);

        frontend.stdout?.on("data", (d) => {
          const line = d.toString().trim();
          if (line) console.log(chalk.magenta("[frontend]"), line);
        });
        frontend.stderr?.on("data", (d) => {
          const line = d.toString().trim();
          if (line) console.log(chalk.magenta("[frontend]"), line);
        });
        frontend.on("close", (code) => {
          if (code !== null && code !== 0) {
            error(`Frontend exited with code ${code}`);
          }
        });
      }

      console.log();
      success("Local servers starting up.");
      info(`Backend:  ${chalk.underline(backendUrl)}`);
      if (!opts.backendOnly) info(`Frontend: ${chalk.underline(frontendUrl)}`);
      info(`\nPress ${chalk.bold("Ctrl+C")} to stop.\n`);

      const oauthNote = `
${chalk.yellow("Note:")} For GitHub OAuth login to work locally, update your OAuth App's
callback URL to: ${chalk.bold(`${backendUrl}/auth/callback`)}
(GitHub → Settings → Developer settings → OAuth Apps → your app)
`;
      console.log(oauthNote);

      // Keep process alive
      await new Promise(() => {});
    });
}
