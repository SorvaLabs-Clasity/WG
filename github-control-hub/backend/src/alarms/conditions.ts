/**
 * What an alarm can watch, and when it fires.
 *
 * Everything here is a pure function of values passed in. Nothing reads a
 * table, calls GitHub or publishes to SNS, that belongs to the evaluator, and
 * keeping it out of here is what makes the firing rules testable without any
 * of it.
 *
 * The catalogue below is deliberately per-widget rather than one generic
 * "value >= n". A Dependabot widget's useful question is "how many criticals",
 * a bypass widget's is "how many bypasses", and a threshold offered against
 * the wrong widget is a threshold nobody can set correctly.
 */

export type Severity = "critical" | "high" | "medium" | "low";

/**
 * GitHub says "moderate" where the rest of the app says "medium". Both appear
 * in live payloads, so both rank here, an unranked severity would sort below
 * "low" and quietly never satisfy a threshold.
 */
const SEVERITY_RANK: Record<string, number> = {
  critical: 4, high: 3, medium: 2, moderate: 2, low: 1,
};

export function severityRank(s: string | undefined): number {
  return SEVERITY_RANK[String(s ?? "").toLowerCase()] ?? 0;
}

/** Metrics that resolve to a count. */
export type CountMetric =
  | "dependabot.critical"
  | "dependabot.high"
  | "dependabot.total"
  | "dependabot.repos"
  | "vulnRepos.repos"
  | "vulnRepos.total"
  | "bypasses.total"
  | "bypasses.repos"
  | "query.rows"
  | "renovatePrs.open"
  | "guardrail.violations"
  | "guardrail.excluded";

export type AlarmCondition =
  | { kind: "count"; metric: CountMetric; op: "gte" | "lte"; threshold: number }
  | { kind: "severity"; metric: "vulnRepos.worstSeverity"; atLeast: Severity }
  /**
   * Tell me about each new thing, rather than when a number crosses a line.
   *
   * A threshold answers "is this bad enough yet", which is the wrong question
   * for most people most of the time: they want to hear about the finding, once,
   * when it appears. A count alarm cannot do that — it fires on the way from
   * clean to not-clean and then stays quiet however many more arrive, because
   * the state is already ALARM.
   *
   * So this one remembers which rows it has already reported and fires on the
   * ones it has not. `metric` is carried only so the message can still say how
   * many there are in total.
   */
  | { kind: "each"; metric: CountMetric };

export interface MetricSpec {
  metric: CountMetric | "vulnRepos.worstSeverity";
  kind: "count" | "severity" | "each";
  label: string;
  /** Shown after the number in the UI, e.g. "3 alerts". */
  unit?: string;
  hint?: string;
}

/**
 * Which conditions a given widget may use.
 *
 * Also the validator. The UI builds its form from this, and the API checks
 * against it before saving, a client is free to post any metric it likes, and
 * an alarm on a metric its widget cannot produce would evaluate to null
 * forever and never fire, which looks identical to "nothing is wrong".
 */
/**
 * The subject id a guardrail alarm carries in place of a widget's.
 *
 * `guardrail:*` watches every rule; `guardrail:<id>` watches one. Encoded in
 * the id rather than added as a second field so the evaluator, which resolves a
 * subject and then knows nothing about what kind it is, needs no changes at all.
 */
export const GUARDRAIL_PREFIX = "guardrail:";

export const guardrailSubjectId = (ruleId?: string) => `${GUARDRAIL_PREFIX}${ruleId || "*"}`;

/** The rule a guardrail subject watches, or null for every rule. */
export function guardrailRuleOf(subjectId: string): string | null {
  if (!subjectId.startsWith(GUARDRAIL_PREFIX)) return null;
  const rest = subjectId.slice(GUARDRAIL_PREFIX.length);
  return rest === "*" ? null : rest;
}

export function conditionsFor(widget: { type: string; presetId?: string }): MetricSpec[] {
  // Findings, not widget rows. A guardrail alarm answers "is the account
  // drifting", which the dashboard has no widget for, the findings table is
  // its own thing and was reachable only by looking at it.
  if (widget.type === "guardrail") {
    return [
      { metric: "guardrail.violations", kind: "each", label: "Every new failing resource",
        hint: "Told once about each resource as it starts breaking the rule, with no number to choose." },
      { metric: "guardrail.violations", kind: "count", label: "Failing resources", unit: "resources",
        hint: "Every resource currently breaking the rule, across accounts and regions." },
      { metric: "guardrail.excluded", kind: "count", label: "Resources being skipped", unit: "resources",
        hint: "Deliberately excluded. Worth an alarm when an exclusion list quietly grows." },
    ];
  }
  if (widget.type === "query") {
    return [
      { metric: "query.rows", kind: "each", label: "Every new matching row",
        hint: "Told once about each row as it appears, with no number to choose." },
      { metric: "query.rows", kind: "count", label: "Matching rows", unit: "rows",
        hint: "Use \"at or below 0\" to be told when a check stops returning anything." },
    ];
  }
  switch (widget.presetId) {
    case "dependabot":
      return [
        { metric: "dependabot.critical", kind: "count", label: "Critical alerts", unit: "critical" },
        { metric: "dependabot.high", kind: "count", label: "High alerts", unit: "high" },
        { metric: "dependabot.total", kind: "count", label: "Alerts in total", unit: "alerts" },
        { metric: "dependabot.repos", kind: "count", label: "Repositories with any alert", unit: "repos" },
      ];
    case "vuln-repos":
      return [
        { metric: "vulnRepos.repos", kind: "count", label: "Matching repositories", unit: "repos" },
        { metric: "vulnRepos.total", kind: "count", label: "Alerts in total", unit: "alerts" },
        { metric: "vulnRepos.worstSeverity", kind: "severity", label: "Worst severity present" },
      ];
    case "renovate-open":
      return [
        { metric: "renovatePrs.open", kind: "count", label: "Open Renovate PRs", unit: "PRs",
          hint: "Counts pull requests the Renovate bot has open and nobody has merged." },
      ];
    case "bypasses":
      return [
        { metric: "bypasses.total", kind: "count", label: "Bypasses in total", unit: "bypasses" },
        { metric: "bypasses.repos", kind: "count", label: "Repositories with a bypass", unit: "repos" },
      ];
    default:
      return [];
  }
}

/** True when this widget may carry this condition. */
export function isValidCondition(
  widget: { type: string; presetId?: string },
  condition: AlarmCondition,
): boolean {
  const allowed = conditionsFor(widget);
  /**
   * Matched on the metric *and* the reading, because one metric is now offered
   * twice.
   *
   * `guardrail.violations` is both "every new failing resource" and "failing
   * resources is at or above N". Finding it by name alone returns whichever was
   * declared first, so switching an alarm to the other one was refused with a
   * message listing the very option that had been chosen.
   */
  const spec = allowed.find(s => s.metric === condition.metric && s.kind === condition.kind);
  if (!spec) return false;
  if (condition.kind === "count") {
    // A non-finite threshold compares false against everything, so an alarm
    // holding one is an alarm that never fires.
    return Number.isFinite(condition.threshold);
  }
  // Nothing to validate: there is no number, which is the point of it.
  if (condition.kind === "each") return true;
  return severityRank(condition.atLeast) > 0;
}

// ── turning rows into a number ────────────────────────────────────────

function sum(rows: any[], field: string): number {
  let n = 0;
  for (const r of rows) {
    const v = Number(r?.[field]);
    if (Number.isFinite(v)) n += v;
  }
  return n;
}

/**
 * The current value of a metric, given the widget's rows.
 *
 * Returns null when the metric cannot be read from these rows, which the
 * evaluator treats as "no reading" rather than as zero. Zero means the check
 * ran and found nothing; null means it did not run, and firing a recovery
 * email off a failed fetch would say "resolved" about something nobody looked
 * at.
 */
export function metricValue(metric: MetricSpec["metric"], rows: any[] | null | undefined): number | null {
  if (!Array.isArray(rows)) return null;
  switch (metric) {
    case "dependabot.critical": return sum(rows, "critical");
    case "dependabot.high": return sum(rows, "high");
    case "dependabot.total": return sum(rows, "total");
    case "dependabot.repos": return rows.length;
    case "vulnRepos.repos": return rows.length;
    case "vulnRepos.total": return sum(rows, "total");
    case "vulnRepos.worstSeverity":
      return rows.reduce((worst, r) => Math.max(worst, severityRank(r?.worst)), 0);
    case "bypasses.total": return sum(rows, "bypasses");
    case "bypasses.repos": return rows.length;
    case "query.rows": return rows.length;
    // Findings carry their own verdict, so the count is of the ones that are
    // actually failing rather than of every row the sweep wrote.
    case "guardrail.violations":
      return rows.filter(r => r?.verdict === "violation" && !r?.excluded).length;
    case "guardrail.excluded":
      return rows.filter(r => r?.excluded).length;
    case "renovatePrs.open": return rows.length;
    default: return null;
  }
}

/**
 * The rows a metric actually counts.
 *
 * `metricValue` filters before it counts — a guardrail's violation count skips
 * the passing and the deliberately excluded — so an "each" alarm reading the
 * raw rows reports things the number it sits beside never included. The first
 * version did exactly that and announced an excluded bucket as newly failing.
 *
 * Kept beside `metricValue` so the two cannot drift: whatever one counts, the
 * other names.
 */
export function rowsForMetric(metric: string, rows: any[]): any[] {
  switch (metric) {
    case "guardrail.violations":
      return rows.filter(r => r?.verdict === "violation" && !r?.excluded);
    case "guardrail.excluded":
      return rows.filter(r => r?.excluded);
    default:
      return rows;
  }
}

/** Whether a reading breaches the condition. A null reading never breaches. */
export function isBreaching(condition: AlarmCondition, value: number | null): boolean {
  if (value === null) return false;
  if (condition.kind === "severity") return value >= severityRank(condition.atLeast);
  // "Anything at all" is what breaching means when there is no threshold. Which
  // of those rows is *new* is decided separately, against what this alarm has
  // already reported; this only decides whether it is currently clean.
  if (condition.kind === "each") return value > 0;
  return condition.op === "gte" ? value >= condition.threshold : value <= condition.threshold;
}

/**
 * A stable identity for one row, so "have I already said this" has an answer.
 *
 * Built from fields that name the thing rather than describe it: a repository
 * and the finding on it, never the wording of the reason, which is regenerated
 * on every pass and would make every row look new every time.
 */
export function rowKey(row: any): string {
  const subject = row?.repo ?? row?.user ?? row?.team ?? row?.resourceId ?? "";
  const detail = row?.dependency ?? row?.ruleId ?? row?.number ?? row?.branch ?? "";
  return `${subject}\u0000${detail}`;
}

/** How many keys an alarm remembers. Bounded so one row cannot grow forever. */
export const MAX_SEEN_KEYS = 500;

/**
 * The rows this alarm has not reported yet, and the set to remember next.
 *
 * Keys that have gone are dropped rather than kept: a finding that is fixed and
 * then comes back is worth being told about a second time, and remembering it
 * for ever would silently swallow the recurrence.
 */
export function newRows(rows: any[], seen: string[] | undefined): {
  /** Rows this alarm has not reported yet. */
  fresh: any[];
  /** Keys it reported that are no longer present, so each can be cleared. */
  gone: string[];
  /**
   * What to remember after speaking about `fresh`.
   *
   * The arrivals are added and the departures are **kept**. Dropping them in
   * the same write would mean a row that appeared and another that cleared in
   * one pass cost the second its all-clear: the arrival wins the pass, the
   * departure is forgotten, and nobody is ever told it recovered. Held, it is
   * announced on the next pass instead.
   */
  seenAfterAlarm: string[];
  /** What to remember after clearing `gone`: the departures dropped, nothing else. */
  seenAfterRecovery: string[];
} {
  const previous = seen ?? [];
  const previousSet = new Set(previous);
  const current: string[] = [];
  const currentSet = new Set<string>();
  const fresh: any[] = [];

  for (const row of rows) {
    const key = rowKey(row);
    if (currentSet.has(key)) continue;
    currentSet.add(key);
    current.push(key);
    if (!previousSet.has(key)) fresh.push(row);
  }

  const gone = previous.filter(k => !currentSet.has(k));

  // Capped at the end rather than while building, so the cap trims the oldest
  // memory rather than silently dropping whichever rows arrived last.
  const seenAfterAlarm = [...new Set([...previous, ...current])].slice(-MAX_SEEN_KEYS);
  const seenAfterRecovery = previous.filter(k => currentSet.has(k)).slice(-MAX_SEEN_KEYS);

  return { fresh, gone, seenAfterAlarm, seenAfterRecovery };
}

// ── firing, and not firing repeatedly ─────────────────────────────────

export type AlarmState = "OK" | "ALARM";

export interface AlarmRuntime {
  state: AlarmState;
  /** Consecutive non-breaching checks since the last breach. */
  cleanStreak: number;
}

/**
 * Clean checks required before an alarm is declared recovered.
 *
 * Asymmetric on purpose. Firing waits for nothing, because the first breach is
 * the whole point. Recovery waits for two, because a value resting exactly on
 * its threshold otherwise flips OK-ALARM-OK-ALARM and sends an email every
 * cycle, which trains people to filter the alarm that mattered.
 */
export const RECOVERY_CHECKS = 2;

export type Firing = "alarm" | "recovery" | null;

export function step(runtime: AlarmRuntime, breaching: boolean): { runtime: AlarmRuntime; fire: Firing } {
  if (breaching) {
    const fire: Firing = runtime.state === "OK" ? "alarm" : null;
    return { runtime: { state: "ALARM", cleanStreak: 0 }, fire };
  }
  const cleanStreak = runtime.cleanStreak + 1;
  if (runtime.state === "ALARM" && cleanStreak >= RECOVERY_CHECKS) {
    return { runtime: { state: "OK", cleanStreak }, fire: "recovery" };
  }
  return { runtime: { state: runtime.state, cleanStreak }, fire: null };
}

// ── how often each widget is worth re-reading ─────────────────────────

/**
 * How often the EventBridge rule invokes the evaluator.
 *
 * Every interval below has to be a multiple of this, because an alarm can only
 * be evaluated on a tick: setting one to ten minutes while the rule fires every
 * fifteen produces a fifteen-minute alarm that reads as ten everywhere in the
 * app. cdk-stack.ts owns the rule and must match; repro-alarms.ts asserts both.
 */
export const TICK_MINUTES = 5;

/**
 * Minutes between evaluations, by what the widget actually reads.
 *
 * Dependabot alarms cost one org-wide sweep per run, paginated at 100 alerts a
 * request and memoised so the run fetches once however many alarms read it. The
 * cost tracks how many alerts are open rather than how many repositories,
 * widgets or alarms exist, which is what makes a short interval affordable: at
 * a few thousand open alerts, ten minutes is a low single-digit percentage of
 * an installation's hourly budget.
 *
 * Everything else reads configuration out of the graph tables, which is cheap
 * and changes when a person changes it.
 */
export const INTERVAL_MINUTES = {
  /** Readings paid for in GitHub API calls. */
  bought: 10,
  /** @deprecated The old name for `bought`, kept while callers move over. */
  dependabot: 10,
  /** @deprecated Nothing reads stored state on a slower clock than the tick. */
  standard: 15,
} as const;

/**
 * The queries that call GitHub, rather than reading the stored graph.
 *
 * Everything else in `evaluateSecurityQuery` answers from `scanGraphEdges`, a
 * table the webhook worker keeps current: a collaborator added, a team changed,
 * a repository created or a vulnerable dependency appearing all write to it as
 * they happen. Those readings are a DynamoDB scan, and cost nothing to repeat.
 *
 * These three build an Octokit and go out to github.com, one of them per
 * repository. That is the cost the intervals exist to bound, and it is the only
 * reason any alarm here waits longer than a tick.
 *
 * repro-alarms.ts checks this against the cases that actually construct an
 * Octokit, because a list of names beside the thing it describes is a list that
 * drifts from it.
 */
export const GITHUB_BACKED_QUERIES = new Set([
  "repos-with-branch-rules",
  "stale-branch-protections",
  "protection-bypasses-ranking",
  // A commit search per privileged account, and commit search allows thirty
  // requests a minute: the smallest budget in the app. This one was missing
  // from the list when it was written by hand, and the check found it.
  "dormant-privileged-users",
  // Reads Dependabot alerts live, so that it and the Vulnerabilities tab
  // cannot disagree about the same package. The sweep is memoised per pass and
  // already paid for by the Dependabot widgets.
  "repos-dependent-on",
]);

/**
 * How often an alarm is re-read: every tick, whatever it watches.
 *
 * Tiering by how expensive a reading is buys nothing here, because the same
 * pass recomputes **every** widget afterwards to store its snapshot. The
 * Dependabot sweep, the Renovate search and every graph scan therefore happen
 * once per tick regardless, memoised, so an alarm reading one is served from a
 * call already made. Waiting a second tick would add five minutes and save no
 * requests.
 *
 * **If the snapshot pass ever stops recomputing everything**, tiering has to
 * come back. `GITHUB_BACKED_QUERIES` above records which readings are bought,
 * and repro-alarms.ts keeps that list honest against the code that buys them.
 */
export function intervalFor(_widget: {
  type: string; presetId?: string; queryId?: string;
}): number {
  return TICK_MINUTES;
}

/**
 * The scheduler ticks every TICK_MINUTES; a ten-minute alarm is due on every
 * second tick, a fifteen-minute one on every third. The tolerance is what makes
 * that true.
 *
 * EventBridge fires within about a minute either side of the scheduled time.
 * Without slack, a tick arriving at 59m50s reads "not yet an hour" and defers
 * to the next one, so an hourly alarm quietly becomes a 75-minute alarm, and
 * the drift compounds. Two minutes is longer than the jitter and far shorter
 * than the shortest interval, so it can only ever pull a check slightly early.
 */
export const DUE_TOLERANCE_MS = 2 * 60 * 1000;

export function isDue(lastCheckedAt: string | undefined, intervalMinutes: number, now: number): boolean {
  if (!lastCheckedAt) return true;
  const last = new Date(lastCheckedAt).getTime();
  // An unreadable timestamp must not wedge an alarm off the schedule forever.
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMinutes * 60 * 1000 - DUE_TOLERANCE_MS;
}
