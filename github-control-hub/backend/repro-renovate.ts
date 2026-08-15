/**
 * Renovate pull requests, found by authorship.
 *
 * The quiet failures this guards against:
 *
 *   - the retention window built from the wrong field, so closed PRs either
 *     vanish early or never leave.
 *   - a truncated search read as a complete one. GitHub stops paging at 1,000
 *     results, and a count that silently caps looks like a plateau rather than
 *     a limit.
 *   - merged and abandoned PRs reading alike, which is most of what the list
 *     is opened to distinguish.
 */
import fs from "fs";
import path from "path";
import {
  buildQueries, normalizePr, fetchRenovatePrs, openPrs, retentionCutoff, botCandidates,
  CLOSED_RETENTION_MONTHS, type SearchIssues,
} from "./src/services/renovateService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = new Date("2026-08-14T12:00:00Z");

// ── the two queries ───────────────────────────────────────────────────
{
  const q = buildQueries("Acme-Org", "acme-renovate", NOW);

  check("both queries scope to the org and the bot",
    q.open.includes("org:Acme-Org") && q.open.includes("author:acme-renovate")
      && q.closed.includes("org:Acme-Org") && q.closed.includes("author:acme-renovate"), q);

  check("  open asks only for open", q.open.includes("is:open") && !q.open.includes("is:closed"), q.open);
  check("  and restricts nothing else — an old open PR still counts",
    !/closed:|created:|updated:/.test(q.open), q.open);

  // The retention rule lives here, as a filter on closed_at. Filtering on
  // updated_at instead would keep a PR alive because someone commented on it.
  check("closed is bounded by when it closed, not when it was touched",
    /is:closed closed:>=\d{4}-\d{2}-\d{2}/.test(q.closed), q.closed);
  check(`  and the bound is ${CLOSED_RETENTION_MONTHS} months back`,
    q.closed.includes("closed:>=2026-05-14"), q.closed);

  check("the cutoff moves with the clock",
    retentionCutoff(new Date("2026-01-10T00:00:00Z")).toISOString().startsWith("2025-10-10"),
    retentionCutoff(new Date("2026-01-10T00:00:00Z")).toISOString());
}

// ── turning a search result into a row ────────────────────────────────
{
  const item = {
    id: 991, number: 42, title: "Update dependency lodash to v4.17.21",
    repository_url: "https://api.github.com/repos/Acme-Org/payments-api",
    html_url: "https://github.com/Acme-Org/payments-api/pull/42",
    state: "open", created_at: "2026-08-04T12:00:00Z", updated_at: "2026-08-10T12:00:00Z",
    closed_at: null, draft: false, pull_request: {},
  };
  const pr = normalizePr(item);

  // Search returns issues, so the repo has to be recovered from the URL.
  check("the repository is recovered from repository_url", pr.repo === "payments-api", pr.repo);
  check("  the browser link is kept, not the API url",
    pr.url.startsWith("https://github.com/") && pr.url.endsWith("/pull/42"), pr.url);
  check("  an open PR has no closedAt", pr.state === "open" && pr.closedAt === null, pr);

  const merged = normalizePr({ ...item, state: "closed", closed_at: "2026-08-12T12:00:00Z",
    pull_request: { merged_at: "2026-08-12T12:00:00Z" } });
  const abandoned = normalizePr({ ...item, state: "closed", closed_at: "2026-08-12T12:00:00Z",
    pull_request: {} });

  check("a merged PR is distinguishable from an abandoned one",
    merged.merged && !abandoned.merged, [merged.merged, abandoned.merged]);
  check("  and both read as closed", merged.state === "closed" && abandoned.state === "closed");

  // Age is what tells a PR nobody has looked at from one raised this morning.
  check("age is measured to the close, not to now, once closed",
    merged.ageDays === 8, merged.ageDays);

  const junk = normalizePr({});
  check("a malformed item yields a row rather than throwing",
    junk.repo === "unknown" && junk.number === 0 && junk.state === "open", junk);
}

(async () => {
  // ── paging, and knowing when the answer is incomplete ─────────────────
  {
    const pageOf = (n: number, state: string, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: from + i, number: from + i, title: `PR ${from + i}`,
        repository_url: "https://api.github.com/repos/Org/repo",
        html_url: `https://github.com/Org/repo/pull/${from + i}`,
        state, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
        closed_at: state === "closed" ? "2026-08-02T00:00:00Z" : null, pull_request: {},
      }));

    let calls: string[] = [];
    const search: SearchIssues = async (q, page) => {
      calls.push(`${q.includes("is:open") ? "open" : "closed"}#${page}`);
      if (q.includes("is:open")) {
        return { items: page === 1 ? pageOf(100, "open", 1) : page === 2 ? pageOf(30, "open", 101) : [] };
      }
      return { items: page === 1 ? pageOf(5, "closed", 500) : [] };
    };

    const res = await fetchRenovatePrs(search, "Org", "bot", NOW);
    check("every page of open results is followed", openPrs(res.prs).length === 130, openPrs(res.prs).length);
    check("  and a short page ends the walk rather than a guess",
      !calls.includes("open#3"), calls);
    check("  closed results are collected too", res.prs.length === 135, res.prs.length);
    check("  a complete answer is not flagged as truncated", !res.truncated, res.truncated);

    // GitHub refuses to page past 1,000 search results.
    const always: SearchIssues = async () => ({ items: pageOf(100, "open", 1) });
    const capped = await fetchRenovatePrs(always, "Org", "bot", NOW);
    check("hitting the search ceiling is reported, not hidden",
      capped.truncated === true, capped.truncated);
  }

  // ── ordering: what needs merging comes first ──────────────────────────
  {
    const mk = (state: string, created: string, closed: string | null) => ({
      id: Math.random(), number: 1, title: "t",
      repository_url: "https://api.github.com/repos/Org/r",
      html_url: "https://github.com/Org/r/pull/1",
      state, created_at: created, updated_at: created, closed_at: closed, pull_request: {},
    });
    const search: SearchIssues = async (q) => ({
      items: q.includes("is:open")
        ? [mk("open", "2026-08-12T00:00:00Z", null), mk("open", "2026-06-01T00:00:00Z", null)]
        : [mk("closed", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"),
           mk("closed", "2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z")],
    });

    const { prs } = await fetchRenovatePrs(search, "Org", "bot", NOW);
    check("open PRs sort above closed ones",
      prs.slice(0, 2).every(p => p.state === "open"), prs.map(p => p.state));
    check("  the longest-open first, since that is the one being ignored",
      prs[0].ageDays > prs[1].ageDays, [prs[0].ageDays, prs[1].ageDays]);
    check("  and closed ones most-recently-closed first",
      new Date(prs[2].closedAt!) > new Date(prs[3].closedAt!),
      [prs[2].closedAt, prs[3].closedAt]);
  }

  // ── an unknown bot account is a state, not a crash ────────────────────
  {
    // Found by running this against a real organization: GitHub answers
    // `author:` for a user it cannot find with 422 Validation Failed, not with
    // an empty result. Left to propagate it becomes a 500 and reads as the
    // feature being broken, when the fix is to correct one word of config.
    const notFound: SearchIssues = async () => {
      const e: any = new Error("Validation Failed: The listed users cannot be searched");
      e.status = 422;
      throw e;
    };
    const res = await fetchRenovatePrs(notFound, "Org", "no-such-bot", NOW);
    check("an unknown bot account reports itself instead of throwing",
      res.unknownBot === true && res.prs.length === 0, res);

    // Anything else is a real failure and must not be swallowed.
    const broken: SearchIssues = async () => {
      const e: any = new Error("Bad credentials"); e.status = 401; throw e;
    };
    let threw = false;
    try { await fetchRenovatePrs(broken, "Org", "bot", NOW); } catch { threw = true; }
    check("  but a genuine error still surfaces", threw,
      "a 401 would be reported as an unknown bot account");
  }

  // ── a GitHub App's login carries a [bot] suffix ───────────────────────
  {
    // Verified against live GitHub: `author:renovate[bot]` returns results,
    // `author:renovate` answers 422. The suffix is invisible in the UI, which
    // shows the App's display name with a separate "Bot" label — so the
    // obvious thing to type is the thing search rejects.
    check("the App form is tried first",
      botCandidates("acme-renovate")[0] === "acme-renovate[bot]", botCandidates("acme-renovate"));
    check("  and the plain form is still tried",
      botCandidates("acme-renovate").includes("acme-renovate"), botCandidates("acme-renovate"));
    check("  a name already carrying the suffix is not doubled",
      botCandidates("acme-renovate[bot]")[0] === "acme-renovate[bot]"
        && !botCandidates("acme-renovate[bot]").some(c => c.includes("[bot][bot]")),
      botCandidates("acme-renovate[bot]"));

    // Typing the display name must find the App.
    // Matched on the whole token, not a substring: "author:some-user[bot]"
    // contains "author:some-user", so a loose check accepts the wrong login
    // and the test passes for a reason the real API would not.
    const only = (login: string): SearchIssues => async (q) => {
      const asked = /author:(\S+)/.exec(q)?.[1];
      if (asked !== login) {
        const e: any = new Error("Validation Failed"); e.status = 422; throw e;
      }
      return { items: q.includes("is:open") ? [{
        id: 1, number: 7, title: "Update dependency", state: "open",
        repository_url: "https://api.github.com/repos/Org/api",
        html_url: "https://github.com/Org/api/pull/7",
        created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
        closed_at: null, pull_request: {},
      }] : [] };
    };

    const typedPlain = await fetchRenovatePrs(only("acme-renovate[bot]"), "Org", "acme-renovate", NOW);
    check("typing the display name finds the App behind it",
      !typedPlain.unknownBot && typedPlain.prs.length === 1, typedPlain);
    check("  and reports which login actually matched",
      typedPlain.resolvedBot === "acme-renovate[bot]", typedPlain.resolvedBot);

    // And a genuine user account still works.
    const typedUser = await fetchRenovatePrs(only("some-user"), "Org", "some-user", NOW);
    check("a real user account still resolves",
      !typedUser.unknownBot && typedUser.resolvedBot === "some-user", typedUser.resolvedBot);

    // Neither form existing is still an unknown bot.
    const neither: SearchIssues = async () => {
      const e: any = new Error("Validation Failed"); e.status = 422; throw e;
    };
    const nope = await fetchRenovatePrs(neither, "Org", "nobody", NOW);
    check("  a name matching neither form reports unknown", nope.unknownBot === true, nope);
  }

  // ── the app must not be able to merge ─────────────────────────────────
  {
    // Asked for explicitly: this app shows Renovate PRs and hands you to GitHub.
    // A merge route added later is a merge route somebody can call, so its
    // absence is asserted rather than left to memory.
    const dir = path.join(__dirname, "src");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name))
          : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []);

    const offenders = walk(dir).filter(f =>
      /pulls\.merge|\.merge\(|mergePullRequest|PUT .*\/merge/.test(fs.readFileSync(f, "utf8")));
    check("nothing anywhere can merge a pull request", offenders.length === 0, offenders);
  }

    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })();

