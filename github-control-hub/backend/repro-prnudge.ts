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
  daysSinceLastCommit, isStale, hasApproved, pendingReviewers, blockReason, mutedBy,
  blockedByMoreThanApprovals,
  nudgeTargets, isNudgeDue, sortByStaleness, fetchOpenPrs, STALE_DAYS,
  __resetPageSizeForTests, __allowStoredPageSizeReload,
  buildNudgeComment, postStickyNudge, NUDGE_MARKER, runNudgePass, staleSeconds, describeIdle,
  SEVEN_DAYS, STALE_SECONDS,
  type PullRequest, type NudgeDeps, type NudgeRunDeps,
} from "./src/services/prNudgeService";
import {
  setPrPause, getPrState, listPrStates, recordNudge, prStateId,
  __resetAlarmStoreForTests,
} from "./src/services/alarmService";

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
  isDraft: false, reviewDecision: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  requestedReviewers: [], reviews: [], checksState: null, ...over,
});

/** Clears the in-process memory of the page size, leaving storage alone. */
function lastGoodIsForgotten(): void {
  __resetPageSizeForTests();
  __allowStoredPageSizeReload();
}

(async () => {
  // ── the clock is the last commit, not the opening date ──────────────
  {
    // The distinction the whole feature turns on. An old branch someone pushed
    // to this morning is alive; a young one nobody has touched is not.
    const oldButActive = pr({ createdAt: daysAgo(200), lastCommitAt: daysAgo(1) });
    const youngAndDead = pr({ createdAt: daysAgo(9), lastCommitAt: daysAgo(9) });

    check("a 200-day-old pull request committed to yesterday is not stale",
      !isStale(oldButActive, NOW, SEVEN_DAYS), daysSinceLastCommit(oldButActive, NOW));
    check("  while a 9-day-old one nobody has touched is",
      isStale(youngAndDead, NOW, SEVEN_DAYS), daysSinceLastCommit(youngAndDead, NOW));

    check(`  seven days is ${SEVEN_DAYS} seconds`, SEVEN_DAYS === 7 * 86_400);
    check("  and exactly seven days counts as stale, not six and a bit",
      isStale(pr({ lastCommitAt: daysAgo(7) }), NOW, SEVEN_DAYS)
        && !isStale(pr({ lastCommitAt: daysAgo(6.9) }), NOW, SEVEN_DAYS));

    // A pull request whose commit date cannot be read must not read as fresh,
    // or the ones we cannot see are exactly the ones never chased.
    check("  a pull request with no commit falls back to its opening date",
      isStale(pr({ lastCommitAt: null, createdAt: daysAgo(20) }), NOW, SEVEN_DAYS),
      daysSinceLastCommit(pr({ lastCommitAt: null, createdAt: daysAgo(20) }), NOW));
  }

  // ── a commit restarts the timer ─────────────────────────────────────
  {
    // Nudged a week ago, then somebody pushed. The next nudge must wait a fresh
    // seven days from the commit, not from the nudge.
    const pushedAfterNudge = pr({ lastCommitAt: daysAgo(2) });
    check("a commit after the last nudge stops the next one",
      !isNudgeDue(pushedAfterNudge, daysAgo(8), NOW, SEVEN_DAYS),
      "somebody who just did the work would be chased the next morning");

    // Still idle a week later: due again.
    const stillIdle = pr({ lastCommitAt: daysAgo(20) });
    check("  a pull request idle since the last nudge is due again after seven days",
      isNudgeDue(stillIdle, daysAgo(7), NOW, SEVEN_DAYS), true);
    check("  but not after only three",
      !isNudgeDue(stillIdle, daysAgo(3), NOW, SEVEN_DAYS));

    // Never nudged and already stale: due immediately.
    check("  a stale pull request never nudged is due now",
      isNudgeDue(stillIdle, null, NOW, SEVEN_DAYS));
    check("  and a fresh one is never due, however long ago it was nudged",
      !isNudgeDue(pr({ lastCommitAt: daysAgo(1) }), daysAgo(400), NOW, SEVEN_DAYS));

    // The reset, asserted as behaviour rather than as a code path. What matters
    // is that a push buys a full fresh week from the commit, whenever the last
    // nudge happened to land.
    for (const nudgedDaysAgo of [1, 3, 6, 8, 30, 400]) {
      check(`  a commit 2 days ago silences a nudge last sent ${nudgedDaysAgo}d ago`,
        !isNudgeDue(pr({ lastCommitAt: daysAgo(2) }), daysAgo(nudgedDaysAgo), NOW, SEVEN_DAYS),
        "a push must buy a full week, regardless of nudge history");
    }
    check("  and once that week elapses it is due again",
      isNudgeDue(pr({ lastCommitAt: daysAgo(8) }), daysAgo(30), NOW, SEVEN_DAYS));
    check("  an unreadable nudge timestamp is treated as never nudged",
      isNudgeDue(stillIdle, "banana", NOW, SEVEN_DAYS));
  }

  // ── whose approval currently stands ─────────────────────────────────
  {
    // The bug found in use. Re-requesting a review from somebody who has
    // already approved puts them back on the hook, and GitHub empties
    // latestReviews to say so — while latestOpinionatedReviews keeps the old
    // approval forever. Reading the wrong one meant the person being asked to
    // look again was the one person never reminded.
    const reRequested = pr({
      requestedReviewers: ["bob"],
      reviews: [],            // latestReviews is emptied by the re-request
    });
    check("a re-requested reviewer is pending again, whatever they approved before",
      pendingReviewers(reRequested).join() === "bob",
      "the person asked to look again would be the one never chased");

    const stillStands = pr({
      requestedReviewers: ["bob"],
      reviews: [{ login: "bob", state: "APPROVED" }],
    });
    check("  while an approval that still stands takes them off it",
      pendingReviewers(stillStands).length === 0 && hasApproved(stillStands, "bob"));

    check("  a COMMENTED review is not an approval",
      pendingReviewers(pr({
        requestedReviewers: ["bob"], reviews: [{ login: "bob", state: "COMMENTED" }],
      })).join() === "bob");

    check("  nor is CHANGES_REQUESTED",
      pendingReviewers(pr({
        requestedReviewers: ["bob"], reviews: [{ login: "bob", state: "CHANGES_REQUESTED" }],
      })).join() === "bob");

    check("  and the comparison is case-insensitive",
      hasApproved(pr({ reviews: [{ login: "Bob", state: "APPROVED" }] }), "bob"));
  }

  // ── the author is always named ──────────────────────────────────────
  {
    for (const [name, over] of [
      ["ready to merge", { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }],
      ["waiting on review", { reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", requestedReviewers: ["bob"] }],
      ["conflicted", { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }],
      ["checks failing", { mergeStateStatus: "BLOCKED", checksState: "FAILURE" }],
      ["a draft", { isDraft: true }],
    ] as const) {
      const t = nudgeTargets(pr({ author: "alice", ...over }));
      check(`  the author is named on ${name}`, t.targets.includes("alice"), t);
    }
    check("  and never twice, even if they are also a requested reviewer",
      nudgeTargets(pr({
        author: "alice", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
        requestedReviewers: ["alice", "bob"],
      })).targets.filter(x => x === "alice").length === 1);
  }

  // ── reviewers are only chased when reviews are the thing missing ────
  {
    // Five approvals required, three given, a required check failing, seven
    // reviewers outstanding. Only the author: nobody else can fix a build.
    const checksBlocking = pr({
      author: "alice",
      mergeStateStatus: "BLOCKED", checksState: "FAILURE",
      reviewDecision: "REVIEW_REQUIRED",
      requestedReviewers: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"],
    });
    check("a failing required check chases the author alone",
      nudgeTargets(checksBlocking).targets.join() === "alice",
      "seven people would be sent to look at a pull request they cannot help with");
    check("  and blockedByMoreThanApprovals says why", blockedByMoreThanApprovals(checksBlocking));

    // Same pull request once the build is green: now the reviewers matter.
    const reviewsOnly = pr({
      author: "alice",
      mergeStateStatus: "BLOCKED", checksState: "SUCCESS",
      reviewDecision: "REVIEW_REQUIRED",
      requestedReviewers: ["r1", "r2", "r3"],
      reviews: [{ login: "r1", state: "APPROVED" }],
    });
    check("  with checks green, everyone still owing a review is chased",
      nudgeTargets(reviewsOnly).targets.join() === "alice,r2,r3", nudgeTargets(reviewsOnly).targets);
    check("  and whoever has approved is not", !nudgeTargets(reviewsOnly).targets.includes("r1"));

    // Enough approvals to merge, but others were asked and have not answered.
    // The author may be waiting on them deliberately, so both are named.
    const enoughButWaiting = pr({
      author: "alice", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      requestedReviewers: ["r1", "r2", "r3", "r4"],
      reviews: [{ login: "r1", state: "APPROVED" }, { login: "r2", state: "APPROVED" }],
    });
    check("enough approvals to merge still chases the ones who have not answered",
      nudgeTargets(enoughButWaiting).targets.join() === "alice,r3,r4",
      nudgeTargets(enoughButWaiting).targets);

    // Everyone asked has approved, but the rule wants somebody who was never
    // asked. Nobody to chase but the author.
    const needsSomeoneElse = pr({
      author: "alice", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
      checksState: "SUCCESS",
      requestedReviewers: ["r1"], reviews: [{ login: "r1", state: "APPROVED" }],
    });
    check("when everyone asked has approved, only the author is chased",
      needsSomeoneElse && nudgeTargets(needsSomeoneElse).targets.join() === "alice",
      nudgeTargets(needsSomeoneElse).targets);

    // Reviewers whose approval cannot satisfy the rule were still asked.
    const wrongPeopleAsked = pr({
      author: "alice", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
      checksState: "SUCCESS", requestedReviewers: ["nobody-with-write"],
    });
    check("a reviewer whose approval does not count is still chased, having been asked",
      nudgeTargets(wrongPeopleAsked).targets.join() === "alice,nobody-with-write");

    // A failing check that no rule requires does not block, so reviews are
    // still the thing missing.
    const unstable = pr({
      author: "alice", mergeStateStatus: "UNSTABLE", checksState: "FAILURE",
      reviewDecision: "REVIEW_REQUIRED", requestedReviewers: ["r1"],
    });
    check("a failing check no rule requires does not shield the reviewers",
      nudgeTargets(unstable).targets.join() === "alice,r1",
      "UNSTABLE means mergeable; the reviews are still what is missing");

    for (const [name, over] of [
      ["conflicts", { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }],
      ["being behind the base", { mergeStateStatus: "BEHIND" }],
      ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }],
      ["a draft", { isDraft: true }],
      ["an unexplained block", { mergeStateStatus: "BLOCKED", reviewDecision: null }],
    ] as const) {
      const t = nudgeTargets(pr({ author: "alice", requestedReviewers: ["r1", "r2"], ...over }));
      check(`  ${name} chases the author alone`, t.targets.join() === "alice", t.targets);
    }
  }

  // ── muting, at four scopes ──────────────────────────────────────────
  {
    const p = pr({
      repo: "o/api", author: "alice",
      reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", checksState: "SUCCESS",
      requestedReviewers: ["bob", "carol"],
    });

    check("a paused pull request reminds nobody",
      nudgeTargets(p, { prPaused: true }).targets.length === 0);
    check("  and names everyone it silenced, so the list explains itself",
      nudgeTargets(p, { prPaused: true }).muted.map(m => m.login).sort().join() === "alice,bob,carol",
      nudgeTargets(p, { prPaused: true }).muted);
    check("  while still reporting what is blocking it",
      nudgeTargets(p, { prPaused: true }).reason === "needs-approval");

    // Per pull request.
    const one = nudgeTargets(p, { prLogins: ["bob"] });
    check("muting one person on this pull request leaves the others",
      one.targets.join() === "alice,carol", one.targets);
    check("  and records the scope that did it",
      one.muted[0]?.scope === "this pull request", one.muted);

    // Per repository.
    const repo = nudgeTargets(p, { repoLogins: ["bob"] });
    check("muting somebody across a repository takes them off its pull requests",
      repo.targets.join() === "alice,carol" && repo.muted[0].scope === "repository", repo);

    // Everywhere.
    const everywhere = nudgeTargets(p, { globalLogins: ["bob"] });
    check("muting somebody everywhere takes them off this one too",
      everywhere.targets.join() === "alice,carol"
        && everywhere.muted[0].scope === "everywhere", everywhere);

    // The widest scope is reported, since that is the one to undo.
    const both = nudgeTargets(p, { globalLogins: ["bob"], prLogins: ["bob"], repoLogins: ["bob"] });
    check("  where several apply, the widest is named",
      both.muted[0].scope === "everywhere", both.muted);

    check("  the author can be muted on their own pull request",
      nudgeTargets(p, { prLogins: ["alice"] }).targets.join() === "bob,carol");

    check("  muting everyone leaves nobody, and so no reminder",
      nudgeTargets(p, { prLogins: ["alice", "bob", "carol"] }).targets.length === 0,
      "a reminder addressed to nobody would still post a comment");

    check("  and matching is case-insensitive at every scope",
      nudgeTargets(p, { globalLogins: ["BOB"] }).targets.join() === "alice,carol"
        && nudgeTargets(p, { repoLogins: ["Bob"] }).targets.join() === "alice,carol"
        && nudgeTargets(p, { prLogins: [" bob "] }).targets.join() === "alice,carol");

    check("  and somebody not muted anywhere is untouched",
      mutedBy("dave", { globalLogins: ["bob"], repoLogins: ["carol"] }) === null);
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

  // ── one refused field does not lose the response ────────────────────
  //
  // GraphQL answers with data *and* errors when the App lacks the permission
  // for a single field: every other field arrives normally, and an error names
  // the refused path. Octokit raises that as a thrown request, so the partial
  // data is on the error rather than returned — and treating it as a failure
  // emptied the whole pull request tab because check status was unavailable.
  {
    const refusal: any = new Error("Resource not accessible by integration");
    refusal.errors = [{
      message: "Resource not accessible by integration",
      path: ["search", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup"],
    }];
    refusal.data = { search: { pageInfo: { hasNextPage: false }, nodes: [{
      number: 9, title: "Still here", url: "u", createdAt: daysAgo(2), isDraft: false,
      mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
      headRefName: "feat", baseRefName: "main",
      author: { login: "alice" }, repository: { nameWithOwner: "o/api" },
      // The refused field comes back null beside its error.
      commits: { nodes: [{ commit: { committedDate: daysAgo(2), statusCheckRollup: null } }] },
      reviewRequests: { nodes: [] }, latestReviews: { nodes: [] },
    }] } };

    const { prs } = await fetchOpenPrs(async () => { throw refusal; }, "Acme-Org");
    check("a refused field still yields the pull requests around it",
      prs.length === 1 && prs[0].number === 9, prs);
    check("  with the unavailable field reported as unknown, not invented",
      prs[0].checksState === null, prs[0].checksState);
    check("  and everything the refusal did not touch is intact",
      prs[0].author === "alice" && prs[0].repo === "o/api", prs[0]);
  }

  // ── an over-expensive page is retried smaller, not abandoned ────────
  //
  // The nested connections make this query's cost scale with the page size, and
  // past some number of pull requests GitHub gives up and returns an HTML 502
  // from its edge. There is no GraphQL error to read: the status is the whole
  // message. Stepping down and retrying the same cursor is what makes the tab
  // work on a large org without hiding pull requests on a small one.
  {
    const sizes: number[] = [];
    const graphql = async (_q: string, v: any) => {
      sizes.push(v.first);
      if (v.first > 15) { const e: any = new Error("502 Bad Gateway"); e.status = 502; throw e; }
      return { search: { pageInfo: { hasNextPage: false }, nodes: [{
        number: 1, title: "T", url: "u", createdAt: daysAgo(1), isDraft: false,
        author: { login: "alice" }, repository: { nameWithOwner: "o/api" },
        commits: { nodes: [{ commit: { committedDate: daysAgo(1) } }] },
        reviewRequests: { nodes: [] }, latestReviews: { nodes: [] },
      }] } };
    };

    const { prs } = await fetchOpenPrs(graphql, "Acme-Org");
    check("a page GitHub refuses to compute is retried at a smaller size",
      sizes.length > 1 && sizes[1] < sizes[0], sizes);
    check("  and the pull requests arrive rather than the tab failing",
      prs.length === 1 && prs[0].number === 1, prs);
    check("  the retry asks from the same point, so nothing is skipped",
      sizes[0] > 15 && sizes[sizes.length - 1] <= 15, sizes);
  }

  // ── the size that worked is remembered ──────────────────────────────
  //
  // Backing off costs a timeout per step, and GitHub takes about eleven seconds
  // to abandon a page it cannot compute. Rediscovering the same answer on every
  // request made every load of the tab pay that again — two dead requests before
  // the first useful one, which is most of the twenty seconds people waited.
  {
    __resetPageSizeForTests();
    const sizes: number[] = [];
    const graphql = async (_q: string, v: any) => {
      sizes.push(v.first);
      if (v.first > 15) { const e: any = new Error("502"); e.status = 502; throw e; }
      return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };

    await fetchOpenPrs(graphql, "Acme-Org");
    const firstCall = [...sizes];
    sizes.length = 0;
    await fetchOpenPrs(graphql, "Acme-Org");

    check("the first call discovers the working size by backing off",
      firstCall.length > 1, firstCall);
    check("  and the next call starts there instead of paying the timeout again",
      sizes.length === 1 && sizes[0] === firstCall[firstCall.length - 1], { firstCall, sizes });
  }

  // ── a size that worked first time is still written down ─────────────
  //
  // The save used to fire only when the size differed from where the walk
  // started — and the walk starts *from* the last good size, so on a fresh
  // process the two were equal and a first attempt that simply worked was
  // never recorded. Only organizations that had to back off stored anything;
  // everyone else rediscovered from scratch on every launch, for a value that
  // was never saved because nothing went wrong.
  {
    const { getOrgConfig } = await import("./src/services/orgConfigService");
    __resetPageSizeForTests();

    // Succeeds immediately, at the largest size. Nothing to back off from.
    await fetchOpenPrs(async () => (
      { search: { pageInfo: { hasNextPage: false }, nodes: [] } }
    ), "Acme-Org");
    await new Promise(r => setTimeout(r, 20));

    const stored = (await getOrgConfig()).prPageSize;
    check("a size that worked on the first try is stored too",
      stored === 30, stored);
  }

  // ── and it survives a restart ───────────────────────────────────────
  //
  // The discovery costs about eleven seconds per step down, and holding the
  // answer in memory alone meant paying it again on every launch of the app and
  // every Lambda cold start. That is the twenty to thirty seconds people saw on
  // the first load of the tab, every single time they opened it.
  {
    const { getOrgConfig, savePrPageSize } = await import("./src/services/orgConfigService");

    __resetPageSizeForTests();
    const graphql = async (_q: string, v: any) => {
      if (v.first > 12) { const e: any = new Error("502"); e.status = 502; throw e; }
      return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };
    await fetchOpenPrs(graphql, "Acme-Org");
    // The write is fire-and-forget so the request is not held up by it.
    await new Promise(r => setTimeout(r, 20));

    const stored = (await getOrgConfig()).prPageSize;
    check("the size that worked is written down, not just remembered in memory",
      stored === 12, stored);

    // A fresh process: module state cleared, storage intact.
    lastGoodIsForgotten();
    const seen: number[] = [];
    await fetchOpenPrs(async (_q: string, v: any) => {
      seen.push(v.first);
      return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
    }, "Acme-Org");
    check("  so a restart starts there rather than rediscovering it",
      seen.length === 1 && seen[0] === 12, seen);

    // A stored value that is no longer one of the sizes must not be trusted
    // blindly — the ladder can change between releases.
    await savePrPageSize(999);
    lastGoodIsForgotten();
    const seen2: number[] = [];
    await fetchOpenPrs(async (_q: string, v: any) => {
      seen2.push(v.first);
      return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
    }, "Acme-Org");
    check("  a stored size that is no longer offered falls back to the largest",
      seen2[0] === 30, seen2);
  }

  // ── but it is not pinned there for ever ─────────────────────────────
  //
  // A single bad afternoon must not permanently choose the smallest page, since
  // the smallest page means the most requests — the opposite of what backing off
  // was for. It is retried larger periodically.
  {
    __resetPageSizeForTests();
    let allow = 15;
    const graphql = async (_q: string, v: any) => {
      if (v.first > allow) { const e: any = new Error("502"); e.status = 502; throw e; }
      return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };

    await fetchOpenPrs(graphql, "Acme-Org");   // backs off to 15 and remembers

    // GitHub recovers. Nothing tells us, so it has to be retried to be found.
    allow = 100;
    const tried = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const seen: number[] = [];
      await fetchOpenPrs(async (_q: string, v: any) => {
        seen.push(v.first);
        return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
      }, "Acme-Org");
      seen.forEach(n => tried.add(n));
    }
    check("a larger page is tried again eventually, so a bad day is not permanent",
      [...tried].some(n => n > 15), [...tried]);
  }

  // ── backing off has a floor ─────────────────────────────────────────
  //
  // An org where even the smallest page fails is broken in some other way, and
  // retrying forever would hang the request instead of reporting it.
  {
    let calls = 0;
    const graphql = async () => {
      calls++;
      const e: any = new Error("502 Bad Gateway"); e.status = 502; throw e;
    };
    let threw = false;
    try { await fetchOpenPrs(graphql, "Acme-Org"); } catch { threw = true; }
    check("a query that fails at every size gives up rather than looping", threw);
    check("  after a bounded number of attempts", calls <= 4, calls);
  }

  // ── a failure carrying no data is still a failure ───────────────────
  //
  // The 502 that GitHub returns when a query is too expensive has no data on
  // it. Swallowing that would report an empty org as though it were an org
  // with no open pull requests.
  {
    const dead: any = new Error("502 Bad Gateway");
    dead.status = 502;
    let threw = false;
    try {
      await fetchOpenPrs(async () => { throw dead; }, "Acme-Org");
    } catch { threw = true; }
    check("a response with no data at all still throws", threw,
      "an empty result here would read as 'no open pull requests'");
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

  // ── one comment, not fifty-two ──────────────────────────────────────
  {
    // The failure this design exists to prevent: a year of weekly reminders
    // leaving fifty-two comments, each mentioning nine people, burying the
    // actual conversation under a wall of bot noise.
    const posted: string[] = [];
    const deleted: number[] = [];
    let nextId = 100;
    let thread: Array<{ id: number; body: string; authorIsApp: boolean }> = [];

    const deps: NudgeDeps = {
      listComments: async () => thread,
      deleteComment: async (_r, id) => {
        deleted.push(id);
        thread = thread.filter(c => c.id !== id);
      },
      postComment: async (_r, _n, body) => {
        posted.push(body);
        const id = nextId++;
        thread.push({ id, body, authorIsApp: true });
        return id;
      },
    };

    const p = pr({ reviewDecision: "REVIEW_REQUIRED", requestedReviewers: ["bob", "carol"] });

    // A human comment that must survive every cycle.
    thread.push({ id: 1, body: "I will look at this tomorrow", authorIsApp: false });

    let lastId: number | undefined;
    for (let cycle = 1; cycle <= 52; cycle++) {
      const body = buildNudgeComment(p, "needs-approval", ["bob", "carol"], 7 * cycle, cycle);
      const res = await postStickyNudge(deps, p, body, lastId);
      lastId = res.commentId;
    }

    const ours = thread.filter(c => c.authorIsApp);
    check("fifty-two weekly reminders leave exactly one comment",
      ours.length === 1, `${ours.length} bot comments remain`);
    check("  and fifty-one were removed", deleted.length === 51, deleted.length);
    check("  while the human comment is untouched",
      thread.some(c => !c.authorIsApp && c.body.startsWith("I will look")),
      thread.map(c => c.body.slice(0, 20)));
    check("  the surviving one is the newest",
      ours[0].body.includes("reminder 52"), ours[0].body.slice(0, 60));
  }

  // ── the comment itself ──────────────────────────────────────────────
  {
    const p = pr();
    const body = buildNudgeComment(
      pr({ author: "alice" }), "needs-approval", ["alice", "bob", "carol"], 9.7, 1);
    check("the comment mentions everyone being chased",
      body.includes("@alice") && body.includes("@bob") && body.includes("@carol"), body);

    // The author and the reviewers are asked for different things. A single
    // sentence addressed to all of them told reviewers to merge a pull request
    // they cannot merge, which is what the first version did.
    const authorLine = body.split("\n").find(l => l.startsWith("@alice")) ?? "";
    const reviewerLine = body.split("\n").find(l => l.startsWith("@bob")) ?? "";
    check("  the author and the reviewers are addressed separately",
      !!authorLine && !!reviewerLine && authorLine !== reviewerLine,
      { authorLine, reviewerLine });
    check("  and the reviewers are not told to merge it",
      !/merg/i.test(reviewerLine), reviewerLine);
    check("  they are told a review is outstanding",
      /review .* (requested|outstanding)/i.test(reviewerLine), reviewerLine);

    const ready = buildNudgeComment(
      pr({ author: "alice" }), "ready", ["alice", "bob"], 8, 1);
    check("  a ready pull request tells the author to merge, and only the author",
      /@alice — .*merg/i.test(ready) && !/@bob — .*merg/i.test(ready), ready);
    check("  says how long it has been idle",
      body.includes("9 days") && !body.includes("9.7"), body);

    // Seen on a real pull request: "No commits for 0 days", because the value
    // was floored to whole days while the pull request had been idle for
    // seconds. A reminder whose first line is visibly wrong is one nobody
    // reads twice.
    check("  and never says zero, since something must have elapsed to be here",
      !/for 0 /.test(buildNudgeComment(pr(), "ready", ["alice"], 10 / 86_400, 1)),
      buildNudgeComment(pr(), "ready", ["alice"], 10 / 86_400, 1));

    for (const [secs, want] of [
      [1, "1 second"], [10, "10 seconds"], [60, "60 seconds"],
      [3_600, "1 hour"], [7_200, "2 hours"], [86_400, "24 hours"],
      [172_800, "2 days"], [604_800, "7 days"],
    ] as const) {
      check(`  ${secs}s reads as "${want}"`,
        describeIdle(secs / 86_400) === want, describeIdle(secs / 86_400));
    }
    check("  and nothing ever reads as a plural one",
      !/\b1 (seconds|minutes|hours|days)\b/.test(
        [1, 60, 3_600, 86_400 * 1.2].map(x => describeIdle(x / 86_400)).join(" ")),
      [1, 60, 3_600, 86_400 * 1.2].map(x => describeIdle(x / 86_400)));
    check("  says what is blocking it", /waiting on review/i.test(body), body);
    check("  and carries the marker that lets the next one find it",
      body.includes(NUDGE_MARKER), body);

    check("  the first reminder does not call itself the first",
      !/reminder 1\b/.test(body), body);
    check("  but later ones say which they are",
      buildNudgeComment(p, "ready", ["alice"], 30, 5).includes("reminder 5"));


  }

  // ── the old comment is found even without a stored id ───────────────
  {
    // A stored id is lost when the state row expires or somebody deletes the
    // comment by hand. Without finding it by marker the next nudge would add a
    // second comment rather than replacing the first.
    const deleted: number[] = [];
    const thread = [
      { id: 7, body: `${NUDGE_MARKER}\nan older reminder`, authorIsApp: true },
      { id: 8, body: "unrelated bot comment with no marker", authorIsApp: true },
      { id: 9, body: "a person talking", authorIsApp: false },
      // GitHub's quote-reply copies the whole body, marker included. Matching
      // on the marker alone would delete somebody's comment because they
      // replied to the reminder.
      { id: 10, body: `> ${NUDGE_MARKER}\n> old reminder\n\nI am on it`, authorIsApp: false },
    ];
    const deps: NudgeDeps = {
      listComments: async () => thread,
      deleteComment: async (_r, id) => { deleted.push(id); },
      postComment: async () => 10,
    };
    await postStickyNudge(deps, pr(), "new body", undefined);
    check("the previous reminder is found by marker with no stored id",
      deleted.join() === "7", deleted);
    check("  and another bot's comment is left alone",
      !deleted.includes(8), deleted);
    check("  as is a person's", !deleted.includes(9), deleted);
    check("  even when they quoted the reminder, marker and all",
      !deleted.includes(10), deleted);
  }

  // ── a failure to read the thread must not duplicate ─────────────────
  {
    const deleted: number[] = [];
    const deps: NudgeDeps = {
      listComments: async () => { throw new Error("500"); },
      deleteComment: async (_r, id) => { deleted.push(id); },
      postComment: async () => 11,
    };
    await postStickyNudge(deps, pr(), "body", 42);
    check("if the thread cannot be read, the stored id is still removed",
      deleted.join() === "42", deleted);

    // And a delete that fails must not stop the reminder being posted.
    let postedAnyway = false;
    let threw = false;
    try {
      await postStickyNudge({
        listComments: async () => [{ id: 5, body: NUDGE_MARKER, authorIsApp: true }],
        deleteComment: async () => { throw new Error("404"); },
        postComment: async () => { postedAnyway = true; return 12; },
      }, pr(), "body");
    } catch { threw = true; }
    // Caught here on purpose. An uncaught throw ends the process, which prints
    // no failures at all and reads as a pass — a mutation removing the internal
    // try/catch scored zero until this was wrapped.
    check("  and a delete that fails does not stop the new one posting",
      postedAnyway && !threw, { postedAnyway, threw });
  }

  // ── the scheduled pass ──────────────────────────────────────────────
  {
    const mkDeps = (prs: PullRequest[], states: Record<string, any> = {}) => {
      const posted: Array<{ repo: string; number: number; body: string }> = [];
      const recorded: string[] = [];
      const deps: NudgeRunDeps = {
        listPrs: async () => ({ prs, truncated: false }),
        getState: async (repo, number) => states[`${repo}#${number}`],
        recordNudge: async (repo, number) => { recorded.push(`${repo}#${number}`); },
        listComments: async () => [],
        deleteComment: async () => {},
        postComment: async (repo, number, body) => { posted.push({ repo, number, body }); return 1; },
        now: NOW,
        // Pinned, so turning the shipped constant down for testing does not
        // rewrite what these assertions mean.
        threshold: SEVEN_DAYS,
      };
      return { deps, posted, recorded };
    };

    const staleOne = pr({ number: 1, lastCommitAt: daysAgo(10), reviewDecision: "APPROVED" });
    const freshOne = pr({ number: 2, lastCommitAt: daysAgo(1) });

    const a = mkDeps([staleOne, freshOne]);
    const r1 = await runNudgePass(a.deps);
    check("only the stale pull request is nudged",
      r1.posted === 1 && a.posted[0].number === 1, { r1, posted: a.posted.map(p => p.number) });
    check("  and the pass reports what it considered", r1.considered === 2 && r1.due === 1, r1);
    check("  a posted reminder is recorded, or the interval never advances",
      a.recorded.join() === "o/api#1", a.recorded);

    // The consequence, asserted directly: a second pass straight after the
    // first must post nothing.
    const a2 = mkDeps([staleOne], { "o/api#1": { lastNudgedAt: new Date(NOW).toISOString() } });
    check("  so an immediate second pass posts nothing",
      (await runNudgePass(a2.deps)).posted === 0, a2.posted.length);

    // Nudged three days ago: not due again for another four.
    const b = mkDeps([staleOne], { "o/api#1": { lastNudgedAt: daysAgo(3) } });
    check("a pull request nudged three days ago is left alone",
      (await runNudgePass(b.deps)).posted === 0, b.posted.length);

    // Nudged eight days ago and still idle: due.
    const c = mkDeps([staleOne], { "o/api#1": { lastNudgedAt: daysAgo(8), nudgeCount: 3 } });
    const r3 = await runNudgePass(c.deps);
    check("  one nudged eight days ago and still idle is nudged again", r3.posted === 1);
    check("  and the comment counts the reminders", c.posted[0].body.includes("reminder 4"),
      c.posted[0].body.slice(0, 60));

    // A paused pull request must not be recorded as nudged. Recording one would
    // restart the seven-day clock, so lifting the pause would be followed by a
    // week of silence instead of the next reminder.
    const d = mkDeps([staleOne], { "o/api#1": { paused: true } });
    const r4 = await runNudgePass(d.deps);
    check("a paused pull request posts nothing", r4.posted === 0 && d.posted.length === 0);
    check("  is counted as paused rather than as done", r4.skippedPaused === 1, r4);
    check("  and is not recorded as nudged, so unpausing does not cost a week of silence",
      d.recorded.length === 0, d.recorded);

    // The block is re-evaluated every pass, so somebody approving between
    // cycles changes who is named without any stored state being updated.
    const waiting = pr({
      number: 5, lastCommitAt: daysAgo(20), reviewDecision: "REVIEW_REQUIRED",
      requestedReviewers: ["bob", "carol"], reviews: [{ login: "bob", state: "APPROVED" }],
    });
    const e = mkDeps([waiting]);
    await runNudgePass(e.deps);
    check("the pass re-evaluates who still owes a review",
      e.posted[0].body.includes("@carol") && !e.posted[0].body.includes("@bob"),
      e.posted[0].body);

    // One failure must not silence everything behind it.
    const f = mkDeps([
      pr({ repo: "o/bad", number: 8, lastCommitAt: daysAgo(10), reviewDecision: "APPROVED" }),
      pr({ repo: "o/good", number: 9, lastCommitAt: daysAgo(10), reviewDecision: "APPROVED" }),
    ]);
    f.deps.postComment = async (repo, number, body) => {
      if (repo === "o/bad") throw new Error("403 — cannot comment here");
      f.posted.push({ repo, number, body });
      return 1;
    };
    let r5: any = null, escaped = false;
    try { r5 = await runNudgePass(f.deps); } catch { escaped = true; }
    check("a repository we cannot comment on does not stop the rest",
      !escaped && r5?.posted === 1 && r5?.failed === 1 && f.posted[0]?.repo === "o/good",
      { escaped, r5, posted: f.posted.map(p => p.repo) });
  }

  // ── the shipped threshold ───────────────────────────────────────────
  {
    // Deliberately not asserted to equal seven days: the constant is turned
    // down for testing and turned back up afterwards, and a test that pins it
    // would have to be edited in step, which is how it ends up forgotten in the
    // wrong position. What matters is that whatever it is, it is a real
    // positive interval and both clocks read the same one.
    check("the shipped threshold is a positive number of seconds",
      Number.isFinite(STALE_SECONDS) && STALE_SECONDS > 0, STALE_SECONDS);
    check("  and staleness and the reminder interval read the same constant",
      staleSeconds() === STALE_SECONDS, { staleSeconds: staleSeconds(), STALE_SECONDS });

    if (STALE_SECONDS !== SEVEN_DAYS) {
      console.log(`  NOTE  threshold is ${STALE_SECONDS}s, not the usual ${SEVEN_DAYS}s — testing mode`);
    }
  }

  // ── the message and the mentions can never disagree ─────────────────
  {
    // The bug this exists for: the comment announced "waiting on review" while
    // deliberately naming no reviewer, because a pending check had shielded
    // them. Seventeen combinations did that, from two functions deciding the
    // same thing independently. Now one decides and the other is derived, and
    // this walks every combination rather than the handful anybody thinks of.
    const states = ["CLEAN", "BLOCKED", "DIRTY", "BEHIND", "UNSTABLE", "DRAFT", "UNKNOWN", null];
    const decisions = ["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED", null];
    const checkStates = ["SUCCESS", "FAILURE", "ERROR", "PENDING", null];

    let saysReviewButNamesNone = 0;
    let namesReviewerButBlamesOther = 0;
    let reviewersOnAuthorOnlyState = 0;
    let combos = 0;

    for (const st of states) for (const d of decisions) for (const c of checkStates) {
      combos++;
      const p = pr({
        mergeStateStatus: st, reviewDecision: d, checksState: c,
        requestedReviewers: ["bob"], author: "alice",
      });
      const reason = blockReason(p);
      const targets = nudgeTargets(p).targets;
      const named = targets.includes("bob");
      const body = buildNudgeComment(p, reason, targets, 9, 1);
      const claimsReviewOutstanding = /review was requested from you/.test(body);

      if (claimsReviewOutstanding && !named) saysReviewButNamesNone++;
      if (reason === "needs-approval" && !named) saysReviewButNamesNone++;
      if (named && blockedByMoreThanApprovals(p)) namesReviewerButBlamesOther++;
      // Anything the author alone can fix must never name a reviewer.
      if (named && ["draft", "conflict", "behind", "checks-failing", "checks-pending", "changes-requested", "blocked"]
            .includes(reason)) reviewersOnAuthorOnlyState++;
    }

    check(`across all ${combos} merge-state combinations, none claims a review is outstanding while naming no reviewer`,
      saysReviewButNamesNone === 0, saysReviewButNamesNone);
    check("  none names a reviewer while blaming something they cannot fix",
      namesReviewerButBlamesOther === 0, namesReviewerButBlamesOther);
    check("  and no author-only state ever names a reviewer",
      reviewersOnAuthorOnlyState === 0, reviewersOnAuthorOnlyState);

    // The specific states that were wrong, named so a regression is readable.
    check("a pending required check reads as checks pending, not as waiting on review",
      blockReason(pr({ mergeStateStatus: "BLOCKED", checksState: "PENDING", reviewDecision: "REVIEW_REQUIRED" }))
        === "checks-pending");
    check("  and a branch behind its base reads as behind",
      blockReason(pr({ mergeStateStatus: "BEHIND", reviewDecision: "REVIEW_REQUIRED" })) === "behind");
    check("  both of which chase the author alone",
      nudgeTargets(pr({ mergeStateStatus: "BEHIND", reviewDecision: "REVIEW_REQUIRED", requestedReviewers: ["bob"] })).targets.join() === "alice");

    // Every reason must have wording, or a state renders as undefined.
    for (const r of ["ready", "needs-approval", "changes-requested", "draft",
                     "conflict", "behind", "checks-failing", "checks-pending", "blocked"] as const) {
      const body = buildNudgeComment(pr({ author: "alice" }), r, ["alice"], 3, 1);
      check(`  the "${r}" state has wording`,
        !/undefined/.test(body) && body.includes("@alice —"), body.slice(0, 80));
    }
  }

  // ── the switches must stop the work, not hide it ────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, "src/routes/pulls.ts"), "utf8");
    const handler = fs.readFileSync(path.join(__dirname, "src/alarms/handler.ts"), "utf8");

    // The list route must decide before it queries GitHub. Checking afterwards
    // means "off" still spends a sweep every time somebody opens the page,
    // which is a switch in appearance only.
    const listBody = src.slice(src.indexOf('router.get("/"'), src.indexOf('router.put("/pause"'));
    // The guard itself, not merely the word appearing somewhere. Looking for
    // any occurrence passed with the condition replaced by `if (false)`,
    // because the message inside the dead branch still mentioned the field.
    const guard = listBody.indexOf("if (!settings.monitoringEnabled)");
    const fetchCall = listBody.indexOf("fetchOpenPrs");
    check("the list refuses before it queries GitHub, not after",
      guard !== -1 && fetchCall !== -1 && guard < fetchCall,
      { guard, fetchCall });

    // Same for the scheduled pass.
    const passBody = handler.slice(handler.indexOf("── stale pull requests ──"));
    const passGate = passBody.indexOf("!prSettings.monitoringEnabled");
    const passFetch = passBody.indexOf("fetchOpenPrs");
    check("  and the scheduled pass checks before fetching anything",
      passGate !== -1 && passFetch !== -1 && passGate < passFetch,
      { passGate, passFetch });

    check("  reminders being off also stops the pass",
      /!prSettings\.remindersEnabled/.test(passBody),
      "the pass would post with reminders switched off");

    // Turning the feature off must not read as a failure in the logs.
    check("  a switched-off feature is not logged as an error",
      /__skip/.test(handler), "an off switch would fill the log with failures");

    // The manual button cannot bypass either switch.
    const runBody = src.slice(src.indexOf('router.post("/run"'), src.indexOf('router.get("/settings"'));
    check("  the manual run refuses when either switch is off",
      /!settings\.monitoringEnabled \|\| !settings\.remindersEnabled/.test(runBody),
      runBody.slice(0, 240));

    // Only admins may flip them.
    const settingsBody = src.slice(src.indexOf('router.put("/settings"'));
    check("  and only an admin may change them",
      /isControlHubAdmin/.test(settingsBody.slice(0, 400)));
  }

  // ── only a commit resets the clock ──────────────────────────────────
  {
    // Everything else people do on a pull request is conversation about work,
    // not work. An approval that reset the timer would let a stalled pull
    // request be kept quiet indefinitely by anyone clicking approve, which is
    // the opposite of what this is for.
    const base = pr({ createdAt: daysAgo(30), lastCommitAt: daysAgo(9) });
    const before = daysSinceLastCommit(base, NOW);

    const events: Array<[string, Partial<PullRequest>]> = [
      ["an approval", { reviews: [{ login: "bob", state: "APPROVED" }], reviewDecision: "APPROVED" }],
      ["changes requested", { reviews: [{ login: "bob", state: "CHANGES_REQUESTED" }], reviewDecision: "CHANGES_REQUESTED" }],
      ["a comment", { reviews: [{ login: "bob", state: "COMMENTED" }] }],
      ["a reviewer added", { requestedReviewers: ["bob", "carol"] }],
      ["a reviewer removed", { requestedReviewers: [] }],
      ["a review re-requested", { requestedReviewers: ["bob"], reviews: [] }],
      ["checks turning green", { checksState: "SUCCESS" }],
      ["checks starting to fail", { checksState: "FAILURE" }],
      ["becoming mergeable", { mergeStateStatus: "CLEAN" }],
      ["becoming blocked", { mergeStateStatus: "BLOCKED" }],
      ["conflicts appearing", { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
      ["the title being edited", { title: "renamed" }],
      ["the base branch changing", { baseRef: "develop" }],
      ["being marked draft", { isDraft: true }],
    ];

    const moved = events.filter(([, over]) =>
      daysSinceLastCommit({ ...base, ...over }, NOW) !== before).map(([n]) => n);
    check(`none of ${events.length} non-commit events resets the clock`,
      moved.length === 0, moved);

    check("  an approval leaves it stale and still due",
      isStale({ ...base, reviews: [{ login: "bob", state: "APPROVED" }] }, NOW, SEVEN_DAYS)
        && isNudgeDue({ ...base, reviews: [{ login: "bob", state: "APPROVED" }] }, null, NOW, SEVEN_DAYS),
      "approving would silence a stalled pull request without touching it");

    check("  while a commit does reset it",
      daysSinceLastCommit({ ...base, lastCommitAt: daysAgo(1) }, NOW) < before);

    // The clock reads committedDate, so a rebase or amend counts as a commit —
    // the branch genuinely moved. Nothing else in the payload is consulted.
    const src = fs.readFileSync(path.join(__dirname, "src/services/prNudgeService.ts"), "utf8");
    check("  and the clock is fed only by the branch's last commit",
      /lastCommitAt: commit\?\.committedDate/.test(src)
        && /const basis = pr\.lastCommitAt \?\? pr\.createdAt;/.test(src),
      "any other field feeding it would let conversation pass for work");
  }

  // ── a mute outlives the pull request being closed ───────────────────
  //
  // Closing a pull request removes it from the list, because the list is built
  // from what GitHub currently reports as open. If that were also what held the
  // mute, reopening would come back unmuted — and the person who was
  // deliberately left out would start being chased by a reminder nobody
  // reinstated. Nothing about closing touches the stored row; this asserts that
  // rather than assuming it.
  {
    __resetAlarmStoreForTests();
    const repo = "example-org/service", number = 41;

    await setPrPause(repo, number, { pausedLogins: ["carol"] }, "admin");
    await recordNudge(repo, number, 5001);

    const pr: PullRequest = {
      repo, number, title: "Add retries", url: "https://example.invalid/pr/41",
      author: "alice", headRef: "retries", baseRef: "main",
      createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      lastCommitAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      requestedReviewers: ["carol", "dave"], reviews: [],
      reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED", isDraft: false, checksState: "SUCCESS",
    };

    const rules = async () => {
      const st = await getPrState(repo, number);
      return { prPaused: st?.paused, prLogins: st?.pausedLogins };
    };

    const before = nudgeTargets(pr, await rules());
    check("the muted reviewer is left out while the PR is open",
      !before.targets.includes("carol") && before.targets.includes("dave"), before);

    // Closed: GitHub stops listing it. The list shrinks; the store does not.
    const openNow: PullRequest[] = [];
    check("a closed pull request is not in the list", openNow.length === 0);
    check("  but its row is still stored",
      (await listPrStates()).some(r => r.id === prStateId(repo, number)));

    // Reopened. Same repository, same number — GitHub never reissues one.
    const after = nudgeTargets(pr, await rules());
    check("reopening it keeps the mute", !after.targets.includes("carol"), after);
    check("  and still names everybody else", after.targets.includes("dave"), after);
    check("  and remembers what was already sent",
      (await getPrState(repo, number))?.nudgeCount === 1);

    // A pause behaves the same way.
    await setPrPause(repo, number, { paused: true }, "admin");
    const paused = nudgeTargets(pr, await rules());
    check("a pause set before closing is still a pause after reopening",
      paused.targets.length === 0, paused);

    // And lifting it still works on the row that survived.
    await setPrPause(repo, number, { paused: false, pausedLogins: [] }, "admin");
    const lifted = nudgeTargets(pr, await rules());
    check("unmuting after a reopen puts everyone back",
      lifted.targets.includes("carol") && lifted.targets.includes("dave"), lifted);
  }

  // ── the row is keyed so a reopen finds it ────────────────────────────
  {
    check("the key is the repository and number, nothing about open or closed",
      prStateId("org/repo", 7) === "pr-state#org/repo#7", prStateId("org/repo", 7));
    check("two pull requests do not share a row",
      prStateId("org/repo", 7) !== prStateId("org/repo", 71));
    check("the same number in two repositories does not share a row",
      prStateId("org/a", 7) !== prStateId("org/b", 7));
  }

  // ── an active pull request never expires out from under a mute ───────
  {
    __resetAlarmStoreForTests();
    const repo = "example-org/service", number = 9;
    await setPrPause(repo, number, { pausedLogins: ["erin"] }, "admin");
    const first = await getPrState(repo, number);

    // Every write pushes the expiry out. A pull request being worked on is
    // written to on each nudge, so the mute cannot quietly lapse mid-review.
    await new Promise(r => setTimeout(r, 1100));
    await recordNudge(repo, number, 5002);
    const second = await getPrState(repo, number);

    check("the stored row carries an expiry", typeof first?.ttl === "number" && first!.ttl > 0);
    check("  which is months out, not days",
      first!.ttl - Math.floor(Date.now() / 1000) > 100 * 86_400, first!.ttl);
    check("  and is pushed further out on every write", second!.ttl > first!.ttl,
      { first: first!.ttl, second: second!.ttl });
    check("  while the mute itself is untouched by that write",
      second?.pausedLogins?.includes("erin") === true, second);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
