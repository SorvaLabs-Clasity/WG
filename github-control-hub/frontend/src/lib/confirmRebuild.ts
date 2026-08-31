/**
 * Asked before a full re-read of the organization, wherever it is triggered.
 *
 * Shared by the buttons on Access and Overview: one of them warning and the
 * other not is how somebody learns the warning is optional.
 *
 * "Full GitHub recrawl" rather than "Sync data", because this is not a refresh.
 * It re-reads every repository, team and member, spends the organization's
 * shared rate limit, and runs in this application, so closing the window stops
 * it partway.
 *
 * The cadence quoted here belongs to infra/cdk-stack.ts
 * ("NightlyGraphRebuild", 22:00 America/New_York). A number typed from memory
 * goes stale the next time that schedule moves.
 */
export function confirmRebuild(edgeCount?: number): boolean {
  const stored = edgeCount
    ? `all ${edgeCount.toLocaleString()} stored connections`
    : "everything currently stored";
  return window.confirm(
    "Run a full GitHub recrawl?\n\n"
    + `This re-reads every repository, team and member in the organization and `
    + `updates ${stored} with whatever has changed.\n\n`
    + "\u2022 Takes several minutes\n"
    + "\u2022 Uses the organization's shared GitHub rate limit, so it can slow "
    + "the app down for everyone\n"
    + "\u2022 Runs in this app, so leave it open until it finishes\n\n"
    + "\u2022 At most one an hour for the whole organization, counting the "
    + "scheduled one\n\n"
    + "This happens automatically every night at 10pm Eastern, and access changes "
    + "arrive by webhook within seconds regardless. Only run it now if you need a "
    + "change reflected before tonight."
  );
}
