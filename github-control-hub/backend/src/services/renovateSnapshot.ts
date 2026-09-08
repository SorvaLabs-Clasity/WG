import { gzipSync, gunzipSync } from "node:zlib";
import { docClient, hasTable, tableName, PutCommand, GetCommand } from "../utils/dynamo";

/**
 * Renovate's last computed answer, kept in the cloud between app launches.
 *
 * Both halves of the Renovate view cost a search against the smallest budget
 * GitHub gives, thirty requests a minute, and the dashboard half then parses a
 * body per repository. Doing that while somebody waits is what made the tab
 * take as long as it did, and doing it on every open is what kept spending
 * that budget.
 *
 * Same shape as the Dependabot sweep beside it, and for the same reasons:
 * stored compressed, because these bodies are large and repetitive; refused
 * rather than truncated when too large, because a partial answer here reads as
 * an organization with less pending than it has; and served immediately with a
 * refresh behind the reader rather than in front of them.
 *
 * Two rows rather than one. The pull requests and the dashboards are refreshed
 * on the same schedule but are read by different views, and a single row would
 * make the cheaper view carry the more expensive one's payload.
 */

const TABLE = () => tableName("ALARMS_TABLE");

export type RenovateSnapshotKind =
  | "renovate-prs"
  | "renovate-dashboards"
  /**
   * The Dependabot pull request search, stored on the same schedule.
   *
   * It lives here rather than beside the Dependabot sweep because this module
   * is the general one: same row shape, same freshness window, same guards. The
   * name says what it holds.
   */
  | "dependabot-prs";

/** Two days, so a stale row cannot outlive the account it describes. */
const TTL_HOURS = 48;

/**
 * How old a stored answer may be and still be served without refreshing.
 *
 * An hour, which is what was asked for and is the right order of magnitude:
 * Renovate self-hosted runs on a schedule measured in hours, so a fresher
 * answer would mostly re-read a body that had not changed.
 */
export const FRESH_MS = 60 * 60_000;

/** DynamoDB's item limit is 400KB; this leaves room for the rest of the row. */
const MAX_PAYLOAD = 380_000;

export interface StoredRenovate<T> {
  data: T;
  computedAt: string;
}

/** Why the last save did not happen, per row, or null if it did. */
const problems: Partial<Record<RenovateSnapshotKind, string>> = {};

/** Whether storage is working, so the view can explain itself rather than just be slow. */
export function renovateSnapshotHealth(kind: RenovateSnapshotKind): {
  storing: boolean; problem: string | null;
} {
  return { storing: !problems[kind], problem: problems[kind] ?? null };
}

export async function saveRenovateSnapshot<T>(kind: RenovateSnapshotKind, data: T): Promise<void> {
  if (!hasTable("ALARMS_TABLE")) {
    problems[kind] = "No storage table is configured for this account, so the "
      + "answer cannot be kept between openings.";
    return;
  }

  try {
    const payload = gzipSync(Buffer.from(JSON.stringify(data), "utf8")).toString("base64");

    // Refused rather than truncated. Half a sweep here reports repositories as
    // having nothing pending when nobody looked at them, which is the one
    // answer this whole view exists to avoid producing.
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
      const kb = Math.round(Buffer.byteLength(payload) / 1024);
      problems[kind] = `This organization's Renovate data compresses to ${kb}KB, `
        + "past the 371KB a single row can hold, so it cannot be stored.";
      console.warn(`[Renovate] ${kind} compresses to ${kb}KB, which will not fit.`);
      return;
    }

    await docClient.send(new PutCommand({
      TableName: TABLE(),
      Item: {
        id: kind, kind: "renovate-snapshot",
        payload,
        computedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + TTL_HOURS * 3600,
      },
    }));
    problems[kind] = undefined;
    held[kind] = null;
  } catch (err: any) {
    // Never lets storing an answer cost the answer, but does say so: a write
    // that fails silently is a view that is slow forever with no visible cause.
    problems[kind] = `Could not be written to storage: ${err?.message ?? err}`;
    console.warn(`[Renovate] Could not store ${kind}: ${err?.message ?? err}`);
  }
}

/**
 * The decoded answer, held briefly in this process.
 *
 * The view makes two requests and each was reading and decompressing its own
 * row independently. The decoding is cheap; the round trip to DynamoDB is not.
 */
const held: Partial<Record<RenovateSnapshotKind, { at: number; value: any } | null>> = {};
const HOLD_MS = 15_000;

export async function readRenovateSnapshot<T>(
  kind: RenovateSnapshotKind,
): Promise<StoredRenovate<T> | null> {
  const hit = held[kind];
  if (hit && Date.now() - hit.at < HOLD_MS) return hit.value;
  if (!hasTable("ALARMS_TABLE")) return null;

  try {
    const res = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id: kind } }));
    const row: any = res.Item;
    if (!row?.payload) return null;

    const value = {
      data: JSON.parse(gunzipSync(Buffer.from(row.payload, "base64")).toString("utf8")) as T,
      computedAt: row.computedAt,
    };
    held[kind] = { at: Date.now(), value };
    return value;
  } catch (err: any) {
    // A corrupt or unreadable row must not take the view with it: the caller
    // falls back to computing, which is what it did before this existed.
    // Deliberately not held: holding a failure would keep answering with it.
    console.warn(`[Renovate] Could not read ${kind}: ${err?.message ?? err}`);
    return null;
  }
}

export function isRenovateFresh(
  stored: { computedAt?: string | null } | null,
  now = Date.now(),
): boolean {
  if (!stored?.computedAt) return false;
  const at = Date.parse(stored.computedAt);
  return Number.isFinite(at) && now - at < FRESH_MS;
}

/**
 * How often a background refresh may be started, and one at a time.
 *
 * The same guard the Dependabot sweep needed, for the same reason: without it,
 * every open of a view whose stored answer is older than the freshness window
 * starts a fresh org-wide search, and two opens start two.
 */
/**
 * How long before the *view* refreshes as a fallback.
 *
 * Longer than the hour the alarm pass warms these rows on, deliberately. Set
 * equal to the freshness window, as it first was, there is always a gap in
 * which the stored answer is stale but the pass has not run yet, and whoever
 * opens the view in that gap pays for the search. Three hours means the view
 * only does it when the pass has clearly stopped.
 */
const REFRESH_EVERY_MS = 3 * 60 * 60_000;

/** Whether the stored answer is old enough that the view should recompute it. */
export function isRenovateDueForRefresh(
  stored: { computedAt?: string | null } | null,
  now = Date.now(),
): boolean {
  if (!stored?.computedAt) return false;
  const at = Date.parse(stored.computedAt);
  return Number.isFinite(at) && now - at >= REFRESH_EVERY_MS;
}
const refreshing: Partial<Record<RenovateSnapshotKind, Promise<void> | null>> = {};
const lastRefreshAt: Partial<Record<RenovateSnapshotKind, number>> = {};

export function isRenovateRefreshing(kind: RenovateSnapshotKind): boolean {
  return !!refreshing[kind];
}

export async function refreshRenovateIfDue(
  kind: RenovateSnapshotKind,
  run: () => Promise<void>,
): Promise<void> {
  if (refreshing[kind]) return;
  if (Date.now() - (lastRefreshAt[kind] ?? 0) < REFRESH_EVERY_MS) return;

  refreshing[kind] = run()
    .catch(err => {
      console.warn(`[Renovate] Background refresh of ${kind} failed: ${err?.message ?? err}`);
    })
    .finally(() => {
      // Set on failure too. Retrying a broken search on every open is the
      // behaviour this exists to stop, and search is the tightest budget here.
      lastRefreshAt[kind] = Date.now();
      refreshing[kind] = null;
    });

  await refreshing[kind];
}

/** Clears everything, for tests that need each case to start clean. */
export function __resetRenovateSnapshots(): void {
  for (const k of ["renovate-prs", "renovate-dashboards", "dependabot-prs"] as RenovateSnapshotKind[]) {
    held[k] = null;
    refreshing[k] = null;
    lastRefreshAt[k] = 0;
    problems[k] = undefined;
  }
}
