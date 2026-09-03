/**
 * "Only when the review is mine to do", in one place.
 *
 * Three screens ask this now: the notification when somebody requests a review,
 * the daily summary's list of reviews waiting on you, and the queue's "waiting
 * on you" section. They ask it of two differently shaped objects, a webhook
 * payload and a pull request row, which is exactly how a counting rule ends up
 * meaning three slightly different things and somebody stops trusting all of
 * them.
 *
 * The rule, stated once:
 *
 *   - **Everybody still awaiting review counts, you included.** A limit of 1
 *     means nobody else was asked, which is the case where the review does not
 *     happen without you.
 *   - **A team counts as one.** It is one more group who might pick it up, and
 *     counting it as nobody would make a request to four teams look like a
 *     request to one person.
 *   - **An unreadable list never withholds.** Silently dropping a review
 *     request on the strength of a number nobody could see leaves somebody
 *     waiting on a review they were never told about, which is worse than one
 *     notification too many.
 */

/** A limit worth applying, or nothing. */
function usable(limit: unknown): limit is number {
  return typeof limit === "number" && Number.isFinite(limit) && limit >= 1;
}

/**
 * Whether a review with this many people on it passes the limit.
 *
 * `total` of null means the list could not be read, which always passes.
 */
export function withinLimit(limit: number | null | undefined, total: number | null): boolean {
  if (!usable(limit)) return true;
  if (total === null) return true;
  return total <= limit;
}

/**
 * How many are on the hook, from a webhook payload.
 *
 * The payload lists the *other* outstanding reviewers, the reader having been
 * removed from it, so the reader is added back here.
 */
export function totalFromEvent(
  counts: { reviewers?: string[]; reviewerTeams?: string[] } | undefined,
): number | null {
  if (!counts?.reviewers) return null;
  return 1 + counts.reviewers.length + (counts.reviewerTeams?.length ?? 0);
}

/**
 * How many are on the hook, from a pull request row.
 *
 * `pending` is everybody still carrying a review request, the reader among
 * them, so unlike the payload it is already the whole number. Adding one here
 * would count the reader twice, which is the mistake this function exists to
 * make impossible.
 */
export function totalFromPull(
  pull: { pending?: string[]; pendingTeams?: string[] } | undefined,
): number | null {
  if (!pull?.pending) return null;
  return pull.pending.length + (pull.pendingTeams?.length ?? 0);
}

/** Applies a limit to a list of pull request rows, keeping the ones that pass. */
export function keepWithinLimit<T extends { pending?: string[]; pendingTeams?: string[] }>(
  rows: T[],
  limit: number | null | undefined,
): T[] {
  if (!usable(limit)) return rows;
  return rows.filter(row => withinLimit(limit, totalFromPull(row)));
}
