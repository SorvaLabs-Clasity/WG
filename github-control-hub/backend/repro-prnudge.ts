/**
 * Stale pull requests, and who gets chased about them.
 *
 * Every failure mode here is a message sent to the wrong person, or not sent at
 * all, and both are quiet:
 *
 *   - chasing on age rather than idleness, so an old branch pushed to this
 *     morning is nagged and a fortnight-dead one is not.
 *   - a commit that fails to reset the clock, so someone who just did the work
 *     is chased the next morning anyway.
 *   - counting a "looks good!" comment as a review, so a pull request genuinely
 *     waiting on approval goes quiet.
 *   - nudging a reviewer who has already approved, or a team handle that is not
 *     a person.
 *   - a pause that does not hold, which is the one failure people notice and
 *     never forgive.
 */
import fs from "fs";
import path from "path";
import {
  daysSinceLastCommit, isStale, hasReviewed, pendingReviewers, blockReason,
  nudgeTargets, isNudgeDue, sortByStaleness, fetchOpenPrs, STALE_DAYS,
  type PullRequest,
} from "./src/services/prNudgeService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = Date.parse("2026-08-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "o/api", number: 1, title: "Add thing", url: "https://x/1",
  author: "alice", headRef: "feature", baseRef: "main",
  createdAt: daysAgo(30), lastCommitAt: daysAgo(1),
  isDraft: false, reviewDecision: null, mergeable: "MERGEABLE",
  requestedReviewers: [], reviews: [], checksState: null, ...over,
});

(async () => {
  // ── the clock is the last commit, not the opening date ──────────────
  {
    // The distinction the whole feature turns on. An old branch someone pushed
    // to this morning is alive; a young one nobody has touched is not.
    const oldButActive = pr({ createdAt: daysAgo(200), lastCommitAt: daysAgo(1) });
    const youngAndDead = pr({ createdAt: daysAgo(9), lastCommitAt: daysAgo(9) });

    check("a 200-day-old pull request committed to yesterday is not stale",
      !isStale(oldButActive, NOW), daysSinceLastCommit(oldButActive, NOW));
    check("  while a 9-day-old one nobody has touched is",
      isStale(youngAndDead, NOW), daysSinceLastCommit(youngAndDead, NOW));

    check(`  the threshold is ${STALE_DAYS} days`, STALE_DAYS === 7);
    check("  and exactly seven days counts as stale, not six and a bit",
      isStale(pr({ lastCommitAt: daysAgo(7) }), NOW)
        && !isStale(pr({ lastCommitAt: daysAgo(6.9) }), NOW));

    // A pull request whose commit date cannot be read must not read as fresh,
    // or the ones we cannot see are exactly the ones never chased.
    check("  a pull request with no commit falls back to its opening date",
      isStale(pr({ lastCommitAt: null, createdAt: daysAgo(20) }), NOW),
      daysSinceLastCommit(pr({ lastCommitAt: null, createdAt: daysAgo(20) }), NOW));
  }

  // ── a commit restarts the timer ─────────────────────────────────────
  {
    // Nudged a week ago, then somebody pushed. The next nudge must wait a fresh
    // seven days from the commit, not from the nudge.
    const pushedAfterNudge = pr({ lastCommitAt: daysAgo(2) });
    check("a commit after the last nudge stops the next one",
      !isNudgeDue(pushedAfterNudge, daysAgo(8), NOW),
      "somebody who just did the work would be chased the next morning");

    // Still idle a week later: due again.
    const stillIdle = pr({ lastCommitAt: daysAgo(20) });
    check("  a pull request idle since the last nudge is due again after seven days",
      isNudgeDue(stillIdle, daysAgo(7), NOW), true);
    check("  but not after only three",
      !isNudgeDue(stillIdle, daysAgo(3), NOW));

    // Never nudged and already stale: due immediately.
    check("  a stale pull request never nudged is due now",
      isNudgeDue(stillIdle, null, NOW));
    check("  and a fresh one is never due, however long ago it was nudged",
      !isNudgeDue(pr({ lastCommitAt: daysAgo(1) }), daysAgo(400), NOW));

    // The reset, asserted as behaviour rather than as a code path. What matters
    // is that a push buys a full fresh week from the commit, whenever the last
    // nudge happened to land.
    for (const nudgedDaysAgo of [1, 3, 6, 8, 30, 400]) {
      check(`  a commit 2 days ago silences a nudge last sent ${nudgedDaysAgo}d ago`,
        !isNudgeDue(pr({ lastCommitAt: daysAgo(2) }), daysAgo(nudgedDaysAgo), NOW),
        "a push must buy a full week, regardless of nudge history");
    }
    check("  and once that week elapses it is due again",
      isNudgeDue(pr({ lastCommitAt: daysAgo(8) }), daysAgo(30), NOW));
    check("  an unreadable nudge timestamp is treated as never nudged",
      isNudgeDue(stillIdle, "banana", NOW));
  }

  // ── who counts as having reviewed ───────────────────────────────────
  {
    const commented = pr({
      requestedReviewers: ["bob"],
      reviews: [{ login: "bob", state: "COMMENTED" }],
    });
    check("a COMMENTED review is not a verdict",
      !hasReviewed(commented, "bob") && pendingReviewers(commented).includes("bob"),
      "a \"looks good!\" with no approval would silence the nudge");

    for (const state of ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]) {
      const p = pr({ requestedReviewers: ["bob"], reviews: [{ login: "bob", state }] });
      check(`  ${state} is`, hasReviewed(p, "bob") && !pendingReviewers(p).includes("bob"));
    }

    check("  the comparison is case-insensitive, since GitHub is",
      hasReviewed(pr({ reviews: [{ login: "Bob", state: "APPROVED" }] }), "bob"));

    const mixed = pr({
      requestedReviewers: ["bob", "carol", "dave"],
      reviews: [{ login: "bob", state: "APPROVED" }, { login: "carol", state: "COMMENTED" }],
    });
    check("  only the ones who owe a verdict are pending",
      pendingReviewers(mixed).join() === "carol,dave", pendingReviewers(mixed));
  }

  // ── what is blocking it ─────────────────────────────────────────────
  {
    check("a draft is reported as a draft, not as missing approvals",
      blockReason(pr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" })) === "draft",
      "a draft is not waiting on anyone");
    check("  a conflict outranks a failing check",
      blockReason(pr({ mergeable: "CONFLICTING", checksState: "FAILURE" })) === "conflict",
      "a conflicted branch cannot merge however green it is");
    check("  changes requested is its own state",
      blockReason(pr({ reviewDecision: "CHANGES_REQUESTED" })) === "changes-requested");
    check("  review required means approvals",
      blockReason(pr({ reviewDecision: "REVIEW_REQUIRED" })) === "needs-approval");
    check("  a failing check when reviews are done",
      blockReason(pr({ reviewDecision: "APPROVED", checksState: "FAILURE" })) === "checks-failing");
    check("  approved and green is ready",
      blockReason(pr({ reviewDecision: "APPROVED", checksState: "SUCCESS" })) === "ready");
    check("  and a repository requiring no review at all is also ready",
      blockReason(pr({ reviewDecision: null, checksState: "SUCCESS" })) === "ready");
  }

  // ── who gets chased ─────────────────────────────────────────────────
  {
    const needsApproval = pr({
      author: "alice",
      reviewDecision: "REVIEW_REQUIRED",
      requestedReviewers: ["bob", "carol", "dave"],
      reviews: [{ login: "bob", state: "APPROVED" }],
    });
    const t = nudgeTargets(needsApproval);
    check("waiting on approval chases the reviewers who have not reviewed",
      t.targets.join() === "carol,dave", t);
    check("  and not the one who already approved", !t.targets.includes("bob"));
    check("  nor the author, who cannot approve their own pull request",
      !t.targets.includes("alice"), t.targets);

    for (const [reason, over] of [
      ["ready", { reviewDecision: "APPROVED", checksState: "SUCCESS" }],
      ["conflict", { mergeable: "CONFLICTING" }],
      ["checks-failing", { reviewDecision: "APPROVED", checksState: "FAILURE" }],
      ["changes-requested", { reviewDecision: "CHANGES_REQUESTED" }],
    ] as const) {
      const r = nudgeTargets(pr({ ...over, requestedReviewers: ["bob"] }));
      check(`  ${reason} chases the author, who is the only one who can move it`,
        r.reason === reason && r.targets.join() === "alice", r);
    }
  }

  // ── pausing, which people notice when it fails ──────────────────────
  {
    const p = pr({
      reviewDecision: "REVIEW_REQUIRED",
      requestedReviewers: ["bob", "carol"],
    });

    check("a paused pull request chases nobody",
      nudgeTargets(p, { pr: true }).targets.length === 0);
    check("  and still reports why it is blocked, so the list stays honest",
      nudgeTargets(p, { pr: true }).reason === "needs-approval");

    const oneOff = nudgeTargets(p, { logins: ["bob"] });
    check("  pausing one reviewer leaves the others being chased",
      oneOff.targets.join() === "carol", oneOff.targets);

    check("  pausing every remaining reviewer produces no nudge at all",
      nudgeTargets(p, { logins: ["bob", "carol"] }).targets.length === 0,
      "a nudge addressed to nobody would still post a comment");

    check("  a paused login matches case-insensitively",
      nudgeTargets(p, { logins: ["BOB"] }).targets.join() === "carol");

    check("  and an author can be paused on their own pull request",
      nudgeTargets(pr({ reviewDecision: "APPROVED" }), { logins: ["alice"] }).targets.length === 0);
  }

  // ── ordering ────────────────────────────────────────────────────────
  {
    const list = [
      pr({ number: 1, lastCommitAt: daysAgo(2) }),
      pr({ number: 2, lastCommitAt: daysAgo(40) }),
      pr({ number: 3, lastCommitAt: daysAgo(9) }),
    ];
    check("the most idle is first and the freshest last",
      sortByStaleness(list, NOW).map(p => p.number).join() === "2,3,1",
      sortByStaleness(list, NOW).map(p => p.number));

    const tied = [
      pr({ repo: "o/z", number: 5, lastCommitAt: daysAgo(9) }),
      pr({ repo: "o/a", number: 4, lastCommitAt: daysAgo(9) }),
    ];
    check("  ties order deterministically, so the list does not shuffle",
      sortByStaleness(tied, NOW).map(p => `${p.repo}#${p.number}`).join() === "o/a#4,o/z#5",
      sortByStaleness(tied, NOW).map(p => p.repo));
  }

  // ── the query ───────────────────────────────────────────────────────
  {
    const queries: string[] = [];
    const graphql = async (_q: string, v: any) => {
      queries.push(String(v.q));
      return { search: { pageInfo: { hasNextPage: false }, nodes: [{
        number: 7, title: "T", url: "u", createdAt: daysAgo(3), isDraft: false,
        mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
        headRefName: "feat", baseRefName: "main",
        author: { login: "alice" }, repository: { nameWithOwner: "o/api" },
        commits: { nodes: [{ commit: { committedDate: daysAgo(3), statusCheckRollup: { state: "SUCCESS" } } }] },
        reviewRequests: { nodes: [
          { requestedReviewer: { __typename: "User", login: "bob" } },
          // A team can be requested. There is no person behind the handle to
          // hold responsible, and mentioning it would notify people never asked.
          { requestedReviewer: { __typename: "Team", slug: "platform" } },
        ] },
        latestOpinionatedReviews: { nodes: [{ author: { login: "carol" }, state: "APPROVED" }] },
      }] } };
    };

    const { prs } = await fetchOpenPrs(graphql, "Acme-Org");
    check("the search asks only for open pull requests",
      queries[0].includes("is:pr") && queries[0].includes("is:open"),
      queries[0]);
    check("  scoped to the organization", queries[0].includes("org:Acme-Org"), queries[0]);

    const p = prs[0];
    check("  every field the list shows is read",
      p.repo === "o/api" && p.number === 7 && p.author === "alice"
        && p.headRef === "feat" && p.baseRef === "main",
      p);
    check("  the last commit date is taken from the branch, not the pull request",
      p.lastCommitAt === daysAgo(3), p.lastCommitAt);
    check("  team reviewers are not treated as people",
      p.requestedReviewers.join() === "bob", p.requestedReviewers);
    check("  and the check rollup is carried through",
      p.checksState === "SUCCESS", p.checksState);
  }

  // ── nothing may list a closed pull request ──────────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, "src/services/prNudgeService.ts"), "utf8");
    const code = src.split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s*\/\/.*$/, "")).join("\n");
    check("the only search this issues is restricted to open",
      /is:pr is:open/.test(code) && !/is:closed|state:all/.test(code),
      "a closed pull request must never appear");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
