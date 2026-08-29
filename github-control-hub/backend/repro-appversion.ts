/**
 * The app says which build it is.
 *
 * A fix can be committed, pushed, and built, and still not be in the app you
 * are running. The release workflow publishes on the version in
 * `desktop/package.json`, and a push that does not move it builds fine and then
 * fails to publish, because the tag already exists. The download stays the
 * previous build, the build log is green, and nothing on screen disagrees.
 *
 * That is exactly how a declared-but-unshipped dependency survived a merge:
 * `@aws-sdk/client-iam` was in the repository and absent from the installed
 * app, and the only way to tell was listing the bundle's node_modules by hand.
 *
 * So the version is shown in two places, and it is asked of the running
 * application rather than compiled in, a constant baked at build time is the
 * version at *compile* time, which is the number that misleads.
 *
 * Run:  npx tsx repro-appversion.ts   from github-control-hub/backend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (p: string) => fs.readFileSync(`${__dirname}/../${p}`, "utf8");

(async () => {
  // ── the wiring ──────────────────────────────────────────────────────
  {
    const main = read("desktop/src/main.ts");
    check("the main process answers with the running app's version",
      /ipcMain\.handle\("app-version", \(\) => app\.getVersion\(\)\)/.test(main),
      "app.getVersion() is what the installed application actually is");

    const preload = read("desktop/src/preload.ts");
    check("  and the bridge exposes it",
      /getAppVersion: \(\): Promise<string> => ipcRenderer\.invoke\("app-version"\)/.test(preload));
    check("  asked over IPC rather than baked in at build time",
      !/getAppVersion[^\n]*process\.env/.test(preload),
      "the frontend is built before packaging, so a baked constant is the wrong number");
  }

  // ── both places it is shown ─────────────────────────────────────────
  {
    for (const [file, where] of [
      ["frontend/src/components/Navbar.tsx", "the account menu"],
      ["frontend/src/pages/LoginPage.tsx", "the sign-in screen"],
    ] as const) {
      const src = read(file);
      check(`${where} reads the version`,
        /getAppVersion\?\.\(\)/.test(src), file);
      check(`  and renders it`, /\{appVersion\}/.test(src) && /v\{appVersion\}/.test(src), file);
      check(`  hiding the line when there is none, rather than showing "v"`,
        /\{appVersion && \(/.test(src),
        "a browser has no installed build to name");
      check(`  and a failure to read it cannot break the screen`,
        /getAppVersion\?\.\(\)[\s\S]{0,160}\.catch\(/.test(src), file);
    }

    // The sign-in screen matters most: the account menu needs somebody signed
    // in, and a broken build is the case where nobody is.
    const login = read("frontend/src/pages/LoginPage.tsx");
    check("the sign-in screen shows it without requiring a session",
      login.indexOf("appVersion") < login.indexOf("const canSwitchAccount"),
      "it is read at mount, not behind any sign-in state");
  }

  // ── the version that gets published ─────────────────────────────────
  {
    const desktop = JSON.parse(read("desktop/package.json"));
    check("the desktop package carries a version at all",
      typeof desktop.version === "string" && /^\d+\.\d+\.\d+$/.test(desktop.version),
      desktop.version);

    // Not a specific number, that would fail on every release. What matters is
    // that the workflow keys on this file, so it is the thing to move.
    const workflow = fs.readFileSync(`${__dirname}/../../.github/workflows/release.yml`, "utf8");
    check("  and the release workflow builds off a push to main",
      /on:\s*\n\s*push:\s*\n\s*branches: \[main\]/.test(workflow));
    check("  with docs excluded, because they cannot move the version",
      /paths-ignore/.test(workflow),
      "a push that cannot publish would otherwise fail the workflow every time");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
