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
  daysSinceLastCommit, isStale, hasApproved, pendingReviewers, blockReason,
  blockedByMoreThanApprovals,
  nudgeTargets, isNudgeDue, sortByStaleness, fetchOpenPrs, STALE_DAYS,
  buildNudgeComment, postStickyNudge, NUDGE_MARKER, runNudgePass, staleSeconds,
  SEVEN_DAYS, STALE_SECONDS,
  type PullRequest, type NudgeDeps, type NudgeRunDeps,
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
  isDraft: false, reviewDecision: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
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

  // ── pausing, which people notice when it fails ──────────────────────
  {
    const p = pr({
      author: "alice",
      reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", checksState: "SUCCESS",
      requestedReviewers: ["bob", "carol"],
    });

    check("a paused pull request chases nobody",
      nudgeTargets(p, { pr: true }).targets.length === 0);
    check("  and still reports why it is blocked, so the list stays honest",
      nudgeTargets(p, { pr: true }).reason === "needs-approval");

    const oneOff = nudgeTargets(p, { logins: ["bob"] });
    check("  muting one reviewer leaves the others, and the author",
      oneOff.targets.join() === "alice,carol", oneOff.targets);

    // The author is always named, so muting every reviewer does not silence the
    // reminder — it narrows it to the one person who can always do something.
    check("  muting every reviewer leaves the author, who is always named",
      nudgeTargets(p, { logins: ["bob", "carol"] }).targets.join() === "alice",
      nudgeTargets(p, { logins: ["bob", "carol"] }).targets);

    check("  muting the author as well leaves nobody, and so no reminder",
      nudgeTargets(p, { logins: ["alice", "bob", "carol"] }).targets.length === 0,
      "a reminder addressed to nobody would still post a comment");

    check("  a muted login matches case-insensitively",
      nudgeTargets(p, { logins: ["BOB"] }).targets.join() === "alice,carol");
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
    check("  says how long it has been idle, in whole days",
      body.includes("9 days") && !body.includes("9.7"), body);
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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
