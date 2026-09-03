import type { Intent } from "../design";

/**
 * Whether a bot's pull request is waiting on GitHub or on a person.
 *
 * Shared by the Renovate view and the Dependabot one. They show the same
 * states of the same kind of object, and two copies would be two places for
 * the wording to drift, which reads as two different things being described.
 */
export type Readiness = "ready" | "failing" | "conflicting" | "waiting" | "unknown";

export const READINESS: Record<Readiness, { label: string; intent: Intent; hint: string }> = {
  ready: { label: "Ready", intent: "good", hint: "Checks passed, no conflicts, nothing requested" },
  failing: { label: "Failing", intent: "danger", hint: "A check failed, or changes were requested" },
  conflicting: { label: "Conflicts", intent: "warn", hint: "Needs a rebase before it can merge" },
  waiting: { label: "Waiting", intent: "info", hint: "Checks still running, or a review is outstanding" },
  // A real state, shown as one. The details come from a batched query that can
  // fail, and a repository with no checks configured returns nothing rather
  // than a pass. Showing those as ready is the one mistake here that costs
  // something.
  unknown: { label: "Unknown", intent: "neutral", hint: "No check status came back for this one" },
};

/** The order somebody would work through them. */
export const READINESS_ORDER: Readiness[] = ["ready", "failing", "conflicting", "waiting", "unknown"];

/** The check rollup in words, or null where GitHub reported none. */
export function checkLabel(checks?: string | null): string | null {
  switch (checks) {
    case "SUCCESS": return "checks passed";
    case "FAILURE": return "checks failed";
    case "ERROR": return "checks errored";
    case "PENDING": return "checks running";
    case "EXPECTED": return "checks queued";
    default: return null;
  }
}

/** The review, where one is actually required. */
export function reviewLabel(decision?: string | null): string | null {
  switch (decision) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "REVIEW_REQUIRED": return "review needed";
    default: return null;
  }
}
