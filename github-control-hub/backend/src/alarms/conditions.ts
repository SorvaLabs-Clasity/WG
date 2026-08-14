/**
 * What an alarm can watch, and when it fires.
 *
 * Everything here is a pure function of values passed in. Nothing reads a
 * table, calls GitHub or publishes to SNS — that belongs to the evaluator, and
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
 * in live payloads, so both rank here — an unranked severity would sort below
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
  | "query.rows";

export type AlarmCondition =
  | { kind: "count"; metric: CountMetric; op: "gte" | "lte"; threshold: number }
  | { kind: "severity"; metric: "vulnRepos.worstSeverity"; atLeast: Severity };

export interface MetricSpec {
  metric: CountMetric | "vulnRepos.worstSeverity";
  kind: "count" | "severity";
  label: string;
  /** Shown after the number in the UI, e.g. "3 alerts". */
  unit?: string;
  hint?: string;
}

/**
 * Which conditions a given widget may use.
 *
 * Also the validator. The UI builds its form from this, and the API checks
 * against it before saving — a client is free to post any metric it likes, and
 * an alarm on a metric its widget cannot produce would evaluate to null
 * forever and never fire, which looks identical to "nothing is wrong".
 */
export function conditionsFor(widget: { type: string; presetId?: string }): MetricSpec[] {
  if (widget.type === "query") {
    return [
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
  const spec = allowed.find(s => s.metric === condition.metric);
  if (!spec) return false;
  if (spec.kind !== condition.kind) return false;
  if (condition.kind === "count") {
    // A non-finite threshold compares false against everything, so an alarm
    // holding one is an alarm that never fires.
    return Number.isFinite(condition.threshold);
  }
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
    default: return null;
  }
}

/** Whether a reading breaches the condition. A null reading never breaches. */
export function isBreaching(condition: AlarmCondition, value: number | null): boolean {
  if (value === null) return false;
  if (condition.kind === "severity") return value >= severityRank(condition.atLeast);
  return condition.op === "gte" ? value >= condition.threshold : value <= condition.threshold;
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
 * cycle — which trains people to filter the alarm that mattered.
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
 * Minutes between evaluations, by what the widget actually reads.
 *
 * Dependabot data is one GitHub request per repository and only changes when
 * GitHub rescans — on push, and when advisories are published, which happens
 * in batches a few times a day. Asking four times an hour spends real rate
 * limit to receive the same answer four times.
 *
 * Everything else reads configuration state out of the graph tables, which is
 * cheap, and changes whenever a person changes it.
 */
export const INTERVAL_MINUTES = { dependabot: 60, standard: 15 } as const;

export function intervalFor(widget: { type: string; presetId?: string }): number {
  const dependabotBacked = widget.type === "preset"
    && (widget.presetId === "dependabot" || widget.presetId === "vuln-repos");
  return dependabotBacked ? INTERVAL_MINUTES.dependabot : INTERVAL_MINUTES.standard;
}

/**
 * The scheduler ticks every 15 minutes; an hourly alarm is due on every fourth
 * tick. The tolerance is what makes that true.
 *
 * EventBridge fires within about a minute either side of the scheduled time.
 * Without slack, a tick arriving at 59m50s reads "not yet an hour" and defers
 * to the next one — so an hourly alarm quietly becomes a 75-minute alarm, and
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
