import {
  docClient, usesDynamo, tableName, PutCommand, scanAll,
} from "../utils/dynamo";

/**
 * Per-subject answers for the checks that cost a GitHub request each.
 *
 * Three security checks ask GitHub something once per subject:
 * `dormant-privileged-users` runs a commit search per privileged account, and
 * the two branch-protection checks read protection and merged pull requests per
 * repository. The cost is therefore the size of the organization, and the
 * budget it draws on is fixed — commit search allows thirty requests a *minute*.
 *
 * Two facts make caching the right answer rather than a shortcut:
 *
 *   - **The questions are slow-moving.** "Has this person committed in six
 *     months" cannot meaningfully change between one fifteen-minute evaluation
 *     and the next. Re-deriving it ninety-six times a day is ninety-six times
 *     the cost of the answer being wrong by at most a few hours.
 *   - **A subject is independent of the others.** Nothing about checking Alice
 *     depends on having just checked Bob, so the work divides. That is what lets
 *     a three-hundred-account organization be covered a batch at a time instead
 *     of needing three hundred requests in one minute it does not have.
 *
 * So each subject's verdict is stored on its own, with when it was taken. A pass
 * refreshes the most stale handful within its budget and assembles the answer
 * from everything on file. Coverage grows until it is complete and then stays
 * complete, refreshing oldest-first forever.
 */

const TABLE = () => tableName("ALARMS_TABLE");

export interface CachedVerdict {
  id: string;
  kind: "query-subject";
  /** Which check this verdict belongs to. */
  queryId: string;
  /** The account or repository it is about. */
  subject: string;
  /**
   * The finding, or null for "checked, nothing to report".
   *
   * Null is a real answer and is stored as one. Leaving a clean subject out
   * would make "checked and fine" indistinguishable from "not checked yet",
   * which is the whole distinction this exists to keep.
   */
  finding: Record<string, unknown> | null;
  checkedAt: string;
  ttl: number;
}

/**
 * How long a verdict is worth keeping.
 *
 * Long enough that a large organization is not re-reading itself constantly,
 * short enough that a person who starts committing stops being reported as
 * dormant within a working day. Refresh is oldest-first and continuous, so in
 * practice entries are replaced well before this; it is the outer bound at which
 * one is no longer allowed to count toward coverage.
 */
export const VERDICT_TTL_HOURS = 24;

/**
 * Subjects refreshed per pass, per check.
 *
 * Twenty-five leaves headroom under commit search's thirty-a-minute while still
 * covering three hundred accounts in twelve passes — an hour at the standard
 * fifteen-minute interval, then continuous. Raising it buys a faster first
 * coverage and risks the limit; the limit is the thing that produces silent
 * wrong answers, so the headroom stays.
 */
export const REFRESH_BUDGET = 25;

const cacheId = (queryId: string, subject: string) => `qcache#${queryId}#${subject}`;

/**
 * The shortest gap between two refreshes of the same check.
 *
 * Refreshing is driven by whoever asks — the scheduled evaluation every fifteen
 * minutes, and *also* every page load. Without a floor, opening the tab twice
 * in a minute spends two batches, and two batches of twenty-five is fifty
 * commit searches against a limit of thirty a minute. The second one fails, and
 * failures are what this whole design exists to avoid.
 *
 * Ninety seconds is longer than a person double-clicking and far shorter than
 * the fifteen-minute interval, so it costs the scheduled pass nothing and makes
 * a page load read the cache rather than spend budget.
 */
export const MIN_REFRESH_GAP_MS = 90_000;

/** Last refresh per check, in this process. */
const lastRefreshAt = new Map<string, number>();

/**
 * Whether this caller should spend budget, or read what is already stored.
 *
 * Deliberately in memory rather than in the table. It is a throttle on one
 * process's outbound requests, not a fact about the organization, and a stored
 * one would need a write per read to maintain.
 */
export function mayRefresh(queryId: string, now = Date.now()): boolean {
  const last = lastRefreshAt.get(queryId);
  return last === undefined || now - last >= MIN_REFRESH_GAP_MS;
}

export function markRefreshed(queryId: string, now = Date.now()): void {
  lastRefreshAt.set(queryId, now);
}

/**
 * How long a manual "check everything now" is allowed to run.
 *
 * It has to end well inside an HTTP request, and it cannot outrun GitHub: the
 * pacing below sleeps between batches rather than firing them back to back, so
 * the ceiling is wall-clock, not appetite. Whatever is left when it expires is
 * picked up by the ordinary passes, so pressing the button twice is a perfectly
 * good way to finish a very large organization.
 */
export const MANUAL_REFRESH_BUDGET_MS = 45_000;

/**
 * What a batch of this check costs, and therefore how fast batches may follow
 * each other during a manual refresh.
 *
 * The two budgets are nothing alike and pacing them the same way gets one of
 * them wrong:
 *
 *   - **search** allows thirty requests a *minute*. A batch is twenty-five, so
 *     a second batch inside the same minute is over the line. Sixty-one seconds
 *     is the smallest gap that cannot be — which means a manual refresh cannot
 *     meaningfully hurry this one, and says so rather than pretending.
 *   - **core** allows fifteen thousand an *hour*. A batch of twenty-five
 *     repositories costs about seventy-five, so batches can follow in seconds
 *     and a few hundred repositories finish inside one request.
 */
export const SUBJECT_COST: Record<
  string, { budget: "search" | "core"; gapMs: number; perPass: number }
> = {
  "dormant-privileged-users": { budget: "search", gapMs: 61_000, perPass: 25 },
  "stale-branch-protections": { budget: "core", gapMs: 2_000, perPass: 50 },
  "protection-bypasses-ranking": { budget: "core", gapMs: 2_000, perPass: 50 },
};

/**
 * Subjects a given check reads per pass.
 *
 * Sized to the budget it draws on, not to one number for all three. Twenty-five
 * exists because commit search allows thirty a minute; the protection checks
 * never touch search, and holding them to a search-shaped limit made an
 * organization with thirty protected repositories wait a pass for an answer the
 * old capped version returned at once. Fifty of them costs about a hundred and
 * fifty core requests, against an allowance of fifteen thousand an hour.
 */
export function budgetFor(queryId: string): number {
  return SUBJECT_COST[queryId]?.perPass ?? REFRESH_BUDGET;
}

/** Whether a check is cached per subject at all. */
export function isBatched(queryId: string): boolean {
  return queryId in SUBJECT_COST;
}

/**
 * Let the next call refresh, whatever the throttle says.
 *
 * Only for a person pressing a button. The throttle exists to stop page loads
 * spending budget; somebody explicitly asking for a refresh is the case it was
 * never meant to block.
 */
export function clearThrottle(queryId: string): void {
  lastRefreshAt.delete(queryId);
}

/** Freshness of what is stored, without asking GitHub anything. */
export function freshnessOf(verdicts: CachedVerdict[]): {
  checked: number; oldestAt: string | null; newestAt: string | null;
} {
  const stamps = verdicts.map(v => v.checkedAt).sort();
  return {
    checked: verdicts.length,
    oldestAt: stamps[0] ?? null,
    newestAt: stamps[stamps.length - 1] ?? null,
  };
}

let memStore: CachedVerdict[] = [];

export async function listVerdicts(queryId: string): Promise<CachedVerdict[]> {
  // Paged and filtered to this check's own rows. A bare scan stops at 1MB, and
  // this is the table most likely to reach it — three hundred subjects across
  // three checks is nine hundred rows on top of everything else living here.
  // Truncation would drop verdicts, so coverage would never complete and the
  // check would refuse forever while looking like it was still building.
  const rows: CachedVerdict[] = usesDynamo()
    ? await scanAll<CachedVerdict>(TABLE(), {
        filter: "#k = :kind AND #q = :queryId",
        names: { "#k": "kind", "#q": "queryId" },
        values: { ":kind": "query-subject", ":queryId": queryId },
      })
    : memStore;

  const cutoff = Date.now() - VERDICT_TTL_HOURS * 3_600_000;
  return rows.filter(r =>
    r.kind === "query-subject"
    && r.queryId === queryId
    // Expired locally as well as by the table's own TTL. DynamoDB deletes on
    // its own schedule — usually within a couple of days, not at the moment the
    // stamp passes — so a row can outlive its meaning by a wide margin. Reading
    // it as current is how a verdict from last week counts as coverage.
    && new Date(r.checkedAt).getTime() >= cutoff);
}

export async function putVerdict(
  queryId: string, subject: string, finding: Record<string, unknown> | null,
): Promise<CachedVerdict> {
  const row: CachedVerdict = {
    id: cacheId(queryId, subject),
    kind: "query-subject",
    queryId,
    subject,
    finding,
    checkedAt: new Date().toISOString(),
    // Kept past its useful life on purpose: the row is what proves the subject
    // was ever checked, and the reader above is what decides it is too old.
    ttl: Math.floor(Date.now() / 1000) + VERDICT_TTL_HOURS * 2 * 3_600,
  };
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: row }));
  } else {
    const i = memStore.findIndex(r => r.id === row.id);
    if (i >= 0) memStore[i] = row; else memStore.push(row);
  }
  return row;
}

export interface Coverage {
  /** Everything the check would look at, if budget were unlimited. */
  total: number;
  /** How many have a verdict on file that is still current. */
  covered: number;
  complete: boolean;
  /** The oldest verdict being counted, so staleness is visible, not assumed. */
  oldestAt: string | null;
}

/**
 * Which subjects to spend this pass's budget on, and what is already known.
 *
 * Never checked comes first, then oldest first. That order is what makes the
 * first few passes converge on full coverage rather than re-reading the same
 * popular subjects while others are never reached.
 */
export function planRefresh(
  subjects: string[], cached: CachedVerdict[], budget = REFRESH_BUDGET,
): { refresh: string[]; known: Map<string, CachedVerdict> } {
  const known = new Map(cached.map(v => [v.subject, v]));

  const ordered = [...subjects].sort((a, b) => {
    const va = known.get(a), vb = known.get(b);
    if (!va && !vb) return a.localeCompare(b);
    // Unchecked outranks any checked subject, however old.
    if (!va) return -1;
    if (!vb) return 1;
    return va.checkedAt.localeCompare(vb.checkedAt);
  });

  return { refresh: ordered.slice(0, Math.max(0, budget)), known };
}

export function coverageOf(subjects: string[], known: Map<string, CachedVerdict>): Coverage {
  const present = subjects.map(s => known.get(s)).filter((v): v is CachedVerdict => !!v);
  const oldest = present.reduce<string | null>(
    (o, v) => (o === null || v.checkedAt < o ? v.checkedAt : o), null);
  return {
    total: subjects.length,
    covered: present.length,
    complete: present.length === subjects.length,
    oldestAt: oldest,
  };
}

/**
 * Findings from every current verdict, each stamped with when it was taken.
 *
 * The stamp travels with the row because a cached answer without one is a claim
 * with no date on it. "This repository bypasses its rules" means something
 * different if it was established four minutes ago or twenty hours ago, and the
 * reader cannot tell which unless the row says.
 */
export function findingsFrom(
  subjects: string[], known: Map<string, CachedVerdict>,
): Record<string, unknown>[] {
  return subjects
    .map(s => known.get(s))
    .filter((v): v is CachedVerdict => !!v && !!v.finding)
    .map(v => ({ ...v.finding as Record<string, unknown>, checkedAt: v.checkedAt }));
}

export function describeProgress(queryLabel: string, c: Coverage): string {
  return `${queryLabel} has checked ${c.covered} of ${c.total} and is still building coverage. `
    + `Each one costs a GitHub request against a limit measured per minute, so they are read `
    + `${REFRESH_BUDGET} at a time — the full picture is a few evaluations away. Nothing is `
    + `reported until then rather than a list that looks shorter than it is.`;
}

/** Test seam, matching the other services. */
export function __resetQueryCacheForTests(): void {
  memStore = [];
  lastRefreshAt.clear();
}

/**
 * Plant a verdict with a chosen timestamp.
 *
 * Only reachable from a test, and only because the age rule cannot otherwise be
 * exercised: `putVerdict` always stamps now, so without this the filter that
 * drops old verdicts is asserted by reading the code rather than by running it.
 */
export function __seedVerdictForTests(row: CachedVerdict): void {
  memStore.push(row);
}
