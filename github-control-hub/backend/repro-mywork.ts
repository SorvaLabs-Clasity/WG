/**
 * The same pull requests, read from the developer's side.
 *
 * Every screen in this app answers an auditor's question. This one answers
 * "what do I do next", out of exactly the same rows, and the interesting part
 * is not the filtering. It is that a queue nobody trusts is worse than no
 * queue. Two ways that happens, both asserted here:
 *
 *   Listing something with nothing to do in it. A reviewer who already approved
 *   is not still on the hook, and a list that says they are gets closed and not
 *   reopened.
 *
 *   Reporting "nothing is waiting on you" when the truth is "we have not looked
 *   yet". Those are opposite messages built from the same empty list.
 *
 * Run:  npx tsx repro-mywork.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { myWork, waitingOn } from "./src/services/developerService";
import type { PullRequest } from "./src/services/prNudgeService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-28T12:00:00Z");

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "web", number: 1, title: "t", url: "u", author: "alice",
  headRef: "f", baseRef: "main",
  createdAt: new Date(NOW - 3 * DAY).toISOString(),
  lastCommitAt: new Date(NOW - DAY).toISOString(),
  isDraft: false, reviewDecision: null, mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", requestedReviewers: [], reviews: [],
  checksState: "SUCCESS",
  ...over,
} as PullRequest);

(async () => {
  // ── whose problem is it ─────────────────────────────────────────────
  {
    check("a conflict is the author's problem", waitingOn("conflict") === "you");
    check("  as is a stale base", waitingOn("behind") === "you");
    check("  and a failing check", waitingOn("checks-failing") === "you");
    // Changes were requested, so the ball came back.
    check("  and requested changes", waitingOn("changes-requested") === "you");
    check("waiting for approval is the reviewers'", waitingOn("needs-approval") === "reviewers");
    check("a ready one is waiting on nobody", waitingOn("ready") === "nobody");
    // Waiting is the correct action here, and calling it your problem would
    // send somebody to look at a pull request they can do nothing about.
    check("running checks are waiting on a machine", waitingOn("checks-pending") === "checks");
  }

  // ── the two halves ──────────────────────────────────────────────────
  {
    const w = myWork([
      pr({ number: 1, author: "alice" }),
      pr({ number: 2, author: "bob", requestedReviewers: ["alice"], mergeStateStatus: "BLOCKED" }),
      pr({ number: 3, author: "carol" }),
    ], "alice", NOW);

    check("my own pull requests are mine", w.mine.map(p => p.number).join() === "1", w.mine);
    check("  one asking for my review is separate", w.toReview.map(p => p.number).join() === "2", w.toReview);
    check("  and one that is neither appears in neither",
      !JSON.stringify(w).includes('"number":3'));
  }

  // ── a queue with nothing to do in it ────────────────────────────────
  {
    const already = pr({
      number: 9, author: "bob", requestedReviewers: ["alice"],
      reviews: [{ login: "alice", state: "APPROVED" }],
      mergeStateStatus: "BLOCKED",
    });
    check("somebody who already approved is off the hook",
      myWork([already], "alice", NOW).toReview.length === 0,
      "a list with nothing to do in it gets closed and not reopened");

    // A draft is explicitly not a request for anyone else's time.
    const draft = pr({ number: 10, author: "bob", requestedReviewers: ["alice"], isDraft: true });
    check("  a draft does not ask for my review",
      myWork([draft], "alice", NOW).toReview.length === 0);
    check("  but my own draft is still mine to deal with",
      myWork([pr({ number: 11, author: "alice", isDraft: true })], "alice", NOW).mine.length === 1,
      "it is my unfinished work, and hiding it is how it stays unfinished");
  }

  // ── logins are case-insensitive on GitHub ───────────────────────────
  {
    const w = myWork([
      pr({ number: 1, author: "Alice" }),
      pr({ number: 2, author: "bob", requestedReviewers: ["ALICE"], mergeStateStatus: "BLOCKED" }),
    ], "alice", NOW);
    check("a differently-cased login still finds your work",
      w.mine.length === 1 && w.toReview.length === 1,
      "an exact match gives an empty tab, which reads as nothing to do");
  }

  // ── ordering and the counts on top ──────────────────────────────────
  {
    const w = myWork([
      pr({ number: 1, author: "alice", lastCommitAt: new Date(NOW - DAY).toISOString() }),
      pr({ number: 2, author: "alice", lastCommitAt: new Date(NOW - 20 * DAY).toISOString() }),
      pr({ number: 3, author: "alice", lastCommitAt: new Date(NOW - 5 * DAY).toISOString() }),
    ], "alice", NOW);
    check("the most idle comes first",
      w.mine.map(p => p.number).join() === "2,3,1",
      "the oldest is the one most likely to have been forgotten");

    const counts = myWork([
      pr({ number: 1, author: "alice", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }),
      pr({ number: 2, author: "alice", mergeable: "CONFLICTING" }),
      pr({ number: 3, author: "alice", mergeStateStatus: "BLOCKED", requestedReviewers: ["bob"] }),
    ], "alice", NOW);
    check("  the headline counts what can be merged now",
      counts.mergeable === 1, counts.mergeable);
    check("  and what is on you rather than on anybody else",
      counts.onYou === 1, counts.onYou);
  }

  // ── not looked yet is not the same as nothing to do ─────────────────
  {
    const route = fs.readFileSync("./src/routes/me.ts", "utf8");
    check("an uncollected snapshot answers 200 with collected:false",
      /collected: false/.test(route) && !/status\(50\d\)[\s\S]{0,80}snapshot/.test(route),
      '"nothing to do" and "we have not looked" are opposite messages from one empty list');
    check("  and a collected one says when",
      /cachedAt: snapshot\.cachedAt/.test(route));
    check("  a truncated walk says so rather than silently dropping the tail",
      /truncated/.test(route));

    // The whole point is that this is cheap enough to open every morning.
    check("the queue costs no GitHub requests",
      /readPrSnapshot/.test(route) && !/fetchOpenPrs/.test(route),
      "a screen that spends a hundred calls to say nothing is waiting stops being opened");

    const server = fs.readFileSync("./src/server.ts", "utf8");
    check("it is gated like the rest of GitHub",
      /app\.use\("\/api\/me", authMiddleware, githubGateMiddleware, meRoutes\)/.test(server),
      "an AWS-only account has no GitHub work to show and must not be asked");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
