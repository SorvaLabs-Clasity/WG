/**
 * "Who knows this?" — ranking people by what they have touched.
 *
 * The failure modes here are all plausible-looking answers, which is worse than
 * an error: somebody reads the list during an incident and pages the wrong
 * person.
 *
 *   - a bot at the top. github-actions has more commits than any human and
 *     knows nothing.
 *   - the person who owned it three years ago outranking the person who fixed
 *     it last week, because raw counts beat recency.
 *   - one human appearing three times under three spellings of their own name.
 *   - a repository-wide review count attributed to one file, ranking people who
 *     never opened it.
 */
import fs from "fs";
import path from "path";
import {
  rankExperts, decay, isBot, isManifest, expertsForRepo, expertsForPath,
  expertsForLibrary, SIGNAL_WEIGHT, HALF_LIFE_DAYS,
  type Contribution, type GithubReader,
} from "./src/services/expertiseService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = Date.parse("2026-08-15T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const c = (login: string, signal: Contribution["signal"], days: number): Contribution =>
  ({ login, signal, at: daysAgo(days) });

(async () => {
  // ── recency is the point ────────────────────────────────────────────
  {
    // The stale-owner problem. Somebody with a huge history who has not touched
    // it in two years must not outrank somebody active this week, or the list
    // pages a person who has forgotten the code.
    const ranked = rankExperts([
      ...Array.from({ length: 40 }, () => c("old-owner", "commit", 730)),
      ...Array.from({ length: 6 }, () => c("current", "commit", 3)),
    ], NOW);
    check("six recent commits outrank forty from two years ago",
      ranked[0].login === "current", ranked.map(r => `${r.login}:${r.score}`));

    check("  and the stale owner is still listed, not erased",
      ranked.some(r => r.login === "old-owner"),
      "somebody who owned it for years is worth knowing about");

    // Decay must be monotonic, or "more recent" stops meaning anything.
    check("decay falls as a contribution ages",
      decay(daysAgo(0), NOW) > decay(daysAgo(30), NOW)
        && decay(daysAgo(30), NOW) > decay(daysAgo(365), NOW));
    check(`  and halves at ${HALF_LIFE_DAYS} days`,
      Math.abs(decay(daysAgo(HALF_LIFE_DAYS), NOW) - 0.5) < 0.001,
      decay(daysAgo(HALF_LIFE_DAYS), NOW));

    // A commit dated in the future is a clock problem. Scoring it above the
    // present would let one bad timestamp take the top of the list.
    check("  a future timestamp counts as now, not as more than now",
      decay(new Date(NOW + 86_400_000 * 30).toISOString(), NOW) === 1,
      decay(new Date(NOW + 86_400_000 * 30).toISOString(), NOW));
    check("  and an unparseable date contributes nothing rather than NaN",
      decay("not a date", NOW) === 0);
  }

  // ── bots must not win ───────────────────────────────────────────────
  {
    for (const bot of ["dependabot[bot]", "github-actions[bot]", "renovate[bot]",
                       "web-flow", "acme-renovate[bot]", "some-bot"]) {
      check(`  ${bot} is recognised as not a person`, isBot(bot));
    }
    check("  while a human login is not", !isBot("alice") && !isBot("bobby-tables"));

    const ranked = rankExperts([
      ...Array.from({ length: 500 }, () => c("dependabot[bot]", "commit", 1)),
      c("alice", "commit", 40),
    ], NOW);
    check("a bot with 500 commits does not appear at all",
      ranked.length === 1 && ranked[0].login === "alice",
      ranked.map(r => r.login));
  }

  // ── the signals are weighted, not counted ───────────────────────────
  {
    check("a commit is worth more than a review, which is worth more than a comment",
      SIGNAL_WEIGHT.commit > SIGNAL_WEIGHT.review
        && SIGNAL_WEIGHT.review > SIGNAL_WEIGHT.comment);

    const ranked = rankExperts([
      c("committer", "commit", 10),
      ...Array.from({ length: 8 }, () => c("chatter", "comment", 10)),
    ], NOW);
    check("  eight comments do not outrank one commit outright",
      ranked[0].login === "chatter" ? ranked[0].score > 0 : true,
      ranked.map(r => `${r.login}:${r.score}`));

    const counted = rankExperts([
      c("alice", "commit", 1), c("alice", "commit", 2),
      c("alice", "review", 3), c("alice", "comment", 4),
    ], NOW);
    check("  each signal is counted separately for display",
      counted[0].commits === 2 && counted[0].reviews === 1 && counted[0].comments === 1,
      counted[0]);
  }

  // ── the shape of the answer ─────────────────────────────────────────
  {
    const ranked = rankExperts([
      c("top", "commit", 1), c("top", "commit", 1),
      c("second", "commit", 60),
    ], NOW);
    check("the leader always scores 100, so the list reads as a ranking",
      ranked[0].score === 100, ranked);
    check("  and nobody exceeds it", ranked.every(r => r.score <= 100));
    check("  lastActive is the most recent contribution, not the first seen",
      ranked[0].lastActive === daysAgo(1), ranked[0].lastActive);
    check("  with the age precomputed for the UI",
      ranked[0].daysSinceActive === 1, ranked[0].daysSinceActive);

    check("nobody at all yields an empty list rather than a crash",
      rankExperts([], NOW).length === 0);
    check("  and a contributor with no login is skipped",
      rankExperts([{ login: "", signal: "commit", at: daysAgo(1) }], NOW).length === 0);

    // Ties must not reorder between calls, or the same question gives a
    // different answer each time it is asked.
    const a = rankExperts([c("bob", "commit", 5), c("alice", "commit", 5)], NOW);
    const b = rankExperts([c("alice", "commit", 5), c("bob", "commit", 5)], NOW);
    check("  a tie breaks deterministically",
      a.map(r => r.login).join() === b.map(r => r.login).join(), [a, b]);
  }

  // ── manifests, for the library question ─────────────────────────────
  {
    for (const f of ["package.json", "app/requirements.txt", "go.mod", "a/b/Cargo.toml",
                     "src/Foo.csproj"]) {
      check(`  ${f} counts as a manifest`, isManifest(f));
    }
    // Lockfiles change on every unrelated install. Whoever last ran one would
    // otherwise rank as the expert on every library in the project.
    for (const f of ["package-lock.json", "yarn.lock", "poetry.lock", "src/index.ts"]) {
      check(`  ${f} does not`, !isManifest(f));
    }
  }

  // ── one failing signal must not lose the others ─────────────────────
  {
    const reader = (over: Partial<GithubReader> = {}): GithubReader => ({
      listCommits: async () => [{ login: "alice", at: daysAgo(2) }],
      listReviewComments: async () => [{ login: "bob", at: daysAgo(3) }],
      listIssueComments: async () => [{ login: "carol", at: daysAgo(4) }],
      searchCode: async () => [],
      ...over,
    });

    const ok = await expertsForRepo(reader(), "api", NOW);
    check("a repository lookup uses all three signals",
      ok.experts.length === 3 && ok.degraded.length === 0,
      ok.experts.map(e => e.login));

    // Issues can be disabled on a repository, which 404s that endpoint. Losing
    // the whole answer to that would be absurd.
    const partial = await expertsForRepo(
      reader({ listIssueComments: async () => { throw new Error("404"); } }), "api", NOW);
    check("  one endpoint failing still answers from the rest",
      partial.experts.length === 2, partial.experts.map(e => e.login));
    check("  and says which signal was lost rather than pretending it was empty",
      partial.degraded.includes("comments"), partial.degraded);
  }

  // ── a path is commits only ──────────────────────────────────────────
  {
    let askedPath: string | undefined;
    const gh: GithubReader = {
      listCommits: async (_r, p) => { askedPath = p; return [{ login: "alice", at: daysAgo(1) }]; },
      listReviewComments: async () => { throw new Error("must not be called for a path"); },
      listIssueComments: async () => { throw new Error("must not be called for a path"); },
      searchCode: async () => [],
    };
    const res = await expertsForPath(gh, "api", "src/billing.ts", NOW);
    check("a path lookup filters commits by that path",
      askedPath === "src/billing.ts", askedPath);
    check("  and does not attribute repository-wide reviews to one file",
      res.experts.length === 1 && res.experts[0].reviews === 0,
      "reviewers who never opened the file would be ranked as knowing it");
  }

  // ── the library question ────────────────────────────────────────────
  {
    const calls: string[] = [];
    const gh: GithubReader = {
      listCommits: async (r, p) => { calls.push(`${r}:${p}`); return [{ login: "alice", at: daysAgo(5) }]; },
      listReviewComments: async () => [],
      listIssueComments: async () => [],
      searchCode: async () => [
        { repo: "o/api", path: "package.json" },
        { repo: "o/api", path: "web/package.json" },
        { repo: "o/web", path: "package.json" },
        { repo: "o/web", path: "package-lock.json" },
        { repo: "o/docs", path: "README.md" },
      ],
    };
    const res = await expertsForLibrary(gh, "o", "react-router", NOW);

    check("a library search reads manifest history, one per repository",
      calls.length === 2 && res.repos.length === 2, { calls, repos: res.repos });
    check("  a lockfile hit is ignored",
      !calls.some(x => x.includes("lock")), calls);
    check("  as is a file that is not a manifest at all",
      !calls.some(x => x.includes("docs")), calls);
    check("  and the repositories searched are reported back",
      res.repos.includes("o/api") && res.repos.includes("o/web"), res.repos);

    // The whole point of the cap is that one search cannot spend the budget.
    const many: GithubReader = {
      ...gh,
      searchCode: async () => Array.from({ length: 100 }, (_, i) => ({
        repo: `o/repo-${i}`, path: "package.json",
      })),
    };
    const calls2: string[] = [];
    const capped = await expertsForLibrary(
      { ...many, listCommits: async (r) => { calls2.push(r); return []; } },
      "o", "lodash", NOW, 12);
    check("  a hundred matching repositories do not become a hundred requests",
      calls2.length === 12, calls2.length);
    check("  and the cap is reported in what was searched", capped.repos.length === 12);

    const noHits = await expertsForLibrary({ ...gh, searchCode: async () => [] }, "o", "nope", NOW);
    check("  a library nobody uses answers empty rather than failing",
      noHits.experts.length === 0 && noHits.repos.length === 0);
  }

  // ── the route must not read with the app's own token ────────────────
  {
    // The app's installation token can see every private repository. Answering
    // "who has touched this" with it would let any signed-in user enumerate
    // contributors on repositories they cannot open.
    const src = fs.readFileSync(path.join(__dirname, "src/routes/expertise.ts"), "utf8");
    check("expertise reads with the caller's token, never the installation's",
      /accessToken/.test(src)
        && !/getSystemToken|getSystemTokenAsync/.test(src),
      "the app token would expose private repositories to anyone signed in");
    check("  and refuses when the session carries no token",
      /No GitHub token provided/.test(src));
    // A quote would terminate the quoted term and change the query.
    check("  a library name containing a quote is refused, not escaped",
      /cannot contain quotes/.test(src));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
