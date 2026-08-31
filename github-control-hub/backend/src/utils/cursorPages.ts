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
 * Every open alert, walked the way these endpoints actually paginate.
 *
 * The Dependabot alert endpoints reject `?page=N` outright:
 *
 *     400  Pagination using the `page` parameter is not supported.
 *
 * They use cursor pagination, a Link header with rel="next" carrying an
 * `after` cursor, so the walk follows that and ends when GitHub stops offering
 * a next link. A short page is not reliable evidence of the end here; the
 * absent link is.
 *
 * Taking only the first page under-counts every severity in the direction that
 * reads as good news.
 *
 * Lives in utils rather than in the route because the alarm evaluator runs in a
 * Lambda, and importing a route would pull Express in with it.
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
