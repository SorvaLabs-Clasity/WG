/**
 * How long a pull request has been quiet, as something a person reads.
 *
 * The age itself is fractional, and has to be: the staleness threshold is
 * compared in seconds, so rounding it at the source would coarsen the rule
 * that decides which pull requests get nudged. That leaves rounding to the
 * moment it is rendered, which was done in one place and not the others, so
 * the same number appeared as "12h" on one screen and
 * "10.742989347923849d" on another.
 *
 * Floored rather than rounded, because "quiet 10 days" is a claim about
 * elapsed whole days. Rounding 10.7 up to 11 says a day that has not happened.
 */
export function idleLabel(days: number): string {
  const secs = Math.max(0, days * 86_400);
  // Under an hour still reads as at least a minute. "0m" looks like a missing
  // value rather than like something that just happened.
  if (secs < 3_600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 172_800) return `${Math.round(secs / 3_600)}h`;
  return `${Math.floor(days)}d`;
}

/** Whole days elapsed, for prose that counts them. */
export const wholeDays = (days: number) => Math.max(0, Math.floor(days));
