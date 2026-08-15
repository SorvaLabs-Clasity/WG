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

/**
 * How long a pull request must sit without a commit before it is chased, and
 * how long between one reminder and the next.
 *
 * ───────────────────────────────────────────────────────────────────────
 *  TESTING: currently 10 seconds. Set back to SEVEN_DAYS when finished.
 * ───────────────────────────────────────────────────────────────────────
 *
 * One constant, in the code, governing the scheduled pass and the manual one
 * alike. It was briefly an environment variable, which was wrong twice over:
 * the scheduled pass runs in a Lambda that never saw a value set locally, so
 * changing it moved the button and nothing else — and how often people are
 * chased is a product decision, not a deployment detail.
 */
export const SEVEN_DAYS = 7 * 86_400;

export const STALE_SECONDS = 10;

/** The same threshold in days, for code and copy that still talk in days. */
export const STALE_DAYS = STALE_SECONDS / 86_400;

export function staleSeconds(): number {
  return STALE_SECONDS;
}

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
  /**
   * Why a merge is or is not possible: CLEAN, BLOCKED, DIRTY, BEHIND, UNSTABLE,
   * DRAFT, HAS_HOOKS, UNKNOWN.
   *
   * The field that distinguishes "checks failed and the rules require them"
   * (BLOCKED) from "checks failed and nothing requires them" (UNSTABLE), which
   * decides whether reviewers are worth chasing at all.
   */
  mergeStateStatus: string | null;
  /** Everyone asked to review, whether or not they have. */
  requestedReviewers: string[];
  /**
   * Reviews that still stand, per person.
   *
   * From latestReviews, not latestOpinionatedReviews. The latter keeps an
   * approval after the author has re-requested review from that person, so
   * somebody asked to look again reads as having already approved and is never
   * chased — which is exactly what happened the first time this ran for real.
   */
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

export function secondsSinceLastCommit(pr: PullRequest, now = Date.now()): number {
  return daysSinceLastCommit(pr, now) * 86_400;
}

export function isStale(pr: PullRequest, now = Date.now(), threshold = staleSeconds()): boolean {
  return secondsSinceLastCommit(pr, now) >= threshold;
}

/**
 * Whether this person's approval currently stands.
 *
 * "Currently" is the whole point. Re-requesting a review from somebody who has
 * already approved puts them back on the hook, and their old approval must stop
 * counting the moment that happens — otherwise the person being asked to look
 * again is the one person never reminded.
 *
 * This reads latestReviews, which GitHub empties on a re-request, rather than
 * latestOpinionatedReviews, which does not.
 */
export function hasApproved(pr: PullRequest, login: string): boolean {
  return pr.reviews.some(r =>
    r.login.toLowerCase() === login.toLowerCase() && r.state === "APPROVED");
}

/**
 * Requested reviewers whose approval does not currently stand.
 *
 * Everyone still carrying a review request is included, whatever their approval
 * counts for. A reviewer whose approval cannot satisfy the rule — no write
 * access, wrong team — was still asked, and is still not answering.
 */
export function pendingReviewers(pr: PullRequest): string[] {
  return pr.requestedReviewers.filter(r => !hasApproved(pr, r));
}

/**
 * Whether something other than missing approvals is stopping the merge.
 *
 * This decides whether reviewers are worth chasing at all. If the branch has
 * conflicts, or a required check is failing, no amount of approving fixes it —
 * the author has work to do, and reminding six reviewers would send six people
 * to look at a pull request they cannot help with.
 *
 * mergeStateStatus is what makes this answerable. BLOCKED means a rule is
 * unsatisfied; UNSTABLE means a check failed that no rule requires, so the
 * merge is still possible and reviews are still the thing missing.
 */
export function blockedByMoreThanApprovals(pr: PullRequest): boolean {
  if (pr.isDraft) return true;
  if (pr.mergeable === "CONFLICTING") return true;

  const state = pr.mergeStateStatus;
  if (state === "DIRTY" || state === "BEHIND" || state === "DRAFT") return true;

  // Somebody has asked for changes. Until the author addresses them, the other
  // reviewers have nothing to do.
  if (pr.reviewDecision === "CHANGES_REQUESTED") return true;

  if (state === "BLOCKED") {
    // Blocked with checks unhealthy means the checks are the blocker, whether
    // or not approvals are also missing. The author fixes checks; reviewers
    // cannot, so they are not chased.
    const checks = pr.checksState;
    if (checks === "FAILURE" || checks === "ERROR" || checks === "PENDING") return true;
    // Blocked purely on reviews. That is what reviewers are for.
    if (pr.reviewDecision === "REVIEW_REQUIRED") return false;
    // Blocked for a reason we cannot name. The author is the only safe target.
    return true;
  }

  return false;
}

/**
 * What is holding this up, for display.
 *
 * Ordered by what a person would act on first, and kept separate from who gets
 * reminded — the two questions have different answers, and conflating them is
 * how reviewers end up chased about a failing build.
 */
export function blockReason(pr: PullRequest): BlockReason {
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflict";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";

  if (pr.mergeStateStatus === "BLOCKED") {
    const checks = pr.checksState;
    if (checks === "FAILURE" || checks === "ERROR") return "checks-failing";
    if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs-approval";
    return "blocked";
  }

  if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs-approval";
  if (pr.checksState === "FAILURE" || pr.checksState === "ERROR") return "checks-failing";

  // Requested but not required still counts as waiting on review: GitHub
  // reports no decision at all when protection demands nothing, so a repository
  // with no rule reads as ready while somebody waits on a review they asked for.
  if (pr.reviewDecision === null && pendingReviewers(pr).length > 0) return "needs-approval";

  return "ready";
}

/**
 * Who to remind.
 *
 * The author is always included. They can chase people in person, they can
 * merge once it is possible, and they are the one person who always has
 * something they could do about it.
 *
 * Beyond that there is one question: is anything other than approvals stopping
 * this? If so, only the author — reviewers cannot fix a failing check or a
 * conflict, and reminding them wastes the attention this feature is spending.
 * If not, everyone still carrying a review request whose approval does not
 * currently stand, whether or not their approval is one the rule counts.
 *
 * Paused logins are removed here rather than at send time, so a pull request
 * with nobody left to name produces no reminder at all instead of one addressed
 * to nobody.
 */
export function nudgeTargets(
  pr: PullRequest,
  paused: { pr?: boolean; logins?: string[] } = {},
): { reason: BlockReason; targets: string[] } {
  const reason = blockReason(pr);
  if (paused.pr) return { reason, targets: [] };

  const pausedSet = new Set((paused.logins ?? []).map(l => l.toLowerCase()));
  const keep = (l: string) => !!l && !pausedSet.has(l.toLowerCase());

  const targets = [pr.author];
  if (!blockedByMoreThanApprovals(pr)) targets.push(...pendingReviewers(pr));

  // The author can also be a requested reviewer on their own pull request in
  // some setups; naming them twice reads as a mistake.
  const seen = new Set<string>();
  return {
    reason,
    targets: targets.filter(l => {
      const k = l.toLowerCase();
      if (!keep(l) || seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
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
  threshold = staleSeconds(),
): boolean {
  if (!isStale(pr, now, threshold)) return false;
  if (!lastNudgedAt) return true;

  const last = new Date(lastNudgedAt).getTime();
  if (!Number.isFinite(last)) return true;

  // No special case for "the nudge predates the newest commit".
  //
  // There was one, and it was unreachable: staleness above already requires the
  // commit to be at least staleDays old, so any nudge older than that commit is
  // older than staleDays too and the interval check below returns true anyway.
  // A mutation removing it changed no outcome, which is how it was found.
  return (now - last) / 1000 >= threshold;
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
        number title url createdAt isDraft mergeable mergeStateStatus reviewDecision
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
        latestReviews(first: 25) {
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
        mergeStateStatus: n.mergeStateStatus ?? null,
        // Teams can be requested as reviewers. Only individuals are nudged —
        // there is no person behind a team handle to hold responsible, and
        // mentioning the team would notify people who were never asked.
        requestedReviewers: (n.reviewRequests?.nodes ?? [])
          .map((r: any) => r?.requestedReviewer)
          .filter((r: any) => r?.__typename === "User" && r.login)
          .map((r: any) => r.login),
        reviews: (n.latestReviews?.nodes ?? [])
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

// ── the scheduled pass ────────────────────────────────────────────────

export interface NudgeRunDeps extends NudgeDeps {
  listPrs: () => Promise<{ prs: PullRequest[]; truncated: boolean }>;
  getState: (repo: string, number: number) => Promise<{
    lastNudgedAt?: string; lastCommentId?: number; nudgeCount?: number;
    paused?: boolean; pausedLogins?: string[];
  } | undefined>;
  recordNudge: (repo: string, number: number, commentId: number | undefined) => Promise<void>;
  now?: number;
  /** Overridable so a test can pin the interval the shipped constant may not be. */
  threshold?: number;
}

/**
 * One pass over every open pull request.
 *
 * Re-evaluates from scratch each time rather than trusting what was decided
 * last cycle: a reviewer may have approved since, the conflict may be resolved,
 * the block may have moved from approvals to a failing check. The spec asks for
 * exactly this — rerun the logic, see who still has not reviewed — and it also
 * means no state has to be kept beyond when we last posted.
 *
 * One pull request failing does not stop the rest. A repository the token
 * cannot comment on would otherwise silence every reminder behind it.
 */
export async function runNudgePass(deps: NudgeRunDeps): Promise<{
  considered: number; due: number; posted: number; skippedPaused: number; failed: number;
}> {
  const now = deps.now ?? Date.now();
  const threshold = deps.threshold ?? staleSeconds();
  const { prs } = await deps.listPrs();
  let due = 0, posted = 0, skippedPaused = 0, failed = 0;

  for (const pr of prs) {
    const state = await deps.getState(pr.repo, pr.number).catch(() => undefined);
    if (!isNudgeDue(pr, state?.lastNudgedAt ?? null, now, threshold)) continue;
    due++;

    const { reason, targets } = nudgeTargets(pr, {
      pr: state?.paused, logins: state?.pausedLogins,
    });
    // Nobody to name. Deliberately no comment and no recorded nudge: recording
    // one would start the seven-day clock again, so lifting the pause would be
    // followed by a week of silence rather than the next reminder.
    if (targets.length === 0) { skippedPaused++; continue; }

    try {
      const body = buildNudgeComment(
        pr, reason, targets, daysSinceLastCommit(pr, now), (state?.nudgeCount ?? 0) + 1);
      const { commentId } = await postStickyNudge(deps, pr, body, state?.lastCommentId);
      await deps.recordNudge(pr.repo, pr.number, commentId);
      posted++;
    } catch {
      failed++;
    }
  }

  return { considered: prs.length, due, posted, skippedPaused, failed };
}
