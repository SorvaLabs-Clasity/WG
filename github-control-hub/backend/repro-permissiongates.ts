/**
 * The gate, and the assertion that keeps it complete.
 *
 * A permission system is only as good as its least-guarded route, and the
 * failure mode is silence: a route added next year with no gate simply works
 * for everybody, and nothing reports it. `repro-undo.ts` already fails when a
 * write route names no authorization guard — that check exists because the
 * rule-template router once shipped with none and the suite passed by not
 * looking at it. This is the same idea applied to permission keys, in both
 * directions.
 *
 * Run:  npx tsx repro-permissiongates.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";
import { PERMISSIONS } from "./src/permissions/vocabulary";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const gate = fs.readFileSync("./src/middleware/permissionGate.ts", "utf8");

console.log("the gate");
{
  check("nothing enforces unless the flag is on",
    /PERMISSIONS_ENABLED/.test(gate) && /!== "true"/.test(gate),
    "flipping this on is stage 4's job, after the dry-run says who loses what");

  check("  and when it is off, the request simply continues",
    /return next\(\)/.test(gate));

  /**
   * Stage 2's hard contract: a per-request call that omits the caller's token
   * falls into the App-token path, which lists every team in the organization —
   * O(teams) GitHub calls on every request.
   *
   * Stage 3 tightened this further: the only function that can carry the
   * caller's own token at all is `accessForSelf`. `accessForOther` — used for
   * inspecting somebody else, never on the request path — has no token
   * parameter to omit in the first place.
   */
  check("every gate passes the caller's own token, through accessForSelf",
    /accessForSelf\(\s*req\.user!?\.login,\s*req\.user!?\.accessToken/.test(gate),
    "omitting it costs one GitHub call per team, per request");

  check("a refusal names the permission it wanted",
    /PERMISSION_REQUIRED/.test(gate) && /permission:/.test(gate));

  check("  and is a 403, distinguishable from an outage",
    /status\(403\)/.test(gate));

  /**
   * An unreadable file is not a refusal about this person. Saying "you may not"
   * when the truth is "we could not ask" sends somebody to request access they
   * already have.
   */
  check("a failure to read permissions answers 503, not 403",
    /status\(503\)/.test(gate) && /failure/.test(gate));

  check("an AWS-only install passes every gate",
    /inert/.test(gate));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
