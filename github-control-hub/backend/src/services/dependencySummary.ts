/**
 * The severity counts behind the Vulnerabilities tab's header.
 *
 * One function, because two callers produce these: the stored snapshot, which
 * is what nearly every open reads, and a live sweep for the first open of an
 * organization that has never stored one. Two hand-written loops would be two
 * places for the marker handling and GitHub's severity spelling to drift, and
 * that drift shows as a header disagreeing with the list underneath it.
 */

export interface DependencySummaryCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  repos_with_vulns: number;
}

interface CountableAlert {
  repo?: string;
  severity?: string;
  clean?: boolean;
  disabled?: boolean;
  scanning?: boolean;
}

export function summariseAlerts(alerts: CountableAlert[]): DependencySummaryCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const reposWithVulns = new Set<string>();

  for (const alert of alerts) {
    // Storage holds a marker for every repository that produced no findings,
    // so a clean repository can be told apart from an unwatched one. They are
    // rows and they carry a severity, and counting them would report findings
    // against every quiet repository in the organization.
    if (alert.clean || alert.disabled || alert.scanning) continue;

    // GitHub says "moderate" where this app says "medium". Counting only the
    // app's spelling meant every moderate alert fell through and was reported
    // in no severity at all, short in the reassuring direction.
    const severity = alert.severity === "moderate" ? "medium" : alert.severity;
    if (severity && severity in counts) counts[severity as keyof typeof counts]++;

    // "unknown" is the sweep's word for an alert it could not attribute.
    // Counting it invents a repository nobody can go and look at.
    if (alert.repo && alert.repo !== "unknown") reposWithVulns.add(alert.repo);
  }

  return { ...counts, repos_with_vulns: reposWithVulns.size };
}
