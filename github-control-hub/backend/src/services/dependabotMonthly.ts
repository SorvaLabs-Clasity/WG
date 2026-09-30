import type { BulkAction, BulkSummary } from "./dependabotBulk";

/**
 * Dependabot security fixes, held back and released once a month.
 *
 * GitHub opens a security-fix pull request whenever an alert appears, and the
 * `schedule` in dependabot.yml does not change that — it governs version
 * updates only. So a monthly cadence cannot be configured; it has to be done
 * by holding the switch:
 *
 * - While a repository is in the batch, its security fixes are **off**, so
 *   nothing arrives mid-month.
 * - On the 1st, the scheduled job switches them **on**. Switching them on is
 *   what makes Dependabot look at every open alert again — the same thing the
 *   Vulnerabilities tab's "Retrigger" relies on. GitHub does not document it,
 *   which is why the first run is meant to be tried on one repository.
 * - After the window (24 hours by default, so Dependabot can finish), the job
 *   switches them **off** again.
 *
 * Taking a repository out of the batch, or turning the whole thing off, turns
 * its fixes back **on**. Nothing here may leave a repository without security
 * fixes by being switched off and forgotten.
 *
 * The job runs as the GitHub App, which needs **Administration: write** to
 * flip the switch. A refusal for that reason is named as such rather than
 * reported as GitHub's "Resource not accessible by integration".
 */

export interface RunRecord {
  at: string;
  /** What the run did: open or close the window, or bring repositories in or out. */
  kind: "open" | "close" | "join" | "leave";
  trigger: "schedule" | "manual";
  by: string;
  results: { repo: string; ok: boolean; error?: string }[];
}

export interface MonthlySchedule {
  enabled: boolean;
  /** The batch. Only these repositories are held back. */
  repos: string[];
  /** How long fixes stay on once the window opens. */
  windowHours: number;
  /** Whose calendar decides when "the 1st" is. */
  timeZone: string;
  /** While a window is open: when the job closes it. */
  openUntil?: string;
  /** "2026-10": the month whose scheduled window has already been opened. */
  lastOpenedMonth?: string;
  /** Newest first, a year's worth. */
  history: RunRecord[];
  changedAt?: string;
  changedBy?: string;
}

export const DEFAULT_SCHEDULE: MonthlySchedule = {
  enabled: false,
  repos: [],
  windowHours: 24,
  timeZone: "America/New_York",
  history: [],
};

const HISTORY_KEEP = 24;
/** The same name the activity feed gives every scheduled job. */
export const SCHEDULE_ACTOR = "system (schedule)";

export function withDefaults(s: MonthlySchedule | undefined): MonthlySchedule {
  return { ...DEFAULT_SCHEDULE, ...(s ?? {}), repos: [...(s?.repos ?? [])], history: [...(s?.history ?? [])] };
}

/** Year, month and day of `now` on the schedule's own calendar. */
export function localDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function monthKey(now: Date, timeZone: string): string {
  const { year, month } = localDate(now, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * What the hourly job should do now. Pure, so the calendar is testable.
 *
 * Close before open: a window still open at midnight on the 1st (because
 * somebody pressed "Run now" on the 31st) is closed first; the next hourly
 * pass then opens the month's own window.
 */
export function decide(s: MonthlySchedule, now: Date): "open" | "close" | "nothing" {
  if (s.openUntil && now.getTime() >= Date.parse(s.openUntil)) return "close";
  if (!s.enabled || s.repos.length === 0 || s.openUntil) return "nothing";
  const { day } = localDate(now, s.timeZone);
  if (day === 1 && s.lastOpenedMonth !== monthKey(now, s.timeZone)) return "open";
  return "nothing";
}

/** GitHub's words for "the App lacks the permission", said as what to do. */
export function explainForApp(error: string | undefined): string | undefined {
  if (!error) return error;
  if (/not accessible by integration/i.test(error)) {
    return "The Control Hub GitHub App does not have Administration: write, which switching "
      + "security fixes needs. An organization owner can grant it in the App's permissions.";
  }
  return error;
}

export interface Deps {
  bulk: (repos: string[], action: BulkAction) => Promise<BulkSummary>;
  load: () => Promise<MonthlySchedule | undefined>;
  save: (change: (current: MonthlySchedule | undefined) => MonthlySchedule) => Promise<MonthlySchedule>;
  log?: (action: "dependabot.enable" | "dependabot.disable", actor: string, repo: string, details: string) => Promise<unknown>;
}

function record(kind: RunRecord["kind"], trigger: RunRecord["trigger"], by: string,
  summary: BulkSummary, now: Date, forApp: boolean): RunRecord {
  return {
    at: now.toISOString(), kind, trigger, by,
    results: summary.results.map(r => ({
      repo: r.repo, ok: r.ok, ...(r.error ? { error: forApp ? explainForApp(r.error) : r.error } : {}),
    })),
  };
}

async function logEach(deps: Deps, summary: BulkSummary, on: boolean, actor: string, why: string) {
  if (!deps.log) return;
  for (const r of summary.results.filter(x => x.ok)) {
    await deps.log(on ? "dependabot.enable" : "dependabot.disable", actor, r.repo,
      `${on ? "Enabled" : "Disabled"} Dependabot security updates on ${r.repo} (${why})`).catch(() => {});
  }
}

/** One pass of the hourly job, as the GitHub App. */
export async function tick(deps: Deps, now = new Date()): Promise<{ did: "open" | "close" | "nothing"; summary?: BulkSummary }> {
  const s = withDefaults(await deps.load());
  const did = decide(s, now);
  if (did === "nothing") return { did };

  const on = did === "open";
  const summary = await deps.bulk(s.repos, on ? "fixes-on" : "fixes-off");
  await deps.save(current => {
    const c = withDefaults(current);
    return {
      ...c,
      openUntil: on ? new Date(now.getTime() + c.windowHours * 3600_000).toISOString() : undefined,
      lastOpenedMonth: on ? monthKey(now, c.timeZone) : c.lastOpenedMonth,
      history: [record(did, "schedule", SCHEDULE_ACTOR, summary, now, true), ...c.history].slice(0, HISTORY_KEEP),
    };
  });
  await logEach(deps, summary, on, SCHEDULE_ACTOR, on ? "monthly window opened" : "monthly window closed");
  return { did, summary };
}

/**
 * Change the batch or switch the whole thing on or off, as the person asking.
 *
 * Repositories coming in have their fixes switched off, since that is what
 * being in the batch means; repositories going out have them switched back on.
 * Turning the schedule off takes every repository out. A repository whose
 * switch could not be flipped keeps its previous membership, so the record
 * never claims a repository is held back when it is not, or released when it
 * is still off.
 */
export async function configure(
  deps: Deps,
  change: { enabled: boolean; repos: string[] },
  actor: string,
  now = new Date(),
): Promise<{ schedule: MonthlySchedule; joined?: BulkSummary; left?: BulkSummary }> {
  const before = withDefaults(await deps.load());
  const wasHeld = new Set(before.enabled ? before.repos : []);
  const wanted = [...new Set(change.repos.filter(r => typeof r === "string" && r.length > 0))].sort();
  const willHold = new Set(change.enabled ? wanted : []);

  // While a window is open the fixes are on already; joining ones follow the
  // window and are switched off when it closes, and leaving ones stay on.
  const windowOpen = !!before.openUntil && now.getTime() < Date.parse(before.openUntil);
  const joining = [...willHold].filter(r => !wasHeld.has(r));
  const leaving = [...wasHeld].filter(r => !willHold.has(r));

  const joined = joining.length && !windowOpen ? await deps.bulk(joining, "fixes-off") : undefined;
  const left = leaving.length && !windowOpen ? await deps.bulk(leaving, "fixes-on") : undefined;

  const failedJoin = new Set((joined?.results ?? []).filter(r => !r.ok).map(r => r.repo));
  const failedLeave = new Set((left?.results ?? []).filter(r => !r.ok).map(r => r.repo));
  // Failed to switch off: not held back, so not in the batch. Failed to switch
  // back on: still off, so still in the batch until it can be released.
  const repos = [...[...willHold].filter(r => !failedJoin.has(r)), ...[...failedLeave]]
    .filter((r, i, a) => a.indexOf(r) === i).sort();

  const history = [
    ...(joined ? [record("join", "manual", actor, joined, now, false)] : []),
    ...(left ? [record("leave", "manual", actor, left, now, false)] : []),
  ];
  const schedule = await deps.save(current => {
    const c = withDefaults(current);
    return {
      ...c,
      // Still on if anything is still held back — a repository that could not
      // be released stays in the batch, and the next window switches it on.
      enabled: change.enabled || repos.length > 0,
      repos,
      // Nothing left held back: no window left to close.
      openUntil: repos.length > 0 ? c.openUntil : undefined,
      history: [...history, ...c.history].slice(0, HISTORY_KEEP),
      changedAt: now.toISOString(),
      changedBy: actor,
    };
  });
  if (joined) await logEach(deps, joined, false, actor, "held back for the monthly batch");
  if (left) await logEach(deps, left, true, actor, "released from the monthly batch");
  return { schedule, joined, left };
}

/** Open the window now, as the person asking. The hourly job closes it. */
export async function runNow(deps: Deps, actor: string, now = new Date()): Promise<{ schedule: MonthlySchedule; summary: BulkSummary }> {
  const s = withDefaults(await deps.load());
  if (!s.enabled || s.repos.length === 0) throw new Error("There is no monthly batch to run.");
  const summary = await deps.bulk(s.repos, "fixes-on");
  const schedule = await deps.save(current => {
    const c = withDefaults(current);
    return {
      ...c,
      openUntil: new Date(now.getTime() + c.windowHours * 3600_000).toISOString(),
      history: [record("open", "manual", actor, summary, now, false), ...c.history].slice(0, HISTORY_KEEP),
    };
  });
  await logEach(deps, summary, true, actor, "monthly window opened by hand");
  return { schedule, summary };
}

/**
 * Repositories in the batch that are not getting security fixes they should be:
 * the last window opening could not switch them on. Shown loudly on the tab.
 */
export function missedLastOpening(s: MonthlySchedule): { repo: string; error?: string }[] {
  const lastOpen = s.history.find(h => h.kind === "open");
  if (!lastOpen) return [];
  return lastOpen.results.filter(r => !r.ok).map(r => ({ repo: r.repo, error: r.error }));
}
