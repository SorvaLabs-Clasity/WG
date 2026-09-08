/**
 * Reading a self-hosted Renovate's Dependency Dashboard.
 *
 * Self-hosted Renovate is a job that runs and exits. There is no service to
 * connect to and no API: the hosted Mend app has a web dashboard, a self-hosted
 * bot has none. What it does have is the **Dependency Dashboard issue**, one per
 * repository, and everything worth knowing is in it: updates it tried and could
 * not make, updates it is holding back, updates waiting on a person, and every
 * dependency it can see.
 *
 * All of that is invisible from the pull request list, which is the only thing
 * this app looked at before. A repository where Renovate errors on every run
 * looks identical to one with nothing to do.
 *
 * The parse keys on the **HTML comment markers**, not the section headings.
 * That is the whole design decision here. Renovate writes markers like
 * `<!-- unlimit-branch=renovate/axios-1.x -->` and then reads them back to
 * learn which box somebody ticked, so they are a machine contract it cannot
 * casually change. The headings above them are prose: seventeen of them, worded
 * for people, and reworded between releases. Keying on the heading would make
 * this break quietly on a Renovate upgrade, and "quietly" is the part that
 * matters, because the failure would look like a repository with nothing
 * pending.
 *
 * The marker also carries the action, so the category comes from it rather than
 * from position in the document: an item under a heading this parser has never
 * heard of still lands in the right bucket if its marker is one of the ten.
 */
import {
  parseDependencyDashboard, categoryOf, tickDashboardBox,
} from "./src/services/renovateDashboard";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const BODY = [
  "This issue lists Renovate updates and detected dependencies.",
  "",
  "## Rate-Limited",
  "",
  "These updates are currently rate-limited.",
  "",
  " - [ ] <!-- unlimit-branch=renovate/axios-1.x -->Update dependency axios to v1.6.0",
  " - [ ] <!-- create-all-rate-limited-prs -->**Create all rate-limited PRs at once**",
  "",
  "## Errored",
  "",
  " - [ ] <!-- retry-branch=renovate/jackson -->Update dependency jackson to v2.15.0",
  "",
  "## Pending Approval",
  "",
  " - [x] <!-- approve-branch=renovate/react-18.x -->Update dependency react to v18",
  "",
  "## Awaiting Schedule",
  "",
  " - [ ] <!-- unschedule-branch=renovate/lodash-4.x -->Update dependency lodash to v4.17.21",
  "",
  "## Open",
  "",
  " - [ ] <!-- rebase-branch=renovate/express -->[Update dependency express](../pull/412)",
  "",
  "## Detected dependencies",
  "",
  "<details><summary>npm</summary>",
  "<blockquote>",
  "",
  "<details><summary>package.json</summary>",
  "",
  " - `lodash 4.17.20`",
  " - `axios 1.5.0`",
  "",
  "</details>",
  "",
  "</blockquote>",
  "</details>",
  "",
  "---",
  "",
  " - [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again",
].join("\n");

console.log("every actionable item, keyed on the marker Renovate reads back");
{
  const d = parseDependencyDashboard(BODY)!;

  check("all five per-branch items are found", d.items.length === 5, d.items.map(i => i.action));

  const byAction = Object.fromEntries(d.items.map(i => [i.action, i]));
  check("  the branch is carried, because that is what an action names",
    byAction.unlimit.branch === "renovate/axios-1.x", byAction.unlimit);
  check("  and the human title beside it",
    byAction.retry.title === "Update dependency jackson to v2.15.0", byAction.retry);

  // A box somebody already ticked is a request Renovate has not run yet.
  // Offering to tick it again would be offering to do nothing.
  check("  a ticked box is reported as ticked",
    byAction.approve.checked === true && byAction.unlimit.checked === false, d.items);

  // The "Open" section links to the pull request it would rebase.
  check("  and a linked item carries its pull request number",
    byAction.rebase.prNumber === 412, byAction.rebase);
  check("    with the link markup stripped from the title",
    byAction.rebase.title === "Update dependency express", byAction.rebase);
}

console.log("\nthe category comes from the marker, not from the heading above it");
{
  /**
   * Renovate writes seventeen headings and rewords them between releases. The
   * markers are what it reads back, so they are the stable half. An item under
   * a heading this parser has never seen still lands correctly.
   */
  check("rate-limited", categoryOf("unlimit") === "rate-limited");
  check("  errored", categoryOf("retry") === "errored");
  check("  awaiting schedule", categoryOf("unschedule") === "awaiting-schedule");
  check("  pending approval", categoryOf("approve") === "pending-approval");
  check("  open", categoryOf("rebase") === "open");
  check("  blocked", categoryOf("recreate") === "blocked");

  // The three approval markers are three different situations, and collapsing
  // them would tell somebody to tick a box that is not there.
  check("  and the three approvals stay apart",
    categoryOf("approvePr") !== categoryOf("approve")
      && categoryOf("approveGroup") !== categoryOf("approve"));

  // Proof rather than assertion: an item under a heading that does not exist
  // is still categorised, because only its marker was read.
  const invented = parseDependencyDashboard(
    "## Some Heading Renovate Has Not Written Yet\n\n"
    + " - [ ] <!-- retry-branch=renovate/thing -->Update thing")!;
  check("  an unknown heading does not lose the item",
    invented.items[0]?.action === "retry", invented.items);
}

console.log("\nthe bulk checkboxes are kept apart from the per-branch ones");
{
  const d = parseDependencyDashboard(BODY)!;

  // "Create all rate-limited PRs at once" has no branch. Treating it as one
  // would invent a branch named after a sentence.
  check("a bulk marker is not an item", d.items.every(i => i.branch.length > 0), d.items);
  check("  it is listed separately",
    d.bulk.some(b => b.marker === "create-all-rate-limited-prs"), d.bulk);
  check("  and so is the manual run trigger",
    d.bulk.some(b => b.marker === "manual job"), d.bulk);
}

console.log("\nthe dependency inventory, per ecosystem and manifest");
{
  const d = parseDependencyDashboard(BODY)!;
  check("the manifest is found", d.detected?.length === 1, d.detected);
  check("  under its ecosystem",
    d.detected?.[0].ecosystem === "npm" && d.detected?.[0].manifest === "package.json",
    d.detected?.[0]);
  check("  with its packages",
    d.detected?.[0].packages.join() === "lodash 4.17.20,axios 1.5.0", d.detected?.[0]);
}

console.log("\nnothing readable is null, never an empty dashboard");
{
  // A repository with no dashboard and a repository whose dashboard could not
  // be read are opposite claims. Only one of them means "nothing pending".
  check("an empty body", parseDependencyDashboard("") === null);
  check("  a missing body", parseDependencyDashboard(undefined) === null);
  check("  and prose with no markers and no sections",
    parseDependencyDashboard("Just some text.") === null);

  // But a real dashboard with nothing outstanding is a real answer.
  const quiet = parseDependencyDashboard(
    "This issue lists Renovate updates and detected dependencies.\n\n## Detected dependencies\n\n"
    + "<details><summary>npm</summary>\n<blockquote>\n\n<details><summary>package.json</summary>\n\n"
    + " - `lodash 4.17.21`\n\n</details>\n\n</blockquote>\n</details>");
  check("  while a dashboard with only an inventory is not nothing",
    quiet !== null && quiet.items.length === 0 && quiet.detected?.length === 1, quiet);
}

console.log("\nticking a box changes that line and nothing else");
{
  /**
   * This is the only channel a self-hosted bot has: Renovate re-reads its own
   * issue and acts on what is ticked. So "retry this update" is an edit to a
   * Markdown file, and the file also holds the inventory, the repository's
   * problems and every other pending update.
   */
  const after = tickDashboardBox(BODY, "retry-branch=renovate/jackson")!;

  check("the box is ticked",
    /- \[x\] <!-- retry-branch=renovate\/jackson -->/.test(after), after.slice(0, 0));

  // The strongest form of "nothing else changed": compare every other line.
  const before = BODY.split("\n");
  const now = after.split("\n");
  const differing = now.map((l, i) => (l === before[i] ? null : i)).filter(i => i !== null);
  check("  exactly one line differs", differing.length === 1, differing);

  // Indentation and bullet are the repository's, not ours. Normalising them
  // would be a diff on somebody's issue for no reason, on a body Renovate
  // rewrites every run.
  check("  and it keeps its own spacing",
    now[differing[0] as number].startsWith(" - [x]"), JSON.stringify(now[differing[0] as number]));

  // Everything the parser found must still be there afterwards, including the
  // inventory, which is the largest and easiest thing to lose.
  const reparsed = parseDependencyDashboard(after)!;
  check("  the rest of the dashboard survives intact",
    reparsed.items.length === 5 && reparsed.detected?.[0].packages.length === 2, reparsed);
  check("  and the ticked item now reads as ticked",
    reparsed.items.find(i => i.action === "retry")?.checked === true);
}

console.log("\nand a write that would change nothing does not happen");
{
  // Rewriting a body to make no change is a needless edit on somebody's issue,
  // and an already-ticked box is a request Renovate has not got to yet.
  check("an already-ticked box returns null",
    tickDashboardBox(BODY, "approve-branch=renovate/react-18.x") === null);
  check("  a marker that is not there returns null",
    tickDashboardBox(BODY, "retry-branch=renovate/does-not-exist") === null);

  // A marker that is a prefix of a real one must not match it: ticking the
  // wrong branch is an update nobody asked Renovate to make.
  check("  and a partial marker matches nothing",
    tickDashboardBox(BODY, "retry-branch=renovate/jack") === null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
