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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
