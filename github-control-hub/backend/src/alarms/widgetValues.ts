import { severityRank, type Severity } from "./conditions";
import type { DependencyAlert } from "../services/dependencyService";

/**
 * A widget's rows, computed on the server.
 *
 * The Analytics page derives these in the browser. The evaluator cannot, so
 * the same aggregations are written here — and pinned by tests against the
 * same inputs, because the number in the email and the number on the card
 * disagreeing is worse than either being wrong on its own.
 *
 * Everything is injected. No GitHub client, no Secrets Manager, no SNS, so the
 * whole of it can be exercised from a test with three fixtures.
 */

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

/** Thresholds the setting used to hold, kept readable so old widgets survive. */
const LEGACY_THRESHOLDS: Record<string, Severity[]> = {
  any: ["critical", "high", "medium", "low"],
  low: ["critical", "high", "medium", "low"],
  medium: ["critical", "high", "medium"],
  high: ["critical", "high"],
  critical: ["critical"],
};

const SET_PREFIX = "sev:";

/**
 * Mirrors the frontend's parseSeverities, including its legacy forms.
 *
 * A bare "high" is an old widget meaning "high and above"; a prefixed
 * "sev:high" is a new one meaning high alone. Reading either the wrong way
 * makes a widget count the opposite of what it was set to, and the alarm on it
 * inherits the mistake.
 */
export function parseSeverities(param: string | undefined): Severity[] {
  const raw = (param ?? "").trim();
  if (!raw) return [...SEVERITIES];

  const explicit = raw.startsWith(SET_PREFIX);
  const body = explicit ? raw.slice(SET_PREFIX.length) : raw;

  if (!explicit && LEGACY_THRESHOLDS[body]) return LEGACY_THRESHOLDS[body];

  const picked = body.split(",").map(x => x.trim().toLowerCase())
    .filter((x): x is Severity => (SEVERITIES as readonly string[]).includes(x));
  // An empty selection would count nothing at all, which reads as a clean
  // check rather than as a misconfigured one.
  return picked.length ? picked : [...SEVERITIES];
}

export interface WidgetLike {
  id: string;
  title?: string;
  type: string;
  presetId?: string;
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: any;
}

export interface WidgetDataSources {
  /** The organization's open Dependabot alerts, and whether the sweep worked. */
  dependencyAlerts: () => Promise<{ alerts: DependencyAlert[]; degraded: boolean }>;
  runQuery: (queryId: string, param?: string, advanced?: any) => Promise<any[]>;
  /** Open Renovate pull requests. Absent when no bot account is configured. */
  renovateOpenPrs: () => Promise<any[] | null>;
}

export interface WidgetRows {
  /** null means the value could not be read — never treat it as zero. */
  rows: any[] | null;
  error?: string;
}

/** Per-repository alert counts, as the Dependabot widget shows them. */
export function aggregateDependabot(alerts: DependencyAlert[]): any[] {
  const map = new Map<string, any>();
  for (const dep of alerts) {
    if (dep.clean || dep.disabled) continue;
    if (!map.has(dep.repo)) {
      map.set(dep.repo, { repo: dep.repo, total: 0, critical: 0, high: 0, medium: 0, low: 0 });
    }
    const e = map.get(dep.repo)!;
    e.total++;
    if (dep.severity === "critical") e.critical++;
    else if (dep.severity === "high") e.high++;
    // GitHub says moderate, the app says medium. Counting only one spelling
    // drops the other into "low" and understates every medium threshold.
    else if (dep.severity === "medium" || dep.severity === "moderate") e.medium++;
    else e.low++;
  }
  return Array.from(map.values()).sort((a, b) =>
    b.critical !== a.critical ? b.critical - a.critical
      : b.high !== a.high ? b.high - a.high
        : b.total - a.total);
}

/** Repositories with an alert in the chosen severities, and their worst one. */
export function aggregateVulnRepos(alerts: DependencyAlert[], queryParam?: string): any[] {
  const wanted = new Set<string>(parseSeverities(queryParam));
  if (wanted.has("medium")) wanted.add("moderate");

  const map = new Map<string, any>();
  for (const dep of alerts) {
    if (dep.clean || dep.disabled || dep.scanning) continue;
    if (!wanted.has(dep.severity)) continue;
    if (!map.has(dep.repo)) map.set(dep.repo, { repo: dep.repo, total: 0, worst: "low" });
    const e = map.get(dep.repo)!;
    e.total++;
    if (severityRank(dep.severity) > severityRank(e.worst)) e.worst = dep.severity;
  }
  return Array.from(map.values()).sort(
    (a, b) => (severityRank(b.worst) - severityRank(a.worst)) || b.total - a.total);
}

export async function computeWidgetRows(
  widget: WidgetLike,
  sources: WidgetDataSources,
): Promise<WidgetRows> {
  try {
    if (widget.type === "query") {
      if (!widget.queryId) return { rows: null, error: "Widget has no query" };
      return { rows: await sources.runQuery(widget.queryId, widget.queryParam, widget.queryAdvanced) };
    }

    switch (widget.presetId) {
      case "dependabot":
      case "vuln-repos": {
        const { alerts, degraded } = await sources.dependencyAlerts();
        // A degraded sweep returns an empty list, which is indistinguishable
        // from a clean organization. Reporting it as no reading is what stops
        // an alarm resolving itself because GitHub answered 403.
        if (degraded) return { rows: null, error: "Dependabot alerts could not be read" };
        return {
          rows: widget.presetId === "dependabot"
            ? aggregateDependabot(alerts)
            : aggregateVulnRepos(alerts, widget.queryParam),
        };
      }
      case "bypasses":
        return { rows: await sources.runQuery("protection-bypasses-ranking") };
      case "renovate-open": {
        const prs = await sources.renovateOpenPrs();
        // null, not an empty list, when no bot is configured — an alarm must
        // not read "zero open PRs" off an organization nobody told us how to
        // look at, and quietly report all clear.
        return prs === null
          ? { rows: null, error: "No Renovate bot account is configured" }
          : { rows: prs };
      }
      default:
        return { rows: null, error: `Unknown preset "${widget.presetId}"` };
    }
  } catch (err) {
    return { rows: null, error: (err as Error).message };
  }
}
