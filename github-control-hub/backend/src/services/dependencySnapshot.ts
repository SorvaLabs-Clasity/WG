import { gzipSync, gunzipSync } from "node:zlib";
import { docClient, hasTable, tableName, PutCommand, GetCommand } from "../utils/dynamo";
import type { DependencyAlert } from "./dependencyService";

/**
 * The Vulnerabilities tab's last computed answer, kept between restarts.
 *
 * Working it out takes an org-wide alert sweep, a paged GraphQL status query
 * and a paged repository listing. On a small organization that is a second; on
 * one where Dependabot has just been switched on everywhere it is long enough
 * that the tab looks broken the first time it is opened after launch.
 *
 * The in-memory cache that already exists does not help there: a freshly
 * started process has none. So the answer is stored, the tab paints from it
 * immediately, and a refresh happens behind the reader rather than in front of
 * them.
 *
 * Stored **compressed**. A few thousand alerts is well past DynamoDB's 400KB
 * item limit as JSON, and this data is extremely repetitive, so gzip takes it
 * to a small fraction of that. Trimming rows instead, as the widget snapshots
 * do, is wrong here: a widget snapshot backs a count and a preview, and this
 * backs the table itself, where a missing repository is a repository somebody
 * concludes is clean.
 */

const TABLE = () => tableName("ALARMS_TABLE");
const ROW_ID = "dependency-snapshot";

/** Two days, so a stale row cannot outlive the account it describes. */
const TTL_HOURS = 48;

/**
 * How old a stored answer may be and still be served.
 *
 * Ten minutes because that is roughly how often the underlying data changes:
 * GitHub rescans on its own schedule, and an alert that appeared thirty seconds
 * ago is not visible to us any sooner by asking again. Anything older is still
 * shown, with its age, while a fresh one is fetched.
 */
export const FRESH_MS = 10 * 60_000;

/**
 * How stale the stored copy must be before a pass that has already swept
 * bothers to refresh it.
 *
 * Half an hour, not the five-minute tick. Refreshing it every tick would add
 * the two marker reads to every pass forever, which is about eight requests a
 * time, for a screen nobody may open all day. Half an hour keeps a cold open
 * minutes-fresh at a twelfth of that, and is well inside how often GitHub
 * rescans anyway.
 */
export const WARM_MS = 30 * 60_000;

export interface StoredSweep {
  alerts: DependencyAlert[];
  computedAt: string;
  /** True when the sweep behind this was partial, so the tab can say so. */
  degraded?: boolean;
}

export async function saveDependencySnapshot(
  alerts: DependencyAlert[], degraded = false,
): Promise<void> {
  if (!hasTable("ALARMS_TABLE")) return;
  try {
    const payload = gzipSync(Buffer.from(JSON.stringify(alerts), "utf8")).toString("base64");
    // Refused rather than truncated. A tab drawn from half a sweep reports
    // repositories as clean that were never looked at, and that is the one
    // answer this whole feature exists to avoid producing.
    if (Buffer.byteLength(payload) > 380_000) {
      console.warn(
        `[Dependencies] ${alerts.length} alerts compress to `
        + `${Math.round(Buffer.byteLength(payload) / 1024)}KB, which will not fit. `
        + "The tab will keep computing live.");
      return;
    }
    await docClient.send(new PutCommand({
      TableName: TABLE(),
      Item: {
        id: ROW_ID, kind: "dependency-snapshot",
        payload, count: alerts.length,
        ...(degraded ? { degraded: true } : {}),
        computedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + TTL_HOURS * 3600,
      },
    }));
  } catch (err: any) {
    // Never lets storing an answer cost the answer.
    console.warn(`[Dependencies] Could not store the sweep: ${err?.message ?? err}`);
  }
}

/** The stored answer, or null when there has never been one. */
export async function readDependencySnapshot(): Promise<StoredSweep | null> {
  if (!hasTable("ALARMS_TABLE")) return null;
  try {
    const res = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id: ROW_ID } }));
    const row: any = res.Item;
    if (!row?.payload) return null;
    const alerts = JSON.parse(
      gunzipSync(Buffer.from(row.payload, "base64")).toString("utf8")) as DependencyAlert[];
    return { alerts, computedAt: row.computedAt, degraded: !!row.degraded };
  } catch (err: any) {
    // A corrupt or unreadable row must not take the tab with it: the caller
    // falls back to computing, which is what it did before this existed.
    console.warn(`[Dependencies] Could not read the stored sweep: ${err?.message ?? err}`);
    return null;
  }
}

/** Whether a stored answer is recent enough to serve without waiting. */
export function isFresh(snapshot: StoredSweep | null, now = Date.now()): boolean {
  if (!snapshot?.computedAt) return false;
  const at = Date.parse(snapshot.computedAt);
  return Number.isFinite(at) && now - at < FRESH_MS;
}
