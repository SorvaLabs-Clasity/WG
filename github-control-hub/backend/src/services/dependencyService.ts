import type { Octokit } from "octokit";
import { fetchAllCursorPages } from "../utils/cursorPages";

/**
 * The organisation's open Dependabot alerts.
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
 * Every open alert in the organisation.
 *
 * Throws only on errors that mean the answer is unknown. 400, 403 and 404 are
 * tolerated the same way the route tolerates them — an organisation without
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
