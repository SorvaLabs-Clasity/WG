/**
 * Asked before a full re-read of the organization, wherever it is triggered.
 *
 * There are two buttons for it, on Access and on Overview, and they must not
 * warn differently: one of them having the dialog and the other not is how
 * somebody learns the warning is optional.
 *
 * "Full GitHub recrawl" rather than "Sync data", because the old label read as
 * a refresh and this is not one. It re-reads every repository, team and member,
 * spends the organization's shared GitHub rate limit doing it, and runs in this
 * application rather than in AWS, so closing the window stops it partway.
 *
 * What it does *not* do is touch GitHub: it is read-only there, and it updates
 * the stored map by writing the differences rather than clearing it. Worth
 * knowing, and not worth putting in a dialog whose job is to slow somebody
 * down for a moment.
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
    + "This happens automatically once a day, and access changes arrive by webhook "
    + "within seconds regardless. Only run it now if you need a "
    + "change reflected before the next one."
  );
}
