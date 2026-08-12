/**
 * Tests for the gate on the AWS credential endpoints.
 *
 * These are the only way back once AWS is disconnected, so requiring a GitHub
 * session to reach them is circular: the session's own secrets come from
 * Secrets Manager, which needs AWS. Getting this wrong locks the user out of
 * their own app with no route back except pasting access keys.
 */
let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** Mirrors setupOrAuthMiddleware's decision, without Express. */
function passesThrough(env: { clientId?: string; activityTable?: string }, locked: boolean): boolean {
  if (!env.clientId) return true;
  if (!env.activityTable || locked) return true;
  return false;   // falls through to authMiddleware
}

const CONFIGURED = { clientId: "Iv1.abc", activityTable: "github-control-hub-activity" };

(async () => {
  check("first run, nothing configured — open",
    passesThrough({}, false));

  check("fully connected and signed in — requires auth",
    !passesThrough(CONFIGURED, false));

  // The reported bug: Reset both drops the GitHub token AND locks AWS.
  check("after Reset both connections — open, so profiles can be listed",
    passesThrough(CONFIGURED, true));

  check("after disconnecting AWS alone — open",
    passesThrough(CONFIGURED, true));

  check("secrets loaded but AWS never connected — open",
    passesThrough({ clientId: "Iv1.abc" }, false));

  // The property that matters: there is no state where the app is unusable.
  const states: [string, { clientId?: string; activityTable?: string }, boolean][] = [
    ["fresh install",        {},                                   false],
    ["aws only",             { activityTable: "t" },               false],
    ["secrets only",         { clientId: "c" },                    false],
    ["both, healthy",        CONFIGURED,                           false],
    ["both, aws locked",     CONFIGURED,                           true],
  ];
  const stuck = states.filter(([, env, locked]) => {
    const awsUsable = !!env.activityTable && !locked;
    // Unreachable means: cannot connect AWS, and AWS is not already working.
    return !passesThrough(env, locked) && !awsUsable;
  });
  check("no state leaves the user unable to reconnect", stuck.length === 0, stuck.map(s => s[0]));

  // ── and what stands in for the missing session ─────────────────────
  //
  // Being open is the point above, which leaves cross-site request forgery as
  // the whole exposure: these endpoints took a POST from any page the user had
  // open and acted on it. CORS does not help — it governs reading the response,
  // not sending the request.
  //
  // The guard is read out of the shipped source rather than reimplemented, so
  // this cannot drift into testing a copy that no longer matches.
  {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "src/routes/auth.ts"), "utf8");
    const body = src.slice(src.indexOf("const sameOriginOnly"),
                           src.indexOf("/** After AWS credentials change"));
    const guard = new Function("process",
      `${body.replace(/: (Request|Response|NextFunction)/g, "")} return sameOriginOnly;`)(process);

    const at = (frontendUrl: string, headers: Record<string, string>) => {
      const previous = process.env.FRONTEND_URL;
      process.env.FRONTEND_URL = frontendUrl;
      let status = 0, allowed = false;
      guard(
        { headers },
        { status(c: number) { status = c; return this; }, json() { return this; } },
        () => { allowed = true; },
      );
      process.env.FRONTEND_URL = previous;
      return allowed ? "allowed" : status;
    };

    const DESKTOP = "http://localhost:4321";

    check("the app's own request is allowed",
      at(DESKTOP, { origin: DESKTOP, "sec-fetch-site": "same-origin" }) === "allowed");

    // Ports are not part of a "site", so Vite on :5173 calling the backend on
    // :4000 reports same-site. Refusing that would break every dev run.
    check("  as is the dev server calling across ports",
      at("http://localhost:5173",
         { origin: "http://localhost:5173", "sec-fetch-site": "same-site" }) === "allowed");

    check("  as is a caller with no browser headers at all",
      at(DESKTOP, {}) === "allowed");

    check("a hostile page is refused",
      at(DESKTOP, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }) === 403);

    check("  with Origin stripped, Sec-Fetch-Site still gives it away",
      at(DESKTOP, { "sec-fetch-site": "cross-site" }) === 403);

    check("  and on an older browser, Origin does",
      at(DESKTOP, { origin: "https://evil.example" }) === 403);

    // The one Sec-Fetch-Site alone would let through: another local server is
    // same-site to the app, so the port in Origin has to be what decides.
    check("  another server on this machine is refused",
      at(DESKTOP, { origin: "http://localhost:9999", "sec-fetch-site": "same-site" }) === 403);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
