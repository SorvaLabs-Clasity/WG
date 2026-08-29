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
 * A larger budget for the aggregate, because it is not the same kind of read.
 *
 * A search runs while somebody types and has to come back before they finish
 * the word. The pulse runs once and is cached, so it can afford to walk
 * further, and it needs to: an organization writing five hundred rows a week
 * passes three thousand inside a month, and a count that quietly stops there
 * reports a plateau as if it were a total.
 *
 * Not unbounded, and the cache is what keeps it affordable. See PULSE_TTL_MS in
 * routes/activity.ts: at one walk every few minutes this is cents a month, and
 * at one walk per request it would not be.
 */
export const MAX_EXAMINED_FOR_PULSE = 6000;

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
  /**
   * False hides the important events: repositories going public, access being
   * granted, protection disappearing.
   *
   * They are the noisiest rows in the organization stream and the ones people
   * most often want on their own, which is the same pair of wishes the
   * detailed toggle exists for.
   */
  includeImportant?: boolean;
  /**
   * Which kinds to keep, when only some are wanted. Empty or absent means all
   * of them; it is a narrowing, not a whitelist that hides everything by
   * default.
   */
  importantKinds?: string[];
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

  // An important event is one that raised an alert, which the action says.
  // Rows written before the kind was recorded still match the on/off filter,
  // and are kept by a kind filter rather than silently dropped: they are the
  // same events, and hiding them because of when they were written would make
  // the filter lie about the history.
  const kind = (e as any).importantKind as string | undefined;
  if (e.action === "security.alert") {
    if (f.includeImportant === false) return false;
    if (f.importantKinds?.length && kind && !f.importantKinds.includes(kind)) return false;
  }

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

/* ────────────────────────────────────────────────────────────────────────
 * Aggregates for the Activity tab's header.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Actors that are not a person.
 *
 * "Most active" is a question about people. The app writes `system` on its own
 * background work, GitHub sends `github[system]` on enterprise rows, and bots
 * announce themselves with a `[bot]` suffix. Left in, the leaderboard is topped
 * by the scheduler every time and says nothing about anybody.
 */
const NOT_A_PERSON = new Set(["", "system", "unknown", "github", "github[system]", "ci"]);
// A hyphen before "bot" rather than the bare word, so somebody named Abbot or
// Botha stays a person.
const BOTISH = /\[bot\]$|-bot$|^bot-|^dependabot|^renovate|^github-actions|^system[ (]/i;

export function isPerson(actor: string | undefined): boolean {
  const a = (actor ?? "").trim().toLowerCase();
  return !!a && !NOT_A_PERSON.has(a) && !BOTISH.test(a);
}

export interface PulseBucket {
  /** Start of the bucket, ISO. */
  start: string;
  github: number;
  aws: number;
  app: number;
  total: number;
}

export interface ActivityPulse {
  buckets: PulseBucket[];
  /** Hours each bucket covers, so the caller can label the axis. */
  bucketHours: number;
  total: number;
  byCategory: Record<string, number>;
  topActors: { actor: string; count: number }[];
  topRepos: { repo: string; count: number }[];
  /** The commonest kinds of thing, by action. */
  topActions: { action: string; count: number }[];
  /**
   * Counts by hour of day, in the timezone the caller asked for.
   *
   * UTC was wrong for a reader: "busiest hour 14:00" means nothing to somebody
   * whose working day is in another zone, and the whole point of the number is
   * to recognise your own afternoon in it.
   */
  byHour: number[];
  /** One entry per calendar day in the window, oldest first. */
  byDay: { date: string; count: number }[];
  /** The zone the two above were computed in, so the label can name it. */
  timeZone: string;
  /**
   * The same window immediately before this one.
   *
   * A number is only interesting next to another number. Counted in the same
   * walk, so it costs nothing extra, and left null when the walk stopped before
   * reaching that far, because a previous period that was only half read would
   * make this week look like a spike.
   */
  previousTotal: number | null;
  /** Rows read to produce this. */
  examined: number;
  /**
   * True when the whole window was walked. False means the budget ran out
   * before the window did, so these are counts of *what was read*, not of what
   * happened, a different answer, and one the header has to say out loud.
   */
  exhausted: boolean;
  /** Oldest row actually counted, so a truncated answer can name its own edge. */
  oldest?: string;
}

/**
 * What has been happening, bucketed for a chart.
 *
 * Walks the feed newest-first within the same budget every other read here
 * uses. A busy organization will hit that budget before it reaches the far end
 * of a week, which is why `exhausted` and `oldest` come back with the counts:
 * a chart drawn from a truncated walk under a "last 7 days" heading is the
 * exact lie this codebase keeps having to remove.
 *
 * Deliberately no filters. This is the shape of everything, and the point of it
 * is to be the backdrop the filtered table sits in front of.
 */
export async function activityPulse(
  hours = 168,
  buckets = 24,
  timeZone = "UTC",
  deps?: { query?: (cursor: any) => Promise<{ items: ActivityEntry[]; next: any }> },
  /**
   * Rows the caller is allowed to count, by action.
   *
   * The chart is deliberately wider than the table it sits behind, narrowing
   * it to the current filter would make it agree with the table and stop being
   * a comparison. That is a statement about *filters*, though, and an AWS-only
   * deployment is not a filter: the feed drops GitHub rows there because an
   * account holding no GitHub credentials is not supposed to be able to read
   * GitHub history either. Counting them into the totals, the busiest hour, the
   * top actors and the top repositories published exactly that history through
   * a different route.
   */
  visible?: (action: string) => boolean,
): Promise<ActivityPulse> {
  const now = Date.now();
  const span = hours * 3_600_000;
  const bucketMs = span / buckets;
  const since = now - span;

  const out: PulseBucket[] = Array.from({ length: buckets }, (_, i) => ({
    start: new Date(since + i * bucketMs).toISOString(),
    github: 0, aws: 0, app: 0, total: 0,
  }));

  const byCategory: Record<string, number> = { github: 0, aws: 0, app: 0 };
  const actors = new Map<string, number>();
  const repos = new Map<string, number>();
  const actions = new Map<string, number>();
  const byHour = new Array(24).fill(0);
  const dayCounts = new Map<string, number>();

  /**
   * Local hour and calendar day, without doing date arithmetic by hand.
   *
   * One formatter, reused. Asking Intl per event is the only way to get this
   * right across a daylight-saving change inside the window, and at a few
   * thousand events behind a one-minute cache it costs nothing worth avoiding.
   *
   * An unknown zone throws rather than falling back, and a thrown formatter
   * would take the whole endpoint with it, so it is validated once here.
   */
  let zone = timeZone;
  let parts: Intl.DateTimeFormat;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    });
  } catch {
    zone = "UTC";
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    });
  }
  const localOf = (d: Date) => {
    const f = parts.formatToParts(d);
    const at = (t: string) => f.find(x => x.type === t)?.value ?? "00";
    return {
      // Intl gives 24 for midnight under hour12:false in some environments.
      hour: Number(at("hour")) % 24,
      date: `${at("year")}-${at("month")}-${at("day")}`,
    };
  };

  // The window before this one, walked in the same pass.
  const prevSince = since - span;
  let previousCount = 0;
  let reachedPrevious = false;

  let examined = 0;
  let total = 0;
  let oldest: string | undefined;
  let key: any;
  let exhausted = false;

  const readPage = deps?.query ?? (async (start: any) => {
    const res: any = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ACTIVITY" },
      ScanIndexForward: false,
      ExclusiveStartKey: start,
    }));
    return { items: (res.Items ?? []) as ActivityEntry[], next: res.LastEvaluatedKey };
  });

  do {
    const page = await readPage(key);
    for (const e of page.items) {
      examined++;
      const t = Date.parse(e.timestamp);
      // Newest-first, so the first row older than the window ends the walk:
      // everything behind it is older still.
      if (Number.isNaN(t)) continue;

      // Behind the window: keep going a little, to count the period before it.
      if (t < since) {
        if (t >= prevSince) {
          if (!visible || visible(e.action)) previousCount++;
          continue;
        }
        reachedPrevious = true;
        exhausted = true;
        break;
      }

      // After the window arithmetic, never before it: how far back the walk has
      // reached is a fact about timestamps, and skipping a row must not make the
      // walk think it has further to go.
      if (visible && !visible(e.action)) continue;

      oldest = e.timestamp;
      total++;

      const cat = categoryOf(e.action);
      if (cat in byCategory) byCategory[cat]++;

      const i = Math.min(buckets - 1, Math.max(0, Math.floor((t - since) / bucketMs)));
      const b = out[i];
      b.total++;
      if (cat === "github") b.github++;
      else if (cat === "aws") b.aws++;
      else b.app++;

      actions.set(e.action, (actions.get(e.action) ?? 0) + 1);

      // UTC on purpose. The rhythm of a week is a property of the organization,
      // and reading it in each viewer's own zone would give two people looking
      // at the same chart two different pictures of it.
      const local = localOf(new Date(t));
      byHour[local.hour]++;
      dayCounts.set(local.date, (dayCounts.get(local.date) ?? 0) + 1);

      // People, not the scheduler. See isPerson.
      if (isPerson(e.actor)) actors.set(e.actor, (actors.get(e.actor) ?? 0) + 1);

      // `repo` on an AWS row is a resource path, "github-control-hub/lambda/
      // alarm-evaluator", because the guardrail engine reuses the field to say
      // what a finding is about. Counting those as repositories put four
      // Lambdas at the top of "busiest repositories", which is true of the
      // field and false of the question.
      // "*" is the marker for organization-wide, written by rules that apply
      // everywhere. It is the one value in this field that names no repository,
      // so counting it puts "everywhere" at the top of "busiest repositories".
      if (e.repo && e.repo !== "*" && cat !== "aws") {
        repos.set(e.repo, (repos.get(e.repo) ?? 0) + 1);
      }
    }
    if (exhausted) break;
    key = page.next;
  } while (key && examined < MAX_EXAMINED_FOR_PULSE);

  const top = (m: Map<string, number>, name: "actor" | "repo") =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([k, count]) => ({ [name]: k, count })) as any[];

  return {
    buckets: out,
    bucketHours: bucketMs / 3_600_000,
    total,
    byCategory,
    topActors: top(actors, "actor"),
    topRepos: top(repos, "repo"),
    topActions: [...actions.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([action, count]) => ({ action, count })),
    byHour,
    // Every calendar day the window covers, including the empty ones. A chart
    // built only from days that have events draws a quiet week and a busy one
    // identically, and the gaps are the shape being looked for.
    byDay: daysBetween(since, now, zone).map(date => ({
      date, count: dayCounts.get(date) ?? 0,
    })),
    timeZone: zone,
    // Only where the walk actually got past the previous window. A partial
    // count compared against a complete one is a comparison that invents a
    // trend.
    previousTotal: reachedPrevious ? previousCount : null,
    examined,
    // Either the window ran out before the budget did, or the feed did.
    exhausted: exhausted || !key,
    oldest,
  };
}

/** Every calendar date between two instants, in a zone, oldest first. */
function daysBetween(fromMs: number, toMs: number, zone: string): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const out: string[] = [];
  const seen = new Set<string>();
  // Stepped in hours rather than days, so a day is never skipped across a
  // daylight-saving change that makes one of them 23 hours long.
  for (let t = fromMs; t <= toMs + 3_600_000; t += 3_600_000) {
    const d = fmt.format(new Date(t));
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}
