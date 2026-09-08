import { gzipSync, gunzipSync } from "node:zlib";
import { docClient, hasTable, tableName, PutCommand, GetCommand, scanAll } from "../utils/dynamo";

/**
 * A computed view, kept in the cloud between app launches.
 *
 * Named for Renovate once and already holding a Dependabot row when it was
 * renamed, which is the usual sign a thing has outgrown its name. It is the
 * general store now: any view expensive enough to be worth not recomputing
 * while somebody waits.
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

/**
 * The row's id, which is also its cache key.
 *
 * A free string rather than a union, because per-person views need the person
 * in the key: "shipped#alice#7" is one row and "shipped#bob#7" another. Callers
 * are expected to namespace with a prefix so the table stays readable.
 */
export type ViewKey = string;

/** Two days, so a stale row cannot outlive the account it describes. */
const TTL_HOURS = 48;

/**
 * How old a stored answer may be and still be left alone by the scheduled pass.
 *
 * An hour for the organization-wide rows: Renovate self-hosted runs on a
 * schedule measured in hours, so a fresher answer would mostly re-read a body
 * that had not changed.
 */
export const FRESH_MS = 60 * 60_000;

/**
 * How stale a stored answer may get before the *view* itself recomputes it.
 *
 * Longer than the hour the scheduled pass warms these rows on, deliberately.
 * Set equal to the freshness window, as it first was, there is always a gap in
 * which the stored answer is stale but the pass has not run yet, and whoever
 * opens the view in that gap pays for an organization-wide search against the
 * tightest budget GitHub gives, thirty requests a minute. Three hours means the
 * view only does that when the pass has clearly stopped.
 */
const REFRESH_EVERY_MS = 3 * 60 * 60_000;

/**
 * Both windows, per family of row, because these rows are not alike.
 *
 * The organization-wide rows above are searches, so the view avoids recomputing
 * them and leaves it to the pass. The per-person My Work rows read DynamoDB and
 * nothing else, cost no GitHub budget at all, and describe something that
 * changes while somebody works, so they are refreshed on the half hour and the
 * view is happy to do it itself when the pass has not.
 *
 * Matched on the key's prefix and kept here rather than passed in at each call:
 * `isViewFresh` and `isViewDue` and `refreshViewIfDue` all have to agree about a
 * row, and three arguments in three files is how they stop agreeing.
 */
const WINDOWS: { prefix: string; fresh: number; refresh: number }[] = [
  { prefix: "shipped#", fresh: 30 * 60_000, refresh: 30 * 60_000 },
];

function windowFor(kind: ViewKey): { fresh: number; refresh: number } {
  return WINDOWS.find(w => kind.startsWith(w.prefix))
    ?? { fresh: FRESH_MS, refresh: REFRESH_EVERY_MS };
}

/** DynamoDB's item limit is 400KB; this leaves room for the rest of the row. */
const MAX_PAYLOAD = 380_000;

export interface StoredView<T> {
  data: T;
  computedAt: string;
}

/** Why the last save did not happen, per row, or null if it did. */
const problems: Record<string, string | undefined> = {};

/** Whether storage is working, so the view can explain itself rather than just be slow. */
export function viewHealth(kind: ViewKey): {
  storing: boolean; problem: string | null;
} {
  return { storing: !problems[kind], problem: problems[kind] ?? null };
}

export async function saveView<T>(kind: ViewKey, data: T): Promise<void> {
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
      problems[kind] = `This answer compresses to ${kb}KB, past the 371KB a `
        + "single row can hold, so it cannot be stored.";
      console.warn(`[View] ${kind} compresses to ${kb}KB, which will not fit.`);
      return;
    }

    await docClient.send(new PutCommand({
      TableName: TABLE(),
      Item: {
        id: kind, kind: "view-snapshot",
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
    console.warn(`[View] Could not store ${kind}: ${err?.message ?? err}`);
  }
}

/**
 * The decoded answer, held briefly in this process.
 *
 * The view makes two requests and each was reading and decompressing its own
 * row independently. The decoding is cheap; the round trip to DynamoDB is not.
 */
const held: Record<string, { at: number; value: any } | null> = {};
const HOLD_MS = 15_000;

export async function readView<T>(
  kind: ViewKey,
): Promise<StoredView<T> | null> {
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
    console.warn(`[View] Could not read ${kind}: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Which stored views of a family exist, and how old each one is.
 *
 * For the per-person rows, which are the only ones whose keys are not known in
 * advance: a row exists because somebody opened the view, so the rows that
 * exist are exactly the set worth keeping warm. Nobody who has never opened it
 * gets work done on their behalf, and the row's own two-day expiry removes
 * people who have stopped.
 *
 * Projected down to the key and the timestamp. The scheduled pass only needs to
 * know what is stale; pulling the payloads to find that out would cost more
 * than recomputing them.
 */
export async function listViews(
  prefix: string,
): Promise<{ kind: ViewKey; computedAt: string }[]> {
  if (!hasTable("ALARMS_TABLE")) return [];
  const rows = await scanAll<any>(TABLE(), {
    filter: "#k = :view AND begins_with(id, :prefix)",
    names: { "#k": "kind" },
    values: { ":view": "view-snapshot", ":prefix": prefix },
    project: "id, computedAt",
  });
  return rows
    .filter(r => typeof r?.id === "string" && typeof r?.computedAt === "string")
    .map(r => ({ kind: r.id as ViewKey, computedAt: r.computedAt as string }));
}

export function isViewFresh(
  kind: ViewKey,
  stored: { computedAt?: string | null } | null,
  now = Date.now(),
): boolean {
  if (!stored?.computedAt) return false;
  const at = Date.parse(stored.computedAt);
  return Number.isFinite(at) && now - at < windowFor(kind).fresh;
}

/** Whether the stored answer is old enough that the view should recompute it. */
export function isViewDue(
  kind: ViewKey,
  stored: { computedAt?: string | null } | null,
  now = Date.now(),
): boolean {
  if (!stored?.computedAt) return false;
  const at = Date.parse(stored.computedAt);
  return Number.isFinite(at) && now - at >= windowFor(kind).refresh;
}
const refreshing: Record<string, Promise<void> | null> = {};
const lastRefreshAt: Record<string, number> = {};

export function isViewRefreshing(kind: ViewKey): boolean {
  return !!refreshing[kind];
}

/**
 * Starts a background refresh, at most one at a time and at most once a window.
 *
 * The same guard the Dependabot sweep needed, for the same reason: without it,
 * every open of a view whose stored answer is stale starts a fresh recompute,
 * and two opens start two.
 */
export async function refreshViewIfDue(
  kind: ViewKey,
  run: () => Promise<void>,
): Promise<void> {
  if (refreshing[kind]) return;
  if (Date.now() - (lastRefreshAt[kind] ?? 0) < windowFor(kind).refresh) return;

  refreshing[kind] = run()
    .catch(err => {
      console.warn(`[View] Background refresh of ${kind} failed: ${err?.message ?? err}`);
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
export function __resetViews(): void {
  for (const k of Object.keys(held)) held[k] = null;
  for (const k of Object.keys(refreshing)) refreshing[k] = null;
  for (const k of Object.keys(lastRefreshAt)) lastRefreshAt[k] = 0;
  for (const k of Object.keys(problems)) problems[k] = undefined;
}
