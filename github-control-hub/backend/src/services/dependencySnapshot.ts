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

/**
 * Why the last save did not happen, or null if it did.
 *
 * Reported to the tab, because a snapshot that is never stored is invisible
 * from the outside and looks exactly like a tab that is simply slow: every
 * open recomputes the whole organization, forever, and nothing says so. That
 * is this codebase's oldest failure shape, an absence rendered as an answer,
 * and it costs a person an afternoon each time it recurs.
 */
let lastSaveProblem: string | null = null;

/** Whether the stored sweep is working, for the tab to explain itself with. */
export function snapshotHealth(): { storing: boolean; problem: string | null } {
  return { storing: lastSaveProblem === null, problem: lastSaveProblem };
}

export async function saveDependencySnapshot(
  alerts: DependencyAlert[], degraded = false,
): Promise<void> {
  if (!hasTable("ALARMS_TABLE")) {
    lastSaveProblem = "No storage table is configured for this account, "
      + "so the sweep cannot be kept between openings.";
    return;
  }
  try {
    const payload = gzipSync(Buffer.from(JSON.stringify(alerts), "utf8")).toString("base64");
    // Refused rather than truncated. A tab drawn from half a sweep reports
    // repositories as clean that were never looked at, and that is the one
    // answer this whole feature exists to avoid producing.
    if (Buffer.byteLength(payload) > 380_000) {
      const kb = Math.round(Buffer.byteLength(payload) / 1024);
      lastSaveProblem = `This organization's ${alerts.length} findings compress to `
        + `${kb}KB, past the 371KB a single row can hold, so the sweep cannot be stored.`;
      console.warn(
        `[Dependencies] ${alerts.length} alerts compress to ${kb}KB, which will not fit. `
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
    lastSaveProblem = null;
    // What was just written is newer than what is held.
    held = null;
  } catch (err: any) {
    // Never lets storing an answer cost the answer, but does say so: a write
    // that fails silently every time is a tab that is slow forever with no
    // visible cause.
    lastSaveProblem = `The sweep could not be written to storage: ${err?.message ?? err}`;
    console.warn(`[Dependencies] Could not store the sweep: ${err?.message ?? err}`);
  }
}

/**
 * The decoded sweep, held briefly in this process.
 *
 * Opening the tab makes three requests, and each was reading the row from
 * DynamoDB and decompressing it independently: the list, the severity counts,
 * and the age line. The decoding is cheap, about six milliseconds each, but the
 * round trip to DynamoDB is not, and from a laptop three of them in series is
 * the part somebody waits through.
 *
 * Fifteen seconds is chosen against what it costs to be wrong. The row itself
 * only changes when a sweep completes, and the age endpoint reads the stored
 * timestamp rather than this, so a caller can still see that a refresh has
 * landed. What this window can do is serve a list fifteen seconds behind a
 * sweep that finished mid-open, which nobody can perceive on data that is
 * allowed to be ten minutes old.
 */
let held: { at: number; value: StoredSweep | null } | null = null;
const HOLD_MS = 15_000;

/**
 * The read that is already running, shared rather than repeated.
 *
 * The window above could not help the case it was written for. The tab opens
 * two requests at once, the list and the severity counts, and both call this in
 * the same tick: neither has finished, so `held` is still empty, and both go on
 * to fetch and gunzip and parse the same multi-megabyte row. The second one is
 * pure waste, and because `gunzipSync` and `JSON.parse` block, it also holds up
 * every other request in flight behind it.
 *
 * The sweep cache and the Renovate reader beside it both share their in-flight
 * promise for exactly this reason. This is the same guard.
 */
let inFlight: Promise<StoredSweep | null> | null = null;

/** The stored answer, or null when there has never been one. */
export async function readDependencySnapshot(): Promise<StoredSweep | null> {
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  if (!hasTable("ALARMS_TABLE")) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id: ROW_ID } }));
      const row: any = res.Item;
      if (!row?.payload) return null;
      const alerts = JSON.parse(
        gunzipSync(Buffer.from(row.payload, "base64")).toString("utf8")) as DependencyAlert[];
      const value = { alerts, computedAt: row.computedAt, degraded: !!row.degraded };
      held = { at: Date.now(), value };
      return value;
    } catch (err: any) {
      // A corrupt or unreadable row must not take the tab with it: the caller
      // falls back to computing, which is what it did before this existed.
      // Deliberately not held: holding a failure would keep answering with it
      // for fifteen seconds after whatever caused it was fixed.
      console.warn(`[Dependencies] Could not read the stored sweep: ${err?.message ?? err}`);
      return null;
    } finally {
      // Cleared whatever happened, or one failure would be handed to every
      // later caller forever.
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * When the sweep was taken, without reading the sweep.
 *
 * The age line needs two scalar attributes and was decompressing two and a
 * half megabytes to get them, and pulling that payload over the wire from
 * DynamoDB to do it. The projection leaves the payload where it is.
 */
export async function readSnapshotAge(): Promise<{ computedAt: string | null; degraded: boolean }> {
  if (held && Date.now() - held.at < HOLD_MS) {
    return { computedAt: held.value?.computedAt ?? null, degraded: !!held.value?.degraded };
  }
  if (!hasTable("ALARMS_TABLE")) return { computedAt: null, degraded: false };
  try {
    const res = await docClient.send(new GetCommand({
      TableName: TABLE(), Key: { id: ROW_ID },
      ProjectionExpression: "computedAt, degraded",
    }));
    return {
      computedAt: (res.Item as any)?.computedAt ?? null,
      degraded: !!(res.Item as any)?.degraded,
    };
  } catch (err: any) {
    console.warn(`[Dependencies] Could not read the sweep's age: ${err?.message ?? err}`);
    return { computedAt: null, degraded: false };
  }
}

/** Drops the held copy, for a caller that has just changed what is stored. */
export function clearSnapshotHold(): void {
  held = null;
}

/**
 * How often the *tab* may start a refresh, as a fallback.
 *
 * Deliberately much longer than the hour the alarm pass warms this row on, and
 * that relationship is the point. They were the wrong way round: the pass
 * filled it hourly while the tab refreshed anything over half an hour old, so
 * the tab won every time and swept on every open regardless.
 *
 * Three hours means the tab only sweeps when the pass has clearly stopped
 * running, which is the only case where somebody opening the app should pay
 * for it.
 *
 * The tab used to start one on every open where the stored sweep was over ten
 * minutes old. Nothing keeps that sweep warm unless a Dependabot-backed alarm
 * happens to run, so on an account without one it was always over ten minutes
 * old, and every open began an organization-wide walk of seventy-odd pages.
 * Opening the app twice in a morning did it twice; clicking between tabs did
 * it concurrently, because there was no guard at all.
 *
 * Serving the stored copy instantly was never the problem. Deciding to
 * recompute *because somebody looked* was. Half an hour matches what the alarm
 * pass already uses to warm the same row, so the two cannot fight.
 */
export const REFRESH_EVERY_MS = 3 * 60 * 60_000;

/**
 * Whether the stored answer is old enough to be worth recomputing.
 *
 * Read from the stored timestamp rather than from anything this process
 * remembers, and that is the whole point of it. The first version of this
 * throttle kept `lastRefreshAt` in module state, which the desktop app resets
 * every time it is closed: the guard held within a session and was empty on
 * every launch, so the first open after starting the app swept the whole
 * organization whenever the stored answer was over ten minutes old, which it
 * almost always is. Close the app, reopen, open the tab, sweep again.
 *
 * `computedAt` is the time of the last successful refresh and it is in
 * DynamoDB, so a process that has just started reaches the same decision as one
 * that has been running for hours.
 *
 * Nothing stored is deliberately **not** due: that is a first open, which
 * computes live rather than serving a stale answer and refreshing behind it.
 */
export function isDueForRefresh(
  stored: { computedAt?: string | null } | null,
  now = Date.now(),
): boolean {
  if (!stored?.computedAt) return false;
  const at = Date.parse(stored.computedAt);
  if (!Number.isFinite(at)) return false;
  return now - at >= REFRESH_EVERY_MS;
}

let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;

/** Whether a background sweep is running right now, so the tab can say so. */
export function isRefreshing(): boolean {
  return refreshing !== null;
}

/**
 * Start a background refresh, unless one is running or one ran recently.
 *
 * Returns when the decision is made, not when the sweep finishes: the caller
 * has already answered its reader from storage and is not waiting for this.
 *
 * The clock is set when the sweep *finishes*, not when it starts, so a walk
 * that takes four minutes does not immediately permit another.
 */
export async function refreshIfDue(
  run: () => Promise<void>,
  opts: { force?: boolean } = {},
): Promise<void> {
  // Two guards, covering two different things. This one stops a second request
  // in the same session starting a second sweep while the first is running.
  if (refreshing) return;
  // And this one stops a sweep that has just finished being repeated. The
  // durable half of the throttle is isDueForRefresh, read from the stored
  // timestamp, because neither of these survives the process being killed.
  //
  // `force` is for a caller that has just *changed* something. The throttle
  // exists to stop reads recomputing the same answer; it should not stop a
  // write from being reflected. The guard above still applies either way.
  if (!opts.force && Date.now() - lastRefreshAt < REFRESH_EVERY_MS) return;

  refreshing = run()
    .catch(err => {
      // Swallowed deliberately: nobody is awaiting this, and an unhandled
      // rejection from a refresh would take the process down.
      console.warn(`[Dependencies] Background refresh failed: ${err?.message ?? err}`);
    })
    .finally(() => {
      // Set even on failure. Retrying a broken sweep on every open is the
      // behaviour this whole function exists to stop.
      lastRefreshAt = Date.now();
      refreshing = null;
    });

  await refreshing;
}

/**
 * Recompute because something just changed, once, however many asked.
 *
 * The three write paths, enabling a repository, disabling one, and the bulk
 * action, each called the rebuild directly. That skipped every guard: two
 * toggles in a row started two concurrent organization-wide walks, each of them
 * paging every repository twice through calls that are not cached, and neither
 * showed up in `isRefreshing`, so the tab reported "not refreshing" while two
 * sweeps were running and its timestamp sat still.
 *
 * A sweep already in flight started before the change and would store an answer
 * that does not contain it, so this waits for that one and then runs, rather
 * than returning and leaving the change unrecorded. Only ever one waiting:
 * three toggles in a row need one rebuild between them, not three.
 */
let queued: Promise<void> | null = null;

export async function refreshNow(run: () => Promise<void>): Promise<void> {
  // One is already waiting to run after the current sweep. It has not started
  // yet, so it will see this change too.
  if (queued) return queued;

  queued = (async () => {
    // Yielded once, before anything below touches `queued`.
    //
    // An async function runs synchronously up to its first `await`, so without
    // this the body's `queued = null` happens *before* the assignment below it,
    // and the slot is then occupied by a finished promise for the life of the
    // process: every later change returns that promise and no rebuild ever runs
    // again. A behavioural test caught this; a source scan could not have.
    await Promise.resolve();

    try {
      // Whatever is running started before this change and will store an
      // answer that does not contain it.
      if (refreshing) await refreshing;

      // Cleared here, as the new sweep starts, and not when it finishes. A
      // change made *during* a sweep needs its own follow-up: that sweep began
      // before it and cannot contain it either. Clearing this at the end would
      // mean the whole run counted as "one already waiting" and the change made
      // halfway through it would never be picked up.
      queued = null;
      await refreshIfDue(run, { force: true });
    } catch (err: any) {
      // Nobody is awaiting this; every caller starts it with `void`. An
      // unhandled rejection from a rebuild would take the process down.
      queued = null;
      console.warn(`[Dependencies] Rebuild after a change failed: ${err?.message ?? err}`);
    }
  })();

  await queued;
}

/** Clears the throttle and the held read, for tests that start clean. */
export function __resetRefreshState(): void {
  refreshing = null;
  lastRefreshAt = 0;
  held = null;
  inFlight = null;
  queued = null;
}

/** Whether a stored answer is recent enough to serve without waiting. */
export function isFresh(
  // Only the timestamp is read, so the age endpoint can pass what it has
  // without having decoded a sweep to get it.
  snapshot: { computedAt?: string | null } | null,
  now = Date.now(),
): boolean {
  if (!snapshot?.computedAt) return false;
  const at = Date.parse(snapshot.computedAt);
  return Number.isFinite(at) && now - at < FRESH_MS;
}
