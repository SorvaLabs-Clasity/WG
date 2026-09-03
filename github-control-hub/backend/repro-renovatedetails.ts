/**
 * "There aren't any details about the Renovate PRs themselves."
 *
 * The panel listed a repository, a number, a title and an age, which is enough
 * to know a pull request exists and not enough to decide anything about it.
 * The question in front of that screen is "which of these can I merge now",
 * and it needs the checks, the review and whether it still merges cleanly.
 *
 * Two constraints shape how they are fetched. REST would be two calls per pull
 * request, the pull request and its check runs, so a hundred open ones is two
 * hundred requests. And search, which found them, has the smallest allowance
 * GitHub gives: thirty a minute. So the details come over GraphQL, batched,
 * on a separate budget.
 *
 * The module is shared with the Dependabot view, which asks the identical
 * question of identical objects. Two copies would be two places for "unknown"
 * to quietly become "passing".
 *
 * The rule the whole file turns on: an unknown check is not a passing one. A
 * batch that fails, a field GitHub did not return, a pull request GitHub is
 * still computing mergeability for, all have to stay unknown, because the one
 * thing this screen must never do is tell somebody a pull request is safe to
 * merge when nobody established that.
 */
import { fetchPullRequestDetails, mergeReadiness } from "./src/services/pullRequestDetails";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const pr = (over: any = {}) => ({
  number: 7, additions: 3, deletions: 1, changedFiles: 2,
  headRefName: "renovate/lodash-4.x", mergeable: "MERGEABLE", reviewDecision: null,
  labels: { nodes: [{ name: "dependencies" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
});

(async () => {
  console.log("details arrive keyed to the pull request they belong to");
  {
    const calls: string[] = [];
    const graphql = async (q: string) => {
      calls.push(q);
      return {
        p0: { name: "api", pullRequest: pr({ number: 7 }) },
        p1: { name: "web", pullRequest: pr({ number: 9, mergeable: "CONFLICTING" }) },
      };
    };
    const out = await fetchPullRequestDetails(graphql, "Org", [
      { repo: "api", number: 7 }, { repo: "web", number: 9 },
    ]);

    check("both are returned", out.size === 2, [...out.keys()]);
    check("  keyed by repository and number, because numbers repeat across repositories",
      out.has("api#7") && out.has("web#9"), [...out.keys()]);
    check("  with the check rollup flattened out", out.get("api#7")?.checks === "SUCCESS");
    check("  and the size of the change", out.get("api#7")?.additions === 3
      && out.get("api#7")?.changedFiles === 2);
    check("  the branch, which names the package better than the title does",
      out.get("api#7")?.headRefName === "renovate/lodash-4.x");
    check("  the labels, flattened", out.get("api#7")?.labels?.[0] === "dependencies");
    check("  and conflicts are carried through", out.get("web#9")?.mergeable === "CONFLICTING");

    check("one request for the batch, not one per pull request", calls.length === 1, calls.length);
  }

  console.log("\na response is matched by what is in it, not by the order it came back");
  {
    // A null in the middle of an aliased response would shift every later
    // alias if they were matched positionally, and every pull request after it
    // would show another one's checks. Worse than missing details.
    const graphql = async () => ({
      p0: null,
      p1: { name: "web", pullRequest: pr({ number: 9, checks: undefined }) },
    });
    const out = await fetchPullRequestDetails(graphql, "Org", [
      { repo: "api", number: 7 }, { repo: "web", number: 9 },
    ]);
    check("a missing repository does not misalign the rest",
      !out.has("api#7") && out.has("web#9"), [...out.keys()]);
  }

  console.log("\na failed batch costs its details and nothing else");
  {
    const graphql = async () => { throw new Error("GraphQL down"); };
    const out = await fetchPullRequestDetails(graphql, "Org", [{ repo: "api", number: 7 }]);
    check("no details rather than a thrown request", out.size === 0);
  }

  console.log("\nbatched, so a hundred pull requests are not a hundred requests");
  {
    let calls = 0;
    const graphql = async () => { calls++; return {}; };
    const many = Array.from({ length: 120 }, (_, i) => ({ repo: "api", number: i + 1 }));
    await fetchPullRequestDetails(graphql, "Org", many);
    check("120 pull requests take three requests, not 120", calls === 3, calls);
  }

  console.log("\nready means somebody can merge it without opening it");
  {
    check("checks green, mergeable, nothing requested",
      mergeReadiness({ checks: "SUCCESS", mergeable: "MERGEABLE" }) === "ready");

    check("  a failing check is failing",
      mergeReadiness({ checks: "FAILURE", mergeable: "MERGEABLE" }) === "failing");
    check("  so is an errored one",
      mergeReadiness({ checks: "ERROR", mergeable: "MERGEABLE" }) === "failing");
    check("  and so are requested changes, whatever the checks say",
      mergeReadiness({ checks: "SUCCESS", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED" })
        === "failing");

    check("  a conflict outranks a green build, because it blocks first",
      mergeReadiness({ checks: "SUCCESS", mergeable: "CONFLICTING" }) === "conflicting");

    check("  pending checks are waiting, not ready",
      mergeReadiness({ checks: "PENDING", mergeable: "MERGEABLE" }) === "waiting");
    check("  and an outstanding review is waiting too",
      mergeReadiness({ checks: "SUCCESS", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" })
        === "waiting");
  }

  console.log("\nunknown is never ready");
  {
    // The whole point of the label is that it can be trusted without opening
    // the pull request. One wrong "ready" costs more than ten cautious ones.
    check("no details at all is unknown", mergeReadiness(undefined) === "unknown");
    check("  a null check state is not a pass",
      mergeReadiness({ checks: null, mergeable: "MERGEABLE" }) === "unknown");
    check("  a repository with no checks configured is not a pass",
      mergeReadiness({ mergeable: "MERGEABLE" }) === "unknown");
    check("  and mergeability GitHub has not computed yet is not a pass",
      mergeReadiness({ checks: "SUCCESS", mergeable: "UNKNOWN" }) === "unknown");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
