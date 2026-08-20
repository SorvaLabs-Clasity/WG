/**
 * Getting a live App token back without restarting the app.
 *
 * The installation token lives an hour and is refreshed by a timer set shortly
 * before it expires. Two things then went wrong together, and the symptom was
 * an app that had been open a while — typically across a laptop sleeping —
 * where the AWS tab showed nothing, the Vulnerabilities tab said "authorization
 * failed, check your permissions", and restarting fixed all of it.
 *
 *   1. **The timer was re-armed only on success.** `scheduleRefresh()` ran from
 *      the end of `_refresh()`, so a refresh that threw — a machine waking with
 *      the network not yet up is precisely one of those — logged a line and
 *      left no timer behind. Nothing would ever try again.
 *
 *   2. **The synchronous getter never asked for a new one.** It hands back the
 *      cached token because it cannot await, which is right, but past real
 *      expiry that token only produces 401s. Roughly twenty call sites use it —
 *      the Vulnerabilities tab, the repository list, the security checks — so
 *      the whole GitHub half failed in a way that reads as a permissions
 *      problem rather than an expired credential.
 *
 * What must not be lost in fixing it:
 *
 *   - the sync getter must still return the App's own token and never reach for
 *     some other credential. That is asserted in repro-token.ts, and the
 *     recovery here must not turn into a fallback.
 *   - one page issuing twenty of these must produce one token request, not
 *     twenty.
 */
process.env.GITHUB_ORG = "test-org";

import fs from "fs";
import path from "path";
import { initTokenManager, getSystemToken, refreshDelayMs } from "./src/github/client";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const dir = __dirname;
const stub = path.join(dir, "stub-recovering.cjs");

// First call hands back a token that is already dead — the state the app wakes
// up in. Every call after it succeeds, which is what a network coming back
// looks like. `calls` is exported so the test can prove the refresh happened
// once rather than once per caller.
fs.writeFileSync(stub, `
  let calls = 0;
  exports.calls = () => calls;
  exports.createAppAuth = () => async () => {
    calls++;
    return calls === 1
      ? { token: "ghs_expired", expiresAt: new Date(Date.now() - 3600e3).toISOString() }
      : { token: "ghs_recovered", expiresAt: new Date(Date.now() + 3600e3).toISOString() };
  };
`);

const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req: string, ...rest: any[]) {
  if (req === "@octokit/auth-app") return stub;
  return origResolve.call(this, req, ...rest);
};

(async () => {
  // ── when the next refresh should happen ──────────────────────────────
  {
    const now = Date.now();

    // The ordinary case: shortly before expiry, and never sooner than a minute.
    const hourOut = refreshDelayMs(now + 3600e3, now, false);
    check("a live token is refreshed before it expires, not after",
      hourOut > 0 && hourOut < 3600e3, hourOut);
    check("  and never more often than once a minute",
      refreshDelayMs(now + 1000, now, false) === 60_000,
      "a token about to expire would otherwise spin");

    // The case that was missing entirely.
    check("a failed refresh is tried again rather than abandoned",
      refreshDelayMs(now + 3600e3, now, true) === 60_000,
      "one bad network moment used to end refreshing for the life of the process");
    check("  including when the token is already long dead",
      refreshDelayMs(now - 3600e3, now, true) === 60_000,
      "expired plus no timer is the state that needed a restart");
  }

  // ── the synchronous getter gets unstuck by itself ────────────────────
  {
    await initTokenManager("1", "key", "1");

    const first = getSystemToken();
    check("it still hands back the App's own expired token, not a fallback",
      first === "ghs_expired", first);

    // Twenty callers, one refresh. The dedupe is the difference between a page
    // load recovering and a page load asking GitHub for twenty tokens.
    for (let i = 0; i < 20; i++) getSystemToken();

    // Let the refresh it started settle.
    await new Promise(r => setTimeout(r, 50));

    const after = getSystemToken();
    check("  and the next call has a live one, with no restart",
      after === "ghs_recovered", after);

    const calls = require(stub).calls();
    check("  having asked GitHub for exactly one replacement",
      calls === 2, { calls, expected: "1 at init + 1 refresh" });
  }

  // ── switching accounts must not leave the old App refreshing ─────────
  //
  // Every AWS account switch reloads the secrets, and that either re-initialises
  // the token manager for the account moved into or drops it when that account
  // holds no GitHub App. Both replaced the module-level reference and neither
  // touched the outgoing manager's refresh timer — and an armed timer holds a
  // reference to the object that armed it, so nothing was collected.
  //
  // The result: one orphan per switch, each still minting installation tokens
  // for an organization the account you are now in is not supposed to touch.
  // Re-arming after failure, which is the fix above, made the orphan immortal.
  {
    const { disposeTokenManager, __armedRefreshTimers } = await import("./src/github/client");

    await initTokenManager("1", "key", "1");
    check("one manager arms one refresh", __armedRefreshTimers() === 1, __armedRefreshTimers());

    // Switching into another account that has an App.
    await initTokenManager("2", "key", "2");
    check("  switching accounts replaces it rather than adding a second",
      __armedRefreshTimers() === 1, __armedRefreshTimers());

    await initTokenManager("3", "key", "3");
    await initTokenManager("4", "key", "4");
    check("  and switching back and forth does not accumulate them",
      __armedRefreshTimers() === 1, __armedRefreshTimers());

    // Switching into an account with no GitHub App at all.
    disposeTokenManager();
    check("  dropping it for an AWS-only account stops the refreshing too",
      __armedRefreshTimers() === 0, __armedRefreshTimers());
    check("  and there is no token left to hand out",
      getSystemToken() === "", getSystemToken());
  }

  fs.unlinkSync(stub);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
