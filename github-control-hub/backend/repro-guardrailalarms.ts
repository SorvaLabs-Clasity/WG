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
  guardrailSubjectId, guardrailRuleOf, GUARDRAIL_PREFIX,
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
    check("a guardrail offers its own metrics", specs.length === 2, specs.map(s => s.metric));
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
    // The sweep that writes findings runs hourly.
    check("a guardrail alarm is checked hourly, not every five minutes",
      intervalFor(GUARD as any) === 60,
      "twelve reads of one answer, and eleven chances to look busy");
  }

  // ── delivery ────────────────────────────────────────────────────────
  {
    const notify = fs.readFileSync("./src/services/notifyService.ts", "utf8");
    check("one publish reaches both channels",
      /publishEmail\(topicArn, subject, body\)/.test(notify)
      && /publishTeams\(topicArn, subject, body\)/.test(notify),
      "adding it at the seam is what gives every existing notification Teams for free");
    check("  attempted independently, so one cannot fail the other",
      /await Promise\.all\(\[\s*\n\s*publishEmail/.test(notify),
      "a stale Teams webhook must not stop the email");
    check("  and delivered-to-anybody counts as delivered",
      /return email \|\| teams;/.test(notify),
      "reporting a reached recipient as a failure records a sent alarm as unsent");
    check("  Teams never throws into the caller",
      /catch \(err\) \{[\s\S]{0,200}return false;/.test(notify));
    check("  a group with no webhooks is not a failure",
      /if \(hooks\.length === 0\) return false;/.test(notify));

    const route = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    check("the webhook URLs never reach the browser",
      /const \{ teamsWebhooks, \.\.\.rest \} = g;/.test(route) && /teamsCount/.test(route),
      "anybody holding one can post into that channel indefinitely");
    check("  and a channel is added through the same allow-list",
      /badWebhook/.test(route),
      "a Lambda posts to whatever is stored, with no further checks");
    check("  removal is by position, since the URL is never sent out",
      /groups\/:id\/teams\/:index/.test(route));

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
