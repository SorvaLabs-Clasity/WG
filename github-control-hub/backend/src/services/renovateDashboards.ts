import { parseDependencyDashboard, tickDashboardBox } from "./renovateDashboard";
import type { DashboardItem, DetectedManifest } from "./renovateDashboard";

/**
 * Every repository's Renovate Dependency Dashboard, across the organization.
 *
 * Found by searching for issues the bot opened, then keeping the ones whose
 * body parses as a dashboard. Deliberately not by title: the title is
 * configurable (`dependencyDashboardTitle`), so an organization that renamed it
 * would appear to have none at all, which is the same wrong answer as having
 * none.
 *
 * One search for the whole organization rather than an issue read per
 * repository. Search returns the body, so a single query answers "which
 * repositories have one, and what is in each".
 */

type SearchIssues = (query: string, page: number) => Promise<{ items: any[] }>;

export interface RepoDashboard {
  repo: string;
  issueNumber: number;
  url: string;
  /** Everything actionable, already categorised. */
  items: DashboardItem[];
  /** The whole-dashboard checkboxes, e.g. create all rate-limited. */
  bulk: { marker: string; checked: boolean }[];
  /**
   * How many dependencies Renovate can see, and in how many manifests.
   *
   * A count rather than the inventory: across an organization the inventory is
   * megabytes, and almost nobody opens it. The list itself is a separate read,
   * for the one repository somebody expands.
   */
  detectedManifests: number;
  detectedPackages: number;
}

export interface DashboardSweep {
  dashboards: RepoDashboard[];
  /**
   * Issues by the bot that are not dashboards, counted rather than listed.
   *
   * Not an error and not noise: it is how somebody notices the parse has
   * stopped recognising them after a Renovate upgrade, which would otherwise
   * look like every repository having nothing pending.
   */
  unparsed: number;
}

const MAX_PAGES = 10;

export async function fetchRenovateDashboards(
  search: SearchIssues,
  org: string,
  bot: string,
): Promise<DashboardSweep> {
  const dashboards: RepoDashboard[] = [];
  let unparsed = 0;

  const q = `is:issue is:open org:${org} author:${bot}`;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items } = await search(q, page);

    for (const item of items ?? []) {
      const repo = String(item?.repository_url ?? "").split("/").pop();
      if (!repo) continue;

      const parsed = parseDependencyDashboard(item?.body);
      if (!parsed) {
        unparsed++;
        continue;
      }

      dashboards.push({
        repo,
        issueNumber: Number(item?.number ?? 0),
        url: String(item?.html_url ?? ""),
        items: parsed.items,
        bulk: parsed.bulk,
        detectedManifests: parsed.detected?.length ?? 0,
        detectedPackages: (parsed.detected ?? []).reduce((n, m) => n + m.packages.length, 0),
      });
    }

    if ((items?.length ?? 0) < 100) break;
  }

  return { dashboards, unparsed };
}

/** The inventory for one repository, read when somebody opens it. */
export async function fetchDetectedDependencies(
  octokit: any, org: string, repo: string, issueNumber: number,
): Promise<DetectedManifest[] | null> {
  const { data } = await octokit.rest.issues.get({
    owner: org, repo, issue_number: issueNumber,
  });
  return parseDependencyDashboard(data?.body)?.detected ?? null;
}

/**
 * Tick one checkbox on one dashboard.
 *
 * The body is re-read here rather than taken from the sweep, which can be
 * minutes old. Renovate rewrites this issue on every run, so a stale body
 * written back would revert whatever it changed in between: an update it has
 * since made would reappear as pending, and a box somebody else ticked would
 * be un-ticked. The read and the write are as close together as they can be.
 */
export async function tickDashboard(
  octokit: any, org: string, repo: string, issueNumber: number, marker: string,
): Promise<{ ticked: boolean; reason?: string }> {
  const { data } = await octokit.rest.issues.get({
    owner: org, repo, issue_number: issueNumber,
  });

  const next = tickDashboardBox(String(data?.body ?? ""), marker);
  if (next === null) {
    // Either it is already ticked, or Renovate has rewritten the issue and the
    // item is gone. Both mean there is nothing to write, and writing anyway
    // would be an edit on somebody's issue that changes nothing.
    return { ticked: false, reason: "That item is no longer pending, or is already requested." };
  }

  await octokit.rest.issues.update({
    owner: org, repo, issue_number: issueNumber, body: next,
  });
  return { ticked: true };
}
