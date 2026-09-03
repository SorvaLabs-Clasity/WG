/** One page of a GitHub issue search. */
type SearchIssues = (q: string, page: number) => Promise<{ items: any[] }>;

export interface DependabotPr {
  id: number;
  number: number;
  repo: string;
  title: string;
  url: string;
  draft: boolean;
  createdAt: string;
  ageDays: number;
  /** The package it bumps, where the branch says so. Null for grouped ones. */
  packageName?: string | null;

  /** Filled in from the shared details module. Absent means nobody read it. */
  checks?: string | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string;
  labels?: string[];
  readiness?: string;
}

export interface DependabotPrResult {
  prs: DependabotPr[];
  /** How many are open per repository, derived rather than searched again. */
  counts: Record<string, number>;
}

/** Held briefly, because two views and a refresh all want the same answer. */
let cache: { at: number; org: string; value: DependabotPrResult } | null = null;
let inFlight: { org: string; run: Promise<DependabotPrResult | null> } | null = null;

const CACHE_MS = 60_000;
const MAX_PAGES = 10;

/**
 * The package a Dependabot branch bumps, or null where it does not say.
 *
 * Read from the branch rather than the title because the title is prose, and
 * prose is what changes between GitHub releases.
 *
 * A package is claimed only where the branch's last component genuinely looks
 * like a version: starting with a digit and carrying a dot. Everything else
 * returns null and the caller shows the title instead.
 *
 * That test is inverted on purpose, and the first version of this got it the
 * other way around. It recognised Dependabot's default `multi-` grouping and
 * treated every other branch as a package, so a real grouped branch from the
 * configuration this app writes,
 *
 *     dependabot/npm_and_yarn/security-fixes-450e0d57a0
 *
 * had its hash stripped as though it were a version and came out as the
 * package "security-fixes". A group is named by whatever the dependabot.yml
 * calls it, so the set of group names cannot be enumerated and no list of them
 * would ever be complete. Versions can be recognised; group names cannot, so
 * versions are what this matches.
 *
 * One genuine ambiguity is left documented rather than hidden. After the
 * ecosystem, `babel/core-7.24.0` is the scoped package `@babel/core` and
 * `frontend/lodash-4.17.21` is lodash inside a directory. They have the same
 * shape. Two segments are read as a scope, because an unscoped package left as
 * its bare second half ("core") is the more confusing of the two wrong
 * answers, and three or more are read as directories.
 */
export function packageFromBranch(branch?: string | null): string | null {
  if (!branch) return null;

  const parts = branch.split("/");
  if (parts[0] !== "dependabot" || parts.length < 3) return null;

  // parts[1] is the ecosystem, e.g. npm_and_yarn, maven, pip.
  const rest = parts.slice(2);
  const last = rest[rest.length - 1];

  const cut = last.lastIndexOf("-");
  if (cut <= 0) return null;

  // A version, not a group's content hash. Requiring the dot is what separates
  // "4.17.21" from "450e0d57a0", and it costs only the rare bump to a version
  // with no dot in it, which claims nothing rather than claiming wrongly.
  const suffix = last.slice(cut + 1);
  if (!/^\d[\w.+]*$/.test(suffix) || !suffix.includes(".")) return null;

  const name = last.slice(0, cut);
  if (!name) return null;

  return rest.length === 2 ? `${rest[0]}/${name}` : name;
}

/** Days since a pull request was opened. */
function ageOf(createdAt: string): number {
  const opened = Date.parse(createdAt);
  if (!Number.isFinite(opened)) return 0;
  return Math.max(0, Math.floor((Date.now() - opened) / 86_400_000));
}

/**
 * Every open Dependabot pull request in the organization.
 *
 * One search for the whole organization rather than a query per repository:
 * search is limited to thirty requests a minute, an order of magnitude tighter
 * than the core limit, and 350 of them would exhaust it many times over.
 *
 * Null means the search failed, and callers must keep it null. Zero open pull
 * requests and an unanswered question look identical on a screen and mean
 * opposite things: the first is a repository to act on, the second is a
 * repository nobody has read.
 */
export async function fetchDependabotPrs(
  search: SearchIssues,
  org: string,
): Promise<DependabotPrResult | null> {
  if (cache && cache.org === org && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inFlight && inFlight.org === org) return inFlight.run;

  const run = collect(search, org);
  inFlight = { org, run };
  try {
    const value = await run;
    if (value) cache = { at: Date.now(), org, value };
    return value;
  } finally {
    inFlight = null;
  }
}

async function collect(search: SearchIssues, org: string): Promise<DependabotPrResult | null> {
  try {
    const prs: DependabotPr[] = [];
    // `app/dependabot` authors security and version updates alike. Both close
    // a vulnerability when merged, and somebody asking "is anything open to
    // fix this" does not care which produced it.
    const q = `is:pr is:open org:${org} author:app/dependabot`;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items } = await search(q, page);

      for (const item of items ?? []) {
        // Search returns a repository_url, not a name: the last segment is the
        // repository, the one before it the owner.
        const repo = String(item?.repository_url ?? "").split("/").pop();
        if (!repo) continue;

        const createdAt = String(item?.created_at ?? "");
        prs.push({
          id: Number(item?.id ?? 0),
          number: Number(item?.number ?? 0),
          repo,
          title: String(item?.title ?? ""),
          url: String(item?.html_url ?? ""),
          draft: !!item?.draft,
          createdAt,
          ageDays: ageOf(createdAt),
        });
      }

      if ((items?.length ?? 0) < 100) break;
    }

    const counts: Record<string, number> = {};
    for (const pr of prs) counts[pr.repo] = (counts[pr.repo] ?? 0) + 1;

    return { prs, counts };
  } catch (err) {
    console.error("[Dependencies] Could not read Dependabot pull requests:", (err as Error).message);
    return null;
  }
}

/** Drops the held answer, for a caller that has just changed the truth. */
export function clearDependabotPrCache(): void {
  cache = null;
}

/** Same thing, named for the tests that need a clean slate between cases. */
export const __resetDependabotPrCache = clearDependabotPrCache;
