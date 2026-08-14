/** The `after` cursor from a Link header's rel="next", if there is one. */
function nextCursor(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url) continue;
    const after = new URL(url).searchParams.get("after");
    if (after) return after;
  }
  return undefined;
}

/**
 * Every open alert, not the first hundred — walked the way these endpoints
 * actually paginate.
 *
 * Two bugs live here. Originally all three Dependabot calls asked for
 * `per_page: 100` and used the single page they got back, so past a hundred
 * open alerts an organization under-counted every severity and under-listed
 * every repository — silently, in the direction that reads as good news.
 *
 * The fix for that walked pages with `?page=N`, shaped like listRepos' loop
 * because that is the pattern everywhere else here. But listRepos calls an
 * endpoint that supports page numbers and the Dependabot alerts endpoints do
 * not — organization-level and repository-level alike answer:
 *
 *     400  Pagination using the `page` parameter is not supported.
 *
 * They use cursor pagination: a Link header with rel="next" carrying an
 * `after` cursor. So the walk follows that instead, and ends when GitHub stops
 * offering a next link rather than when a page looks short. A short page is not
 * reliable evidence of the end here, and the link is.
 *
 * Lives in utils rather than in the dependencies route because the alarm
 * evaluator runs in a Lambda and importing a route would pull Express in with
 * it.
 */
export async function fetchAllCursorPages(
  fetchPage: (cursor: string | undefined) => Promise<{ data: any[]; headers?: Record<string, any> }>,
): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const { data, headers } = await fetchPage(cursor);
    if (!data || data.length === 0) break;
    all.push(...data);

    const next = nextCursor(headers?.link);
    if (!next) break;
    cursor = next;
  }

  return all;
}
