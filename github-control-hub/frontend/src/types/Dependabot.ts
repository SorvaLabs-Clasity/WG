export type DependencySeverity = "critical" | "high" | "medium" | "low";

export interface DependencyAlert {
  id: string;
  repo: string;
  org: string;
  dependency: string;
  severity: DependencySeverity;
  cve: string;
  ecosystem: string; // npm, pip, maven, etc.
  vulnerable_version: string;
  patched_version: string | null;
  detected_at: string;
  disabled?: boolean; // indicates if dependabot is off for the repo
  clean?: boolean; // indicates if dependabot is on but has no alerts
  /**
   * Just switched on, and GitHub has not reported results yet. Distinct from
   * `clean`: one means "looked, found nothing", the other "has not looked yet".
   */
  scanning?: boolean;
  /**
   * Dependabot security updates, the switch that opens pull requests.
   *
   * Undefined means it could not be read, which is not the same as off:
   * GitHub returns the field only for repositories the signed-in account
   * administers, and offering to turn it on elsewhere is a button that can
   * only fail.
   */
  fixesEnabled?: boolean;
  /**
   * Why this repository has no fix pull requests, where something identifiable
   * is stopping them.
   *
   * Null is the interesting value: nothing is wrong with the repository, and
   * GitHub simply never did the work. Undefined is a repository nothing was
   * established about.
   */
  fixBlocker?: "archived" | "fixes-off" | "no-patch" | "config-target-branch" | "transitive" | null;
}

export interface DependencySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  repos_with_vulns: number;
}
