/**
 * Alarms on the AWS guardrails, and Teams as a delivery channel for everything.
 *
 * Two additions that share one idea: the app already had a state machine for
 * "watch a number, tell somebody when it crosses a line", and a group of people
 * to tell, both were wired to exactly one kind of subject and exactly one kind
 * of recipient.
 *
 * The guardrail half is deliberately not a second alarm system. A guardrail
 * alarm is an ordinary alarm whose subject is synthesised from its id, so the
 * evaluator, the state machine, the recovery streak and the message templates
 * are the ones already in use and already tested. What is asserted here is that
 * the seams hold: the new metrics read findings correctly, an alarm on a
 * deleted rule is refused rather than reading zero forever, and the new
 * delivery channel cannot take the old one down.
 *
 * Run:  npx tsx repro-guardrailalarms.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import {
  conditionsFor, metricValue, intervalFor, isValidCondition,
  guardrailSubjectId, guardrailRuleOf, GUARDRAIL_PREFIX, TICK_MINUTES,
} from "./src/alarms/conditions";
import { buildCard } from "./src/services/teamsClient";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const GUARD = { id: guardrailSubjectId(), type: "guardrail" };
const f = (over: Record<string, any> = {}) => ({
  ruleId: "r1", resourceId: "b1", verdict: "violation", excluded: false, ...over,
});

(async () => {
  // ── the subject, which is an id rather than a record ────────────────
  {
    check("watching every rule has its own id",
      guardrailSubjectId() === `${GUARDRAIL_PREFIX}*`);
    check("  and watching one names it", guardrailSubjectId("r1") === `${GUARDRAIL_PREFIX}r1`);
    check("  which reads back", guardrailRuleOf(guardrailSubjectId("r1")) === "r1");
    check("  with every-rule reading back as null, not as the string star",
      guardrailRuleOf(guardrailSubjectId()) === null,
      'filtering findings by the literal "*" would match nothing and read as compliant');
    check("  a widget id is not mistaken for one",
      guardrailRuleOf("abc-123") === null && !"abc-123".startsWith(GUARDRAIL_PREFIX));
  }

  // ── what a guardrail alarm can watch ────────────────────────────────
  {
    const specs = conditionsFor(GUARD as any);
    // Distinct metrics, not options: `guardrail.violations` is offered twice,
    // once as a threshold and once as "tell me about each new failing resource".
    const metrics = [...new Set(specs.map(s => s.metric))];
    check("a guardrail offers its own metrics", metrics.length === 2, metrics);
    check("  and its failing-resource count can be watched either way",
      specs.some(s => s.metric === "guardrail.violations" && s.kind === "count")
        && specs.some(s => s.metric === "guardrail.violations" && s.kind === "each"),
      specs.map(s => `${s.kind}:${s.metric}`));
    check("  and not a widget's",
      !specs.some(s => String(s.metric).startsWith("dependabot")));
    check("  every one carries a unit or a hint, since none is self-explanatory",
      specs.every(s => !!s.unit || !!s.hint));

    // A metric a subject cannot produce evaluates to nothing forever, which is
    // indistinguishable from an alarm that simply is not triggering.
    check("a widget metric is refused on a guardrail",
      !isValidCondition(GUARD as any,
        { kind: "count", metric: "dependabot.critical", op: "gte", threshold: 1 } as any));
    check("  and a guardrail metric is refused on a widget",
      !isValidCondition({ type: "query" } as any,
        { kind: "count", metric: "guardrail.violations", op: "gte", threshold: 1 } as any));
  }

  // ── reading the findings ────────────────────────────────────────────
  {
    const rows = [
      f({ ruleId: "r1", resourceId: "a" }),
      f({ ruleId: "r1", resourceId: "b" }),
      f({ ruleId: "r2", resourceId: "c" }),
      f({ ruleId: "r2", resourceId: "d", verdict: "compliant" }),
      f({ ruleId: "r3", resourceId: "e", verdict: "not_applicable", excluded: true }),
    ];

    check("failing resources counts the failures",
      metricValue("guardrail.violations", rows) === 3, metricValue("guardrail.violations", rows));
    check("  a compliant row is not one",
      metricValue("guardrail.violations", [f({ verdict: "compliant" })]) === 0);
    // An excluded resource is deliberately skipped. Counting it as a violation
    // would make every exclusion list look like a growing problem.
    check("  nor is a deliberately excluded one",
      metricValue("guardrail.violations", [f({ excluded: true, verdict: "violation" })]) === 0,
      "an exclusion is a decision somebody made, not a finding");

    check("skipped resources are their own number",
      metricValue("guardrail.excluded", rows) === 1);
    // Worth an alarm of its own: an exclusion list that quietly grows is how a
    // rule stops covering anything while still reporting green.
    check("  which is what makes a growing exclusion list noticeable",
      metricValue("guardrail.excluded", [f({ excluded: true }), f({ excluded: true })]) === 2);

    // No reading is not a reading of zero.
    check("no findings at all is null, not zero",
      metricValue("guardrail.violations", null) === null,
      "zero would advance the recovery streak and send an all-clear about nothing");
  }

  // ── how often it is worth checking ──────────────────────────────────
  {
    // Was hourly, on the reasoning that the sweep writing findings was hourly
    // too, so checking faster was twelve reads of one answer. The premise was
    // wrong: a CloudTrail event rewrites a resource's findings within seconds,
    // so the table moves between sweeps and an hourly alarm cannot see it. The
    // symptom was the tab going red at once and the alarm arriving an hour on,
    // from the same data.
    check("a guardrail alarm is checked on every tick",
      intervalFor(GUARD as any) === TICK_MINUTES,
      "the findings can change between sweeps, so a slower alarm misses it");

    // The cost argument that justified an hour does not apply: this reading is
    // a scan of a table already written, not a sweep of an estate or a call to
    // GitHub, which is what makes every tick affordable.
    // No longer a special case: every alarm is evaluated every tick, because
    // the pass recomputes every widget afterwards anyway. What still makes a
    // guardrail alarm different is the trigger, not the interval.
    check("  the same as every other alarm",
      intervalFor({ type: "preset", presetId: "dependabot" } as any) === intervalFor(GUARD as any)
      && intervalFor({ type: "query", queryId: "unowned-repos" } as any) === intervalFor(GUARD as any),
      "one rule is easier to hold than three, and the tiering bought nothing");
  }

  // ── delivery ────────────────────────────────────────────────────────
  {
    const notify = fs.readFileSync("./src/services/notifyService.ts", "utf8");
    check("one publish reaches both channels",
      /publishEmail\(topicArn,/.test(notify) && /publishTeams\(topicArn,/.test(notify),
      "adding it at the seam is what gives every existing notification Teams for free");

    // Teams can be worded separately from the email. Unset has to keep meaning
    // "send the email wording", or every alarm written before the field
    // existed would start sending a blank message.
    check("  Teams falls back to the email wording when none is set",
      /teamsText\?\.subject \|\| subject, teamsText\?\.body \|\| body/.test(notify),
      "an unset Teams template must send the email's words, not nothing");
    check("  attempted independently, so one cannot fail the other",
      /await Promise\.all\(\[\s*\n\s*publishEmail/.test(notify),
      "a stale Teams webhook must not stop the email");
    // The claim is unchanged; `publish` now reports each channel rather than
    // one boolean for both, so that a Teams failure beside a delivered email is
    // visible instead of being rounded up to success.
    check("  and delivered-to-anybody counts as delivered",
      /delivered: email \|\| teams\.sent/.test(notify),
      "reporting a reached recipient as a failure records a sent alarm as unsent");
    check("    while still saying which half did not arrive",
      /teamsSent: teams\.sent/.test(notify) && /teamsError/.test(notify),
      "one boolean for two channels is how a broken Teams workflow stayed invisible");
    // Anchored on the Teams catch specifically, not on any `return false` that
    // happens to follow a catch somewhere in the file.
    check("  Teams never throws into the caller",
      /\/\/ Never allowed to take the email down with it\.[\s\S]{0,220}return \{ sent: false, error \};/
        .test(notify));
    // Stronger than it was: not a failure now means carrying no error, so a
    // group nobody uses for Teams does not mark every firing as undelivered.
    check("  a group with nobody in Teams is not a failure",
      /if \(people\.length === 0\) return \{ sent: false \};/.test(notify));
    check("  one request per person, so one bad address does not stop the rest",
      /people\.map\(\(address: string\) => sendToPerson\(flowUrl, address, /.test(notify)
      && /Promise\.all\(\s*\n?\s*people\.map/.test(notify),
      "the flow reads who each message is for");

    const route = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    // A group holds people now, not pipes, so there is nothing to hide: an
    // address is the same shape as the email beside it.
    check("a group lists who it reaches, by name",
      /teamsRecipients: g\.teamsRecipients \?\? \[\]/.test(route));
    check("  added by address, checked as an email",
      /badTeamsAddress/.test(route));
    check("  and removed by address rather than by position",
      /groups\/:id\/teams\/:address/.test(route),
      "a position is only a handle when the value cannot be shown");
    // The one credential left, and it is org-wide.
    check("the shared flow URL is set once and never returned",
      /router\.put\("\/teams-flow"/.test(route)
      && /res\.json\(\{ configured: !!flow\?\.url/.test(route),
      "anybody holding it can post as the flow, to anyone");
    check("  and it is still guarded by the host allow-list",
      /badWebhook\(raw\)/.test(route));

    // An empty heading renders a separator with nothing above it.
    const card = JSON.stringify(buildCard("Subject", "Group", [{ heading: "", links: [], emptyText: "Body" }]));
    check("a plain alarm renders without an empty heading",
      !/"text":""/.test(card) && /Body/.test(card), card.slice(0, 160));
  }

  // ── an alarm on a rule that no longer exists ────────────────────────
  {
    const route = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    check("a deleted rule is refused rather than watched",
      /return found \? \{ id, type: "guardrail"/.test(route),
      "an alarm on a deleted rule reads zero forever, which looks exactly like compliance");

    const values = fs.readFileSync("./src/alarms/widgetValues.ts", "utf8");
    check("a guardrail alarm reads findings and evaluates nothing",
      /listFindings/.test(values) && !/runGuardrails|invokeEngine/.test(values),
      "a sweep started by an alarm makes the reading a consequence of the check");

    const handler = fs.readFileSync("./src/alarms/handler.ts", "utf8");
    check("the evaluator resolves the subject without knowing there are two kinds",
      /id\.startsWith\(GUARDRAIL_PREFIX\)/.test(handler),
      "a second evaluation loop would be a second state machine to keep in step");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
