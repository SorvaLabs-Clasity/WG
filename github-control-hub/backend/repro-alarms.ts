/**
 * Widget alarms: what they watch, when they fire, and what they say.
 *
 * The quiet failures this guards against, all of which look like "no alarm" to
 * anyone reading their inbox:
 *
 *   - a condition offered against a widget that cannot produce it. It reads as
 *     configured, evaluates to nothing forever, and never fires.
 *   - firing on every cycle while a value sits on its threshold, which trains
 *     people to filter the alarm.
 *   - an hourly alarm drifting to 75 minutes because the scheduler's jitter
 *     lands just short of the interval.
 *   - a subject line SNS refuses, which turns a firing alarm into silence —
 *     and silence already means "all clear".
 */
import fs from "fs";
import path from "path";
import {
  conditionsFor, isValidCondition, metricValue, isBreaching, step, intervalFor,
  isDue, severityRank, INTERVAL_MINUTES, RECOVERY_CHECKS, DUE_TOLERANCE_MS, TICK_MINUTES,
  type AlarmCondition, type AlarmRuntime,
} from "./src/alarms/conditions";
import {
  render, unknownVariables, sanitizeSubject, buildMessage, SUBJECT_MAX,
  DEFAULT_ALARM_SUBJECT, DEFAULT_ALARM_BODY, TEMPLATE_VARIABLES, formatTimestamp,
} from "./src/alarms/message";
import {
  parseSeverities, aggregateDependabot, aggregateVulnRepos, computeWidgetRows,
} from "./src/alarms/widgetValues";
import { evaluateAlarms, meetsMinimumSeverity } from "./src/alarms/evaluate";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

// ── each widget offers only what it can answer ────────────────────────
{
  const dep = conditionsFor({ type: "preset", presetId: "dependabot" }).map(s => s.metric);
  const vuln = conditionsFor({ type: "preset", presetId: "vuln-repos" }).map(s => s.metric);
  const byp = conditionsFor({ type: "preset", presetId: "bypasses" }).map(s => s.metric);
  const qry = conditionsFor({ type: "query" }).map(s => s.metric);

  check("a dependabot widget offers severity counts", dep.includes("dependabot.critical") && dep.includes("dependabot.high"), dep);
  check("  a vuln-repos widget offers worst-severity", vuln.includes("vulnRepos.worstSeverity"), vuln);
  check("  a bypasses widget offers bypass counts", byp.includes("bypasses.total"), byp);
  check("  a query widget offers a row count", qry.length === 1 && qry[0] === "query.rows", qry);

  // The point of a per-widget catalogue is that they do not overlap.
  const overlap = dep.filter(m => byp.includes(m) || qry.includes(m));
  check("  and no metric is offered by two different widget kinds", overlap.length === 0, overlap);

  check("an unknown preset offers nothing rather than everything",
    conditionsFor({ type: "preset", presetId: "not-a-real-preset" }).length === 0,
    "an unknown widget would accept any condition");
}

// ── the API must not accept a condition its widget cannot produce ─────
{
  const depWidget = { type: "preset", presetId: "dependabot" };
  const bypWidget = { type: "preset", presetId: "bypasses" };

  const good: AlarmCondition = { kind: "count", metric: "dependabot.critical", op: "gte", threshold: 1 };
  check("a matching condition is accepted", isValidCondition(depWidget, good));

  check("  a condition from another widget is refused",
    !isValidCondition(bypWidget, good),
    "an alarm that can never fire would look configured");

  check("  a severity condition on a widget without one is refused",
    !isValidCondition(depWidget, { kind: "severity", metric: "vulnRepos.worstSeverity", atLeast: "high" }));

  // NaN compares false against everything, so this alarm would never fire.
  check("  a non-numeric threshold is refused",
    !isValidCondition(depWidget, { kind: "count", metric: "dependabot.critical", op: "gte", threshold: NaN }),
    "NaN >= anything is false, so the alarm is silently dead");
  check("  as is an infinite one",
    !isValidCondition(depWidget, { kind: "count", metric: "dependabot.critical", op: "gte", threshold: Infinity }));

  check("  an unknown severity is refused",
    !isValidCondition({ type: "preset", presetId: "vuln-repos" },
      { kind: "severity", metric: "vulnRepos.worstSeverity", atLeast: "urgent" as any }),
    "an unranked severity sorts below low and never fires");
}

// ── reading a value out of the rows ───────────────────────────────────
{
  const depRows = [
    { repo: "a", total: 5, critical: 2, high: 1, medium: 2, low: 0 },
    { repo: "b", total: 3, critical: 0, high: 3, medium: 0, low: 0 },
  ];
  check("critical counts are summed across repositories", metricValue("dependabot.critical", depRows) === 2);
  check("  as are highs", metricValue("dependabot.high", depRows) === 4);
  check("  and totals", metricValue("dependabot.total", depRows) === 8);
  check("  while the repo metric counts rows", metricValue("dependabot.repos", depRows) === 2);

  const vulnRows = [{ repo: "a", total: 2, worst: "moderate" }, { repo: "b", total: 1, worst: "critical" }];
  check("worst severity takes the highest across rows",
    metricValue("vulnRepos.worstSeverity", vulnRows) === severityRank("critical"),
    metricValue("vulnRepos.worstSeverity", vulnRows));

  // GitHub says moderate, the app says medium. An unranked value sorts to 0.
  check("  and understands GitHub's \"moderate\" as medium",
    metricValue("vulnRepos.worstSeverity", [{ worst: "moderate" }]) === severityRank("medium"),
    "a moderate-only org would read as rank 0 and never breach a medium threshold");

  check("bypasses are summed from their own field",
    metricValue("bypasses.total", [{ repo: "a", bypasses: 3 }, { repo: "b", bypasses: 4 }]) === 7);

  check("a row missing the field contributes nothing rather than NaN",
    metricValue("dependabot.critical", [{ repo: "a" }, { repo: "b", critical: 2 }]) === 2,
    "one NaN would poison the whole sum");

  // Distinguishing "found nothing" from "could not look" is the difference
  // between a recovery email and a lie.
  check("no rows at all reads as null, not as zero",
    metricValue("query.rows", null) === null && metricValue("query.rows", undefined) === null,
    "a failed fetch would resolve every alarm it touches");
  check("  but an empty array is a real zero", metricValue("query.rows", []) === 0);
}

// ── breaching ─────────────────────────────────────────────────────────
{
  const gte3: AlarmCondition = { kind: "count", metric: "dependabot.critical", op: "gte", threshold: 3 };
  check("at the threshold counts as breaching", isBreaching(gte3, 3));
  check("  above it too", isBreaching(gte3, 4));
  check("  below it does not", !isBreaching(gte3, 2));

  const lte0: AlarmCondition = { kind: "count", metric: "query.rows", op: "lte", threshold: 0 };
  check("\"at or below\" fires when a check returns nothing", isBreaching(lte0, 0));
  check("  and not when it returns something", !isBreaching(lte0, 1));

  const sev: AlarmCondition = { kind: "severity", metric: "vulnRepos.worstSeverity", atLeast: "high" };
  check("a severity condition fires at that severity", isBreaching(sev, severityRank("high")));
  check("  and above it", isBreaching(sev, severityRank("critical")));
  check("  but not below", !isBreaching(sev, severityRank("medium")));

  check("a null reading never breaches",
    !isBreaching(gte3, null) && !isBreaching(lte0, null),
    "a failed fetch would fire every alarm at once");
}

// ── firing once, and recovering carefully ─────────────────────────────
{
  let rt: AlarmRuntime = { state: "OK", cleanStreak: 0 };

  let r = step(rt, true); rt = r.runtime;
  check("the first breach fires", r.fire === "alarm" && rt.state === "ALARM", r);

  r = step(rt, true); rt = r.runtime;
  check("  a continuing breach does not fire again", r.fire === null, r.fire);
  r = step(rt, true); rt = r.runtime;
  check("  nor a third time", r.fire === null, r.fire);

  r = step(rt, false); rt = r.runtime;
  check("  one clean check is not yet a recovery", r.fire === null && rt.state === "ALARM", r);

  r = step(rt, false); rt = r.runtime;
  check(`  ${RECOVERY_CHECKS} clean checks are`, r.fire === "recovery" && rt.state === "OK", r);

  // The flap this exists to prevent: on/off/on/off must not mail every cycle.
  rt = { state: "OK", cleanStreak: 0 };
  const fires: (string | null)[] = [];
  for (const breaching of [true, false, true, false, true, false]) {
    const out = step(rt, breaching); rt = out.runtime; fires.push(out.fire);
  }
  check("a value resting on its threshold does not mail every cycle",
    fires.filter(f => f !== null).length === 1,
    fires);

  // A breach midway through recovery must reset the count, or two separated
  // clean checks would look like two consecutive ones.
  rt = { state: "ALARM", cleanStreak: 1 };
  rt = step(rt, true).runtime;
  check("  a fresh breach resets the clean streak", rt.cleanStreak === 0, rt);
}

// ── the schedule ──────────────────────────────────────────────────────
{
  check("dependabot-backed widgets are hourly",
    intervalFor({ type: "preset", presetId: "dependabot" }) === INTERVAL_MINUTES.dependabot
      && intervalFor({ type: "preset", presetId: "vuln-repos" }) === INTERVAL_MINUTES.dependabot);
  check("  everything else is on the standard interval",
    intervalFor({ type: "preset", presetId: "bypasses" }) === INTERVAL_MINUTES.standard
      && intervalFor({ type: "query" }) === INTERVAL_MINUTES.standard);

  const now = Date.now();
  check("an alarm never checked is due", isDue(undefined, 60, now));
  check("  one checked just now is not", !isDue(new Date(now - 60_000).toISOString(), 60, now));

  // The drift this tolerance exists for: EventBridge fires a little early, the
  // elapsed time reads just under an hour, the check defers to the next tick
  // and the hourly alarm becomes a 75-minute alarm.
  const almost = new Date(now - (60 * 60 * 1000 - 10_000)).toISOString();
  check("a tick arriving ten seconds early still counts as due",
    isDue(almost, 60, now),
    "an hourly alarm would silently become a 75-minute alarm");

  const wellShort = new Date(now - (60 * 60 * 1000 - DUE_TOLERANCE_MS - 60_000)).toISOString();
  check("  but a tick a full interval early does not", !isDue(wellShort, 60, now));

  check("an unreadable timestamp does not wedge the alarm off the schedule",
    isDue("not a date", 60, now),
    "the alarm would never run again");
}

// ── templates ─────────────────────────────────────────────────────────
{
  check("known variables are substituted",
    render("{{widget}} is {{value}}", { widget: "Deps", value: 7 }) === "Deps is 7");

  check("  a missing value renders empty rather than \"undefined\"",
    render("[{{value}}]", {}) === "[]", render("[{{value}}]", {}));

  // Blanking a typo makes the email look broken; leaving it makes the typo
  // obvious, and unknownVariables reports it at save time instead.
  check("  an unknown variable is left as written",
    render("{{criticals}} found", { value: 1 }) === "{{criticals}} found",
    render("{{criticals}} found", { value: 1 }));
  check("  and is reported for the author to fix",
    unknownVariables("{{criticals}} and {{widget}}").join() === "criticals",
    unknownVariables("{{criticals}} and {{widget}}"));

  check("the shipped default template uses only real variables",
    unknownVariables(DEFAULT_ALARM_SUBJECT).length === 0
      && unknownVariables(DEFAULT_ALARM_BODY).length === 0,
    [unknownVariables(DEFAULT_ALARM_SUBJECT), unknownVariables(DEFAULT_ALARM_BODY)]);
}

// ── the subject line SNS will actually accept ─────────────────────────
{
  check("newlines are flattened",
    !sanitizeSubject("first\nsecond").includes("\n"), sanitizeSubject("first\nsecond"));
  check("  tabs and carriage returns too",
    !/[\t\r]/.test(sanitizeSubject("a\tb\rc")), sanitizeSubject("a\tb\rc"));

  // Repository and team names reach this string and are not ASCII-only.
  check("  non-ASCII is removed rather than sent",
    /^[\x20-\x7E]*$/.test(sanitizeSubject("repo–naming ✅ done")),
    sanitizeSubject("repo–naming ✅ done"));

  const long = sanitizeSubject("x".repeat(500));
  check("  and the length is capped", long.length <= SUBJECT_MAX, long.length);

  check("a subject that sanitizes to nothing falls back rather than failing",
    sanitizeSubject("✅✅✅") === "Control Hub alarm",
    sanitizeSubject("✅✅✅"));

  check("  a leading stripped character does not leave an illegal first char",
    /^[A-Za-z0-9\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/.test(sanitizeSubject("✅ Alarm fired")),
    sanitizeSubject("✅ Alarm fired"));

  // The whole path, as the evaluator will call it.
  const built = buildMessage(DEFAULT_ALARM_SUBJECT, DEFAULT_ALARM_BODY, {
    state: "ALARM", widget: "Dependabot", metric: "Critical alerts",
    value: 12, threshold: 5, org: "Acme-Org", time: "2026-08-14T09:00:00Z",
  });
  check("a built message carries the numbers that matter",
    built.subject.includes("12") && built.body.includes("12") && built.body.includes("5"),
    built);
  check("  and its subject is legal",
    built.subject.length <= SUBJECT_MAX && /^[\x20-\x7E]+$/.test(built.subject),
    built.subject);
}

// ── timestamps say which clock they are on ────────────────────────────
{
  // The raw ISO form was correct and unreadable: to anyone not on UTC the
  // alarm looked like it had fired hours away, and the only thing saying
  // otherwise was a trailing Z lost among the milliseconds.
  const t = formatTimestamp("2026-08-14T13:15:50.911Z");
  check("a timestamp names its timezone", t.endsWith(" UTC"), t);
  check("  and keeps the date and the minute", t.startsWith("2026-08-14 13:15"), t);
  // No milliseconds, and no ISO "T" wedged between the date and the time.
  // Matching a bare "T" would flag the word UTC, which is the part that makes
  // the whole thing readable.
  check("  without milliseconds or an ISO separator",
    !t.includes(".") && !/\dT\d/.test(t), t);

  check("an unreadable timestamp is passed through rather than dropped",
    formatTimestamp("not a date") === "not a date", formatTimestamp("not a date"));
  check("  and an absent one renders empty", formatTimestamp(undefined) === "");

  // 13:15 UTC is 09:15 in Toronto. The hour has to move, and the label with it.
  const local = formatTimestamp("2026-08-14T13:15:50.911Z", "America/Toronto");
  check("a timezone shifts the clock and renames it",
    local.startsWith("2026-08-14 09:15") && !local.includes("UTC"), local);
  check("  and a zone crossing midnight moves the date too",
    formatTimestamp("2026-08-14T02:30:00Z", "America/Toronto").startsWith("2026-08-13 22:30"),
    formatTimestamp("2026-08-14T02:30:00Z", "America/Toronto"));

  // Intl throws on an unknown zone, and a thrown formatter takes the email.
  check("an unknown timezone falls back to UTC rather than throwing",
    formatTimestamp("2026-08-14T13:15:50.911Z", "Mars/Olympus").endsWith(" UTC"),
    formatTimestamp("2026-08-14T13:15:50.911Z", "Mars/Olympus"));

  // Both senders must use it; one raw path is one confusing email.
  for (const f of ["src/alarms/evaluate.ts", "src/alarms/securityNotify.ts"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    check(`  ${f.split("/").pop()} formats the time it sends`,
      /time:\s*formatTimestamp\(/.test(src),
      "this sender still puts a raw ISO string in the email");
  }
}

// ── the variable catalogue is honest ──────────────────────────────────
{
  // The UI lists these as available; a name listed but not substituted would
  // be advertised and then rendered literally into someone's email.
  const unsubstituted = TEMPLATE_VARIABLES
    .map(v => v.name)
    .filter(n => render(`{{${n}}}`, { [n]: "x" }) !== "x");
  check("every advertised variable actually substitutes", unsubstituted.length === 0, unsubstituted);
}

// ── the severity filter, as old widgets stored it ─────────────────────
{
  check("no filter means every severity", parseSeverities(undefined).length === 4);

  // A bare name is an old widget meaning "and above"; prefixed means the set.
  check("a legacy \"high\" still means high and above",
    parseSeverities("high").sort().join() === ["critical", "high"].sort().join(),
    parseSeverities("high"));
  check("  while \"sev:high\" means high alone",
    parseSeverities("sev:high").join() === "high", parseSeverities("sev:high"));
  check("  and a set round-trips",
    parseSeverities("sev:critical,low").sort().join() === ["critical", "low"].sort().join(),
    parseSeverities("sev:critical,low"));
  check("an unrecognized filter counts everything rather than nothing",
    parseSeverities("sev:banana").length === 4,
    "an empty selection reads on the card as a clean check");
}

// ── aggregations must match what the page shows ───────────────────────
{
  const alerts: any[] = [
    { repo: "api", severity: "critical" }, { repo: "api", severity: "moderate" },
    { repo: "web", severity: "high" }, { repo: "web", severity: "low" },
    { repo: "old", severity: "high", clean: true },
    { repo: "off", severity: "high", disabled: true },
  ];

  const dep = aggregateDependabot(alerts);
  check("clean and disabled markers are not counted as alerts",
    dep.every(r => r.repo !== "old" && r.repo !== "off"), dep.map(r => r.repo));
  check("  GitHub's \"moderate\" lands in medium, not low",
    dep.find(r => r.repo === "api")?.medium === 1
      && dep.find(r => r.repo === "api")?.low === 0,
    dep.find(r => r.repo === "api"));
  check("  and the worst repository sorts first", dep[0].repo === "api", dep.map(r => r.repo));

  const vuln = aggregateVulnRepos(alerts, "sev:critical,high");
  check("a severity filter selects the right repositories",
    vuln.map(r => r.repo).sort().join() === "api,web", vuln.map(r => r.repo));
  check("  and reports each one's worst",
    vuln.find(r => r.repo === "api")?.worst === "critical", vuln);

  // "medium" must also admit GitHub's spelling, or a medium filter silently
  // matches nothing on an org whose alerts are all moderate.
  const medium = aggregateVulnRepos(alerts, "sev:medium");
  check("  a medium filter matches GitHub's \"moderate\"",
    medium.length === 1 && medium[0].repo === "api", medium);
}

(async () => {
  // ── reading a widget's rows ─────────────────────────────────────────
  {
    const sources = {
      dependencyAlerts: async () => ({ alerts: [{ repo: "a", severity: "high" }] as any, degraded: false }),
      runQuery: async () => [{ repo: "x" }, { repo: "y" }],
    };

    const q = await computeWidgetRows({ id: "1", type: "query", queryId: "public-repos" }, sources);
    check("a query widget returns its rows", q.rows?.length === 2, q);

    const b = await computeWidgetRows({ id: "2", type: "preset", presetId: "bypasses" }, sources);
    check("  a bypasses widget runs its ranking query", b.rows?.length === 2, b);

    const unknown = await computeWidgetRows({ id: "3", type: "preset", presetId: "nope" }, sources);
    check("  an unknown preset reads as no value, not as zero", unknown.rows === null, unknown);

    // The distinction the whole design rests on.
    const degraded = await computeWidgetRows({ id: "4", type: "preset", presetId: "dependabot" }, {
      ...sources, dependencyAlerts: async () => ({ alerts: [], degraded: true }),
    });
    check("a degraded Dependabot sweep is no reading, not an empty one",
      degraded.rows === null,
      "an alarm would resolve itself because GitHub answered 403");

    const threw = await computeWidgetRows({ id: "5", type: "query", queryId: "boom" }, {
      ...sources, runQuery: async () => { throw new Error("upstream exploded"); },
    });
    check("  and a thrown query is caught rather than killing the pass",
      threw.rows === null && /exploded/.test(threw.error ?? ""), threw);
  }

  // ── the evaluator ───────────────────────────────────────────────────
  const widget = { id: "w1", title: "Dependabot", type: "preset", presetId: "dependabot" };
  const baseAlarm = {
    id: "a1", widgetId: "w1", name: "Too many criticals",
    condition: { kind: "count", metric: "dependabot.critical", op: "gte", threshold: 2 },
    groupId: "g1", subjectTemplate: DEFAULT_ALARM_SUBJECT, bodyTemplate: DEFAULT_ALARM_BODY,
    notifyOnRecovery: true, enabled: true, state: "OK" as const, cleanStreak: 0,
  };

  function harness(overrides: any = {}) {
    const sent: { subject: string; body: string }[] = [];
    const saved: any[] = [];
    const deps: any = {
      now: Date.now(),
      org: "Acme-Org",
      listAlarms: async () => [{ ...baseAlarm }],
      getWidget: async (id: string) => (id === "w1" ? widget : undefined),
      topicArnFor: async () => "arn:aws:sns:us-east-1:1:topic",
      computeRows: async () => ({ rows: [{ repo: "api", critical: 3, high: 0, total: 3 }] }),
      publish: async (_a: string, subject: string, body: string) => { sent.push({ subject, body }); return true; },
      saveRuntime: async (id: string, rt: any) => { saved.push({ id, ...rt }); },
      ...overrides,
    };
    return { deps, sent, saved };
  }

  {
    const { deps, sent, saved } = harness();
    const s = await evaluateAlarms(deps);
    check("a breaching alarm fires and emails", s.fired === 1 && sent.length === 1, { s, sent });
    check("  the email names the value and the limit",
      sent[0].body.includes("3") && sent[0].body.includes("2"), sent[0].body);
    check("  and the state is persisted as ALARM", saved[0].state === "ALARM", saved[0]);
  }

  {
    const { deps, sent } = harness({ listAlarms: async () => [{ ...baseAlarm, enabled: false }] });
    const s = await evaluateAlarms(deps);
    check("a disabled alarm is not evaluated at all",
      s.considered === 0 && sent.length === 0, s);
  }

  {
    // Checked a minute ago; the hourly Dependabot interval is not up.
    const { deps, sent } = harness({
      listAlarms: async () => [{ ...baseAlarm, lastCheckedAt: new Date(Date.now() - 60_000).toISOString() }],
    });
    const s = await evaluateAlarms(deps);
    check("an alarm that is not due is skipped without reading anything",
      s.skippedNotDue === 1 && s.evaluated === 0 && sent.length === 0, s);
  }

  {
    const { deps, sent, saved } = harness({
      listAlarms: async () => [{ ...baseAlarm, state: "ALARM", cleanStreak: 1 }],
      computeRows: async () => ({ rows: null, error: "GitHub said 403" }),
    });
    const s = await evaluateAlarms(deps);
    check("a failed read does not count as a clean check",
      saved[0].cleanStreak === 1 && saved[0].state === "ALARM" && sent.length === 0,
      saved[0]);
    check("  and is recorded so the UI can say the value is stale",
      s.unreadable === 1 && /403/.test(saved[0].lastError), saved[0]);
  }

  {
    // One clean check is not a recovery; the second one is.
    const { deps, sent, saved } = harness({
      listAlarms: async () => [{ ...baseAlarm, state: "ALARM", cleanStreak: 0 }],
      computeRows: async () => ({ rows: [{ repo: "api", critical: 0, total: 0 }] }),
    });
    await evaluateAlarms(deps);
    check("one clean check does not send an all-clear",
      sent.length === 0 && saved[0].state === "ALARM", saved[0]);

    const second = harness({
      listAlarms: async () => [{ ...baseAlarm, state: "ALARM", cleanStreak: 1 }],
      computeRows: async () => ({ rows: [{ repo: "api", critical: 0, total: 0 }] }),
    });
    const s2 = await evaluateAlarms(second.deps);
    check("  the second one does", s2.recovered === 1 && second.sent.length === 1, s2);
    check("    and it says OK rather than ALARM",
      second.sent[0].subject.includes("OK"), second.sent[0].subject);
  }

  {
    const { deps, sent } = harness({
      listAlarms: async () => [{ ...baseAlarm, state: "ALARM", cleanStreak: 1, notifyOnRecovery: false }],
      computeRows: async () => ({ rows: [{ repo: "api", critical: 0, total: 0 }] }),
    });
    const s = await evaluateAlarms(deps);
    check("an alarm can recover silently if that is what was asked",
      s.recovered === 1 && sent.length === 0, s);
  }

  {
    const { deps, sent, saved } = harness({ getWidget: async () => undefined });
    const s = await evaluateAlarms(deps);
    check("an alarm whose widget was deleted does not fire",
      sent.length === 0 && s.unreadable === 1, s);
    check("  and says so rather than failing silently",
      /no longer exists/.test(saved[0].lastError), saved[0]);
  }

  {
    const { deps, saved } = harness({ topicArnFor: async () => undefined });
    const s = await evaluateAlarms(deps);
    check("a missing email group is counted as a failure, not a send",
      s.publishFailures === 1, s);
    check("  and the alarm still records that it fired, so it will not fire again",
      saved[0].state === "ALARM" && saved[0].lastFiredAt === undefined, saved[0]);
  }

  {
    const { deps, sent } = harness({
      publish: async () => false,
    });
    const s = await evaluateAlarms(deps);
    check("a refused publish is reported rather than thrown",
      s.publishFailures === 1 && s.fired === 1, s);
  }

  // ── route order, which Express decides by registration ──────────────
  {
    // `router.put("/:id")` registered before `router.put("/security")` makes
    // the security toggle unreachable: the update arrives at the alarm handler
    // as id "security" and 404s, which reads as the toggle being broken rather
    // than as a routing mistake.
    const src = fs.readFileSync(path.join(__dirname, "src/routes/alarms.ts"), "utf8");
    const at = (pattern: string) => src.indexOf(pattern);

    const literals = ['router.put("/security"', 'router.get("/security"',
                      'router.get("/groups"', 'router.post("/groups"'];
    const params = ['router.put("/:id"', 'router.delete("/:id"'];

    const firstParam = Math.min(...params.map(at).filter(i => i >= 0));
    const shadowed = literals.filter(l => at(l) >= 0 && at(l) > firstParam);
    check("no literal route is registered after a parameterised one",
      firstParam > 0 && shadowed.length === 0, shadowed);

    // Reads are gated too, because a group's members are people's addresses.
    check("every alarm route is behind the admin gate",
      /router\.use\(requireAdmin\)/.test(src),
      "notification settings would be world-readable to any signed-in user");

    check("  and the gate is applied before any route is declared",
      at("router.use(requireAdmin)") < at('router.get("/variables"'),
      "routes declared above the gate are ungated");
  }

  // ── a new table has to be registered in three places ────────────────
  {
    // The alarms table was created, named in the CDK for the Lambdas, and
    // missed in the desktop app's own list — so every Lambda could reach it
    // and the app itself answered "Missing required DynamoDB table env var".
    // Three lists that must agree, and nothing compared them.
    const root = path.join(__dirname, "../..");
    const rd = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

    const srcDir = path.join(__dirname, "src");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name))
          : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);

    // Every table the backend actually asks for by name.
    const required = new Set<string>();
    for (const f of walk(srcDir)) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/tableName\(\s*["'](\w+_TABLE)["']/g)) {
        required.add(m[1]);
      }
    }

    /**
     * Tables the desktop app deliberately does not resolve, with the reason.
     * Listed rather than filtered out silently, so adding one is a decision
     * somebody writes down.
     */
    const LAMBDA_ONLY: Record<string, string> = {
      WEBHOOK_DELIVERIES_TABLE:
        "deduplication state read only by the webhook Lambdas; created by CDK, " +
        "not by the setup script, so cdk destroy can take it without touching user data",
    };

    const bootstrap = rd("github-control-hub/desktop/src/bootstrap.ts");
    const setup = rd("scripts/setup-aws-account.sh");

    const missingFromApp = [...required]
      .filter(t => !(t in LAMBDA_ONLY))
      .filter(t => !new RegExp(`\\b${t}\\s*:`).test(bootstrap));
    check("every table the code reads is resolved by the desktop app",
      required.size > 0 && missingFromApp.length === 0,
      missingFromApp.length ? missingFromApp : "no tableName() calls found — wrong directory");

    // And the table has to exist for the name to be worth anything.
    const suffixes = [...required]
      .filter(t => !(t in LAMBDA_ONLY))
      .map(t => t.replace(/_TABLE$/, "").toLowerCase().replace(/_/g, "-"));
    const missingFromSetup = suffixes.filter(s => !new RegExp(`\\b${s}\\b`).test(setup));
    check("  and created by the setup script",
      missingFromSetup.length === 0, missingFromSetup);
  }

  // ── the UI's label mirror must cover the real catalogue ─────────────
  {
    // The alarm list names a condition without asking the server, so the
    // labels are duplicated in the frontend. Only the words — never the rules
    // about which widget may use which metric — and this is what stops a new
    // metric shipping with its raw identifier showing in the UI.
    const mirror = fs.readFileSync(
      path.join(__dirname, "../frontend/src/lib/alarmSpecs.ts"), "utf8");

    const everyMetric = new Set<string>();
    for (const w of [
      { type: "preset", presetId: "dependabot" },
      { type: "preset", presetId: "vuln-repos" },
      { type: "preset", presetId: "bypasses" },
      { type: "query" },
    ]) {
      for (const spec of conditionsFor(w)) everyMetric.add(spec.metric);
    }

    const missing = [...everyMetric].filter(m => !mirror.includes(`"${m}"`));
    check("the frontend knows a label for every metric the backend offers",
      everyMetric.size > 0 && missing.length === 0,
      missing.length ? missing : "no metrics found — the catalogue is empty");
  }

  // ── the tick has to divide every interval ──────────────────────────
  {
    // An alarm is only evaluated when the rule fires, so an interval the tick
    // does not divide silently rounds up to the next tick: ten minutes under a
    // fifteen-minute rule is a fifteen-minute alarm, displayed as ten in the
    // app and in the email. Nothing fails, and the reading is simply late.
    for (const [name, minutes] of Object.entries(INTERVAL_MINUTES)) {
      check(`the ${name} interval is a whole number of ticks`,
        minutes % TICK_MINUTES === 0,
        `${minutes}m interval under a ${TICK_MINUTES}m tick rounds up to ${
          Math.ceil(minutes / TICK_MINUTES) * TICK_MINUTES}m`);
    }

    // The tolerance pulls a check slightly early so jitter cannot defer it a
    // whole tick. It must stay under one tick, or a check becomes due before
    // its interval has elapsed and the interval means nothing.
    check("  and the tolerance is shorter than one tick",
      DUE_TOLERANCE_MS < TICK_MINUTES * 60_000,
      `${DUE_TOLERANCE_MS / 60_000}m tolerance against a ${TICK_MINUTES}m tick`);

    // CDK owns the rule and cannot import this constant — infra/ compiles with
    // rootDir "." and does not include backend/. So the two are asserted equal
    // here rather than shared, which is the only thing keeping them together.
    const stack = fs.readFileSync(
      path.join(__dirname, "..", "infra", "cdk-stack.ts"), "utf8");
    const alarmRule = stack.slice(stack.indexOf('new events.Rule(this, "AlarmSchedule"'));
    const rate = /Schedule\.rate\(cdk\.Duration\.minutes\((\d+)\)\)/.exec(alarmRule)?.[1];
    check("  and the deployed rule fires at exactly that rate",
      rate !== undefined && Number(rate) === TICK_MINUTES,
      rate === undefined ? "no rate found on AlarmSchedule" : `rule fires every ${rate}m, code assumes ${TICK_MINUTES}m`);
  }

  // ── one sweep per run, however many alarms read it ──────────────────
  {
    // Several Dependabot alarms are the normal case — one for criticals, one
    // for highs, one per team. Each doing its own org-wide sweep would multiply
    // the request cost by the number of alarms for identical data, and nothing
    // else would notice: every alarm still reports the right number.
    //
    // The handler memoises on the *promise* rather than the result, so reads
    // that overlap share one call instead of racing. Both orderings are checked
    // because only the concurrent one catches a memo that caches too late.
    const makeSources = () => {
      let fetches = 0;
      let pending: any = null;
      const dependencyAlerts = () => {
        if (!pending) {
          pending = (async () => {
            fetches++;
            return { alerts: [{ severity: "critical" }, { severity: "high" }], degraded: false };
          })();
        }
        return pending;
      };
      return {
        count: () => fetches,
        sources: { dependencyAlerts, renovateOpenPrs: async () => [], runQuery: async () => [] },
      };
    };

    // Both Dependabot-backed presets, since they share the one sweep.
    const widgets = [
      ...Array(6).fill({ type: "preset", presetId: "dependabot" }),
      ...Array(4).fill({ type: "preset", presetId: "vuln-repos" }),
    ];

    const seq = makeSources();
    const seqRows = [];
    for (const w of widgets) seqRows.push(await computeWidgetRows(w as any, seq.sources as any));
    check(`${widgets.length} alarms sequentially cost one sweep`,
      seq.count() === 1, `${seq.count()} sweeps`);
    check("  and every one of them still got rows",
      seqRows.every(r => r.rows != null), seqRows.filter(r => r.rows == null).length + " empty");

    const par = makeSources();
    const parRows = await Promise.all(
      widgets.map(w => computeWidgetRows(w as any, par.sources as any)));
    check("  concurrently too, which is how the evaluator reads them",
      par.count() === 1, `${par.count()} sweeps`);
    check("  and those got rows as well",
      parRows.every(r => r.rows != null), parRows.filter(r => r.rows == null).length + " empty");

    // Sharing only holds while every preset goes through the injected source.
    // A preset that imported the service and called it directly would still
    // return the right rows — and would add one org-wide sweep per alarm, which
    // the counts above cannot see because they only observe the injected one.
    const wv = fs.readFileSync(
      path.join(__dirname, "src", "alarms", "widgetValues.ts"), "utf8");
    const valueImports = [...wv.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map(m => m[1]);
    check("  and widget values reach GitHub only through the injected sources",
      !valueImports.some(i => /services\/|github\//.test(i)),
      valueImports.filter(i => /services\/|github\//.test(i)));

    // The memo must not outlive the run: a module-level cache would serve the
    // previous invocation's alerts, so an alarm would report a number that had
    // already changed and a resolved vulnerability would keep firing.
    const handler = fs.readFileSync(
      path.join(__dirname, "src", "alarms", "handler.ts"), "utf8");
    const body = handler.slice(handler.indexOf("export async function handler"));
    check("  and the memo is declared inside the handler, not at module scope",
      /^\s+let dependencyPromise/m.test(body)
        && !/^let dependencyPromise/m.test(handler.slice(0, handler.indexOf("export async function handler"))),
      "a module-scope memo would serve one run's alerts to the next");
  }

  // ── the activity row says what changed ─────────────────────────────
  {
    // Exercised rather than grepped. The first version of this checked the
    // source for `describeChanges(` and for the phrase it produces, and passed
    // with the call rewired to `false ?` — the patterns were all still present,
    // just no longer reachable. Two mutations proved it before this was rewritten.
    delete process.env.ACTIVITY_TABLE;
    delete process.env.ALARMS_TABLE;
    const { saveSecuritySettings, saveFeedSettings, __resetAlarmStoreForTests } =
      await import("./src/services/alarmService");
    const { getActivity } = await import("./src/services/activityService");

    __resetAlarmStoreForTests();
    const since = () => getActivity(20);
    const latest = async () => (await since())[0]?.details ?? "";

    await saveSecuritySettings({ enabled: false, groupId: "g1", minSeverity: "high" }, "tester");

    // The case that started this: change only the body, nothing else.
    await saveSecuritySettings({ bodyTemplate: "a totally new body {{repo}}" }, "tester");
    const bodyRow = await latest();
    check("editing only the body logs that the body was edited",
      /body template edited/i.test(bodyRow), bodyRow);
    check("  and does not claim the toggle changed",
      !/emails on\b|emails off\b/i.test(bodyRow), bodyRow);

    await saveSecuritySettings({ subjectTemplate: "new subject {{repo}}" }, "tester");
    check("editing only the subject logs the subject",
      /subject template edited/i.test(await latest()), await latest());

    await saveSecuritySettings({ minSeverity: "low" }, "tester");
    const sevRow = await latest();
    check("moving the severity floor names the new value",
      /severity floor/i.test(sevRow) && /low/.test(sevRow), sevRow);
    check("  and does not mention templates that did not change",
      !/template edited/i.test(sevRow), sevRow);

    // Saving the identical settings again must not claim a change.
    await saveSecuritySettings({ minSeverity: "low" }, "tester");
    check("re-saving unchanged settings says so",
      /no change/i.test(await latest()), await latest());

    // The same for both feeds, since they share the implementation.
    await saveFeedSettings("dependabot-alert", { enabled: false, groupId: "g1" }, "tester");
    await saveFeedSettings("dependabot-alert", { bodyTemplate: "new {{package}}" }, "tester");
    check("the Dependabot feed logs a template edit too",
      /body template edited/i.test(await latest()), await latest());

    await saveFeedSettings("renovate-pr", { enabled: false, groupId: "g1" }, "tester");
    await saveFeedSettings("renovate-pr", { subjectTemplate: "new {{title}}" }, "tester");
    check("  and so does the Renovate feed",
      /subject template edited/i.test(await latest()), await latest());

    // The body itself must not end up in the feed: it is several lines, and a
    // one-line entry is not where a template belongs.
    const rows = await since();
    check("  but the template text itself is never quoted into the row",
      !rows.some(r => (r.details || "").includes("a totally new body")),
      rows.map(r => r.details).slice(0, 4));
  }

  // ── a request body cannot reach past the alarm it edits ───────────────
  //
  // Alarms, email groups, the security toggle, the feed settings and the pull
  // request state share one table keyed on `id`. PUT /api/alarms/:id handed
  // req.body straight to updateAlarm, which copied every key it found — so a
  // body carrying its own `id` wrote the edited alarm over whatever else held
  // that id. `{"id": "security-settings"}` replaces the organization's
  // security-alert configuration; an email group's id replaces the group and
  // with it the topicArn every alarm publishes to.
  {
    const { pickAlarmEdits } = require("./src/services/alarmService");

    const hostile = pickAlarmEdits({
      name: "renamed",
      id: "security-settings",
      kind: "group",
      topicArn: "arn:aws:sns:eu-west-1:000000000000:somebody-elses-topic",
      state: "ALARM",
      createdBy: "mallory",
      widgetId: "another-widget",
    });

    check("an edit keeps only the fields a person may change",
      Object.keys(hostile).join(",") === "name", Object.keys(hostile));

    for (const forbidden of ["id", "kind", "topicArn", "state", "createdBy", "widgetId"]) {
      check(`  and "${forbidden}" cannot ride in on the body`,
        !(forbidden in hostile), forbidden);
    }

    const legitimate = pickAlarmEdits({
      name: "n", condition: { kind: "count", metric: "total", op: ">=", threshold: 1 },
      groupId: "g", subjectTemplate: "s", bodyTemplate: "b",
      notifyOnRecovery: false, enabled: false,
    });
    check("  while every field the form sends still gets through",
      Object.keys(legitimate).sort().join(",")
        === "bodyTemplate,condition,enabled,groupId,name,notifyOnRecovery,subjectTemplate",
      Object.keys(legitimate).sort());

    // `enabled: false` and `notifyOnRecovery: false` must survive. Filtering on
    // truthiness rather than on `undefined` is the obvious way to write this and
    // would make an alarm impossible to switch off.
    check("  including the ones whose value is false",
      legitimate.enabled === false && legitimate.notifyOnRecovery === false, legitimate);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
