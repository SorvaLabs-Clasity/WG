/**
 * Open pull requests, and nudging the people holding them up.
 *
 * Only open ones, ever. A closed pull request is finished and listing it turns
 * a work queue into an archive nobody reads.
 *
 * "Stale" is measured from the last *commit*, not from when the pull request
 * was opened. A three-month-old branch someone pushed to this morning is alive;
 * a two-week-old one nobody has touched is not, and only the second is worth
 * anyone's attention. Opening date would flag the first and miss the second.
 */

export const STALE_DAYS = 7;

export type BlockReason =
  | "ready"           // nothing in the way; somebody just has to press merge
  | "needs-approval"  // waiting on reviewers who have not reviewed
  | "changes-requested"
  | "draft"
  | "conflict"
  | "checks-failing"
  | "blocked";        // GitHub says blocked and will not say why

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  /** Last commit on the branch. The clock this feature runs on. */
  lastCommitAt: string | null;
  isDraft: boolean;
  /** GitHub's own summary: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null. */
  reviewDecision: string | null;
  mergeable: string | null;
  /** Everyone asked to review, whether or not they have. */
  requestedReviewers: string[];
  /** Who has actually left a review, and what they said. */
  reviews: Array<{ login: string; state: string }>;
  /** Rolled-up check state: SUCCESS, FAILURE, PENDING, null when no checks ran. */
  checksState: string | null;
}

/**
 * Days since the last commit, or since the pull request opened when there is
 * no commit to read.
 *
 * A pull request with no readable commit date falls back to its creation date
 * rather than counting as fresh. Treating "unknown" as "just committed" would
 * mean the ones we cannot read are exactly the ones never chased.
 */
export function daysSinceLastCommit(pr: PullRequest, now = Date.now()): number {
  const basis = pr.lastCommitAt ?? pr.createdAt;
  const t = new Date(basis).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / 86_400_000);
}

export function isStale(pr: PullRequest, now = Date.now(), staleDays = STALE_DAYS): boolean {
  return daysSinceLastCommit(pr, now) >= staleDays;
}

/**
 * Who has actually reviewed, ignoring anything that is not a verdict.
 *
 * A COMMENTED review is somebody talking, not somebody approving, and treating
 * it as a review would let a "looks good!" with no approval silence the nudge
 * for a pull request that is still genuinely waiting.
 */
export function hasReviewed(pr: PullRequest, login: string): boolean {
  return pr.reviews.some(r =>
    r.login.toLowerCase() === login.toLowerCase()
    && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED"));
}

/** Requested reviewers who still owe a verdict. */
export function pendingReviewers(pr: PullRequest): string[] {
  return pr.requestedReviewers.filter(r => !hasReviewed(pr, r));
}

/**
 * What is actually holding this pull request up.
 *
 * Ordered by what a person would act on first. A draft is not waiting on
 * anyone, so it is reported as a draft rather than as missing approvals, and
 * conflicts come before checks because a conflicted branch cannot merge however
 * green it is.
 */
export function blockReason(pr: PullRequest): BlockReason {
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs-approval";
  if (pr.checksState === "FAILURE" || pr.checksState === "ERROR") return "checks-failing";
  if (pr.checksState === "PENDING") return "blocked";
  // APPROVED, or a repository that requires no review at all.
  if (pr.reviewDecision === "APPROVED" || pr.reviewDecision === null) return "ready";
  return "blocked";
}

/**
 * Who to nudge, and why.
 *
 * The rule asked for: waiting on approvals means the reviewers who have not
 * reviewed; anything else, including ready-to-merge, means the author. The
 * author is the only person who can act on a conflict, a failing check or a
 * merge that nobody has pressed.
 *
 * Paused logins are removed here rather than at send time, so a pull request
 * whose every remaining reviewer is paused produces no nudge at all instead of
 * a nudge addressed to nobody.
 */
export function nudgeTargets(
  pr: PullRequest,
  paused: { pr?: boolean; logins?: string[] } = {},
): { reason: BlockReason; targets: string[] } {
  const reason = blockReason(pr);
  if (paused.pr) return { reason, targets: [] };

  const pausedSet = new Set((paused.logins ?? []).map(l => l.toLowerCase()));
  const keep = (l: string) => l && !pausedSet.has(l.toLowerCase());

  if (reason === "needs-approval") {
    return { reason, targets: pendingReviewers(pr).filter(keep) };
  }
  // Everything else is the author's to move, ready-to-merge included.
  return { reason, targets: [pr.author].filter(keep) };
}

/**
 * Whether this pull request is due a nudge right now.
 *
 * Two clocks have to agree. The pull request must be stale — no commit for
 * STALE_DAYS — and it must be STALE_DAYS since the last nudge, so a long-idle
 * pull request is chased every seven days rather than on every pass.
 *
 * A commit resets both: `daysSinceLastCommit` drops below the threshold, so
 * nothing is due until seven fresh days have passed, which is the restart the
 * spec asks for and needs no separate bookkeeping.
 */
export function isNudgeDue(
  pr: PullRequest,
  lastNudgedAt: string | null,
  now = Date.now(),
  staleDays = STALE_DAYS,
): boolean {
  if (!isStale(pr, now, staleDays)) return false;
  if (!lastNudgedAt) return true;

  const last = new Date(lastNudgedAt).getTime();
  if (!Number.isFinite(last)) return true;

  // No special case for "the nudge predates the newest commit".
  //
  // There was one, and it was unreachable: staleness above already requires the
  // commit to be at least staleDays old, so any nudge older than that commit is
  // older than staleDays too and the interval check below returns true anyway.
  // A mutation removing it changed no outcome, which is how it was found.
  return (now - last) / 86_400_000 >= staleDays;
}

/** Oldest first, by the clock this feature runs on. */
export function sortByStaleness(prs: PullRequest[], now = Date.now()): PullRequest[] {
  return [...prs].sort((a, b) =>
    daysSinceLastCommit(b, now) - daysSinceLastCommit(a, now)
    || a.repo.localeCompare(b.repo)
    || a.number - b.number);
}

// ── fetching ──────────────────────────────────────────────────────────
//
// One GraphQL query for everything, rather than the REST equivalent of a list
// call plus three per pull request — reviews, commits and mergeability are
// separate endpoints. At fifty open pull requests that is over a hundred and
// fifty requests to answer one screen; this is one.

export const OPEN_PRS_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url createdAt isDraft mergeable reviewDecision
        headRefName baseRefName
        author { login }
        repository { nameWithOwner }
        commits(last: 1) {
          nodes { commit {
            committedDate
            statusCheckRollup { state }
          } }
        }
        reviewRequests(first: 25) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
        latestOpinionatedReviews(first: 25) {
          nodes { author { login } state }
        }
      }
    }
  }
}`;

type GraphQlFn = (query: string, variables: Record<string, unknown>) => Promise<any>;

/** Guards against an endless walk if a cursor stops advancing. */
const MAX_PAGES = 10;

export async function fetchOpenPrs(
  graphql: GraphQlFn,
  org: string,
): Promise<{ prs: PullRequest[]; truncated: boolean }> {
  const prs: PullRequest[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res: any = await graphql(OPEN_PRS_QUERY, {
      // `is:open` is load-bearing and asserted in the tests: without it this
      // returns every pull request ever opened, and the whole point is that a
      // closed one never appears.
      q: `is:pr is:open org:${org} archived:false`,
      cursor,
    });
    const search = res?.search;
    if (!search) break;

    for (const n of search.nodes ?? []) {
      if (!n || typeof n.number !== "number") continue;
      const commit = n.commits?.nodes?.[0]?.commit;
      prs.push({
        repo: n.repository?.nameWithOwner ?? "",
        number: n.number,
        title: n.title ?? "",
        url: n.url ?? "",
        author: n.author?.login ?? "unknown",
        headRef: n.headRefName ?? "",
        baseRef: n.baseRefName ?? "",
        createdAt: n.createdAt ?? "",
        lastCommitAt: commit?.committedDate ?? null,
        isDraft: !!n.isDraft,
        reviewDecision: n.reviewDecision ?? null,
        mergeable: n.mergeable ?? null,
        // Teams can be requested as reviewers. Only individuals are nudged —
        // there is no person behind a team handle to hold responsible, and
        // mentioning the team would notify people who were never asked.
        requestedReviewers: (n.reviewRequests?.nodes ?? [])
          .map((r: any) => r?.requestedReviewer)
          .filter((r: any) => r?.__typename === "User" && r.login)
          .map((r: any) => r.login),
        reviews: (n.latestOpinionatedReviews?.nodes ?? [])
          .filter((r: any) => r?.author?.login)
          .map((r: any) => ({ login: r.author.login, state: r.state })),
        checksState: commit?.statusCheckRollup?.state ?? null,
      });
    }

    if (!search.pageInfo?.hasNextPage) return { prs, truncated };
    cursor = search.pageInfo.endCursor ?? null;
    if (!cursor) return { prs, truncated };
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { prs, truncated };
}

// ── the nudge itself ──────────────────────────────────────────────────
//
// One sticky comment per pull request: the previous one is deleted and a fresh
// one posted, so the conversation carries exactly one reminder however many
// cycles have passed. A year of weekly nudges is one comment, not fifty-two.
//
// Deleted and reposted rather than edited, because editing a comment notifies
// nobody. The notification is the entire point, and GitHub only sends one for a
// new comment — so an edit would leave a tidy thread that reaches no one.

const MARKER = "<!-- github-control-hub:stale-pr -->";

const REASON_TEXT: Record<BlockReason, string> = {
  "ready": "This is approved and green — it just needs merging.",
  "needs-approval": "This is waiting on review.",
  "changes-requested": "Changes were requested and have not been addressed.",
  "draft": "This is still a draft.",
  "conflict": "This has conflicts with its base branch.",
  "checks-failing": "Checks are failing.",
  "blocked": "This is blocked from merging.",
};

export function buildNudgeComment(
  pr: PullRequest,
  reason: BlockReason,
  targets: string[],
  idleDays: number,
  nudgeNumber: number,
): string {
  const mentions = targets.map(t => `@${t}`).join(" ");
  const days = Math.floor(idleDays);
  const nth = nudgeNumber > 1 ? ` This is reminder ${nudgeNumber}.` : "";

  return [
    MARKER,
    `**No commits for ${days} days.**${nth}`,
    "",
    `${REASON_TEXT[reason]} ${mentions}`,
    "",
    `<sub>Posted by GitHub Control Hub. This reminder replaces itself rather than `
      + `adding a new comment each time. An organization admin can pause it.</sub>`,
  ].join("\n");
}

export interface NudgeDeps {
  listComments: (repo: string, number: number) => Promise<Array<{ id: number; body: string; authorIsApp: boolean }>>;
  deleteComment: (repo: string, id: number) => Promise<void>;
  postComment: (repo: string, number: number, body: string) => Promise<number | undefined>;
}

/**
 * Replace this pull request's reminder with a fresh one.
 *
 * The old comment is found by marker rather than only by stored id: a stored id
 * is lost if the row expires or somebody deletes the comment by hand, and
 * without the marker the next nudge would add a second comment rather than
 * replacing the first — which is exactly the pile-up this design exists to
 * avoid.
 *
 * Deleting first, then posting. The other order leaves two comments visible if
 * the delete fails, and a duplicate reminder is worse than a brief gap.
 */
export async function postStickyNudge(
  deps: NudgeDeps,
  pr: PullRequest,
  body: string,
  knownCommentId?: number,
): Promise<{ commentId?: number; removed: number }> {
  let removed = 0;

  let stale: number[] = [];
  try {
    const comments = await deps.listComments(pr.repo, pr.number);
    stale = comments.filter(c => c.authorIsApp && c.body.includes(MARKER)).map(c => c.id);
  } catch {
    // Could not read the thread. Fall back to the stored id so a failure here
    // does not turn into a duplicate comment.
    if (knownCommentId) stale = [knownCommentId];
  }

  for (const id of stale) {
    try { await deps.deleteComment(pr.repo, id); removed++; }
    catch { /* already gone, or not ours to delete */ }
  }

  const commentId = await deps.postComment(pr.repo, pr.number, body);
  return { commentId, removed };
}

export { MARKER as NUDGE_MARKER };
