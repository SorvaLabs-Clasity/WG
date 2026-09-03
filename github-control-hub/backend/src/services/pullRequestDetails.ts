/**
 * The things about a bot's pull request that decide what to do with it.
 *
 * Shared by the Renovate view and the Dependabot one. They ask the identical
 * question of identical objects, and two copies would be two places for
 * "unknown" to quietly become "passing".
 *
 * Search returns a title, a number and some dates, which is enough to list
 * pull requests and not enough to act on any of them. The question somebody
 * actually has in front of this screen is "which of these can I merge right
 * now", and that needs the checks, the review, and whether it still merges
 * cleanly.
 *
 * Fetched over GraphQL, by repository and number, a batch at a time. Two
 * reasons rather than one:
 *
 *   - REST would be two calls per pull request, the pull request and its check
 *     runs, so a hundred open ones is two hundred requests. This is one.
 *   - Search has the smallest allowance GitHub gives, thirty requests a
 *     minute, and it is already spent on finding these. GraphQL is a separate
 *     budget entirely.
 *
 * Every field is optional, and a batch that fails leaves them unset rather
 * than defaulted. "Checks unknown" and "checks passing" are different answers,
 * and only one of them should let somebody merge without looking.
 */

/** How the checks came out, as GitHub's rollup reports it. */
export type CheckState =
  | "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED";

export interface RenovateDetail {
  checks?: CheckState | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when none is set. */
  reviewDecision?: string | null;
  /** MERGEABLE, CONFLICTING, or UNKNOWN while GitHub is still working it out. */
  mergeable?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** e.g. "renovate/lodash-4.x", which names the package better than the title. */
  headRefName?: string;
  labels?: string[];
}

type GraphQlFn = (query: string, vars: Record<string, unknown>) => Promise<any>;

/** Aliases per query. Fifty keeps the document well inside GitHub's limits. */
const BATCH = 50;

const FRAGMENT = `fragment D on PullRequest {
  number
  additions
  deletions
  changedFiles
  headRefName
  mergeable
  reviewDecision
  labels(first: 8) { nodes { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

/**
 * Details for each pull request, keyed "<repo>#<number>".
 *
 * Repositories are addressed by name and number rather than by node id
 * because that is what search gave us, and asking for the ids first would be
 * the extra round trip this is avoiding.
 */
export async function fetchPullRequestDetails(
  graphql: GraphQlFn,
  org: string,
  prs: { repo: string; number: number }[],
): Promise<Map<string, RenovateDetail>> {
  const details = new Map<string, RenovateDetail>();

  for (let i = 0; i < prs.length; i += BATCH) {
    const batch = prs.slice(i, i + BATCH);

    // One alias per pull request. The alias carries the index, and the
    // response is matched back by the repository and number inside it rather
    // than by alias order, so a null in the middle cannot shift the rest.
    const body = batch
      .map((pr, n) =>
        `p${n}: repository(owner: $org, name: ${JSON.stringify(pr.repo)}) {
          name
          pullRequest(number: ${pr.number}) { ...D }
        }`)
      .join("\n");

    try {
      const res = await graphql(`query($org:String!) {\n${body}\n}\n${FRAGMENT}`, { org });

      for (const value of Object.values(res ?? {})) {
        const repo: any = value;
        const pr = repo?.pullRequest;
        if (!repo?.name || !pr?.number) continue;

        details.set(`${repo.name}#${pr.number}`, {
          checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
          reviewDecision: pr.reviewDecision ?? null,
          mergeable: pr.mergeable ?? null,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          headRefName: pr.headRefName,
          labels: (pr.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean),
        });
      }
    } catch (err) {
      // One batch failing costs that batch's details and nothing else. The
      // pull requests still list, without the extra columns, which is the
      // state the screen was in before any of this existed.
      console.warn(`[Renovate] Could not read details for a batch: ${(err as Error).message}`);
    }
  }

  return details;
}

/**
 * Whether this pull request is waiting on GitHub or on a person.
 *
 * Deliberately conservative: anything unknown is not "ready". The whole value
 * of the label is that it can be trusted without opening the pull request, and
 * one wrong "ready" costs more than ten cautious "check this one".
 */
export function mergeReadiness(
  detail: RenovateDetail | undefined,
): "ready" | "failing" | "conflicting" | "waiting" | "unknown" {
  if (!detail) return "unknown";
  if (detail.mergeable === "CONFLICTING") return "conflicting";
  if (detail.checks === "FAILURE" || detail.checks === "ERROR") return "failing";
  if (detail.reviewDecision === "CHANGES_REQUESTED") return "failing";
  if (detail.checks === "PENDING" || detail.checks === "EXPECTED") return "waiting";
  if (detail.reviewDecision === "REVIEW_REQUIRED") return "waiting";

  // Checks passing, nothing blocking, and either approved or no review needed.
  if (detail.checks === "SUCCESS" && detail.mergeable === "MERGEABLE") return "ready";

  return "unknown";
}
