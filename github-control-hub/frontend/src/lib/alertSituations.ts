/**
 * Alerts as situations rather than events, and as a trend rather than a count.
 *
 * The tab was an inbox: every webhook produced a row, and every row waited to
 * be resolved. On a busy organization that is a queue nobody can keep up with,
 * and a queue nobody keeps up with is one nobody reads. The alerts were not
 * wrong; the shape was.
 *
 * Three changes, all here:
 *
 * **The unit is what happened, not how many times it fired.** A team added to a
 * hundred repositories is one action and a hundred webhooks. Grouped, it is one
 * line that says so.
 *
 * **A count is compared with what is normal.** "4 repositories went public this
 * week" means nothing on its own. Against zero in the eight weeks before, it is
 * the only line worth reading.
 *
 * **Only some of it is a queue.** Critical events still want somebody to look
 * and decide. The rest is a record, and asking for it to be cleared is what
 * created the backlog.
 */

export interface AlertLike {
  id: string;
  repo: string;
  type: string;
  message?: string;
  severity: string;
  timestamp: string;
  /** Who made the change, where the webhook told us. */
  actor?: string;
  /** The member, branch or ruleset this is about. */
  subject?: string;
  /**
   * Set when the nightly walk found this rather than a webhook reporting it.
   * The timestamp is then when it was *noticed*, not when it happened.
   */
  source?: "reconciliation";
  resolved?: boolean;
}

export interface Situation {
  key: string;
  type: string;
  /** The highest severity anything in the group carried. */
  severity: string;
  repos: string[];
  count: number;
  /**
   * How many of these were later undone on GitHub.
   *
   * Not "how many are still open". Nothing is open. This used to be
   * `unresolved`, a count of rows where `resolved` was false, and on an
   * account where somebody had once worked through the old queue that was
   * zero for every group, so every group claimed to have been undone.
   */
  reverted: number;
  first: string;
  last: string;
  ids: string[];
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const rank = (s: string) => RANK[(s ?? "").toLowerCase()] ?? 0;

/**
 * How far apart two alerts of the same kind can be and still be one thing.
 *
 * A script adding a team to two hundred repositories takes minutes, not
 * seconds, because GitHub delivers webhooks at its own pace. An hour is wide
 * enough to hold that and narrow enough that Tuesday's change and Thursday's
 * stay apart.
 */
export const BURST_GAP_MS = 60 * 60 * 1000;

/** Alerts collapsed into the things that caused them. */
export function toSituations(alerts: AlertLike[]): Situation[] {
  const byType = new Map<string, AlertLike[]>();
  for (const a of alerts) {
    const list = byType.get(a.type);
    if (list) list.push(a); else byType.set(a.type, [a]);
  }

  const out: Situation[] = [];
  for (const [type, list] of byType) {
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let run: AlertLike[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const repos = [...new Set(run.map(r => r.repo).filter(Boolean))].sort();
      out.push({
        key: `${type}#${run[0].timestamp}`,
        type,
        severity: run.reduce((w, r) => (rank(r.severity) > rank(w) ? r.severity : w), run[0].severity),
        repos,
        count: run.length,
        reverted: run.filter(wasReverted).length,
        first: run[0].timestamp,
        last: run[run.length - 1].timestamp,
        ids: run.map(r => r.id),
      });
      run = [];
    };
    for (const a of sorted) {
      if (run.length && Date.parse(a.timestamp) - Date.parse(run[run.length - 1].timestamp) > BURST_GAP_MS) {
        flush();
      }
      run.push(a);
    }
    flush();
  }

  // Newest first, and within a moment the more severe first.
  return out.sort((a, b) => b.last.localeCompare(a.last) || rank(b.severity) - rank(a.severity));
}

export interface Trend {
  type: string;
  thisWeek: number;
  /** Mean per week over the eight weeks before this one. */
  baseline: number;
  /** "new" when there is no history to compare against. */
  direction: "up" | "down" | "steady" | "new" | "quiet";
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * This week against what the eight before it looked like.
 *
 * Eight weeks because fewer is noise on anything weekly, and more starts
 * including a period the organization no longer resembles.
 */
export function trends(alerts: AlertLike[], now = Date.now()): Trend[] {
  const types = [...new Set(alerts.map(a => a.type))];
  return types.map(type => {
    const mine = alerts.filter(a => a.type === type).map(a => Date.parse(a.timestamp));
    const thisWeek = mine.filter(t => t > now - WEEK_MS).length;
    const before = mine.filter(t => t <= now - WEEK_MS && t > now - 9 * WEEK_MS);
    const baseline = before.length / 8;

    let direction: Trend["direction"];
    if (before.length === 0 && thisWeek > 0) direction = "new";
    else if (thisWeek === 0) direction = "quiet";
    // A fifty percent move, and at least two, so one extra alert on a quiet
    // type does not read as a spike.
    else if (thisWeek >= baseline * 1.5 && thisWeek - baseline >= 2) direction = "up";
    else if (baseline > 0 && thisWeek <= baseline * 0.5) direction = "down";
    else direction = "steady";

    return { type, thisWeek, baseline: Math.round(baseline * 10) / 10, direction };
  }).sort((a, b) => b.thisWeek - a.thisWeek);
}

/**
 * Nothing here is a task.
 *
 * `needsDecision` used to live here: critical and high, still unresolved, shown
 * as a queue with a Resolve button on each. The trouble is that almost every
 * one of them was a change somebody made on purpose, so clearing it recorded
 * only that a person had pressed a button, in a row nobody opened again. A
 * queue that is right 99.999% of the time is a queue nobody reads, and the
 * 0.001% is then invisible inside it.
 *
 * So an alert is a log line. It arrives, it is counted, it ages out. What
 * replaces the queue is a window: what has happened lately, which empties
 * itself whether or not anybody looks.
 */

/** How far back "lately" reaches. */
export const RECENT_DAYS = 7;

/** Everything from the last week, newest first. Nothing to clear. */
export function recent(alerts: AlertLike[], days = RECENT_DAYS, now = Date.now()): AlertLike[] {
  const since = now - days * 24 * 60 * 60 * 1000;
  return alerts
    .filter(a => {
      const t = Date.parse(a.timestamp);
      return !Number.isNaN(t) && t >= since;
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || rank(b.severity) - rank(a.severity));
}

/**
 * Was the change undone?
 *
 * The one thing `resolved` still means. The webhook worker sets it when a
 * repository goes private again, protection is restored, a ruleset is
 * recreated or a member is removed, and that is genuinely worth showing beside
 * the original event. A row carrying somebody's login instead is from the era
 * of the Resolve button and means only that a person pressed it.
 */
export function wasReverted(a: { resolved?: boolean; resolvedBy?: string }): boolean {
  return !!a.resolved && (a.resolvedBy ?? "").startsWith("system");
}

/**
 * Is this an ordinary week?
 *
 * Used to give the page a resting state. A quiet week should look visibly
 * quiet, rather than looking like a list that failed to load. It no longer
 * asks whether anything is outstanding, because nothing ever is.
 */
export function isRestingState(alerts: AlertLike[], now = Date.now()): boolean {
  return !trends(alerts, now).some(t => t.direction === "up" || t.direction === "new");
}

/* ────────────────────────────────────────────────────────────────────────
 * Shapes the dashboard draws.
 *
 * The tab had no picture of time at all: every number was "this week", which
 * on an organization where the last event was eleven days ago renders as a
 * wall of zeroes and reads as "nothing has ever happened here". A count needs
 * its own history beside it before it means anything.
 * ──────────────────────────────────────────────────────────────────────── */

/** Severity, worst first. The order the ramp is drawn in and stacked in. */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface WeekBucket {
  /** Midnight UTC at the start of the week, as ms. The filter key. */
  start: number;
  end: number;
  label: string;
  total: number;
  bySeverity: Record<Severity, number>;
}

/**
 * Weekly counts, oldest first, including the weeks where nothing happened.
 *
 * The empty weeks are the point. A bar chart built only from weeks that have
 * alerts draws a busy month and a quiet one identically, side by side, and
 * the gap is the shape somebody is actually looking for.
 */
export function weeklyActivity(alerts: AlertLike[], weeks = 12, now = Date.now()): WeekBucket[] {
  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = now - i * WEEK_MS;
    const start = end - WEEK_MS;
    buckets.push({
      start, end,
      label: new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      total: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    });
  }

  for (const a of alerts) {
    const t = Date.parse(a.timestamp);
    if (Number.isNaN(t)) continue;
    // Linear rather than a binary search: a security tab holds hundreds of
    // rows, not millions, and the index arithmetic is where an off-by-one
    // would put an event in the wrong week without ever looking wrong.
    const b = buckets.find(x => t > x.start && t <= x.end);
    if (!b) continue;
    b.total++;
    const s = (a.severity ?? "").toLowerCase() as Severity;
    if (s in b.bySeverity) b.bySeverity[s]++;
  }
  return buckets;
}

export interface KindSummary {
  type: string;
  /** Everything of this kind, over the whole window being shown. */
  total: number;
  /** How many of this kind were later undone on GitHub. */
  reverted: number;
  thisWeek: number;
  baseline: number;
  direction: Trend["direction"];
  /** Weekly counts, oldest first, for the tile's own small chart. */
  spark: number[];
  /** The worst severity this kind has carried. */
  worst: string;
  repos: number;
  /** ISO timestamp of the most recent one, or "" if there are none. */
  last: string;
}

/**
 * One row per kind of thing that has happened, with its own history.
 *
 * Ordered by what deserves attention rather than by volume: anything above its
 * usual rate first, then unresolved, then how recent. Sorting by count alone
 * puts the noisiest kind on top permanently, which is the opposite of useful.
 */
export function summarizeKinds(alerts: AlertLike[], weeks = 12, now = Date.now()): KindSummary[] {
  const trend = new Map(trends(alerts, now).map(t => [t.type, t]));
  const types = [...new Set(alerts.map(a => a.type))];

  const out = types.map(type => {
    const mine = alerts.filter(a => a.type === type);
    const t = trend.get(type);
    const sorted = [...mine].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      type,
      total: mine.length,
      reverted: mine.filter(wasReverted).length,
      thisWeek: t?.thisWeek ?? 0,
      baseline: t?.baseline ?? 0,
      direction: t?.direction ?? "quiet",
      spark: weeklyActivity(mine, weeks, now).map(b => b.total),
      worst: mine.reduce((w, a) => (rank(a.severity) > rank(w) ? a.severity : w), mine[0]?.severity ?? "low"),
      repos: new Set(mine.map(a => a.repo).filter(Boolean)).size,
      last: sorted.length ? sorted[sorted.length - 1].timestamp : "",
    } satisfies KindSummary;
  });

  // Anything above its usual rate first, then by how bad it gets, then by how
  // recent. There used to be an "has open items" term here, which after the
  // queue was removed ranked on whether somebody had once pressed a button.
  const urgency = (k: KindSummary) => (k.direction === "up" || k.direction === "new" ? 1 : 0);
  return out.sort((a, b) =>
    urgency(b) - urgency(a) || rank(b.worst) - rank(a.worst) || b.last.localeCompare(a.last));
}

export interface RepoSummary {
  repo: string;
  total: number;
  reverted: number;
  worst: string;
  last: string;
  /** How many different kinds of thing have happened here. */
  kinds: number;
}

/**
 * Which repositories this keeps happening to.
 *
 * Nothing else in the app answers it. One repository appearing under four
 * different kinds of alert is a different problem from four repositories with
 * one each, and until now both rendered as "eight alerts".
 */
export function summarizeRepos(alerts: AlertLike[]): RepoSummary[] {
  const byRepo = new Map<string, AlertLike[]>();
  for (const a of alerts) {
    if (!a.repo) continue;
    const list = byRepo.get(a.repo);
    if (list) list.push(a); else byRepo.set(a.repo, [a]);
  }
  return [...byRepo.entries()]
    .map(([repo, list]) => ({
      repo,
      total: list.length,
      reverted: list.filter(wasReverted).length,
      worst: list.reduce((w, a) => (rank(a.severity) > rank(w) ? a.severity : w), list[0].severity),
      last: list.reduce((m, a) => (a.timestamp > m ? a.timestamp : m), list[0].timestamp),
      kinds: new Set(list.map(a => a.type)).size,
    }))
    .sort((a, b) => rank(b.worst) - rank(a.worst) || b.total - a.total || a.repo.localeCompare(b.repo));
}
