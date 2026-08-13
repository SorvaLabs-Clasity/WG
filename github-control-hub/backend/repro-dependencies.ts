/**
 * Dependabot alert paging.
 *
 * All three calls in routes/dependencies.ts asked GitHub for `per_page: 100`
 * and then used the single page they got back. An organisation with more than
 * a hundred open alerts therefore under-counted every severity and
 * under-listed every affected repository — with no error, no warning, and in
 * the direction that looks like good news.
 *
 * That is the same failure MissingGraphDataError guards against on the graph
 * checks: reporting fewer findings than exist is the worst thing a security
 * dashboard can do, because nobody goes looking for the ones it did not
 * mention.
 */
import { fetchAllPages } from "./src/routes/dependencies";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** A fake GitHub holding `total` alerts, recording which pages were asked for. */
function githubWith(total: number) {
  const pagesRequested: number[] = [];
  const fetchPage = async (page: number) => {
    pagesRequested.push(page);
    const start = (page - 1) * 100;
    const data = Array.from(
      { length: Math.max(0, Math.min(100, total - start)) },
      (_, i) => ({ number: start + i + 1 }),
    );
    return { data };
  };
  return { fetchPage, pagesRequested };
}

(async () => {
  // The reported bug, at the boundary where it starts.
  {
    const { fetchPage, pagesRequested } = githubWith(250);
    const all = await fetchAllPages(fetchPage);
    check("250 alerts are all returned, not the first 100", all.length === 250, all.length);
    check("  three pages were fetched", pagesRequested.length === 3, pagesRequested);
    check("  and the last alert is present",
      all[all.length - 1]?.number === 250, all[all.length - 1]);
  }

  // Exactly one full page is the case a naive loop gets wrong in the other
  // direction: 100 back means "there may be more", so page 2 must be asked
  // for, and it comes back empty.
  {
    const { fetchPage, pagesRequested } = githubWith(100);
    const all = await fetchAllPages(fetchPage);
    check("exactly 100 alerts returns 100", all.length === 100, all.length);
    check("  and stops once the next page is empty",
      pagesRequested.length === 2, pagesRequested);
  }

  // A short first page is the last page — asking again costs a request per
  // call across the whole org and learns nothing.
  {
    const { fetchPage, pagesRequested } = githubWith(12);
    const all = await fetchAllPages(fetchPage);
    check("a short page ends the walk", all.length === 12 && pagesRequested.length === 1,
      { got: all.length, pages: pagesRequested });
  }

  // A clean org: no alerts, one request, empty list rather than a throw.
  {
    const { fetchPage, pagesRequested } = githubWith(0);
    const all = await fetchAllPages(fetchPage);
    check("no alerts returns an empty list in one request",
      all.length === 0 && pagesRequested.length === 1, { got: all.length, pages: pagesRequested });
  }

  // Rate limiting throws rather than retrying (createOctokit sets
  // onRateLimit: () => false), and the routes turn that into a 429. Swallowing
  // it here would silently return a partial list, which is the very thing this
  // file exists to prevent.
  {
    let reached = 0;
    const fetchPage = async (page: number) => {
      reached++;
      if (page === 2) throw Object.assign(new Error("rate limited"), { status: 403 });
      return { data: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) };
    };
    let threw = false;
    try { await fetchAllPages(fetchPage); } catch { threw = true; }
    check("a failed page propagates instead of truncating", threw && reached === 2,
      { threw, reached });
  }

  // The property, stated plainly: the count never depends on the page size.
  {
    for (const n of [1, 99, 100, 101, 199, 200, 201, 1000]) {
      const { fetchPage } = githubWith(n);
      const all = await fetchAllPages(fetchPage);
      if (all.length !== n) { check(`${n} alerts round-trip`, false, all.length); break; }
    }
    check("every size from 1 to 1000 round-trips exactly", true);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
