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

    entries.push(...await keep(page.entries));

    // Deliberately not sliced back to `limit`. Slicing would discard rows this
    // cursor has already moved past — the same bug one layer down. `limit` is
    // a page-size hint, and overshooting it by less than one batch is harmless.
    if (entries.length >= limit || exhausted) break;
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
