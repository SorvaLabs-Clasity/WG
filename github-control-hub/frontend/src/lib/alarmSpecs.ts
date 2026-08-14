import type { MetricSpec } from "../api/alarms";

/**
 * Display labels for alarm metrics.
 *
 * The authoritative catalogue is backend/src/alarms/conditions.ts, which is
 * what the form is built from and what the API validates against. This is a
 * labels-only mirror so the alarm list can name a condition without one
 * request per alarm.
 *
 * Only the words are duplicated, never the rules about which widget may use
 * which metric. repro-alarms.ts asserts that every metric the backend offers
 * appears here, so a new one cannot ship showing its raw identifier.
 */
export const ALL_METRIC_SPECS: MetricSpec[] = [
  { metric: "dependabot.critical", kind: "count", label: "Critical alerts", unit: "critical" },
  { metric: "dependabot.high", kind: "count", label: "High alerts", unit: "high" },
  { metric: "dependabot.total", kind: "count", label: "Alerts in total", unit: "alerts" },
  { metric: "dependabot.repos", kind: "count", label: "Repositories with any alert", unit: "repos" },
  { metric: "vulnRepos.repos", kind: "count", label: "Matching repositories", unit: "repos" },
  { metric: "vulnRepos.total", kind: "count", label: "Alerts in total", unit: "alerts" },
  { metric: "vulnRepos.worstSeverity", kind: "severity", label: "Worst severity present" },
  { metric: "bypasses.total", kind: "count", label: "Bypasses in total", unit: "bypasses" },
  { metric: "bypasses.repos", kind: "count", label: "Repositories with a bypass", unit: "repos" },
  { metric: "query.rows", kind: "count", label: "Matching rows", unit: "rows" },
];
