import {
  newRows, rowKey, isBreaching, isValidCondition, conditionsFor, MAX_SEEN_KEYS,
} from "./src/alarms/conditions";
import { evaluateAlarms } from "./src/alarms/evaluate";

/**
 * Regression test: "tell me about each new one", the alarm with no threshold.
 *
 * A count alarm speaks on the way from clean to not-clean and then stays quiet
 * however many more arrive, because the state is already ALARM. That is the
 * right shape for "is this bad enough yet" and the wrong shape for the thing
 * most people actually want, which is to hear about a finding once, when it
 * turns up. The failure to guard against is the opposite one: saying the same
 * thing every five minutes for ever.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const row = (repo: string, extra: Record<string, unknown> = {}) => ({ repo, ...extra });

/** One pass, with everything injected. Returns what was sent. */
async function pass(opts: {
  rows: any[]; seen?: string[]; state?: "OK" | "ALARM"; notifyOnRecovery?: boolean;
}) {
  const sent: string[] = [];
  let savedSeen: string[] | undefined = opts.seen;
  const alarm: any = {
    id: "a1", widgetId: "w1", name: "Anything at all",
    condition: { kind: "each", metric: "query.rows" },
    groupId: "g1", subjectTemplate: "{{alarm}}", bodyTemplate: "{{value}}",
    notifyOnRecovery: opts.notifyOnRecovery ?? false, enabled: true,
    state: opts.state ?? "OK", cleanStreak: 0, seenKeys: opts.seen,
  };
  await evaluateAlarms({
    now: Date.now(), org: "acme",
    listAlarms: async () => [alarm],
    getWidget: async () => ({ id: "w1", title: "A check", type: "query" }) as any,
    topicArnFor: async () => "arn:topic",
    computeRows: async () => ({ rows: opts.rows }) as any,
    publish: async (_arn: string, subject: string) => { sent.push(subject); return true; },
    saveRuntime: async (_id: string, rt: any) => {
      if (rt.seenKeys) savedSeen = rt.seenKeys;
    },
    claimSeen: async (_id: string, _from: any, to: string[]) => { savedSeen = to; return true; },
    ignoreInterval: true,
  } as any);
  return { sent, savedSeen };
}

const KEY_API = rowKey({ repo: "api" });

(async () => {
  console.log("\na row is identified by what it is, not by how it reads");
  {
    // `reason` is regenerated on every pass. Keying on it would make every row
    // look new every five minutes, for ever.
    const a = rowKey({ repo: "api", dependency: "lodash", reason: "No push in 8 months" });
    const b = rowKey({ repo: "api", dependency: "lodash", reason: "No push in 9 months" });
    check("wording changing does not make a row new", a === b, { a, b });
    check("  a different finding on the same repo is a different row",
      rowKey({ repo: "api", dependency: "lodash" }) !== rowKey({ repo: "api", dependency: "axios" }));
    check("  and so is the same finding on another repo",
      rowKey({ repo: "api", dependency: "lodash" }) !== rowKey({ repo: "web", dependency: "lodash" }));
    // Guardrail findings name a resource and a rule rather than a repository.
    check("  a guardrail finding is identified too",
      rowKey({ resourceId: "bucket-a", ruleId: "s3-public" })
        !== rowKey({ resourceId: "bucket-b", ruleId: "s3-public" }));
  }

  console.log("\nit speaks about what is new, and only that");
  {
    const first = await pass({ rows: [row("api"), row("web")] });
    check("the first sighting is reported", first.sent.length === 1, first.sent);

    const again = await pass({ rows: [row("api"), row("web")], seen: first.savedSeen, state: "ALARM" });
    check("  the same rows are not reported twice", again.sent.length === 0, again.sent);

    // The case a threshold alarm cannot serve at all: already firing, and
    // something new arrives.
    const third = await pass({
      rows: [row("api"), row("web"), row("infra")], seen: first.savedSeen, state: "ALARM",
    });
    check("  a new row while already firing is reported", third.sent.length === 1, third.sent);
  }

  console.log("\na finding that comes back is news again");
  {
    // Remembering it for ever would swallow the recurrence, which is the one
    // thing somebody watching for regressions cares about.
    const { seenAfterRecovery } = newRows([row("api")], [KEY_API, rowKey({ repo: "gone" })]);
    check("only the rows present are remembered",
      seenAfterRecovery.length === 1 && seenAfterRecovery[0] === KEY_API, seenAfterRecovery);

    const gone = await pass({ rows: [], seen: [KEY_API], state: "ALARM" });
    check("  nothing to report when everything cleared", gone.sent.length === 0, gone.sent);

    const back = await pass({ rows: [row("api")], seen: [], state: "OK" });
    check("  and its return is reported", back.sent.length === 1, back.sent);
  }

  console.log("\nclearing is told the same way as arriving");
  {
    // The asymmetry this replaced: told about each resource as it started
    // failing, then once about all of them clearing — so a resource you fixed
    // went unacknowledged for as long as an unrelated one stayed broken.
    const two = await pass({ rows: [row("api"), row("web")], notifyOnRecovery: true });
    check("both are reported when they appear", two.sent.length === 1, two.sent);

    const oneLeft = await pass({
      rows: [row("api")], seen: two.savedSeen, state: "ALARM", notifyOnRecovery: true,
    });
    check("  one clearing is reported while the other still fails",
      oneLeft.sent.length === 1, oneLeft.sent);

    const stillOne = await pass({
      rows: [row("api")], seen: oneLeft.savedSeen, state: "ALARM", notifyOnRecovery: true,
    });
    check("    and is not reported again", stillOne.sent.length === 0, stillOne.sent);
  }

  console.log("\nnothing is lost when one arrives as another clears");
  {
    // The arrival takes the pass. The departure has to survive that write, or
    // its all-clear is dropped and never sent.
    const before = await pass({ rows: [row("api")], notifyOnRecovery: true });
    const swap = await pass({
      rows: [row("web")], seen: before.savedSeen, state: "ALARM", notifyOnRecovery: true,
    });
    check("the arrival is reported first", swap.sent.length === 1, swap.sent);
    check("  and the departure is still remembered",
      (swap.savedSeen ?? []).includes(rowKey({ repo: "api" })), swap.savedSeen);

    const next = await pass({
      rows: [row("web")], seen: swap.savedSeen, state: "ALARM", notifyOnRecovery: true,
    });
    check("    so its all-clear arrives on the next pass", next.sent.length === 1, next.sent);
  }

  console.log("\na cleared row is forgotten even when nobody is told");
  {
    // Recovery messages off. Without persisting the set on a silent pass, the
    // row stays remembered for ever and its return is never reported.
    const seen = (await pass({ rows: [row("api")], notifyOnRecovery: false })).savedSeen;
    const cleared = await pass({
      rows: [], seen, state: "ALARM", notifyOnRecovery: false,
    });
    check("nothing is sent", cleared.sent.length === 0, cleared.sent);
    check("  and it is no longer remembered",
      !(cleared.savedSeen ?? []).includes(rowKey({ repo: "api" })), cleared.savedSeen);

    const back = await pass({ rows: [row("api")], seen: cleared.savedSeen, state: "OK" });
    check("    so its return is reported", back.sent.length === 1, back.sent);
  }

  console.log("\nwhat it remembers is bounded");
  {
    const many = Array.from({ length: MAX_SEEN_KEYS + 50 }, (_, i) => row(`repo-${i}`));
    const { seenAfterAlarm } = newRows(many, []);
    check(`no more than ${MAX_SEEN_KEYS} keys are kept`,
      seenAfterAlarm.length === MAX_SEEN_KEYS, seenAfterAlarm.length);
  }

  console.log("\nthe condition needs no number, and is offered everywhere");
  {
    check("an each condition is valid with nothing else on it",
      isValidCondition({ type: "query" }, { kind: "each", metric: "query.rows" } as any));
    check("  anything at all counts as breaching",
      isBreaching({ kind: "each", metric: "query.rows" } as any, 1)
        && !isBreaching({ kind: "each", metric: "query.rows" } as any, 0));
    // A reading that could not be taken is still not a clean check.
    check("  and an unreadable check never counts as breaching",
      !isBreaching({ kind: "each", metric: "query.rows" } as any, null));

    for (const [what, widget] of [
      ["a query widget", { type: "query" }],
      ["an AWS guardrail", { type: "guardrail" }],
    ] as const) {
      const offered = conditionsFor(widget as any).some(c => c.kind === "each");
      check(`  ${what} offers it`, offered);
    }
  }

  console.log("\na guardrail alarm can be switched between its two readings");
  {
    // The error somebody actually hit: switching "every new failing resource"
    // to "failing resources" was refused with a message listing the very option
    // that had been chosen. One metric is offered twice, and the validator
    // looked it up by name alone, so it always found the first of the pair and
    // rejected the second for having the wrong kind.
    const guard = { type: "guardrail" } as any;
    check("the count reading is accepted",
      isValidCondition(guard, {
        kind: "count", metric: "guardrail.violations", op: "gte", threshold: 1,
      } as any));
    check("  and so is the each reading",
      isValidCondition(guard, { kind: "each", metric: "guardrail.violations" } as any));
    check("  while a reading the subject does not offer is still refused",
      !isValidCondition(guard, {
        kind: "count", metric: "dependabot.critical", op: "gte", threshold: 1,
      } as any));

    // The same shape on the widget side, where the pair also exists.
    check("  a query widget can be switched too",
      isValidCondition({ type: "query" } as any, {
        kind: "count", metric: "query.rows", op: "gte", threshold: 1,
      } as any)
        && isValidCondition({ type: "query" } as any, {
          kind: "each", metric: "query.rows",
        } as any));
  }

  console.log("\nguardrail findings drive it the same way widget rows do");
  {
    // Findings carry their own verdict, so an excluded or passing resource is
    // not a failing one. An each alarm that counted every row the sweep wrote
    // would report a clean account as broken.
    const finding = (resourceId: string, over: Record<string, unknown> = {}) =>
      ({ resourceId, ruleId: "s3-public", verdict: "violation", excluded: false, ...over });

    const sent: string[] = [];
    let saved: string[] | undefined;
    const alarm: any = {
      id: "g1", widgetId: "guardrail:s3-public", name: "Any failing bucket",
      condition: { kind: "each", metric: "guardrail.violations" },
      groupId: "g", subjectTemplate: "{{items}}", bodyTemplate: "{{items}}",
      notifyOnRecovery: true, enabled: true, state: "OK", cleanStreak: 0,
    };
    const run = (rows: any[]) => evaluateAlarms({
      now: Date.now(), org: "acme",
      listAlarms: async () => [alarm],
      getWidget: async () => ({ id: alarm.widgetId, type: "guardrail", title: "Guardrail" }) as any,
      topicArnFor: async () => "arn:topic",
      computeRows: async () => ({ rows }) as any,
      publish: async (_a: string, subj: string) => { sent.push(subj); return true; },
      saveRuntime: async (_id: string, rt: any) => { if (rt.seenKeys) saved = rt.seenKeys; },
      claimSeen: async (_id: string, _f: any, to: string[]) => { saved = to; return true; },
      ignoreInterval: true,
    } as any);

    await run([finding("bucket-a"), finding("bucket-b", { excluded: true })]);
    check("only the failing resource is reported", sent.length === 1, sent);
    check("  and the message names it", sent[0]?.includes("bucket-a"), sent);
    check("    without naming the excluded one", !sent[0]?.includes("bucket-b"), sent);

    alarm.seenKeys = saved; alarm.state = "ALARM"; sent.length = 0;
    await run([finding("bucket-a"), finding("bucket-c")]);
    check("  a newly failing resource is reported on its own",
      sent.length === 1 && sent[0].includes("bucket-c") && !sent[0].includes("bucket-a"), sent);

    alarm.seenKeys = saved; sent.length = 0;
    await run([finding("bucket-c")]);
    check("  and one returning to normal is reported by name",
      sent.length === 1 && sent[0].includes("bucket-a"), sent);
  }

  console.log("\nthe message never mentions a limit that does not exist");
  {
    // What somebody actually received: "your limit is undefined". The count
    // template ends with the threshold, and an each condition has none, so
    // String(undefined) went straight into the body.
    const conditions = await import("./src/alarms/conditions");
    const message = await import("./src/alarms/message");

    check("the each wording does not ask for a threshold",
      !message.DEFAULT_EACH_BODY.includes("{{threshold}}"),
      "an alarm with no limit should not have a sentence about its limit");
    check("  it names what changed instead",
      message.DEFAULT_EACH_BODY.includes("{{items}}")
        && message.DEFAULT_EACH_BODY.includes("{{change}}"));
    check("  and both new variables are declared, or the form cannot offer them",
      message.TEMPLATE_VARIABLES.some(v => v.name === "items")
        && message.TEMPLATE_VARIABLES.some(v => v.name === "count")
        && message.TEMPLATE_VARIABLES.some(v => v.name === "change"));

    // Alarms written before that wording existed still carry the count
    // template, so the value has to read sensibly inside "your limit is …".
    const rendered = message.buildMessage(
      "s", message.DEFAULT_ALARM_BODY,
      { widget: "W", metric: "M", value: "3", threshold: "any", state: "ALARM", org: "o", time: "t" },
    );
    check("  an older alarm reads sensibly rather than saying undefined",
      rendered.body.includes("your limit is any") && !rendered.body.includes("undefined"),
      rendered.body.split("\n")[2]);

    // And the thing that matters most: none of this ever decided whether to
    // fire. The threshold is not consulted for an each condition.
    check("  and the wording never decided whether it fires",
      conditions.isBreaching({ kind: "each", metric: "query.rows" } as any, 1)
        && !conditions.isBreaching({ kind: "each", metric: "query.rows" } as any, 0));
  }

  console.log("\ntwo passes cannot both report the same rows");
  {
    // The evaluator runs on a tick and again whenever guardrail findings are
    // rewritten, so two passes overlap in practice. A state claim is no use
    // here: this kind commonly speaks while already in ALARM, where there is no
    // state change to compete over.
    const sent: string[] = [];
    const alarm: any = {
      id: "a1", widgetId: "w1", name: "Anything", state: "ALARM", cleanStreak: 0,
      condition: { kind: "each", metric: "query.rows" }, groupId: "g1",
      subjectTemplate: "s", bodyTemplate: "b", notifyOnRecovery: false, enabled: true,
      seenKeys: [],
    };
    await evaluateAlarms({
      now: Date.now(), org: "acme",
      listAlarms: async () => [alarm],
      getWidget: async () => ({ id: "w1", title: "A check", type: "query" }) as any,
      topicArnFor: async () => "arn:topic",
      computeRows: async () => ({ rows: [row("api")] }) as any,
      publish: async (_a: string, s2: string) => { sent.push(s2); return true; },
      saveRuntime: async () => {},
      // The other pass got there first.
      claimSeen: async () => false,
      ignoreInterval: true,
    } as any);
    check("the pass that loses the claim says nothing", sent.length === 0, sent);
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
