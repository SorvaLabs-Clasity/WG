import type { BulkAction, BulkSummary } from "./dependabotBulk";

/**
 * Dependabot security fixes, held back and released once a month, in named
 * batches.
 *
 * GitHub opens a security-fix pull request whenever an alert appears, and the
 * `schedule` in dependabot.yml does not change that — it governs version
 * updates only. So a monthly cadence is made by holding the switch:
 *
 * - While a repository is in a batch, its security fixes are **off**, so
 *   nothing arrives mid-month.
 * - On the batch's day, the hourly job switches them **on**. Switching them on
 *   is what makes Dependabot look at every open alert again — the same thing
 *   the Vulnerabilities tab's "Retrigger" relies on. GitHub does not document
 *   it, which is why the first run is meant to be tried on one repository.
 * - After the window (24 hours, so Dependabot can finish), the job switches
 *   them **off** again.
 *
 * A repository belongs to at most one batch: two batches holding the same
 * switch would each undo the other. Only a repository whose fix pull requests
 * are already on can join — holding back something that was never on would
 * end with the job switching on fixes nobody asked for.
 *
 * Taking a repository out switches its fixes back **on**. Nothing here may
 * leave a repository switched off and forgotten: one that cannot be switched
 * back on stays in its batch, so the next window releases it.
 *
 * The job runs as the GitHub App, which needs **Administration: write**. A
 * refusal for that reason is named as such rather than reported as GitHub's
 * "Resource not accessible by integration".
 */

export interface RunRecord {
  at: string;
  /** What the run did: open or close the window, or bring repositories in or out. */
  kind: "open" | "close" | "join" | "leave";
  trigger: "schedule" | "manual";
  by: string;
  results: { repo: string; ok: boolean; error?: string }[];
}

export interface Batch {
  id: string;
  name: string;
  /** Only these repositories are held back by this batch. */
  repos: string[];
  /** The day of the month fixes are released, 1–28 so every month has one. */
  dayOfMonth: number;
  /** How long fixes stay on once the window opens. */
  windowHours: number;
  /** While a window is open: when the job closes it. */
  openUntil?: string;
  /** "2026-10": the month whose scheduled window has already been opened. */
  lastOpenedMonth?: string;
  /** Newest first. */
  history: RunRecord[];
  createdAt: string;
  createdBy: string;
  changedAt?: string;
  changedBy?: string;
}

export interface BatchesConfig {
  /** Whose calendar decides what day it is. */
  timeZone: string;
  batches: Batch[];
}

/** The single batch this replaced, as it was stored, so nothing in it is lost. */
interface LegacySchedule {
  enabled?: boolean;
  repos?: string[];
  windowHours?: number;
  timeZone?: string;
  openUntil?: string;
  lastOpenedMonth?: string;
  history?: RunRecord[];
  changedAt?: string;
  changedBy?: string;
}

const HISTORY_KEEP = 24;
const DEFAULT_TZ = "America/New_York";
const DEFAULT_WINDOW = 24;
/** The same name the activity feed gives every scheduled job. */
export const SCHEDULE_ACTOR = "system (schedule)";

export function withDefaults(c: BatchesConfig | undefined, legacy?: LegacySchedule): BatchesConfig {
  if (c) {
    return {
      timeZone: c.timeZone || DEFAULT_TZ,
      batches: (c.batches ?? []).map(b => ({ ...b, repos: [...b.repos], history: [...(b.history ?? [])] })),
    };
  }
  // The one batch there used to be becomes the first named one.
  if (legacy && (legacy.repos?.length || legacy.openUntil)) {
    return {
      timeZone: legacy.timeZone || DEFAULT_TZ,
      batches: [{
        id: "monthly",
        name: "Monthly batch",
        repos: [...(legacy.repos ?? [])],
        dayOfMonth: 1,
        windowHours: legacy.windowHours ?? DEFAULT_WINDOW,
        openUntil: legacy.openUntil,
        lastOpenedMonth: legacy.lastOpenedMonth,
        history: [...(legacy.history ?? [])],
        createdAt: legacy.changedAt ?? new Date(0).toISOString(),
        createdBy: legacy.changedBy ?? "unknown",
      }],
    };
  }
  return { timeZone: DEFAULT_TZ, batches: [] };
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

/** Is the window open right now? */
export function isOpen(b: Batch, now = new Date()): boolean {
  return !!b.openUntil && now.getTime() < Date.parse(b.openUntil);
}

/**
 * What the hourly job should do for one batch now. Pure, so the calendar is
 * testable.
 *
 * Close before open: a window still open on release day (because somebody
 * pressed "Run now" the day before) is closed first; the next hourly pass then
 * opens the month's own window.
 */
export function decide(b: Batch, now: Date, timeZone: string): "open" | "close" | "nothing" {
  if (b.openUntil && now.getTime() >= Date.parse(b.openUntil)) return "close";
  if (b.repos.length === 0 || b.openUntil) return "nothing";
  const { day } = localDate(now, timeZone);
  if (day === b.dayOfMonth && b.lastOpenedMonth !== monthKey(now, timeZone)) return "open";
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
  /** Whether a repository's fix pull requests are on; null when GitHub could not say. */
  fixesOn?: (repo: string) => Promise<boolean | null>;
  load: () => Promise<BatchesConfig>;
  save: (change: (current: BatchesConfig) => BatchesConfig) => Promise<BatchesConfig>;
  log?: (action: "dependabot.enable" | "dependabot.disable", actor: string, repo: string, details: string) => Promise<unknown>;
}

export interface RepoResult { repo: string; ok: boolean; error?: string }

export class BatchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function record(kind: RunRecord["kind"], trigger: RunRecord["trigger"], by: string,
  results: RepoResult[], now: Date, forApp: boolean): RunRecord {
  return {
    at: now.toISOString(), kind, trigger, by,
    results: results.map(r => ({
      repo: r.repo, ok: r.ok, ...(r.error ? { error: forApp ? explainForApp(r.error) : r.error } : {}),
    })),
  };
}

function toResults(s: BulkSummary): RepoResult[] {
  return s.results.map(r => ({ repo: r.repo, ok: r.ok, ...(r.error ? { error: r.error } : {}) }));
}

async function logEach(deps: Deps, results: RepoResult[], on: boolean, actor: string, why: string) {
  if (!deps.log) return;
  for (const r of results.filter(x => x.ok)) {
    await deps.log(on ? "dependabot.enable" : "dependabot.disable", actor, r.repo,
      `${on ? "Enabled" : "Disabled"} Dependabot security updates on ${r.repo} (${why})`).catch(() => {});
  }
}

/** Change one batch in the stored config, by id. */
function patchBatch(c: BatchesConfig, id: string, change: (b: Batch) => Batch): BatchesConfig {
  return { ...c, batches: c.batches.map(b => (b.id === id ? change(b) : b)) };
}

function find(c: BatchesConfig, id: string): Batch {
  const b = c.batches.find(x => x.id === id);
  if (!b) throw new BatchError("That batch no longer exists.", 404);
  return b;
}

function validDay(day: unknown): number {
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 28) {
    throw new BatchError("The release day must be between the 1st and the 28th, so every month has one.");
  }
  return n;
}

function validName(name: unknown, c: BatchesConfig, except?: string): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > 60) throw new BatchError("Give the batch a name, up to 60 characters.");
  if (c.batches.some(b => b.id !== except && b.name.toLowerCase() === n.toLowerCase())) {
    throw new BatchError(`There is already a batch called "${n}".`);
  }
  return n;
}

// ── the hourly job ─────────────────────────────────────────────────────────

/** One pass of the hourly job, as the GitHub App, over every batch. */
export async function tick(deps: Deps, now = new Date()): Promise<{ id: string; did: "open" | "close"; failed: number }[]> {
  const c = await deps.load();
  const acted: { id: string; did: "open" | "close"; failed: number }[] = [];
  for (const b of c.batches) {
    const did = decide(b, now, c.timeZone);
    if (did === "nothing") continue;
    const on = did === "open";
    const results = toResults(await deps.bulk(b.repos, on ? "fixes-on" : "fixes-off"));
    await deps.save(cur => patchBatch(cur, b.id, x => ({
      ...x,
      openUntil: on ? new Date(now.getTime() + x.windowHours * 3600_000).toISOString() : undefined,
      lastOpenedMonth: on ? monthKey(now, cur.timeZone) : x.lastOpenedMonth,
      history: [record(did, "schedule", SCHEDULE_ACTOR, results, now, true), ...x.history].slice(0, HISTORY_KEEP),
    })));
    await logEach(deps, results, on, SCHEDULE_ACTOR, `"${b.name}": monthly window ${on ? "opened" : "closed"}`);
    acted.push({ id: b.id, did, failed: results.filter(r => !r.ok).length });
  }
  return acted;
}

// ── what people do on the tab, as themselves ──────────────────────────────

export async function createBatch(
  deps: Deps, input: { name: unknown; dayOfMonth: unknown }, actor: string, now = new Date(),
): Promise<Batch> {
  const c = await deps.load();
  const name = validName(input.name, c);
  const dayOfMonth = validDay(input.dayOfMonth ?? 1);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "batch";
  const batch: Batch = {
    id: `${slug}-${now.getTime().toString(36)}`, name, repos: [], dayOfMonth,
    windowHours: DEFAULT_WINDOW, history: [], createdAt: now.toISOString(), createdBy: actor,
  };
  await deps.save(cur => ({ ...cur, batches: [...cur.batches, batch] }));
  return batch;
}

export async function updateBatch(
  deps: Deps, id: string, input: { name?: unknown; dayOfMonth?: unknown }, actor: string, now = new Date(),
): Promise<Batch> {
  const c = await deps.load();
  const b = find(c, id);
  const name = input.name === undefined ? b.name : validName(input.name, c, id);
  const dayOfMonth = input.dayOfMonth === undefined ? b.dayOfMonth : validDay(input.dayOfMonth);
  const saved = await deps.save(cur => patchBatch(cur, id, x => ({
    ...x, name, dayOfMonth, changedAt: now.toISOString(), changedBy: actor,
  })));
  return find(saved, id);
}

/**
 * Delete a batch. Only an empty one: taking its repositories out is what
 * switches their fixes back on, and that is done first, repository by
 * repository, where a failure can be seen.
 */
export async function deleteBatch(deps: Deps, id: string): Promise<void> {
  const c = await deps.load();
  const b = find(c, id);
  if (b.repos.length > 0) {
    throw new BatchError(`Take the ${b.repos.length} repositor${b.repos.length === 1 ? "y" : "ies"} out of "${b.name}" `
      + "first, which switches their fixes back on.", 409);
  }
  await deps.save(cur => ({ ...cur, batches: cur.batches.filter(x => x.id !== id) }));
}

/**
 * Bring repositories into a batch, which switches their fixes off.
 *
 * Refused, per repository and in words: one already in another batch, and one
 * whose fix pull requests are not on. While this batch's window is open the
 * newcomers are left on and switched off with the rest when it closes.
 */
export async function addRepos(
  deps: Deps, id: string, repos: string[], actor: string, now = new Date(),
): Promise<RepoResult[]> {
  const c = await deps.load();
  const b = find(c, id);
  const wanted = [...new Set(repos.filter(r => typeof r === "string" && r.length > 0))];
  const results: RepoResult[] = [];
  const eligible: string[] = [];

  for (const repo of wanted) {
    if (b.repos.includes(repo)) { results.push({ repo, ok: true }); continue; }
    const other = c.batches.find(x => x.id !== id && x.repos.includes(repo));
    if (other) {
      results.push({ repo, ok: false, error: `Already in "${other.name}". A repository can be in one batch.` });
      continue;
    }
    const on = deps.fixesOn ? await deps.fixesOn(repo) : true;
    if (on === false) {
      results.push({ repo, ok: false, error: "Fix pull requests are off for this repository, so there is "
        + "nothing to hold back. Turn them on first (Dependabot → Manage → Open fix pull requests)." });
      continue;
    }
    if (on === null) {
      results.push({ repo, ok: false, error: "Could not check whether fix pull requests are on. Try again." });
      continue;
    }
    eligible.push(repo);
  }

  if (eligible.length === 0) return results;

  const open = isOpen(b, now);
  const joined = open ? eligible.map(repo => ({ repo, ok: true })) : toResults(await deps.bulk(eligible, "fixes-off"));
  results.push(...joined);
  const added = joined.filter(r => r.ok).map(r => r.repo);
  await deps.save(cur => patchBatch(cur, id, x => ({
    ...x,
    repos: [...new Set([...x.repos, ...added])].sort(),
    history: [record("join", "manual", actor, joined, now, false), ...x.history].slice(0, HISTORY_KEEP),
    changedAt: now.toISOString(), changedBy: actor,
  })));
  if (!open) await logEach(deps, joined, false, actor, `held back for "${b.name}"`);
  return results;
}

/**
 * Take repositories out of a batch, which switches their fixes back on. One
 * that cannot be switched back on stays in, so the next window releases it.
 */
export async function removeRepos(
  deps: Deps, id: string, repos: string[], actor: string, now = new Date(),
): Promise<RepoResult[]> {
  const c = await deps.load();
  const b = find(c, id);
  const unique = [...new Set(repos)];
  const leaving = unique.filter(r => b.repos.includes(r));
  const notIn = unique.filter(r => !b.repos.includes(r)).map(repo => ({ repo, ok: true }));
  if (leaving.length === 0) return notIn;

  // While the window is open their fixes are on already.
  const open = isOpen(b, now);
  const left = open ? leaving.map(repo => ({ repo, ok: true })) : toResults(await deps.bulk(leaving, "fixes-on"));
  const released = new Set(left.filter(r => r.ok).map(r => r.repo));
  await deps.save(cur => patchBatch(cur, id, x => {
    const repos = x.repos.filter(r => !released.has(r));
    return {
      ...x,
      repos,
      // Nothing left to hold: no window left to close.
      openUntil: repos.length === 0 ? undefined : x.openUntil,
      history: [record("leave", "manual", actor, left, now, false), ...x.history].slice(0, HISTORY_KEEP),
      changedAt: now.toISOString(), changedBy: actor,
    };
  }));
  if (!open) await logEach(deps, left, true, actor, `released from "${b.name}"`);
  return [...left, ...notIn];
}

/**
 * Release a batch's fixes now, outside its day, as the person asking.
 *
 * Takes a slice of the batch so the tab can show progress: the first slice
 * opens the window and every slice switches its repositories on, all recorded
 * as one run. The hourly job closes the window. Does not use up the batch's
 * own release this month.
 */
export async function runBatch(
  deps: Deps, id: string, repos: string[] | undefined, actor: string, now = new Date(),
): Promise<RepoResult[]> {
  const c = await deps.load();
  const b = find(c, id);
  if (b.repos.length === 0) throw new BatchError(`"${b.name}" has no repositories to release.`);
  const slice = repos ? [...new Set(repos)].filter(r => b.repos.includes(r)) : b.repos;
  if (slice.length === 0) return [];
  const results = toResults(await deps.bulk(slice, "fixes-on"));
  await deps.save(cur => patchBatch(cur, id, x => {
    const open = isOpen(x, now);
    const [latest, ...rest] = x.history;
    const continuing = open && latest?.kind === "open" && latest.trigger === "manual"
      && now.getTime() - Date.parse(latest.at) < 10 * 60_000;
    const fresh = record("open", "manual", actor, results, now, false);
    const history = continuing
      ? [{ ...latest, results: [...latest.results, ...fresh.results] }, ...rest]
      : [fresh, ...x.history];
    return {
      ...x,
      openUntil: open ? x.openUntil : new Date(now.getTime() + x.windowHours * 3600_000).toISOString(),
      history: history.slice(0, HISTORY_KEEP),
    };
  }));
  await logEach(deps, results, true, actor, `"${b.name}" released by hand`);
  return results;
}

/**
 * Repositories in a batch that are not getting fixes they should be: the last
 * time its window opened it could not switch them on. Shown loudly on the tab.
 */
export function missedLastOpening(b: Batch): RepoResult[] {
  const lastOpen = b.history.find(h => h.kind === "open");
  if (!lastOpen) return [];
  return lastOpen.results.filter(r => !r.ok && b.repos.includes(r.repo));
}

/** The next release date for a batch, on the schedule's calendar, as "YYYY-MM-DD". */
export function nextRelease(b: Batch, timeZone: string, now = new Date()): string {
  const { year, month, day } = localDate(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const thisMonth = `${year}-${pad(month)}`;
  if (day < b.dayOfMonth || (day === b.dayOfMonth && b.lastOpenedMonth !== thisMonth)) {
    return `${year}-${pad(month)}-${pad(b.dayOfMonth)}`;
  }
  const [ny, nm] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${ny}-${pad(nm)}-${pad(b.dayOfMonth)}`;
}
