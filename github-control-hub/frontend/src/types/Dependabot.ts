export type DependencySeverity = "critical" | "high" | "medium" | "low";

export interface DependencyAlert {
  id: string;
  repo: string;
  dependency: string;
  severity: DependencySeverity;
  cve: string;
  ecosystem: string; // npm, pip, maven, etc.
  vulnerable_version: string;
  patched_version: string | null;
  detected_at: string;
  disabled?: boolean; // indicates if dependabot is off for the repo
}

export interface DependencySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  repos_with_vulns: number;
}
