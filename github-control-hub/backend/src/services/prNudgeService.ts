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
 * One constant, in the code, governing the scheduled pass and the manual one
 * alike. It was briefly an environment variable, which was wrong twice over:
 * the scheduled pass runs in a Lambda that never saw a value set locally, so
 * changing it moved the manual button and nothing else — and how often people
 * are chased is a product decision, not a deployment detail.
 *
 * To exercise the behaviour in seconds rather than fortnights, set
 * STALE_SECONDS to 10 and deploy. The page shows a banner and the test suite
 * prints a note while it is anything other than seven days, so it cannot be
 * left turned down unnoticed.
 */
export const SEVEN_DAYS = 7 * 86_400;

export const STALE_SECONDS = SEVEN_DAYS;

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
  | "behind"          // base branch has moved on; the author must update
  | "checks-failing"
  | "checks-pending"  // still running, so nobody can do anything yet
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
 * What is holding this up.
 *
 * The single source of truth for both the message and the targeting. They were
 * two functions computing the same thing independently, and seventeen
 * combinations of merge state, review decision and check state made them
 * disagree — the comment announcing "waiting on review" while deliberately
 * telling no reviewer anything, because a pending check had shielded them.
 *
 * Ordered so that everything the author alone can fix is decided before
 * approvals are considered at all.
 */
export function blockReason(pr: PullRequest): BlockReason {
  const state = pr.mergeStateStatus;

  if (pr.isDraft || state === "DRAFT") return "draft";
  if (pr.mergeable === "CONFLICTING" || state === "DIRTY") return "conflict";
  if (state === "BEHIND") return "behind";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";

  if (state === "BLOCKED") {
    const checks = pr.checksState;
    // Only when the state is BLOCKED do failing checks mean anything: UNSTABLE
    // is a check that failed with no rule requiring it, so the merge is still
    // possible and reviews are still the thing missing.
    if (checks === "FAILURE" || checks === "ERROR") return "checks-failing";
    if (checks === "PENDING") return "checks-pending";
    if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs-approval";
    return "blocked";
  }

  if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs-approval";

  // Requested but not required still counts as waiting: GitHub reports no
  // decision at all when protection demands nothing, so a repository with no
  // rule reads as ready while somebody waits on a review they asked for.
  if (pr.reviewDecision === null && pendingReviewers(pr).length > 0) return "needs-approval";

  return "ready";
}

/**
 * The two states where reviewers are worth chasing.
 *
 * Derived from the reason rather than recomputed, so the comment cannot say one
 * thing while the mention list does another.
 */
const REVIEWERS_CAN_HELP: ReadonlySet<BlockReason> = new Set(["ready", "needs-approval"]);

/**
 * Whether something other than missing approvals is stopping the merge.
 *
 * If so, no amount of approving fixes it — the author has work to do, and
 * reminding six reviewers would send six people to look at a pull request they
 * cannot help with.
 */
export function blockedByMoreThanApprovals(pr: PullRequest): boolean {
  return !REVIEWERS_CAN_HELP.has(blockReason(pr));
}

/**
 * Every reason a person might not be reminded, in one shape.
 *
 * Kept as a scope rather than a boolean so the screen can say which switch is
 * silencing whom. "Nobody was reminded" with no explanation is the state that
 * gets reported as the feature being broken.
 */
export type MuteScope = "everywhere" | "repository" | "this pull request";

export interface MuteRules {
  /** The whole pull request is paused. Nobody is reminded. */
  prPaused?: boolean;
  /** Muted on this pull request only. */
  prLogins?: string[];
  /** Muted across this repository. */
  repoLogins?: string[];
  /** Muted everywhere. */
  globalLogins?: string[];
}

const has = (list: string[] | undefined, login: string) =>
  (list ?? []).some(l => l.trim().toLowerCase() === login.trim().toLowerCase());

/** Which rule silences this person, or null if none does. */
export function mutedBy(login: string, rules: MuteRules): MuteScope | null {
  if (has(rules.globalLogins, login)) return "everywhere";
  if (has(rules.repoLogins, login)) return "repository";
  if (has(rules.prLogins, login)) return "this pull request";
  return null;
}

/**
 * Who to remind, and who was left out and why.
 *
 * The author is always a candidate. They can chase people in person, they can
 * merge once it is possible, and they are the one person who always has
 * something they could do about it.
 *
 * Beyond that there is one question: is anything other than approvals stopping
 * this? If so, only the author — reviewers cannot fix a failing check or a
 * conflict, and reminding them wastes the attention this feature spends. If
 * not, everyone still carrying a review request whose approval does not
 * currently stand.
 *
 * Mutes are applied last and reported rather than silently dropped, so a pull
 * request that reminds nobody can say which rule did it.
 */
export function nudgeTargets(
  pr: PullRequest,
  rules: MuteRules = {},
): {
  reason: BlockReason;
  targets: string[];
  muted: Array<{ login: string; scope: MuteScope }>;
} {
  const reason = blockReason(pr);

  const candidates = [pr.author];
  if (!blockedByMoreThanApprovals(pr)) candidates.push(...pendingReviewers(pr));

  // The author can also be a requested reviewer on their own pull request in
  // some setups; naming them twice reads as a mistake.
  const seen = new Set<string>();
  const unique = candidates.filter(l => {
    const k = (l ?? "").trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // A paused pull request silences everyone, and says so for each of them
  // rather than reporting an empty list with no cause.
  if (rules.prPaused) {
    return {
      reason, targets: [],
      muted: unique.map(login => ({ login, scope: "this pull request" as const })),
    };
  }

  const targets: string[] = [];
  const muted: Array<{ login: string; scope: MuteScope }> = [];
  for (const login of unique) {
    const scope = mutedBy(login, rules);
    if (scope) muted.push({ login, scope });
    else targets.push(login);
  }
  return { reason, targets, muted };
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
query($q: String!, $cursor: String, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first, after: $cursor) {
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
        reviewRequests(first: 10) {
          totalCount
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
        latestReviews(first: 10) {
          totalCount
          nodes { author { login } state }
        }
      }
    }
  }
}`;

type GraphQlFn = (query: string, variables: Record<string, unknown>) => Promise<any>;

/**
 * Page sizes, largest first, stepped down when GitHub gives up on one.
 *
 * The cost of this query is in its nested connections — the last commit, the
 * requested reviewers and the latest reviews are resolved per pull request, and
 * fifty of them at once exceeded GitHub's own execution budget on a real org.
 * That arrives as an HTML 502 or 504 from the edge rather than a GraphQL error,
 * with nothing said about why.
 *
 * A fixed smaller number would have been tuned to one organization on one day.
 * Backing off on failure fits whatever the org actually is, and costs a wasted
 * request only on the orgs that need it.
 */
/**
 * Page sizes, largest first, stepped down when GitHub gives up on one.
 *
 * Finer steps than [30, 15, 5], because a page that is smaller than it needs to
 * be is not free: the walk pays a fixed ~1.4s per request, so halving the page
 * doubles the requests and makes the whole thing slower. On an organization
 * where 25 works and 50 does not, dropping straight from 30 to 15 skipped the
 * only sizes worth using.
 */
const PAGE_SIZES = [30, 24, 18, 12, 6];

/** Reviewers read per pull request. See the warning where it is compared. */
const REVIEW_PAGE = 10;

/**
 * The page size that last worked, remembered across calls.
 *
 * Backing off costs a timeout per step — GitHub takes about eleven seconds to
 * give up on a page it cannot compute — and rediscovering the same answer on
 * every request meant every load of the pull request tab paid that tax again.
 * On an organization that needs the smallest page, opening the tab cost two
 * dead requests before the first useful one, which is most of the twenty
 * seconds people were waiting.
 *
 * Starting from the last size that worked makes the cost one-off. It is only
 * ever an optimisation: a remembered size that has since become too expensive
 * backs off exactly as it did before, and one that is now too cautious is
 * retried upward below.
 */
let lastGoodSize = 0;

/** Whether the stored size has been read yet in this process. */
let loadedStored = false;

/** Reset between tests, which need a predictable starting point. */
export function __resetPageSizeForTests(): void {
  lastGoodSize = 0;
  sinceStepUp = 0;
  loadedStored = true;   // tests supply their own starting point
}

/**
 * Lets the stored size be read again, the way a fresh process would.
 *
 * `__resetPageSizeForTests` deliberately marks the stored value as already read,
 * so a test can set its own starting point without storage interfering. Testing
 * that a restart picks the value up needs the opposite.
 */
export function __allowStoredPageSizeReload(): void {
  loadedStored = false;
}

/**
 * The size this organization settled on last time, read once per process.
 *
 * Best-effort by design: a failure here costs a slow first load, which is what
 * the whole thing was already doing, so it must never be allowed to fail the
 * request it is trying to speed up.
 */
async function loadStoredPageSize(): Promise<void> {
  if (loadedStored) return;
  loadedStored = true;
  try {
    const { getOrgConfig } = await import("./orgConfigService");
    const stored = (await getOrgConfig()).prPageSize;
    if (typeof stored !== "number") return;
    const index = PAGE_SIZES.indexOf(stored);
    if (index >= 0) lastGoodSize = index;
  } catch (err) {
    console.warn("[pull requests] Could not read the stored page size:",
      (err as Error)?.message ?? err);
  }
}

/** Records a change, so the next process starts where this one ended up. */
function rememberPageSize(index: number): void {
  void (async () => {
    try {
      const { savePrPageSize } = await import("./orgConfigService");
      await savePrPageSize(PAGE_SIZES[index]);
    } catch (err) {
      console.warn("[pull requests] Could not store the page size:",
        (err as Error)?.message ?? err);
    }
  })();
}

/**
 * Calls since the page size last stepped down, so it can be tried larger again.
 *
 * Without this a single bad afternoon would pin the smallest page forever, and
 * the smallest page means the most requests — the opposite of what backing off
 * was for.
 */
let sinceStepUp = 0;
const STEP_UP_AFTER = 20;

/** Total pull requests read before reporting the list as truncated. */
const MAX_PRS = 500;

/** Guards against an endless walk if a cursor stops advancing. */
const MAX_REQUESTS = 120;

/**
 * A gateway failure, meaning the query was too expensive rather than wrong.
 *
 * GitHub answers these with an HTML error page, so there is no GraphQL error to
 * read and the status is all there is to go on.
 */
function isTooExpensive(err: any): boolean {
  return err?.status === 502 || err?.status === 504 || err?.status === 503;
}

/** Refused field paths already reported, so one missing permission logs once. */
const reportedRefusals = new Set<string>();

/**
 * A GraphQL response can carry data *and* errors at the same time.
 *
 * When the App lacks the permission for one field, GitHub returns every other
 * field normally and adds an error naming the refused path. Octokit treats any
 * `errors` array as a thrown request, which discards a response that was almost
 * entirely usable — so one unavailable field took out the whole pull request
 * tab rather than blanking one column of it.
 *
 * The partial data is on the thrown error. Anything without data — a network
 * failure, a 502, a malformed query — still throws, because there is nothing to
 * carry on with.
 */
async function graphqlAllowingPartial(
  graphql: GraphQlFn,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  try {
    return await graphql(query, variables);
  } catch (err: any) {
    const data = err?.data;
    if (!data) throw err;

    for (const e of err.errors ?? []) {
      const path = (e?.path ?? []).filter((p: unknown) => typeof p === "string").join(".");
      const key = `${path}|${e?.message}`;
      if (reportedRefusals.has(key)) continue;
      reportedRefusals.add(key);
      console.warn(
        `[pull requests] GitHub refused "${path || "a field"}": ${e?.message}. ` +
        "The rest of the response is being used. If this is statusCheckRollup, " +
        "the GitHub App needs Checks (read) and Commit statuses (read) — until " +
        "then, check status shows as unknown.",
      );
    }
    return data;
  }
}

export async function fetchOpenPrs(
  graphql: GraphQlFn,
  org: string,
): Promise<{ prs: PullRequest[]; truncated: boolean }> {
  const prs: PullRequest[] = [];
  let cursor: string | null = null;
  const truncated = false;

  // Start where this organization ended up last time — in this process if it has
  // run before, otherwise from what the previous one stored.
  await loadStoredPageSize();
  let size = lastGoodSize;
  if (size > 0 && ++sinceStepUp >= STEP_UP_AFTER) {
    size--;
    sinceStepUp = 0;
  }

  for (let request = 0; request < MAX_REQUESTS; request++) {
    if (prs.length >= MAX_PRS) return { prs, truncated: true };

    let res: any;
    try {
      res = await graphqlAllowingPartial(graphql, OPEN_PRS_QUERY, {
        // `is:open` is load-bearing and asserted in the tests: without it this
        // returns every pull request ever opened, and the whole point is that a
        // closed one never appears.
        q: `is:pr is:open org:${org} archived:false`,
        cursor,
        first: PAGE_SIZES[size],
      });
    } catch (err: any) {
      // Retried from the same cursor, so nothing is skipped by stepping down.
      if (isTooExpensive(err) && size < PAGE_SIZES.length - 1) {
        size++;
        lastGoodSize = size;
        sinceStepUp = 0;
        rememberPageSize(size);
        console.warn(
          `[pull requests] GitHub returned ${err.status} for ${PAGE_SIZES[size - 1]} ` +
          `pull requests per page — retrying at ${PAGE_SIZES[size]}, and starting there next time.`,
        );
        continue;
      }
      throw err;
    }

    // This size answered, so it is where the next call should begin — and where
    // the next launch should begin too.
    if (size !== lastGoodSize) rememberPageSize(size);
    lastGoodSize = size;

    const search = res?.search;
    if (!search) break;

    for (const n of search.nodes ?? []) {
      if (!n || typeof n.number !== "number") continue;
      const commit = n.commits?.nodes?.[0]?.commit;

      // Ten reviewers is generous and still a limit. Asking for 25 of each was
      // half this query's node count and most of its cost; asking for 10 makes
      // a much larger page viable, which is a bigger win than the two extra
      // reviewers it might drop. The count says when that happened, so a
      // pull request with a crowd on it is reported rather than quietly
      // half-read.
      const asked = n.reviewRequests?.totalCount ?? 0;
      const reviewed = n.latestReviews?.totalCount ?? 0;
      if (asked > REVIEW_PAGE || reviewed > REVIEW_PAGE) {
        console.warn(
          `[pull requests] ${n.repository?.nameWithOwner}#${n.number} has ${asked} requested ` +
          `reviewers and ${reviewed} reviews; only the first ${REVIEW_PAGE} of each were read, ` +
          `so someone on it may not be chased.`,
        );
      }
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
  }

  // Every exit above is a complete walk. Falling out of the loop means the
  // request budget ran out with pages still to read, which is the one case the
  // caller has to be told about — a short list that looks complete is worse
  // than a short list that says it is short.
  return { prs, truncated: true };
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

const NUDGE_MARKER_VALUE = "<!-- github-control-hub:stale-pr -->";
const MARKER = NUDGE_MARKER_VALUE;

/**
 * What the author is being asked to do, per state.
 *
 * Addressed to them specifically. The reviewers get their own line, because
 * "it just needs merging" sent to somebody who cannot merge reads as an
 * instruction they are unable to follow — which is what the first version did.
 */
const AUTHOR_TEXT: Record<BlockReason, string> = {
  "ready": "this is approved and green, so it just needs merging",
  "needs-approval": "this is waiting on review",
  "changes-requested": "changes were requested and have not been addressed yet",
  "draft": "this is still a draft",
  "conflict": "this has conflicts with its base branch",
  "behind": "this branch is behind its base and needs updating",
  "checks-failing": "checks are failing",
  "checks-pending": "checks are still running",
  "blocked": "this is blocked from merging",
};

/**
 * How long it has been idle, in a unit a person would use.
 *
 * Never rounds down to zero: something has to have elapsed for a reminder to
 * exist at all, so "0 days" is always a rendering fault rather than a fact.
 */
export function describeIdle(days: number): string {
  const secs = Math.max(0, days * 86_400);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (secs < 90) return unit(Math.max(1, Math.round(secs)), "second");
  if (secs < 3_600) return unit(Math.round(secs / 60), "minute");
  // Days only once there is more than one, so nothing ever reads "1 days" or
  // rounds a day and a half down to one.
  if (secs < 172_800) return unit(Math.round(secs / 3_600), "hour");
  return unit(Math.floor(days), "day");
}

export function buildNudgeComment(
  pr: PullRequest,
  reason: BlockReason,
  targets: string[],
  idleDays: number,
  nudgeNumber: number,
): string {
  // Rendered in whatever unit is actually true.
  //
  // It said "No commits for 0 days" on a real pull request, because the value
  // was floored to whole days and the pull request had been idle for seconds.
  // A reminder whose first line is visibly wrong is one nobody reads twice.
  const idle = describeIdle(idleDays);
  const nth = nudgeNumber > 1 ? ` This is reminder ${nudgeNumber}.` : "";

  // Split by role, because the two are being asked for different things and a
  // single sentence addressed to everyone tells at least one of them something
  // they cannot act on.
  const author = targets.find(t => t.toLowerCase() === pr.author.toLowerCase());
  const reviewers = targets.filter(t => t.toLowerCase() !== pr.author.toLowerCase());

  const lines = [
    NUDGE_MARKER_VALUE,
    `**No commits for ${idle}.**${nth}`,
    "",
  ];

  if (author) lines.push(`@${author} — ${AUTHOR_TEXT[reason]}.`);
  if (reviewers.length) {
    lines.push(
      `${reviewers.map(r => `@${r}`).join(" ")} — a review was requested from you and is `
      + `still outstanding.`);
  }

  lines.push(
    "",
    `<sub>Posted by GitHub Control Hub. This reminder replaces itself rather than `
      + `adding a new comment each time. An organization admin can pause it.</sub>`,
  );
  return lines.join("\n");
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
  /** Organization-wide and per-repository mutes, read once for the whole pass. */
  mutes?: { global: string[]; byRepo: Record<string, string[]> };
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
      prPaused: state?.paused,
      prLogins: state?.pausedLogins,
      repoLogins: deps.mutes?.byRepo?.[pr.repo],
      globalLogins: deps.mutes?.global,
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
