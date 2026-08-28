/**
 * Who may start a full recrawl, and whether one is already going.
 *
 * A full recrawl re-reads every repository, team and member in the
 * organization. It spends the organization's shared GitHub budget, so two
 * people pressing the button ten minutes apart is pure waste, and two pressing
 * it at once is waste plus a race between two writers of the same table.
 *
 * Both answers come from state the aggregator already keeps in the org config,
 * so they are the same for everybody: the desktop app on one person's machine
 * and the nightly Lambda write to the same row and read the same row.
 *
 * **The nightly run counts.** It is a full recrawl like any other, so the hour
 * is measured from whichever ran last, scheduled or manual. A manual attempt at
 * 10:40pm, forty minutes after the 10pm walk, waits twenty minutes.
 *
 * The scheduled walk itself is never blocked by this. It is the reconciliation
 * pass that catches missed webhooks, and skipping it because somebody pressed
 * the button at 9:50pm would delay that by a day to save one crawl.
 */

/** How long after any full recrawl before another may be started by hand. */
export const RECRAWL_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * After this, a run that never said it finished is assumed dead.
 *
 * `runningSince` is cleared when a walk ends, including when it fails. What it
 * cannot survive is the process disappearing: the Lambda being killed at its
 * timeout, or somebody closing the desktop app mid-walk, which the dialog warns
 * about. Without a ceiling that would leave every screen in the organization
 * saying "recrawling" forever, and the button unusable with it.
 *
 * Comfortably past the Lambda's own 15-minute timeout, so a slow-but-alive run
 * is never declared dead while it is still writing.
 */
export const RUN_ASSUMED_DEAD_MS = 20 * 60 * 1000;

export interface AggregationRecord {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  edgeCount?: number;
  runningSince?: string;
  startedBy?: string;
}

export interface RecrawlState {
  /** A walk is under way. Every screen says so, whoever started it. */
  running: boolean;
  /** When it started, if one is running. */
  runningSince?: string;
  /** Who started it: a login, or "the nightly schedule". */
  startedBy?: string;
  /** Whole minutes since the last walk began, or null if there has never been one. */
  minutesSinceLast: number | null;
  /** Whole minutes to wait before another may be started. 0 when allowed. */
  waitMinutes: number;
  /** May somebody start one right now? */
  allowed: boolean;
}

/** How the schedule identifies itself, so the UI can name it in a sentence. */
export const SCHEDULE_ACTOR = "the nightly schedule";

const minutes = (ms: number) => Math.max(0, Math.ceil(ms / 60_000));

export function recrawlState(
  agg: AggregationRecord | undefined,
  now: number = Date.now(),
): RecrawlState {
  const startedMs = agg?.runningSince ? Date.parse(agg.runningSince) : NaN;
  // A `runningSince` that cannot be parsed is treated as no run rather than as
  // a run of unknown age, because the alternative locks the button on a value
  // nothing can clear.
  const running = Number.isFinite(startedMs) && now - startedMs < RUN_ASSUMED_DEAD_MS;

  const lastMs = agg?.lastAttemptAt ? Date.parse(agg.lastAttemptAt) : NaN;
  const sinceLast = Number.isFinite(lastMs) ? now - lastMs : null;

  // Measured from when the last walk *started*, not when it finished. A walk
  // that takes eight minutes would otherwise put the next one 68 minutes away,
  // and the number somebody is shown would not match the clock they watched.
  const waitMs = sinceLast === null ? 0 : Math.max(0, RECRAWL_COOLDOWN_MS - sinceLast);

  return {
    running,
    runningSince: running ? agg?.runningSince : undefined,
    startedBy: running ? agg?.startedBy : undefined,
    minutesSinceLast: sinceLast === null ? null : Math.floor(sinceLast / 60_000),
    waitMinutes: minutes(waitMs),
    allowed: !running && waitMs === 0,
  };
}

/**
 * Why the button is refused, in a sentence somebody can act on.
 *
 * Returns null when it is not refused. Written here rather than in the route so
 * the wording is the same whether it arrives as an error or is shown before the
 * click as a disabled reason.
 */
export function refusalReason(state: RecrawlState): string | null {
  if (state.running) {
    return `A full recrawl started by ${state.startedBy || "someone else"} is already running. `
      + `Wait for it to finish.`;
  }
  if (!state.allowed) {
    const ago = state.minutesSinceLast ?? 0;
    return `The organization was last recrawled ${ago} ${ago === 1 ? "minute" : "minutes"} ago. `
      + `You can run another in ${state.waitMinutes} `
      + `${state.waitMinutes === 1 ? "minute" : "minutes"}.`;
  }
  return null;
}
