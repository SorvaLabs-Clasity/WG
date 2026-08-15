/**
 * Dependabot alert paging.
 *
 * Two bugs, one after the other, in the same handful of lines.
 *
 * The first: all three calls in routes/dependencies.ts asked GitHub for
 * `per_page: 100` and used the single page they got back. An organization with
 * more than a hundred open alerts under-counted every severity and under-listed
 * every affected repository — no error, no warning, in the direction that looks
 * like good news.
 *
 * The second was the fix for the first. It walked pages with `?page=N`, which
 * is how every other paginated call in this codebase works — and which the
 * Dependabot alerts endpoints reject outright:
 *
 *     400  Pagination using the `page` parameter is not supported.
 *
 * Both the organization-level and repository-level alert endpoints use cursor
 * pagination instead: a `Link` header carrying `rel="next"` with an `after`
 * cursor. The route's catch tolerated only 403 and 404, so the 400 propagated,
 * the request returned 500, and the Dependabot page rendered nothing at all.
 * Under-reporting became reporting nothing.
 *
 * The previous version of this suite passed throughout, because its fake
 * accepted `page` and returned arrays. It proved the loop agreed with the fake.
 * The fake was the thing that was wrong, so the fake here refuses `page` the
 * way GitHub does.
 */
import fs from "fs";
import path from "path";
import { fetchAllCursorPages } from "./src/utils/cursorPages";
import { fetchRepoAlertStatus } from "./src/services/dependencyService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/**
 * A fake GitHub holding `total` alerts behind cursor pagination.
 *
 * It mirrors the real endpoint in the one way that matters: asking for a `page`
 * is a 400, not a silently different result.
 */
function githubWith(total: number) {
  const cursorsRequested: Array<string | undefined> = [];

  const fetchPage = async (cursor: string | undefined, extra?: Record<string, unknown>) => {
    if (extra && "page" in extra) {
      const err: any = new Error("Pagination using the `page` parameter is not supported.");
      err.status = 400;
      throw err;
    }
    cursorsRequested.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const data = Array.from(
      { length: Math.max(0, Math.min(100, total - start)) },
      (_, i) => ({ number: start + i + 1 }),
    );
    const nextStart = start + data.length;
    // GitHub only sends rel="next" when there is more to come.
    const headers = nextStart < total ? { link: `<https://api.github.com/x?after=${nextStart}>; rel="next"` } : {};
    return { data, headers };
  };

  return { fetchPage, cursorsRequested };
}

(async () => {
  // The original bug, at the boundary where it starts.
  {
    const { fetchPage, cursorsRequested } = githubWith(250);
    const all = await fetchAllCursorPages(fetchPage);
    check("250 alerts are all returned, not the first 100", all.length === 250, all.length);
    check("  three requests were made", cursorsRequested.length === 3, cursorsRequested);
    check("  the first asks for no cursor", cursorsRequested[0] === undefined, cursorsRequested[0]);
    check("  and the last alert is present", all[all.length - 1]?.number === 250, all[all.length - 1]);
  }

  // Exactly one full page: a naive loop gets this wrong in the other direction.
  // Here the absence of a next link is what ends it, not the page size.
  {
    const { fetchPage, cursorsRequested } = githubWith(100);
    const all = await fetchAllCursorPages(fetchPage);
    check("exactly 100 alerts returns 100", all.length === 100, all.length);
    check("  and stops without a second request, because there is no next link",
      cursorsRequested.length === 1, cursorsRequested);
  }

  {
    const { fetchPage } = githubWith(12);
    const all = await fetchAllCursorPages(fetchPage);
    check("a short page ends the walk", all.length === 12, all.length);
  }

  {
    const { fetchPage, cursorsRequested } = githubWith(0);
    const all = await fetchAllCursorPages(fetchPage);
    check("no alerts returns an empty list in one request",
      all.length === 0 && cursorsRequested.length === 1, { all: all.length, cursorsRequested });
  }

  // Truncating on error would under-report, which is the failure this whole
  // file exists to prevent.
  {
    let reached = 0;
    const failing = async (cursor: string | undefined) => {
      reached++;
      if (reached === 2) { const e: any = new Error("rate limited"); e.status = 403; throw e; }
      return { data: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
               headers: { link: `<https://api.github.com/x?after=100>; rel="next"` } };
    };
    let threw = false;
    try { await fetchAllCursorPages(failing); } catch { threw = true; }
    check("a failed page propagates instead of truncating", threw && reached === 2, { threw, reached });
  }

  {
    for (const n of [1, 99, 100, 101, 199, 200, 201, 1000]) {
      const { fetchPage } = githubWith(n);
      const all = await fetchAllCursorPages(fetchPage);
      if (all.length !== n) { check(`${n} alerts round-trip`, false, all.length); break; }
    }
    check("every size boundary round-trips exactly", true);
  }

  // The bug was not in the loop — it was in what the callers handed it. A
  // behavioral test of the helper cannot see that, so this reads the source.
  {
    // Both files, because the org-wide sweep moved into the service so the
    // alarm evaluator could share it. Reading only the route would have let
    // the tolerance disappear with the code that carried it.
    const code = ["src/routes/dependencies.ts", "src/services/dependencyService.ts"]
      .map(f => fs.readFileSync(path.join(__dirname, f), "utf8"))
      .map(s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"))
      .join("\n");

    check("no Dependabot call passes a page parameter",
      !/dependabot\.list\w+\(\{[^}]*\bpage\b/s.test(code),
      "the alerts endpoints answer `page` with 400");

    check("  and every org-wide sweep tolerates a 400 rather than 500ing its caller",
      /err\.status !== 400/.test(code) || !/listAlertsForOrg/.test(code),
      "a rejected page walk took the whole page down with it");

    // The summary endpoint counted GitHub's "moderate" into a `medium` bucket
    // it never matched, so moderate alerts were reported in no severity at all.
    check("  and \"moderate\" is folded into medium rather than dropped",
      /moderate/.test(code),
      "moderate-severity alerts vanish from the org summary");
  }

  // ── alert status without a request per repository ───────────────────
  {
    // This replaced one REST call per repository with 100 repositories per
    // GraphQL request. Checked in both directions before the swap: a field that
    // is always false would agree with a mostly-off organization and still be
    // wrong.
    const page = (names: string[], next: string | null) => ({
      organization: { repositories: {
        pageInfo: { hasNextPage: !!next, endCursor: next },
        nodes: names.map(n => ({ name: n, hasVulnerabilityAlertsEnabled: n.startsWith("on-") })),
      } },
    });

    let seen: (string | null)[] = [];
    const gql = async (_q: string, vars: any) => {
      seen.push(vars.cursor);
      return vars.cursor === null ? page(["on-a", "off-b"], "CUR1") : page(["on-c", "off-d"], null);
    };

    const status = await fetchRepoAlertStatus(gql, "Org");
    check("every page of repositories is walked", status?.size === 4, status?.size);
    check("  following the cursor it was given", seen.join(",") === ",CUR1", seen);
    check("  and the flag is carried through both ways",
      status?.get("on-a") === true && status?.get("off-b") === false, [...(status ?? [])]);

    // A failure must not be mistaken for "every repository has alerts off",
    // which would fill the tab with findings nobody caused.
    const broken = await fetchRepoAlertStatus(async () => { throw new Error("GraphQL down"); }, "Org");
    check("a failed query reads as unknown, not as all-disabled", broken === null, broken);

    const empty = await fetchRepoAlertStatus(async () => ({}), "Org");
    check("  as does a response with no organization in it", empty === null, empty);

    // A cursor that never advances would otherwise loop until the rate limit.
    let calls = 0;
    const stuck = async () => { calls++; return page(["x"], "SAME"); };
    await fetchRepoAlertStatus(stuck, "Org");
    check("  and a non-advancing cursor is bounded rather than endless",
      calls > 0 && calls <= 50, calls);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
