/**
 * The update check that sometimes never ran.
 *
 * It needs a GitHub App token, the token comes from Secrets Manager, and so AWS
 * has to be reachable before GitHub can be asked anything. That coupling is
 * structural. What was not structural is that every way of saying "not yet"
 * was implemented as "not until you relaunch":
 *
 *   1. AWS not reachable within five minutes. Sitting on the sign-in screen for
 *      longer, or an expired SSO session, and the attempt gave up for half an
 *      hour. Signing in a minute later changed nothing.
 *
 *   2. No GitHub App token. An AWS-only account holds no App key on purpose, so
 *      this is permanent there: the check reported an error and returned, every
 *      half hour, for ever. That account could never update itself.
 *
 *   3. Switching into an account that does have one. Nothing re-triggered a
 *      check, so the app stayed on the clock it started with at launch.
 *
 * All three are the same mistake, and the symptom people actually reported was
 * "I have to relaunch the app for it to check".
 *
 * Run:  npx tsx repro-updatecheck.ts   from github-control-hub/backend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const main = fs.readFileSync("../desktop/src/main.ts", "utf8");
const scheduler = main.slice(main.indexOf("function scheduleUpdateChecks"));

(async () => {
  // ── waiting is not giving up ────────────────────────────────────────
  {
    check("there is no five-minute deadline to fall off",
      !/AUTH_WAIT_MS/.test(main),
      "a deadline turned 'AWS is not ready' into 'not until you relaunch'");

    check("it retries on a short clock until a check runs",
      /const RETRY_MS = 20_000;/.test(main)
      && /retry = setInterval\(\(\) => \{ void tick\(\); \}, RETRY_MS\)/.test(scheduler),
      "half an hour between attempts is why signing in did not help");

    check("  and only then settles into the ordinary interval",
      /clearInterval\(retry\)[\s\S]{0,300}setInterval\(\(\) => \{ void attempt\(\); \}, UPDATE_INTERVAL_MS\)/.test(scheduler),
      "retrying every twenty seconds for ever would be the other mistake");

    check("  which is decided by whether a check actually ran",
      /const attempt = async \(\): Promise<boolean>/.test(scheduler)
      && /if \(!\(await attempt\(\)\)\) return;/.test(scheduler),
      "anything else counts 'could not run' as done");
  }

  // ── the AWS-only account, where this was permanent ──────────────────
  {
    const tokenBranch = scheduler.slice(scheduler.indexOf("const token = readSystemToken()"));

    check("a missing App token does not end the attempts",
      /return false;/.test(tokenBranch.slice(0, 900))
      && !/sendUpdateStatus\("error"/.test(tokenBranch.slice(0, 900)),
      "an AWS-only account has no App key by design and would never check again");

    check("  and says so as a normal state, not a failure",
      /expected in an AWS-only account/.test(scheduler),
      "reporting a designed absence as an error trains people to ignore the log");

    // The state it describes is normal and permanent in such an account, so a
    // line every twenty seconds is a line nobody reads.
    check("  once, rather than on every retry",
      /const sayOnce = \(key: string, say: \(\) => void\) =>/.test(scheduler)
      && /sayOnce\("token"/.test(scheduler),
      "a log that repeats for ever is noise, and the next real problem hides in it");

    check("  and each distinct reason still gets said",
      /sayOnce\("backend"/.test(scheduler) && /sayOnce\("aws"/.test(scheduler),
      "one flag for every cause would report the first and hide the rest");
  }

  // ── a failed check is the interval's problem, not the retry's ───────
  {
    check("a check that ran and threw counts as having run",
      /check threw[\s\S]{0,200}return true;/.test(scheduler),
      "GitHub being down is not a reason to poll every twenty seconds");

    check("  and the reasons are cleared once it works",
      /reported = "";/.test(scheduler),
      "a later failure must explain itself rather than be silenced by an old one");
  }

  // ── the token still never crosses a network boundary ────────────────
  //
  // The backend used to expose this unauthenticated over HTTP, which put an
  // org-wide admin token behind anything that could open a socket.
  {
    // The route is named in the comment explaining why it is gone, so the
    // check is that nothing *calls* it, not that the words never appear.
    check("the token is read in-process, not fetched",
      /require\(clientPath\)\.getSystemToken\(\)/.test(main)
      && !/httpGetJson\([^)]*system-token/.test(main),
      "an org-wide token must not be reachable from a socket");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
