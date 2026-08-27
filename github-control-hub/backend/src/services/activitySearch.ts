/**
 * Searching and paging the activity feed, where the rows actually are.
 *
 * The tab used to fetch the newest hundred rows once and do everything in the
 * browser: paging, searching, every filter. That made the pager a lie. Page two
 * was the end of the list whatever the table held, and a search for a
 * repository touched last March matched nothing, because March was never
 * fetched. Twelve months in, the feed could hold fifty thousand rows and the
 * screen could reach a hundred of them.
 *
 * So filtering happens here. The complication is that DynamoDB's `Limit` counts
 * rows **read**, not rows that survive a filter, so asking for fifty matches
 * cannot be done in one request: the query is paged until enough match or the
 * examined budget runs out.
 *
 * That budget is the honest part. A search matching nothing in the last three
 * thousand rows returns no matches **and says it stopped early**, with a cursor
 * to carry on from, rather than reporting "no results" for a question it only
 * partly asked.
 */
import { docClient, usesDynamo, tableName, QueryCommand } from "../utils/dynamo";
import type { ActivityEntry } from "./activityService";

const TABLE = () => tableName("ACTIVITY_TABLE");

/**
 * How many rows one request may read before returning what it has.
 *
 * Every row shares one partition key, so a filter is applied after reading:
 * a rare search term would otherwise walk thirteen months of history in a
 * single request and time out. Three thousand is far enough to answer almost
 * every search on the first page, and small enough to stay fast when it does
 * not.
 */
export const MAX_EXAMINED_PER_REQUEST = 3000;

/**
 * Which stream an action belongs to.
 *
 * A copy of `frontend/src/lib/activityCategories.ts`, kept deliberately: the
 * two run in different processes and cannot import each other. `repro-activitycategories`
 * asserts the two lists agree, so the copy cannot drift silently.
 *
 * Longest match wins, so `template.apply` can differ from `template.create`:
 * applying a template changed repositories, creating one changed a setting in
 * this app.
 */
const PREFIXES: Array<[string, string]> = [
  ["aws.", "aws"],
  ["security.", "github"],
  ["sync.", "app"],
  ["widget.", "app"],
  ["scanner.", "app"],
  ["config.", "app"],
  ["exclusion.", "app"],
  ["template.create", "app"],
  ["template.update", "app"],
  ["template.delete", "app"],
  ["activity.", "app"],
  ["template.apply", "github"],
  ["branch.", "github"],
  ["repo.", "github"],
  ["github.", "github"],
  ["dependabot.", "github"],
  ["conflict.", "github"],
];

/** Unrecognised actions land in the organization stream on purpose: hiding
 *  something new in a tab nobody opens is how it stays unnoticed. */
export function categoryOf(action: string): string {
  let best: string | null = null, bestLen = -1;
  for (const [prefix, cat] of PREFIXES) {
    if (action.startsWith(prefix) && prefix.length > bestLen) { best = cat; bestLen = prefix.length; }
  }
  return best ?? "github";
}

export interface ActivityFilters {
  /** Free text over actor, action and details. */
  q?: string;
  source?: "app" | "github" | "audit";
  category?: "github" | "aws" | "app";
  repo?: string;
  target?: string;
  /** False hides rows written under detailed logging. */
  includeDetailed?: boolean;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /** Opaque; hand back to continue. Absent when the feed is exhausted. */
  cursor?: string;
  /** Rows read to produce this page, matched or not. */
  examined: number;
  /**
   * True when the whole feed was walked. False means the budget ran out and
   * there may be older matches behind the cursor, which is a different answer
   * from "there are none".
   */
  exhausted: boolean;
}

function encode(key: any): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}
function decode(cursor?: string): any {
  if (!cursor) return undefined;
  try { return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { return undefined; }   // a mangled cursor restarts rather than throwing
}

export function matches(e: ActivityEntry, f: ActivityFilters): boolean {
  if (f.source && e.source !== f.source) return false;
  if (f.category && categoryOf(e.action) !== f.category) return false;
  if (f.includeDetailed === false && (e as any).detailed) return false;

  if (f.repo) {
    if (!(e.repo ?? "").toLowerCase().includes(f.repo.toLowerCase())) return false;
  }
  if (f.target) {
    const t = f.target.toLowerCase();
    const hit = (e.target ?? "").toLowerCase().includes(t)
      || (e.prNumber !== undefined && String(e.prNumber) === t)
      || (e.commitSha ?? "").toLowerCase().includes(t);
    if (!hit) return false;
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    const hit = (e.actor ?? "").toLowerCase().includes(q)
      || (e.action ?? "").toLowerCase().includes(q)
      || (e.details ?? "").toLowerCase().includes(q)
      || (e.repo ?? "").toLowerCase().includes(q)
      || (e.target ?? "").toLowerCase().includes(q);
    if (!hit) return false;
  }
  return true;
}

/**
 * One page of matching rows, newest first.
 *
 * Only top-level rows are counted towards the page: a child belongs to its
 * parent and is attached by the caller, not paged separately.
 */
/**
 * One repository's rows, straight off `repo-index`.
 *
 * The index is keyed on `repo` with the timestamp as its sort key, so this is a
 * direct query: it costs the same whether the row is from this morning or from
 * fourteen months ago, and it returns every match rather than however many
 * turned up inside a read budget.
 *
 * Exact match, because a partition key has to be. A partial name falls back to
 * the scan below, which still works and is still bounded.
 */
async function searchByRepo(
  repo: string, filters: ActivityFilters, limit: number, cursor?: string,
): Promise<ActivityPage | null> {
  const entries: ActivityEntry[] = [];
  let key = decode(cursor);
  let examined = 0;

  do {
    const out: any = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      IndexName: "repo-index",
      KeyConditionExpression: "repo = :r",
      ExpressionAttributeValues: { ":r": repo },
      ScanIndexForward: false,
      Limit: 200,
      ExclusiveStartKey: key,
    }));
    const items = (out.Items ?? []) as ActivityEntry[];
    examined += items.length;

    // Nothing at all under this exact name: the caller meant a partial match,
    // and the scan path answers that better than an empty result does.
    if (examined === 0 && !cursor) return null;

    for (const e of items) {
      if (e.parentId) continue;
      // Every filter except the repository one, which the key already applied.
      if (!matches(e, { ...filters, repo: undefined })) continue;
      entries.push(e);
      if (entries.length >= limit) {
        return {
          entries,
          cursor: encode({ repo, sk: (e as any).sk, pk: (e as any).pk }),
          examined, exhausted: false,
        };
      }
    }
    key = out.LastEvaluatedKey;
  } while (key && examined < MAX_EXAMINED_PER_REQUEST);

  return { entries, ...(key ? { cursor: encode(key) } : {}), examined, exhausted: !key };
}

export async function searchActivity(
  filters: ActivityFilters,
  limit: number,
  cursor?: string,
  deps?: { query?: (cursor: any) => Promise<{ items: ActivityEntry[]; next: any }> },
): Promise<ActivityPage> {
  // An exact repository name is a key on `repo-index`, so it is answered
  // completely and at any depth rather than within the budget below.
  if (filters.repo && !deps?.query) {
    const direct = await searchByRepo(filters.repo, filters, limit, cursor);
    if (direct) return direct;
  }

  const entries: ActivityEntry[] = [];
  let examined = 0;
  let key = decode(cursor);
  let exhausted = false;

  const readPage = deps?.query ?? (async (start: any) => {
    const out: any = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ACTIVITY" },
      ScanIndexForward: false,
      // Read in chunks rather than one row at a time; the filter is applied
      // here, so a chunk that matches nothing costs one request, not many.
      Limit: 200,
      ExclusiveStartKey: start,
    }));
    return { items: (out.Items ?? []) as ActivityEntry[], next: out.LastEvaluatedKey };
  });

  while (entries.length < limit && examined < MAX_EXAMINED_PER_REQUEST) {
    const { items, next } = await readPage(key);
    examined += items.length;

    for (const e of items) {
      if (e.parentId) continue;              // attached to its parent, not paged
      if (!matches(e, filters)) continue;
      entries.push(e);
      if (entries.length >= limit) {
        // Resume from this row next time rather than from the chunk boundary,
        // or the rows after it in the same chunk would be skipped.
        key = { pk: (e as any).pk ?? "ACTIVITY", sk: (e as any).sk };
        return { entries, cursor: encode(key), examined, exhausted: false };
      }
    }

    key = next;
    if (!next) { exhausted = true; break; }
  }

  return {
    entries,
    ...(exhausted ? {} : { cursor: key ? encode(key) : undefined }),
    examined,
    exhausted,
  };
}

/** In-memory equivalent, for local development without DynamoDB. */
export function searchMemory(
  log: ActivityEntry[], filters: ActivityFilters, limit: number, offset = 0,
): ActivityPage {
  const all = log.filter(e => !e.parentId && matches(e, filters));
  const entries = all.slice(offset, offset + limit);
  const end = offset + entries.length;
  return {
    entries,
    ...(end < all.length ? { cursor: String(end) } : {}),
    examined: log.length,
    exhausted: end >= all.length,
  };
}

export { usesDynamo };
