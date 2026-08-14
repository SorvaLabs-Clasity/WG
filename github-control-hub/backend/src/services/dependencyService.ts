import type { Octokit } from "octokit";
import { fetchAllCursorPages } from "../utils/cursorPages";

/**
 * The organization's open Dependabot alerts.
 *
 * Extracted from the dependencies route so the alarm evaluator can read the
 * same alerts the Dependabot tab shows. Two callers computing "how many
 * criticals" from separately-written code is how the number on the screen and
 * the number in the email start disagreeing.
 *
 * This is the org-wide sweep only. The route additionally walks every
 * repository to mark the ones that are clean or have Dependabot switched off,
 * which costs a request per repository — the alarm aggregations discard those
 * marker rows anyway, so the evaluator does not pay for them.
 */

export interface DependencyAlert {
  id: string;
  repo: string;
  org: string;
  dependency: string;
  severity: string;
  cve: string;
  ecosystem: string;
  vulnerable_version: string;
  patched_version: string | null;
  detected_at: string;
  clean?: boolean;
  disabled?: boolean;
  scanning?: boolean;
}

export function mapAlert(alert: any, repoName: string, orgName: string): DependencyAlert {
  const advisory = alert.security_advisory || {};
  const vuln = alert.security_vulnerability || {};

  return {
    id: `dep-${alert.number}`,
    repo: repoName,
    org: orgName,
    dependency: vuln.package?.name || advisory.summary || "unknown",
    severity: advisory.severity || vuln.severity || "low",
    cve: advisory.cve_id || (advisory.identifiers || []).find((i: any) => i.type === "CVE")?.value || "",
    ecosystem: vuln.package?.ecosystem || "",
    vulnerable_version: vuln.vulnerable_version_range || "",
    patched_version: vuln.first_patched_version?.identifier || null,
    detected_at: alert.created_at || new Date().toISOString(),
  };
}

/**
 * Every open alert in the organization.
 *
 * Throws only on errors that mean the answer is unknown. 400, 403 and 404 are
 * tolerated the same way the route tolerates them — an organization without
 * Dependabot, or a token without the scope, is a real state and not a failure —
 * but the caller is told, because an alarm must not read "no alerts" off a
 * sweep that never ran.
 */
export async function fetchOrgDependencyAlerts(
  octokit: Octokit,
  org: string,
): Promise<{ alerts: DependencyAlert[]; degraded: boolean }> {
  try {
    const data = await fetchAllCursorPages((after) =>
      (octokit as any).rest.dependabot.listAlertsForOrg({
        org,
        state: "open",
        per_page: 100,
        ...(after ? { after } : {}),
      })
    );
    return {
      alerts: data.map((a: any) => mapAlert(a, a.repository?.name || "unknown", org)),
      degraded: false,
    };
  } catch (err: any) {
    if (err.status !== 400 && err.status !== 403 && err.status !== 404) throw err;
    console.error(
      `[Dependencies] Org-wide alert sweep failed (${err.status}):`, err.message);
    return { alerts: [], degraded: true };
  }
}


/**
 * Which repositories have Dependabot alerts switched on.
 *
 * The route used to answer this with one REST call per repository —
 * `checkVulnerabilityAlerts`, 204 for on and 404 for off — which at 355 repos
 * meant ~351 requests every time the tab was opened, against the same core
 * budget the graph sync and compliance sweep draw on.
 *
 * GraphQL exposes the flag directly, 100 repositories at a time. Measured
 * against this organization: 4 requests instead of 351, and the answers agree
 * in both directions — verified on repositories with alerts on and off, since
 * a field that is always false would agree with a mostly-off organization and
 * still be wrong.
 *
 * GraphQL is also metered separately from REST, so this moves the cost off the
 * budget everything else competes for rather than merely reducing it.
 *
 * Returns null if the query fails. The caller lists repositories without the
 * on/off marker rather than falling back to hundreds of requests — a slow page
 * is worse than a page missing one column, and the fallback is the thing being
 * removed.
 */
export type GraphQlFn = (query: string, vars: Record<string, unknown>) => Promise<any>;

const ALERT_STATUS_QUERY = `query($org:String!, $cursor:String) {
  organization(login:$org) {
    repositories(first:100, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name hasVulnerabilityAlertsEnabled }
    }
  }
}`;

/** Guards against an endless walk if a cursor ever stops advancing. */
const MAX_REPO_PAGES = 50;

export async function fetchRepoAlertStatus(
  graphql: GraphQlFn,
  org: string,
): Promise<Map<string, boolean> | null> {
  try {
    const status = new Map<string, boolean>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_REPO_PAGES; page++) {
      const res: any = await graphql(ALERT_STATUS_QUERY, { org, cursor });
      const repos = res?.organization?.repositories;
      if (!repos) return null;
      for (const n of repos.nodes ?? []) {
        if (n?.name) status.set(n.name, !!n.hasVulnerabilityAlertsEnabled);
      }
      if (!repos.pageInfo?.hasNextPage) return status;
      cursor = repos.pageInfo.endCursor ?? null;
      if (!cursor) return status;
    }
    return status;
  } catch (err) {
    console.error("[Dependencies] Could not read alert status via GraphQL:", (err as Error).message);
    return null;
  }
}
