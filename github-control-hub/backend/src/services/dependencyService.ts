import type { Octokit } from "octokit";
import { fetchAllCursorPages } from "../utils/cursorPages";
import { withFeature } from "./githubUsageService";

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
 * which costs a request per repository, the alarm aggregations discard those
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
  /** "direct", "transitive", "inconclusive", "unknown", or null for unstated. */
  relationship?: string | null;
  detected_at: string;
  clean?: boolean;
  disabled?: boolean;
  scanning?: boolean;
  /**
   * Dependabot security updates, the switch that opens pull requests.
   *
   * Undefined means nobody could read it, which is not the same as off:
   * the field is only returned for repositories the caller administers.
   */
  fixesEnabled?: boolean;
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
    // Whether the vulnerable package is one this repository asked for, or one
    // pulled in underneath something it asked for. GitHub cannot usually fix
    // the second without a change to the parent, so it is the difference
    // between a pull request that never came and one that never could.
    //
    // "unknown" and "inconclusive" are GitHub declining to answer, and are
    // kept as they are rather than folded into either side.
    relationship: vuln.package?.relationship ?? alert.dependency?.relationship ?? null,
    detected_at: alert.created_at || new Date().toISOString(),
  };
}

/**
 * Every open alert in the organization.
 *
 * Throws only on errors that mean the answer is unknown. 400, 403 and 404 are
 * tolerated the same way the route tolerates them, an organization without
 * Dependabot, or a token without the scope, is a real state and not a failure,
 * but the caller is told, because an alarm must not read "no alerts" off a
 * sweep that never ran.
 */
/**
 * Held briefly, and shared by every caller.
 *
 * This walks the organization's open alerts a hundred at a time, so one call is
 * several requests issued back to back, and several callers wanting the same
 * answer within a moment is what a secondary rate limit is for. The alarm pass
 * memoised it for itself, which did nothing for the routes or for a widget
 * computed live while a page was open.
 *
 * Sixty seconds: GitHub rescans on its own schedule, so a fresher answer than
 * that does not exist to be had.
 *
 * The in-flight promise is shared as well as the result, because the case this
 * exists for is several callers starting together and all missing the cache.
 */
const SWEEP_CACHE_MS = 60_000;
let sweepCache: { at: number; org: string; value: { alerts: DependencyAlert[]; degraded: boolean } } | null = null;
let sweepInFlight: { org: string; run: Promise<{ alerts: DependencyAlert[]; degraded: boolean }> } | null = null;

/**
 * The held sweep, if there is one, without starting a new one.
 *
 * For anything that wants to describe the sweep rather than use it. The budget
 * page reports how many alerts there are; asking GitHub to draw that page would
 * be the page spending the allowance it exists to report on.
 */
export function peekDependencySweep(): { alerts: DependencyAlert[]; degraded: boolean } | null {
  if (!sweepCache || Date.now() - sweepCache.at >= SWEEP_CACHE_MS) return null;
  return sweepCache.value;
}

/** Forget the held sweep, so the next read goes to GitHub. */
export function invalidateDependencySweep(): void {
  sweepCache = null;
}

export function fetchOrgDependencyAlerts(
  octokit: Octokit,
  org: string,
): Promise<{ alerts: DependencyAlert[]; degraded: boolean }> {
  return withFeature("Dependabot alert sweep", () => cachedOrgAlertSweep(octokit, org));
}

async function cachedOrgAlertSweep(
  octokit: Octokit,
  org: string,
): Promise<{ alerts: DependencyAlert[]; degraded: boolean }> {
  if (sweepCache && sweepCache.org === org && Date.now() - sweepCache.at < SWEEP_CACHE_MS) {
    return sweepCache.value;
  }
  if (sweepInFlight && sweepInFlight.org === org) return sweepInFlight.run;

  const run = sweepOrgAlerts(octokit, org);
  sweepInFlight = { org, run };
  try {
    const value = await run;
    // A degraded sweep is not cached. It is the answer "we could not read
    // this", and holding it for a minute turns one failed request into a
    // minute of them.
    if (!value.degraded) sweepCache = { at: Date.now(), org, value };
    return value;
  } finally {
    sweepInFlight = null;
  }
}

async function sweepOrgAlerts(
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
 * GraphQL exposes the flag directly, 100 repositories at a time, so this is a
 * handful of requests rather than one REST call per repository against the same
 * core budget the graph sync and the compliance sweep draw on. GraphQL is
 * metered separately, so the cost moves off that budget rather than merely
 * shrinking.
 *
 * Returns null if the query fails, and the caller lists repositories without
 * the on/off marker: a slow page is worse than a page missing one column.
 */
export type GraphQlFn = (query: string, vars: Record<string, unknown>) => Promise<any>;

/**
 * Everything about a repository that decides whether a fix pull request can
 * appear, on one query.
 *
 * The alert flag was already read this way, a hundred repositories at a time,
 * to replace a REST call per repository. The archived flag and the Dependabot
 * configuration ride along on that same query: they are extra fields on a page
 * already being fetched, so they cost no extra request at all, where reading
 * the configuration over REST would have been another 351.
 *
 * Both spellings of the file are read because GitHub accepts either, and a
 * repository using the one we did not ask for would come back as having no
 * configuration, which is the wrong answer rather than a missing one.
 */
const REPO_FACTS_QUERY = `query($org:String!, $cursor:String) {
  organization(login:$org) {
    repositories(first:100, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        hasVulnerabilityAlertsEnabled
        isArchived
        yml: object(expression: "HEAD:.github/dependabot.yml") { ... on Blob { text } }
        yaml: object(expression: "HEAD:.github/dependabot.yaml") { ... on Blob { text } }
      }
    }
  }
}`;

/** What the query above establishes about one repository. */
export interface RepoFacts {
  alertsEnabled: boolean;
  archived: boolean;
  /** The repository's Dependabot configuration, or null where it has none. */
  config: string | null;
}

/**
 * The facts for every repository in the organization, or null if the query
 * failed.
 *
 * Null rather than an empty map, and the distinction is the whole point: an
 * empty map means an organization with no repositories, and reading a failed
 * query as that would mark every repository unarchived and unconfigured, which
 * are assertions nobody made.
 */
export async function fetchRepoFacts(
  graphql: GraphQlFn,
  org: string,
): Promise<Map<string, RepoFacts> | null> {
  try {
    const facts = new Map<string, RepoFacts>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_REPO_PAGES; page++) {
      const res: any = await graphql(REPO_FACTS_QUERY, { org, cursor });
      const repos = res?.organization?.repositories;
      if (!repos) return null;
      for (const n of repos.nodes ?? []) {
        if (!n?.name) continue;
        facts.set(n.name, {
          alertsEnabled: !!n.hasVulnerabilityAlertsEnabled,
          archived: !!n.isArchived,
          config: n.yml?.text ?? n.yaml?.text ?? null,
        });
      }
      if (!repos.pageInfo?.hasNextPage) return facts;
      cursor = repos.pageInfo.endCursor ?? null;
      if (!cursor) return facts;
    }
    return facts;
  } catch (err) {
    console.error("[Dependencies] Could not read repository facts via GraphQL:", (err as Error).message);
    return null;
  }
}

/** Guards against an endless walk if a cursor ever stops advancing. */
const MAX_REPO_PAGES = 50;

/**
 * Which repositories have Dependabot **security updates** on.
 *
 * A different switch from alerts, and the one that opens pull requests. GraphQL
 * has no field for it, so this is REST, and it reads the organization listing a
 * hundred at a time rather than asking per repository: four requests for three
 * hundred repositories instead of three hundred.
 *
 * `security_and_analysis` is only returned for repositories the caller
 * administers. A repository missing from the map is therefore **unknown**, not
 * off, and the difference matters: drawing a "turn it on" button over a
 * repository that already has it, because the caller could not see the field,
 * is a worse answer than drawing nothing.
 */
export async function fetchRepoFixStatus(
  octokit: any,
  org: string,
): Promise<Map<string, boolean> | null> {
  try {
    const status = new Map<string, boolean>();
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const { data } = await octokit.rest.repos.listForOrg({
        org, per_page: 100, page, type: "all",
      });
      for (const repo of data ?? []) {
        const state = repo?.security_and_analysis?.dependabot_security_updates?.status;
        // Absent means the caller cannot see it. Left out of the map entirely,
        // so "unknown" stays distinguishable from "off".
        if (state === "enabled" || state === "disabled") {
          status.set(repo.name, state === "enabled");
        }
      }
      if (!data || data.length < 100) return status;
    }
    return status;
  } catch (err) {
    // A page that cannot say beats a page that says the wrong thing.
    console.error("[Dependencies] Could not read security-update status:", (err as Error).message);
    return null;
  }
}

export async function fetchRepoAlertStatus(
  graphql: GraphQlFn,
  org: string,
): Promise<Map<string, boolean> | null> {
  const facts = await fetchRepoFacts(graphql, org);
  if (!facts) return null;
  return new Map([...facts].map(([name, f]) => [name, f.alertsEnabled]));
}
