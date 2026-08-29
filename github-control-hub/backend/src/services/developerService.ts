import {
  type PullRequest, type BlockReason,
  blockReason, pendingReviewers, hasApproved, daysSinceLastCommit,
} from "./prNudgeService";

/**
 * The same data, asked from the developer's side.
 *
 * Every screen in this app so far answers an auditor's question: who can reach
 * what, which rules are not being followed, what changed last night. The people
 * whose work those questions are about get nothing, and the app already holds
 * the answers to what they would ask.
 *
 * Nothing here reads GitHub. It is composition over what the pull request pass
 * and the nightly walk already collected, which is what makes it cheap enough
 * to be a tab somebody opens every morning rather than a report they run.
 *
 * The organising principle is that a developer's questions are about *the next
 * action*, not about state. "Fourteen open pull requests" is state. "Three of
 * them are waiting on you and two are waiting on nobody" is the next action,
 * and it is the same fourteen rows.
 */

/** Why a pull request is sitting where it is, from the reader's point of view. */
export type Waiting =
  /** The author has something to do: conflicts, failing checks, a stale base. */
  | "you"
  /** Reviewers have something to do. */
  | "reviewers"
  /** Nobody: it can be merged. */
  | "nobody"
  /** A machine is still running. Waiting is the correct action. */
  | "checks";

export interface MyPull {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  isDraft: boolean;
  reason: BlockReason;
  waiting: Waiting;
  /** Days since the last commit, which is the age that matters for nudging. */
  idleDays: number;
  /** Who still owes a review. Empty when nobody was asked. */
  pending: string[];
  approvals: number;
}

/**
 * Who has to act next, derived from why it is blocked.
 *
 * Kept separate from `blockReason` rather than folded into it: that answers
 * "what is wrong", which is a property of the pull request, and this answers
 * "whose problem is it", which is the same fact read from one side. A conflict
 * and a failing check are different problems and the same answer, yours.
 */
export function waitingOn(reason: BlockReason): Waiting {
  switch (reason) {
    case "ready": return "nobody";
    case "needs-approval": return "reviewers";
    // Changes were requested, so the ball is back with the author.
    case "changes-requested":
    case "conflict":
    case "behind":
    case "checks-failing":
    case "draft":
      return "you";
    case "checks-pending": return "checks";
    // GitHub says blocked and will not say why. Reviewers is the likelier of
    // the two and the cheaper to be wrong about: chasing a review that was not
    // needed costs a message, and telling somebody their own work is done when
    // it is not costs them the morning.
    default: return "reviewers";
  }
}

function toMine(pr: PullRequest, now: number): MyPull {
  const reason = blockReason(pr);
  return {
    repo: pr.repo, number: pr.number, title: pr.title, url: pr.url,
    author: pr.author, baseRef: pr.baseRef, isDraft: pr.isDraft,
    reason,
    waiting: waitingOn(reason),
    idleDays: daysSinceLastCommit(pr, now),
    pending: pendingReviewers(pr),
    approvals: pr.reviews.filter(r => r.state === "APPROVED").length,
  };
}

/**
 * Case-insensitively, because GitHub logins are.
 *
 * A comparison that is not would silently give somebody an empty tab, which
 * reads as "nothing to do" rather than as "we did not find you".
 */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface MyWork {
  /** Open pull requests this person opened. */
  mine: MyPull[];
  /** Open pull requests waiting for this person's review. */
  toReview: MyPull[];
  /** Of `mine`, the ones nobody is blocking. They can be merged now. */
  mergeable: number;
  /** Of `mine`, the ones where the next action is the author's own. */
  onYou: number;
}

/**
 * What one person needs to do next, out of every open pull request.
 *
 * Both halves are wanted, and they are different questions. "What am I blocked
 * on" is answered by `mine`; "who is blocked on me" by `toReview`, which is the
 * one GitHub reports worst, a review request is a notification that scrolls
 * away, and after that the only record is on a page nobody opens.
 *
 * Drafts are kept in `mine` and excluded from `toReview`. A draft is the
 * author's business and explicitly not a request for anyone else's time.
 */
export function myWork(prs: PullRequest[], login: string, now = Date.now()): MyWork {
  const mine: MyPull[] = [];
  const toReview: MyPull[] = [];

  for (const pr of prs) {
    const row = toMine(pr, now);
    if (same(pr.author, login)) {
      mine.push(row);
      continue;
    }
    if (pr.isDraft) continue;
    // Asked, and has not answered yet. Somebody who already approved is not
    // still on the hook, and listing them there is how a queue stops being
    // trusted, a list with nothing to do in it gets closed and not reopened.
    if (row.pending.some(p => same(p, login)) && !hasApproved(pr, login)) {
      toReview.push(row);
    }
  }

  // Most idle first, in both. The oldest thing is the one most likely to have
  // been forgotten, which is the whole reason to have a list rather than
  // relying on remembering.
  const byIdle = (a: MyPull, b: MyPull) => b.idleDays - a.idleDays;
  mine.sort(byIdle);
  toReview.sort(byIdle);

  return {
    mine,
    toReview,
    mergeable: mine.filter(p => p.waiting === "nobody").length,
    onYou: mine.filter(p => p.waiting === "you").length,
  };
}
