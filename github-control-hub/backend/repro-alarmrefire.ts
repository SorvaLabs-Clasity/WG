/**
 * An alarm must not email again because somebody saved it.
 *
 * Run from github-control-hub/backend:  npx tsx repro-alarmrefire.ts
 *
 * What happened, in order:
 *
 *   1. An alarm on a widget had been firing for days. Value 2, limit 2. Nothing
 *      about it changed and nobody expected another email about it.
 *   2. Somebody opened its email template, mistyped one character, saved.
 *   3. Minutes later the alarm emailed everyone — with the broken template, so
 *      the mistake was visible in the message that should never have been sent.
 *
 * The cause was not the template. `updateAlarm` resets an alarm's ALARM/OK state
 * when its *condition* changes, which is right — an alarm that starts watching
 * something else has to be able to fire for the new thing. It decided that with
 *
 *     JSON.stringify(data.condition) !== JSON.stringify(existing.condition)
 *
 * and DynamoDB hands a map's keys back in its own order. The row on the live
 * table reads `{kind, threshold, metric, op}`; the form sends
 * `{kind, metric, op, threshold}`. Same condition. Different string. So the
 * comparison said "changed" on *every* save of *any* field — a rename, a
 * different email group, a typo fixed — reset the firing alarm to OK, and the
 * next evaluation saw a fresh breach and sent the email.
 *
 * The key orders below are copied from the real stored row and the real form,
 * not invented, because inventing them is how this passed review the first time.
 */
import { readFileSync } from "fs";
import { sameValue } from "./src/utils/sameValue";
import { step } from "./src/alarms/conditions";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** Exactly as DynamoDB returned it from the live table. */
const STORED = { kind: "count", threshold: 2, metric: "query.rows", op: "gte" };
/** Exactly as AlarmModal.buildCondition() constructs it. */
const FROM_FORM = { kind: "count", metric: "query.rows", op: "gte", threshold: 2 };

// ── the comparison itself ─────────────────────────────────────────────
{
  check("the two orderings really are different strings — the bug was real",
    JSON.stringify(STORED) !== JSON.stringify(FROM_FORM),
    { stored: JSON.stringify(STORED), form: JSON.stringify(FROM_FORM) });

  check("the same condition in a different key order is not a change",
    sameValue(STORED, FROM_FORM));

  // A severity condition, whose field names sort differently again.
  check("a severity condition is order-independent too",
    sameValue(
      { kind: "severity", metric: "vulnRepos.worstSeverity", atLeast: "high" },
      { atLeast: "high", kind: "severity", metric: "vulnRepos.worstSeverity" }));
}

// ── what must still count as changed ──────────────────────────────────
{
  check("a different threshold is a change",
    !sameValue(STORED, { ...FROM_FORM, threshold: 5 }));
  check("a different operator is a change",
    !sameValue(STORED, { ...FROM_FORM, op: "lte" }));
  check("a different metric is a change",
    !sameValue(STORED, { ...FROM_FORM, metric: "query.total" }));
  check("a different kind is a change",
    !sameValue(STORED, { kind: "severity", metric: "x", atLeast: "high" }));
  check("2 and \"2\" are not the same threshold",
    !sameValue(STORED, { ...FROM_FORM, threshold: "2" as any }));
  check("an extra field is a change",
    !sameValue(STORED, { ...FROM_FORM, extra: true }));
  check("a missing field is a change",
    !sameValue(STORED, { kind: "count", metric: "query.rows", op: "gte" }));
  check("a field present but undefined is not the same as absent",
    !sameValue({ a: 1 }, { a: 1, b: undefined }));
  // Same number of keys, different keys, both undefined. Counting keys is not
  // enough here — the names have to be compared, or a renamed field reads as no
  // change at all.
  check("  and two different undefined fields are not each other",
    !sameValue({ a: 1, b: undefined }, { a: 1, c: undefined }));
}

// ── arrays keep their order ───────────────────────────────────────────
{
  check("a list in a different order is a different list",
    !sameValue(["alice", "bob"], ["bob", "alice"]));
  check("the same list is the same list", sameValue(["alice", "bob"], ["alice", "bob"]));
  check("a list is not an object with the same keys", !sameValue([1, 2], { 0: 1, 1: 2 }));
  // Both orders. With the array on the left the length check happens to reject
  // an object anyway, so testing only that direction leaves the guard unproven.
  check("  nor the other way round", !sameValue({ 0: 1, 1: 2 }, [1, 2]));
  check("nesting is compared all the way down",
    sameValue({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }));
  check("  and a difference deep inside is still a difference",
    !sameValue({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }));
}

// ── null, undefined and the empties ───────────────────────────────────
{
  check("null is not an empty object", !sameValue(null, {}));
  check("null equals null", sameValue(null, null));
  check("undefined equals undefined", sameValue(undefined, undefined));
  check("null is not undefined", !sameValue(null, undefined));
  check("two empty objects are equal", sameValue({}, {}));
  check("two empty arrays are equal", sameValue([], []));
  check("an empty array is not an empty object", !sameValue([], {}));
}

// ── the consequence, spelled out through the state machine ────────────
//
// The comparison is only interesting because of what it drives. This walks the
// exact sequence that produced the email, so a regression is reported as
// "editing the template sent an email" rather than as an equality failure.
{
  /** What updateAlarm does, in the two spellings of the condition check. */
  const save = (
    stored: { state: "OK" | "ALARM"; cleanStreak: number },
    submitted: Record<string, unknown>,
    compare: (a: unknown, b: unknown) => boolean,
  ) => {
    const changed = !compare(submitted, STORED);
    return changed ? { state: "OK" as const, cleanStreak: 0 } : stored;
  };

  const byJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // A firing alarm, still breaching, and somebody edits the email body only.
  const firing = { state: "ALARM" as const, cleanStreak: 0 };

  const old = save(firing, FROM_FORM, byJson);
  const oldNext = step(old, true);
  check("the old comparison reset a firing alarm on a template-only save",
    old.state === "OK", old);
  check("  and the next evaluation emailed everyone again",
    oldNext.fire === "alarm", oldNext);

  const fixed = save(firing, FROM_FORM, sameValue);
  const fixedNext = step(fixed, true);
  check("the alarm stays in ALARM across a template-only save",
    fixed.state === "ALARM", fixed);
  check("  so the next evaluation sends nothing", fixedNext.fire === null, fixedNext);

  // Saving repeatedly must not creep back into a firing state either.
  let s = firing as { state: "OK" | "ALARM"; cleanStreak: number };
  let emails = 0;
  for (let i = 0; i < 20; i++) {
    s = save(s, FROM_FORM, sameValue);
    const r = step(s, true);
    if (r.fire === "alarm") emails++;
    s = r.runtime;
  }
  check("twenty saves in a row send zero emails", emails === 0, emails);

  // And the behaviour the reset exists for is still there.
  const real = save(firing, { ...FROM_FORM, threshold: 99 }, sameValue);
  const realNext = step(real, true);
  check("a genuine condition change still resets the alarm", real.state === "OK", real);
  check("  and fires for the new condition", realNext.fire === "alarm", realNext);
}

// ── nothing else may reset a send decision ────────────────────────────
//
// The fix above is one comparison. The rule it protects is broader: saving a
// setting must never be able to make something send again. This reads the
// source rather than trusting it, so a reset added to a different save — the
// security toggle, a feed's template, the pull request switches — fails here
// instead of arriving as another surprise email.
{
  const service = readFileSync("src/services/alarmService.ts", "utf8");

  const resets = service.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    // No trailing \b: `state = "OK";` ends on a quote followed by a semicolon,
    // which is not a word boundary, so requiring one silently matched only half
    // the pattern — and the guard reported one reset where there are two.
    .filter(l => /\b(state\s*=\s*"OK"|cleanStreak\s*=\s*0\b)/.test(l.line)
      && !l.line.startsWith("//") && !l.line.startsWith("*"));

  // Two lines, adjacent, in updateAlarm's conditionChanged branch. Any third is
  // a new way for a save to trigger an email.
  check("only one place resets an alarm's firing state", resets.length === 2,
    resets.map(r => `line ${r.n}: ${r.line}`));

  const guarded = service.includes(`  if (conditionChanged) {
    updated.state = "OK";
    updated.cleanStreak = 0;`);
  check("  and it is behind the condition-changed check", guarded);

  // The comparison that guards it must not go back to comparing JSON text.
  check("no send decision is made by comparing JSON strings",
    !/JSON\.stringify\([^)]*\)\s*[!=]==\s*JSON\.stringify/.test(service),
    service.split("\n").filter(l => /JSON\.stringify.*[!=]==.*JSON\.stringify/.test(l)));

  // The other three email paths keep no state a save could clear; assert they
  // still keep none rather than assuming it stays that way.
  for (const fn of ["saveSecuritySettings", "saveFeedSettings"]) {
    const start = service.indexOf(`export async function ${fn}`);
    const body = service.slice(start, start + 2200);
    check(`${fn} touches no send state`,
      start > -1 && !/\bstate\s*=|\bcleanStreak\b|\bsentAt\s*=|lastFiredAt/.test(body));
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
