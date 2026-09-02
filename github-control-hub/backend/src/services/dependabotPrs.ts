/** One page of a GitHub issue search. */
type SearchIssues = (q: string, page: number) => Promise<{ items: any[] }>;

/** Held briefly, because two views and a refresh all want the same answer. */
let cache: { at: number; org: string; value: Map<string, number> } | null = null;
let inFlight: { org: string; run: Promise<Map<string, number> | null> } | null = null;

const CACHE_MS = 60_000;
const MAX_PAGES = 10;

/**
 * How many open Dependabot pull requests each repository has.
 *
 * The number that makes the Vulnerabilities tab answerable. A repository can
 * show a hundred findings and a switch reading "auto-fix on" and still have
 * nothing open, and until both numbers sit side by side there is no way to see
 * that from the screen, which is exactly the state that sends somebody
 * clicking through repositories one at a time.
 *
 * One search for the whole organization rather than a query per repository:
 * search is limited to thirty requests a minute, an order of magnitude
 * tighter than the core limit, and 351 of them would exhaust it many times
 * over.
 *
 * Null means the search failed, and callers must keep it null. Zero pull
 * requests and an unanswered question look identical on a screen and mean
 * opposite things: the first is a repository to act on, the second is a
 * repository nobody has read.
 */
export async function fetchDependabotPrCounts(
  search: SearchIssues,
  org: string,
): Promise<Map<string, number> | null> {
  if (cache && cache.org === org && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inFlight && inFlight.org === org) return inFlight.run;

  const run = countPrs(search, org);
  inFlight = { org, run };
  try {
    const value = await run;
    if (value) cache = { at: Date.now(), org, value };
    return value;
  } finally {
    inFlight = null;
  }
}

async function countPrs(search: SearchIssues, org: string): Promise<Map<string, number> | null> {
  try {
    const counts = new Map<string, number>();
    // `app/dependabot` is the author of security and version update pull
    // requests alike. Both resolve a vulnerability when merged, and somebody
    // asking "is anything open to fix this" does not care which produced it.
    const q = `is:pr is:open org:${org} author:app/dependabot`;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items } = await search(q, page);
      for (const item of items ?? []) {
        // Search returns a repository_url, not a name: the last segment is the
        // repository, the one before it the owner.
        const name = String(item?.repository_url ?? "").split("/").pop();
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if ((items?.length ?? 0) < 100) return counts;
    }
    return counts;
  } catch (err) {
    console.error("[Dependencies] Could not count Dependabot pull requests:", (err as Error).message);
    return null;
  }
}

/** Drops the held answer, for a caller that has just changed the truth. */
export function clearDependabotPrCache(): void {
  cache = null;
}
