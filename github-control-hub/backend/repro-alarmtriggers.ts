/**
 * Alarms that notice when the data moves, not when a clock says to look.
 *
 * The findings table has three writers and only one is a clock: the scheduled
 * sweep, a CloudTrail event within seconds of a resource changing, and somebody
 * pressing Run or editing an exclusion list. The alarm pass was a fourth thing
 * on a fifth clock, so the AWS tab showed a bucket going red at once while the
 * alarm about it waited up to an hour. Two answers to one question, from one
 * table.
 *
 * The fix is that whatever rewrites the findings evaluates the alarms reading
 * them. That means two evaluators, which is only safe because firing is claimed
 * atomically first, and that claim was needed anyway: the alarm pass has a
 * five-minute timeout on a five-minute schedule, so an overrun already
 * overlapped the next run and could send twice.
 *
 * Run:  npx tsx repro-alarmtriggers.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { evaluateAlarms } from "./src/alarms/evaluate";
import type { AlarmState } from "./src/alarms/conditions";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** One alarm row, shared by however many passes are looking at it. */
function world(opts: { state?: AlarmState; lastCheckedAt?: string } = {}) {
  const row = { state: opts.state ?? ("OK" as AlarmState), cleanStreak: 0 };
  const sent: string[] = [];
  const deps = (tag: string, extra: Record<string, unknown> = {}): any => ({
    now: Date.now(), org: "acme", timezone: "UTC",
    listAlarms: async () => [{
      id: "a1", widgetId: "guardrail:r1", name: "Bucket policy", groupId: "g1",
      condition: { kind: "count", metric: "guardrail.violations", op: "gte", threshold: 1 },
      subjectTemplate: "[{{state}}] {{widget}}", bodyTemplate: "b",
      notifyOnRecovery: false, enabled: true,
      state: row.state, cleanStreak: row.cleanStreak,
      lastCheckedAt: opts.lastCheckedAt,
    }],
    getWidget: async () => ({ id: "guardrail:r1", type: "guardrail", title: "Bucket policy" }),
    topicArnFor: async () => "arn:topic",
    computeRows: async () => ({ rows: [{ verdict: "violation" }] }),
    publish: async () => { sent.push(tag); return true; },
    saveRuntime: async () => {},
    claimTransition: async (_id: string, from: AlarmState, to: AlarmState) => {
      // The conditional write, in miniature: it applies only if the state is
      // still what the caller read.
      if (row.state !== from) return false;
      row.state = to;
      return true;
    },
    ...extra,
  });
  return { row, sent, deps };
}

(async () => {
  // ── one message per transition, not per evaluation ──────────────────
  {
    const w = world();
    await Promise.all([evaluateAlarms(w.deps("A")), evaluateAlarms(w.deps("B"))]);
    check("two overlapping passes send one notification",
      w.sent.length === 1, w.sent);

    check("  and the loser records that it stood down",
      w.row.state === "ALARM",
      "the winner's transition has to be the one that lands");

    // Without the claim this is the bug as it shipped: the evaluator publishes
    // and *then* writes the state, so both passes see OK and both send.
    const bare = world();
    await Promise.all([
      evaluateAlarms({ ...bare.deps("A"), claimTransition: undefined }),
      evaluateAlarms({ ...bare.deps("B"), claimTransition: undefined }),
    ]);
    check("  which is exactly what was happening without it",
      bare.sent.length === 2, bare.sent);
  }

  // ── the counter, so an overlap is visible rather than inferred ──────
  {
    const w = world();
    const [a, b] = await Promise.all([evaluateAlarms(w.deps("A")), evaluateAlarms(w.deps("B"))]);
    check("a stood-down transition is counted",
      (a.duplicatesAvoided + b.duplicatesAvoided) === 1,
      { a: a.duplicatesAvoided, b: b.duplicatesAvoided });

    check("  and only one of them reports firing",
      (a.fired + b.fired) === 1, { a: a.fired, b: b.fired });
  }

  // ── a data-triggered pass ignores the interval ──────────────────────
  //
  // The interval answers "how often is this worth looking at". A sweep landing
  // two minutes after a tick has just answered it, and without the override the
  // triggered pass would evaluate nothing at all.
  {
    const justChecked = new Date(Date.now() - 60_000).toISOString();

    const scheduled = world({ lastCheckedAt: justChecked });
    const s1 = await evaluateAlarms(scheduled.deps("scheduled"));
    check("a scheduled pass respects the interval",
      s1.skippedNotDue === 1 && scheduled.sent.length === 0, s1);

    const triggered = world({ lastCheckedAt: justChecked });
    const t1 = await evaluateAlarms(triggered.deps("triggered", { ignoreInterval: true }));
    check("  and a triggered one does not",
      t1.evaluated === 1 && triggered.sent.length === 1, t1);
  }

  // ── it is the same evaluator, given a shorter list ──────────────────
  {
    const after = fs.readFileSync("./src/aws-guardrails/alarmsAfterSweep.ts", "utf8");

    check("the sweep reuses the evaluator rather than reimplementing it",
      /import \{ evaluateAlarms \}/.test(after) && /evaluateAlarms\(\{/.test(after),
      "a second implementation of firing is a second set of rules to keep in step");

    check("  and claims transitions like the scheduled pass",
      /claimTransition,/.test(after),
      "two evaluators without the claim is the double-send made ordinary");

    // Their reading is a table this invocation just wrote. Every other alarm
    // buys its reading, so triggering those on data changes would multiply that
    // cost by how often the data moves.
    check("  restricted to guardrail alarms",
      /a\.widgetId\.startsWith\(GUARDRAIL_PREFIX\) && a\.enabled/.test(after),
      "a widget alarm's reading costs GitHub calls, which is what its interval bounds");

    check("  and does nothing when there are none",
      /if \(mine\.length === 0\) return \{ evaluated: 0, fired: 0 \};/.test(after),
      "an empty pass should not read settings or touch SNS");
  }

  // ── wired where every writer passes ─────────────────────────────────
  {
    const handler = fs.readFileSync("./src/aws-guardrails/handler.ts", "utf8");
    const write = handler.slice(handler.indexOf("await putFindings(result.findings);"));

    check("the trigger sits beside the findings write",
      /evaluateGuardrailAlarms\(\)/.test(write.slice(0, 1400)),
      "at a call site instead, each of the four writers would need its own");

    check("  and only when findings were actually written",
      handler.indexOf("if (!options.dryRun) {") < handler.indexOf("evaluateGuardrailAlarms"),
      "a dry run has changed nothing, so there is nothing to re-evaluate");

    check("  without being able to fail the sweep",
      /catch \(err: any\) \{[\s\S]{0,160}could not evaluate alarms after the sweep/.test(handler),
      "the sweep may already have remediated something before this runs");

    const stack = fs.readFileSync("../infra/cdk-stack.ts", "utf8");
    check("the sweep may publish to this stack's topics, and nothing else",
      /sid: "PublishGuardrailAlarms"[\s\S]{0,160}resources: \[notifyTopics\]/.test(stack),
      "it has to send an alarm now, and the prefix is the boundary");

    check("  with the grant declared before it is used",
      stack.indexOf("const notifyTopics =") < stack.indexOf('sid: "PublishGuardrailAlarms"'),
      "a const used above its declaration throws at synth");
  }

  // ── one reading of the graph per pass ───────────────────────────────
  //
  // The version counter below means an unchanged graph is never re-read, so
  // most passes cost nothing. Pinning is for the other case: a pass runs for a
  // minute or more, computing every widget sequentially, and webhooks keep
  // writing while it does. Without a pin, each change mid-pass triggers another
  // full scan, and, worse, the widgets computed after it see a different graph
  // from the ones before. One dashboard, two answers.
  {
    process.env.GRAPH_EDGES_TABLE = "fake-edges";
    const { docClient } = await import("./src/utils/dynamo");
    const realSend = (docClient as any).send;

    let scans = 0, version = 0;
    (docClient as any).send = async (cmd: any) => {
      const n = cmd?.constructor?.name;
      if (n === "ScanCommand") {
        scans++;
        return { Items: [{ pk: "REPO#a", sk: `BRANCH#v${version}`, type: "has_branch" }] };
      }
      if (n === "GetCommand") return { Item: { version } };
      if (n === "UpdateCommand") { version++; return {}; }
      return { Items: [] };
    };

    try {
      const { scanGraphEdges, withPinnedGraph } = await import("./src/services/graphService");
      const { bumpGraphVersion } = await import("./src/services/graphVersion");

      // A pass that reads the graph four times while the world changes under
      // it, which is what a webhook arriving mid-pass does.
      const busyPass = async () => {
        const seen: string[] = [];
        for (let i = 0; i < 4; i++) {
          const edges = await scanGraphEdges();
          seen.push(edges[0]?.sk ?? "none");
          await bumpGraphVersion();
          await new Promise(r => setTimeout(r, 6500));
        }
        return seen;
      };

      scans = 0;
      const unpinnedSeen = await busyPass();
      const unpinned = scans;
      check("a pass reading a changing graph re-reads it each time",
        unpinned > 1, unpinned);
      check("  and sees a different graph as it goes",
        new Set(unpinnedSeen).size > 1, unpinnedSeen);

      scans = 0;
      const pinnedSeen = await withPinnedGraph(busyPass);
      check("pinned, it reads once",
        scans <= 1 && scans < unpinned, { pinned: scans, unpinned });
      check("  and every widget in the pass sees the same graph",
        new Set(pinnedSeen).size === 1, pinnedSeen);

      // A warm Lambda container serves many invocations. A pin that outlived
      // its pass would hand the next one a graph from the last.
      await bumpGraphVersion();
      scans = 0;
      await new Promise(r => setTimeout(r, 6500));
      await scanGraphEdges();
      check("  and the pin is released when the pass ends",
        scans === 1, scans);
    } finally {
      (docClient as any).send = realSend;
      delete process.env.GRAPH_EDGES_TABLE;
    }

    const handler = fs.readFileSync("./src/alarms/handler.ts", "utf8");
    check("the alarm pass runs inside a pin",
      /withPinnedGraph\(async \(\) => evaluateAlarms\(\{/.test(handler),
      "the evaluation is the first half of the pass");
    check("  and so does the snapshot loop, which is the longer half",
      /await withPinnedGraph\(async \(\) => \{\s*\n\s*for \(const widget of all\)/.test(handler),
      "every widget computed from one graph, so two cards cannot disagree");
  }

  // ── ask whether the graph changed, before reading all of it ─────────
  //
  // Every graph-backed check starts by loading the whole edge table, and on a
  // large organization that scan is the largest line in the DynamoDB bill. Most
  // passes run over a graph nobody has touched since the last one, and the old
  // code had no way to know that: the only way to find out whether anything had
  // changed was to read everything and look.
  //
  // A counter row costs about one read unit and answers it.
  {
    process.env.GRAPH_EDGES_TABLE = "fake-edges";
    const { docClient } = await import("./src/utils/dynamo");
    const realSend = (docClient as any).send;

    let scans = 0, version = 0;
    (docClient as any).send = async (cmd: any) => {
      const n = cmd?.constructor?.name;
      if (n === "ScanCommand") {
        scans++;
        return { Items: [
          { pk: "GRAPH", sk: "VERSION", version },
          { pk: "REPO#a", sk: "BRANCH#main", type: "has_branch" },
        ] };
      }
      if (n === "GetCommand") return { Item: { version } };
      if (n === "UpdateCommand") { version++; return {}; }
      return { Items: [] };
    };

    // Past the six-second timer, so what is being measured is the version
    // check rather than the timer.
    const past = () => new Promise(r => setTimeout(r, 6500));

    try {
      const { scanGraphEdges, invalidateEdgeCache } =
        await import("./src/services/graphService");
      const { bumpGraphVersion } = await import("./src/services/graphVersion");

      // The block above left a cached reading stamped with its own version
      // counter, and this one starts a fresh counter at zero. Cleared, so what
      // is measured here is this block's behaviour and not the last one's.
      invalidateEdgeCache();

      const first = await scanGraphEdges();
      check("the counter row is not returned as an edge",
        !first.some((e: any) => e.pk === "GRAPH"),
        "every reader iterates these by type, and this is not one");

      scans = 0;
      await past(); await scanGraphEdges();
      await past(); await scanGraphEdges();
      check("an unchanged graph is not re-read, however long the gap",
        scans === 0, scans);

      await bumpGraphVersion();
      scans = 0;
      await past(); await scanGraphEdges();
      check("  and a changed one is",
        scans === 1, scans);
    } finally {
      (docClient as any).send = realSend;
      delete process.env.GRAPH_EDGES_TABLE;
    }

    const ver = fs.readFileSync("./src/services/graphVersion.ts", "utf8");
    const svc = fs.readFileSync("./src/services/graphService.ts", "utf8");

    check("the counter is incremented atomically",
      /UpdateExpression: "ADD #v :one/.test(ver),
      "read-then-write loses increments between concurrent writers");

    // A counter that fails to move makes a cached copy look current: stale.
    // A counter that fails the write it rides on loses the edge: wrong.
    check("  and a failure to record a change cannot lose the change",
      /catch \(err: any\) \{[\s\S]{0,140}could not record a graph change/.test(ver),
      "stale is recoverable, wrong is not");

    check("  an unreadable counter falls through to reading everything",
      /if \(current !== null && current === edgeCache\.version\)/.test(svc),
      "a cached graph must only be served against a version somebody checked");

    // Anchored on the code, not on the comment beside it: a test that fails
    // when somebody rewords a comment is a test nobody trusts.
    const scanBody = svc.slice(svc.indexOf("edgeCacheInFlight = (async () =>"));
    check("  and the version is read after the scan, never before",
      scanBody.indexOf("} while (lastKey);") < scanBody.indexOf("await readGraphVersion()"),
      "a change landing mid-scan would be stamped with the older version");

    const edges = fs.readFileSync("./src/services/graphEdgeService.ts", "utf8");
    check("every edge write says the graph changed",
      (edges.match(/await bumpGraphVersion\(\);/g) ?? []).length === 4,
      "one writer that stays silent makes every cached copy wrong");

    for (const job of ["./src/jobs/graphAggregator.ts", "./src/jobs/lightGraphRefresh.ts"]) {
      const text = fs.readFileSync(job, "utf8");
      check(`  including ${job.split("/").pop()}`,
        (text.match(/await bumpGraphVersion\(\);/g) ?? []).length === 2,
        "per batch, so a job that fails halfway still says the graph moved");
    }
  }

  // ── going wrong is instant; coming right waits ──────────────────────
  //
  // The asymmetry is deliberate and is the thing people ask about: a breach
  // fires on the first check, and a recovery waits for two clean ones, so a
  // value resting on its threshold does not send an all-clear every time it
  // wobbles.
  {
    const { step, RECOVERY_CHECKS } = await import("./src/alarms/conditions");

    const first = step({ state: "OK", cleanStreak: 0 }, true);
    check("the first breach fires", first.fire === "alarm", first);
    check("  and a second does not", step(first.runtime, true).fire === null,
      "one notification per transition, not one per evaluation");

    let r = step({ state: "ALARM", cleanStreak: 0 }, false);
    check("one clean check does not recover", r.fire === null, r);
    r = step(r.runtime, false);
    check(`  ${RECOVERY_CHECKS} do`, r.fire === "recovery" && r.runtime.state === "OK", r);

    // Which is why a fix at 2:50 with a five-minute tick lands at 3:00 rather
    // than instantly: one clean check on the event, one on the next tick.
    check("  so a recovery is at most two checks behind the fix",
      RECOVERY_CHECKS === 2, RECOVERY_CHECKS);

    const modal = fs.readFileSync("../frontend/src/components/AlarmModal.tsx", "utf8");
    check("the wait is stated where the setting is",
      /two clean checks\s*\n?\s*in a row/.test(modal),
      "an all-clear that is late without explanation reads as one that is lost");

    check("  and the setting says it covers Teams as well as email",
      /by email and Teams/.test(modal),
      "labelled email only, nobody turns it off for the channel it also uses");
  }

  // ── the interval on screen comes from the evaluator ─────────────────
  //
  // The list worked it out for itself from the subject's kind, so it said
  // "checked every hour" about an alarm the evaluator looks at every tick. Two
  // places deciding one number means one of them is wrong, and it is the copy.
  {
    const routes = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    check("the alarms list reports each alarm's real interval",
      /intervalMinutes: subject \? intervalFor\(subject\) : null/.test(routes),
      "the screen should not be guessing what the evaluator does");

    const page = fs.readFileSync("../frontend/src/pages/AlarmsPage.tsx", "utf8");
    check("  and the screen uses it rather than its own table",
      /interval=\{a\.intervalMinutes \?\? null\}/.test(page)
      && !/interval=\{guardrail \? 60/.test(page),
      "a hardcoded 60 outlives every change to the evaluator");

    const modal = fs.readFileSync("../frontend/src/components/AlarmModal.tsx", "utf8");
    check("  and a guardrail says it reacts to the change, not to the clock",
      /Checked whenever the findings change/.test(modal),
      "the tick is the backstop there, and quoting only it hides the whole point");

    check("  while everything else quotes its interval honestly",
      /Checked \{describeInterval\(spec\.intervalMinutes\)\}, so this can take up to/.test(modal),
      "a widget alarm really does wait for the next pass");

    check("  with a deleted subject stating no interval at all",
      /interval !== null && <span>checked/.test(page),
      "a number there would be the confident half of a contradiction");
  }

  // ── an exclusion change re-checks, and so re-alarms ─────────────────
  {
    const routes = fs.readFileSync("./src/routes/awsGuardrails.ts", "utf8");
    check("changing exclusions re-runs the affected rules",
      /await invokeEngine\(\{ ruleIds \}\)/.test(routes),
      "otherwise a resource stays skipped after the list excluding it has gone");

    // That invocation lands in the same handler as a sweep, so it writes
    // findings and then evaluates the alarms reading them: a resource that
    // comes back into scope and breaches fires at once.
    const handler = fs.readFileSync("./src/aws-guardrails/handler.ts", "utf8");
    const afterWrite = handler.slice(handler.indexOf("await putFindings(result.findings);"));
    check("  and that run evaluates alarms like any other",
      /evaluateGuardrailAlarms\(\)/.test(afterWrite.slice(0, 1400)),
      "a narrow run is still a run, and the alarm must not wait for the sweep");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
