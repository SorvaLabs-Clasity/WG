import type { ActivityEntry } from "./activityService";

/** One fetch from whichever store is behind the feed. */
export interface SourcePage {
  entries: ActivityEntry[];
  cursor?: string;
  /** False means the read budget ran out, not that there is nothing more. */
  exhausted: boolean;
  examined?: number;
}

export interface FilledPage {
  entries: ActivityEntry[];
  cursor?: string;
  exhausted: boolean;
  examined: number;
  /** How many extra fetches the refill cost. Zero on an unrestricted feed. */
  fetches: number;
  /** True when the bound stopped us with a short page that is not exhausted. */
  boundHit: boolean;
}

/**
 * A viewer's page of the activity feed, refilled after redaction.
 *
 * The bug this exists to prevent: redaction drops rows, so a page sliced to
 * `limit` by the store and only then redacted arrives short, while `cursor`
 * and `exhausted` still describe the rows the store returned. A restricted
 * viewer sees four rows marked exhausted and reads it as "nothing more
 * happened" — when in truth thirty things happened that they may not see.
 *
 * Reporting the number dropped would fix the arithmetic and break the
 * permission: `activity.read.app.rows` withholds the knowledge that those rows
 * exist, and "26 rows hidden" hands it straight back. So we refill instead,
 * and the viewer simply pages through the feed they are allowed.
 *
 * Bounded, because a viewer permitted almost nothing would otherwise turn one
 * request into a scan of the entire table. On hitting the bound we return what
 * we have with `exhausted` false and a real cursor: short, but honest, and
 * "load more" still works.
 *
 * **Only redaction earns a refill.** A short page has two possible causes and
 * they want opposite answers: `keep` dropped rows, which is this function's
 * whole reason to exist, or the source's own read budget ran out
 * (`MAX_EXAMINED_PER_REQUEST`), which has always meant "here is what fitted,
 * ask again" and has always been returned as-is. Looping on the second turned
 * one 3,000-row read into six for every viewer on a large table, flag or no
 * flag, and moved `examined` and the cursor with it. So the batch is measured
 * before and after `keep`: nothing removed, nothing to refill.
 *
 * That makes the refill inert wherever redaction is inert — which is exactly
 * the property the flag promises — and costs an unrestricted viewer nothing
 * when it is on, which a bound lowered to 1 by the flag would not.
 */
export async function fillPage(
  fetchPage: (cursor: string | undefined) => Promise<SourcePage>,
  keep: (entries: ActivityEntry[]) => Promise<ActivityEntry[]>,
  limit: number,
  startCursor: string | undefined,
  maxFetches = 6,
): Promise<FilledPage> {
  const entries: ActivityEntry[] = [];
  let cursor = startCursor;
  let exhausted = false;
  let examined = 0;
  let fetches = 0;

  while (true) {
    const page = await fetchPage(cursor);
    fetches++;
    examined += page.examined ?? 0;
    cursor = page.cursor;
    exhausted = page.exhausted;

    const kept = await keep(page.entries);
    const dropped = page.entries.length - kept.length;
    entries.push(...kept);

    // Deliberately not sliced back to `limit`. Slicing would discard rows this
    // cursor has already moved past — the same bug one layer down. `limit` is
    // a page-size hint, and overshooting it by less than one batch is harmless.
    if (entries.length >= limit || exhausted) break;
    // Nothing was redacted away, so this page is short because the source's
    // budget ran out — the pre-existing meaning of `exhausted: false`, and the
    // answer this route gave before the refill existed.
    if (dropped === 0) break;
    if (fetches >= maxFetches) break;
  }

  return {
    entries,
    cursor,
    exhausted,
    examined,
    fetches,
    boundHit: fetches >= maxFetches && !exhausted && entries.length < limit,
  };
}
