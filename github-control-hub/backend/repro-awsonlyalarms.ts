/**
 * Alarms in an account that watches AWS and nothing else, and a Teams wording
 * that can differ from the email's.
 *
 * The two are related by the same gap. Guardrails could raise alarms, but the
 * evaluator was created only when the deployment had a GitHub organization, so
 * an AWS-only account had a rule that could detect a violation, a tab to
 * configure an alarm on it, and nothing anywhere that would ever evaluate one.
 * Everything saved. Nothing ran. That is the worst shape a gap can take,
 * because the screen agrees with you.
 *
 * The wording half is what those alarms then say. Teams and email were sent
 * identical text because there was only one template, and the two are read
 * differently: an email is opened deliberately, a Teams message is glanced at.
 *
 * Run:  npx tsx repro-awsonlyalarms.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { evaluateAlarms } from "./src/alarms/evaluate";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const stack = fs.readFileSync("../infra/cdk-stack.ts", "utf8");
const handler = fs.readFileSync("./src/alarms/handler.ts", "utf8");

(async () => {
  // ── the evaluator exists in an AWS-only account ─────────────────────
  {
    const gate = stack.indexOf("if (!awsOnly) {");
    check("the stack still has a GitHub-only half", gate > 0);

    check("the alarm evaluator is created outside it",
      stack.indexOf('new NodejsFunction(this, "AlarmEvaluator"') < gate
      && stack.indexOf('new NodejsFunction(this, "AlarmEvaluator"') > 0,
      "inside, an AWS-only account saves guardrail alarms that nothing evaluates");

    check("  and so is its schedule",
      stack.indexOf('new events.Rule(this, "AlarmSchedule"') < gate,
      "a function with no trigger is the same as no function");

    // The webhook receiver and the graph walk are GitHub's, and an account
    // holding no App key must not be given the machinery to use one.
    for (const [what, id] of [
      ["the webhook receiver", 'functionName: `${stackPrefix}-webhook-receiver`'],
      ["the access graph walk", 'functionName: `${stackPrefix}-graph-aggregator`'],
    ] as const) {
      check(`  while ${what} stays behind the gate`,
        stack.indexOf(id) > gate,
        "keeping GitHub out of that account is the whole point of the mode");
    }

    check("the two shared definitions moved out with it",
      stack.indexOf("const webhookBundling = {") < gate
      && stack.indexOf("const notifyTopics =") < gate,
      "the evaluator is built with one and granted the other");
  }

  // ── it is told which install it is in ───────────────────────────────
  //
  // Rather than inferring it from a missing GITHUB_ORG, which is also what a
  // secret that failed to load looks like. One of those is a normal pass and
  // the other has to fail loudly, so they must not be the same signal.
  {
    check("the stack tells the function whether this is an AWS-only install",
      /AWS_ONLY: String\(awsOnly\)/.test(stack));

    check("  and the bootstrap only demands an org when one is expected",
      /!awsOnlyInstall\(\) && !process\.env\.GITHUB_ORG/.test(handler),
      "an AWS-only install has no organization, and that is not a fault");

    check("  while a GitHub install with no org still refuses to cache that bootstrap",
      /bootstrapped = null;\s*\n\s*throw new Error\("\[Alarm\] Secrets did not load/.test(handler),
      "a container that memoises a failed secret load never reaches GitHub again");
  }

  // ── the GitHub half is skipped, not faked ───────────────────────────
  {
    check("a pass with no GitHub reads no token",
      /const token = hasGitHub \? await getSystemTokenAsync\(\) : "";/.test(handler),
      "the App is the only credential, so asking for one without it throws");

    for (const [what, marker] of [
      ["Dependabot alerts", 'needsGitHub("Dependabot alerts")'],
      ["the Renovate feed", 'needsGitHub("The Renovate feed")'],
      ["a security query", 'needsGitHub("A security query")'],
    ] as const) {
      check(`  ${what} refuses rather than reading empty`,
        handler.includes(marker),
        "zero findings and no reading look identical, and one of them is an all-clear");
    }

    // This is the failure that matters. An alarm on "repositories with
    // vulnerabilities" that reads zero because it cannot see GitHub would
    // recover itself and send an all-clear.
    check("  which is the difference between no answer and a clean one",
      /throw new Error\(`\$\{what\} needs GitHub/.test(handler),
      "an absence must never be reported as a healthy reading");

    for (const [what, marker] of [
      ["widget snapshots", "if (!hasGitHub) throw new SkipWithoutGitHub();"],
      ["the pull request walk", "if (!hasGitHub) throw { __skip: true };"],
    ] as const) {
      check(`  ${what} are skipped outright`, handler.includes(marker),
        "storing an error against every widget every five minutes is not a snapshot");
    }

    check("  and a skipped section is silent, while a real failure is not",
      /if \(!\(err instanceof SkipWithoutGitHub\)\) \{/.test(handler),
      "logging every tick of a normal AWS-only pass as an error trains people to ignore it");
  }

  // ── a guardrail alarm needs none of that ────────────────────────────
  {
    const values = fs.readFileSync("./src/alarms/widgetValues.ts", "utf8");
    const guardrailAt = values.indexOf('widget.type === "guardrail"');
    const firstSource = values.indexOf("sources.");
    check("a guardrail reading is answered before any GitHub source is touched",
      guardrailAt > 0 && guardrailAt < firstSource,
      "otherwise the one alarm an AWS-only account can raise would need a token");

    check("  from the findings table the sweep already wrote",
      /listFindings/.test(values.slice(guardrailAt, guardrailAt + 400)),
      "an alarm that ran its own sweep would be measuring its own consequence");
  }

  // ── one firing, two wordings ────────────────────────────────────────
  {
    const sent: any[] = [];
    const alarm = {
      id: "a1", widgetId: "w1", name: "Bucket policy", groupId: "g1",
      condition: { kind: "count", metric: "guardrail.violations", op: "gte", threshold: 1 },
      subjectTemplate: "[{{state}}] {{widget}}: {{metric}} is {{value}}",
      bodyTemplate: "The long version, for an inbox.",
      teamsSubjectTemplate: "{{state}} {{widget}}",
      teamsBodyTemplate: "The short version, for a sidebar.",
      notifyOnRecovery: false, enabled: true,
      state: "OK" as const, cleanStreak: 0,
    };

    const deps: any = {
      now: Date.now(), org: "acme", timezone: "UTC",
      listAlarms: async () => [alarm],
      getWidget: async () => ({ id: "w1", type: "guardrail", title: "Bucket policy" }),
      topicArnFor: async () => "arn:aws:sns:us-east-2:1:github-control-hub-notify-g1",
      computeRows: async () => ({ rows: [{ verdict: "violation" }, { verdict: "violation" }] }),
      publish: async (_t: string, subject: string, body: string, teamsText?: any) => {
        sent.push({ subject, body, teamsText }); return true;
      },
      saveRuntime: async () => {},
    };

    const summary = await evaluateAlarms(deps);
    check("an alarm fires", summary.fired === 1, summary);

    const one = sent[0];
    check("  the email gets the email wording",
      one?.subject?.startsWith("[ALARM] Bucket policy") && one?.subject?.endsWith("is 2"),
      one?.subject);
    check("  and Teams gets its own",
      one?.teamsText?.subject === "ALARM Bucket policy"
      && one?.teamsText?.body === "The short version, for a sidebar.",
      one?.teamsText);

    // Both renderings come from one set of variables, so the channels cannot
    // disagree about what happened. Two readings would be two facts.
    check("  both rendered from the same reading",
      one.subject.includes("is 2") && summary.evaluated === 1,
      "separate wordings must not mean separately measured numbers");
  }

  // ── and nothing changes for an alarm that never asked for two ───────
  {
    const sent: any[] = [];
    const deps: any = {
      now: Date.now(), org: "acme", timezone: "UTC",
      listAlarms: async () => [{
        id: "a2", widgetId: "w1", name: "Retention", groupId: "g1",
        condition: { kind: "count", metric: "guardrail.violations", op: "gte", threshold: 1 },
        subjectTemplate: "[{{state}}] {{widget}}",
        bodyTemplate: "Body.",
        // Absent, which is every alarm written before the field existed.
        notifyOnRecovery: false, enabled: true, state: "OK", cleanStreak: 0,
      }],
      getWidget: async () => ({ id: "w1", type: "guardrail", title: "Retention" }),
      topicArnFor: async () => "arn:topic",
      computeRows: async () => ({ rows: [{ verdict: "violation" }] }),
      publish: async (_t: string, subject: string, body: string, teamsText?: any) => {
        sent.push({ subject, body, teamsText }); return true;
      },
      saveRuntime: async () => {},
    };

    await evaluateAlarms(deps);
    check("no Teams template means none is rendered",
      sent[0]?.teamsText === undefined,
      "publish is what decides the fallback, and it needs the two cases kept apart");

    const notify = fs.readFileSync("./src/services/notifyService.ts", "utf8");
    check("  and publish then sends the email's words to Teams",
      /teamsText\?\.subject \|\| subject, teamsText\?\.body \|\| body/.test(notify),
      "an unset template must not send a blank message");
  }

  // ── the wording survives being saved ────────────────────────────────
  {
    const store = fs.readFileSync("./src/services/alarmService.ts", "utf8");
    check("the Teams templates are persisted with the alarm",
      /"teamsSubjectTemplate", "teamsBodyTemplate"/.test(store),
      "a field missing from the allow-list saves in the UI and is dropped on write");

    check("  and an edit to them is recorded like any other",
      /Teams subject template edited/.test(store),
      "changing what an alarm says to a group is an auditable change");

    const routes = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    check("  they are validated like the email ones",
      /\["Teams subject", teamsSubject\], \["Teams body", teamsBody\]/.test(routes),
      "a template naming a variable that does not exist renders the literal text");

    check("  but empty stays legal, since empty is what means the email wording",
      /tpl === undefined \|\| tpl === ""/.test(routes),
      "rejecting empty would make the off state unsavable");

    // Built by hand rather than spread, so this is the one that silently drops.
    check("the security feed carries them into the flush",
      /teamsSubjectTemplate: sec\.teamsSubjectTemplate/.test(handler),
      "a field added to the settings and not here saves and then does nothing");
  }

  // ── and the tab can actually be reached there ───────────────────────
  //
  // Everything above is invisible without this. The evaluator can run, the
  // guardrail can fire, and if the API refuses and the tab is hidden then
  // nobody in that account can set one up or see one.
  {
    const server = fs.readFileSync("./src/server.ts", "utf8");
    const line = server.split("\n").find(l => l.includes('app.use("/api/alarms"')) ?? "";
    check("the alarms API is not behind the GitHub gate",
      !line.includes("githubGateMiddleware"),
      "an AWS-only account creates guardrail alarms from the AWS tab, and that posts here");

    // The gate exists for a reason and the rest of the GitHub half keeps it.
    for (const path of ["/api/widgets", "/api/graph", "/api/pulls"]) {
      const other = server.split("\n").find(l => l.includes(`app.use("${path}"`)) ?? "";
      check(`  while ${path} stays behind it`,
        other.includes("githubGateMiddleware"),
        "lifting the gate for alarms must not lift it for the GitHub half");
    }

    check("  and admin membership is still required",
      /router\.use\(requireAdmin\)/.test(fs.readFileSync("./src/routes/alarms.ts", "utf8")),
      "these send mail for the whole organization, gate or no gate");

    const nav = fs.readFileSync("../frontend/src/components/Navbar.tsx", "utf8");
    check("the Alarms tab is shown in an AWS-only account",
      /ALWAYS_AVAILABLE = new Set\(\["\/aws", "\/activity", "\/alarms"\]\)/.test(nav),
      "a hidden tab is the same as no tab");

    const page = fs.readFileSync("../frontend/src/pages/AlarmsPage.tsx", "utf8");
    check("  and the page does not ask for widgets it cannot have",
      /useWidgets\(undefined, !githubBlocked\)/.test(page),
      "a refused request behind a working page reads as the page being broken");
  }

  // ── the prefix reaches both halves of an install ────────────────────
  //
  // The setup scripts let you choose one, and export STACK_NAME so both halves
  // use it. setup-aws-account.sh read it and named the tables; the CDK app did
  // not, and configured every Lambda for "github-control-hub-*". A custom
  // prefix therefore produced an account whose tables existed under one name
  // and whose functions looked for another, and the symptom was a sweep that
  // found nothing while the data sat there.
  {
    const appTs = fs.readFileSync("../infra/cdk-app.ts", "utf8");
    check("the CDK app reads the prefix the setup scripts export",
      /process\.env\.STACK_NAME \|\| "github-control-hub"/.test(appTs),
      "exported into a deploy that ignores it is the same as not exported");

    check("  and passes it to the stack",
      /stackPrefix: prefix/.test(appTs),
      "the prop existed and was documented, and nothing ever set it");

    check("  along with the secret names derived from it",
      /secretName: `\$\{prefix\}\/secrets`/.test(appTs),
      "the tables would be renamed and the secret not, which is half a rename");

    const script = fs.readFileSync("../../scripts/setup-aws-only.sh", "utf8");
    check("  which is what the script was already trying to do",
      /STACK_NAME="\$PREFIX" npx cdk deploy/.test(script));

    // Unset has to keep meaning the default, or every existing install renames
    // every resource it owns on the next deploy.
    check("no prefix still means the default",
      /\|\| "github-control-hub"/.test(appTs),
      "a deploy that renames an entire stack is not an upgrade");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
