import { getSystemToken } from "../github/client";
import { readUsage, type Bucket } from "./githubUsageService";

/**
 * What has actually been spent of the organization's GitHub allowance, and by
 * what.
 *
 * Both halves are measured. **Headroom** comes from GitHub: how much of each
 * allowance has gone this hour. **Usage** comes from a counter this app
 * increments on every request it makes, because GitHub reports that a request
 * happened and never which feature made it.
 *
 * The two are counted differently and will not agree exactly. GitHub's figure
 * covers every request against the installation; ours covers what this app
 * made, attributed. Where they differ, the gap is itself worth knowing.
 *
 * This page used to publish estimates instead, requests-per-run times
 * runs-per-hour derived from the code. They were arithmetic about a
 * hypothetical organization, and nobody could act on them.
 */

export type { Bucket };

export interface BudgetLimit {
  bucket: Bucket;
  limit: number;
  used: number;
  remaining: number;
  /** ISO. When this bucket refills. */
  resetsAt: string;
  /** The window the limit applies over, in words. */
  window: string;
}

/**
 * What a feature is, for a reader who has just seen its name in a list.
 *
 * Reference material, not a measurement: it says what the feature does and
 * where to change it, and carries no numbers. Anything measured that is not
 * described here still shows, with its count and no explanation, which is the
 * honest rendering of work nobody has labelled yet.
 */
export interface FeatureNote {
  feature: string;
  trigger: string;
  endpoints: string[];
  /** Source files that make these requests. Checked against the tree by a test. */
  files: string[];
  scalesWith: string;
  note?: string;
}

export interface UsageRow {
  feature: string;
  bucket: Bucket;
  count: number;
  /**
   * How many of these went out on a signed-in person's own token.
   *
   * Those draw on that person's allowance rather than the app's, which is why
   * they are counted apart rather than folded into one figure.
   */
  viaUser: number;
  /**
   * Which processes wrote these, largest first.
   *
   * The app's server and three Lambdas deploy separately, so an unlabelled row
   * is either a call site nobody named or a function still running an older
   * build. One is fixed by editing code and the other by deploying, and without
   * this the page cannot say which.
   */
  sources: Array<{ name: string; count: number }>;
  /** Share of everything measured in this window, 0 to 1. */
  share: number;
  about?: FeatureNote;
}

export interface BudgetReport {
  limits: BudgetLimit[];
  /** Measured usage, biggest first. */
  usage: UsageRow[];
  /** Per-bucket measured totals for the window, both credentials together. */
  totals: Record<Bucket, number>;
  /**
   * Per-bucket totals for the app's own credentials only.
   *
   * The half that is comparable with `limits`, which GitHub reports per token.
   */
  appTotals: Record<Bucket, number>;
  /** Hours covered, oldest first. */
  hours: string[];
  /** Nothing has been recorded yet, as distinct from nothing having happened. */
  empty: boolean;
  /** Set when headroom could not be read; the measured half still stands. */
  error?: string;
}

const WINDOW: Record<Bucket, string> = {
  core: "per hour",
  search: "per minute",
  graphql: "points per hour",
};

/**
 * Headroom, straight from GitHub.
 *
 * `GET /rate_limit` is the one endpoint that does not count against the limit
 * it reports, so a page about the budget cannot spend it.
 */
async function readLimits(token: string): Promise<{ limits: BudgetLimit[]; error?: string }> {
  try {
    const { createOctokit } = await import("../github/client");
    const res: any = await createOctokit(token, "Reading this page").rest.rateLimit.get();
    const r = res.data?.resources ?? {};
    const of = (bucket: Bucket, raw: any): BudgetLimit | null => raw ? {
      bucket,
      limit: raw.limit ?? 0,
      remaining: raw.remaining ?? 0,
      used: (raw.limit ?? 0) - (raw.remaining ?? 0),
      resetsAt: new Date((raw.reset ?? 0) * 1000).toISOString(),
      window: WINDOW[bucket],
    } : null;
    return {
      limits: [of("core", r.core), of("search", r.search), of("graphql", r.graphql)]
        .filter((x): x is BudgetLimit => x !== null),
    };
  } catch (err: any) {
    return { limits: [], error: err?.message ?? String(err) };
  }
}

/**
 * What each labelled feature is.
 *
 * Keyed by the exact string passed to `withFeature`, so a renamed label with no
 * matching entry shows as an undescribed row rather than silently attaching the
 * old explanation to new work.
 */
export const FEATURE_NOTES: Record<string, Omit<FeatureNote, "feature">> = {
  "Dependabot alert sweep": {
    trigger: "The alarm pass, every 5 minutes, and the Vulnerabilities tab",
    endpoints: ["GET /orgs/{org}/dependabot/alerts"],
    files: ["services/dependencyService.ts"],
    scalesWith: "open alerts, not repositories",
    note: "Pages a hundred alerts at a time. Held for a minute and shared, so "
      + "opening the tab beside a pass does not pay for it twice.",
  },
  "Renovate pull request search": {
    trigger: "The alarm pass, every 5 minutes, and the Dependencies tab",
    endpoints: ["GET /search/issues", "POST /graphql (pull request details)"],
    files: ["alarms/handler.ts", "routes/dependencies.ts", "services/pullRequestDetails.ts"],
    scalesWith: "open Renovate pull requests",
    note: "Finding them draws on search, metered per minute and the smallest "
      + "allowance the app touches. Two requests when the bot name is unknown, "
      + "because search answers an unrecognised author with 422 rather than an "
      + "empty result, so each candidate spelling is tried. The checks, review "
      + "and conflict state behind each one come over GraphQL instead, fifty "
      + "pull requests to a request and on a different budget: over REST that "
      + "would be two calls per pull request, and open ones only, since nobody "
      + "is deciding anything about a closed one.",
  },
  "Open pull request walk": {
    trigger: "The alarm pass, every 5 minutes, when monitoring is on",
    endpoints: ["POST /graphql (search ISSUE)"],
    files: ["services/prNudgeService.ts"],
    scalesWith: "open pull requests",
    note: "One call per page of 100, stopping at 120 requests, so a very large "
      + "organization gets a truncated snapshot rather than an unbounded walk. "
      + "GraphQL is metered in points against its own allowance, never core.",
  },
  "Per-subject check: stale-branch-protections": {
    trigger: "A batch of 50 protected repositories, at most every 2 seconds",
    endpoints: [
      "GET /repos/{o}/{r}/branches/{b}/protection",
      "GET /repos/{o}/{r}/rulesets",
      "GET /repos/{o}/{r}/rulesets/{id}",
    ],
    files: ["services/graphService.ts"],
    scalesWith: "protected repositories not yet covered",
    note: "Refreshes oldest-first, and only while coverage is incomplete or a "
      + "verdict has aged past 24 hours. Loud on a new install, quiet once "
      + "settled.",
  },
  "Per-subject check: protection-bypasses-ranking": {
    trigger: "A batch of 50 protected repositories, at most every 2 seconds",
    endpoints: [
      "GET /repos/{o}/{r}/branches/{b}/protection",
      "GET /repos/{o}/{r}/rulesets",
      "GET /repos/{o}/{r}/rulesets/{id}",
    ],
    files: ["services/graphService.ts"],
    scalesWith: "protected repositories not yet covered",
    note: "The same shape and the same throttle as the stale-protection check.",
  },
  "Per-subject check: dormant-privileged-users": {
    trigger: "A batch of 25 accounts, at most once a minute",
    endpoints: ["GET /search/commits"],
    files: ["services/graphService.ts"],
    scalesWith: "privileged accounts not yet covered",
    note: "Twenty-five, no more than once a minute, because commit search "
      + "allows thirty requests a minute and this is the only thing competing "
      + "for them besides the Renovate search.",
  },
  "Widget check: repos-with-branch-rules": {
    trigger: "A widget carrying this check being computed",
    endpoints: ["GET /repos/{o}/{r}/branches/{b}/protection"],
    files: ["services/graphService.ts"],
    scalesWith: "repositories in the widget's scope",
  },
  "Light access graph refresh": {
    trigger: "Every 30 minutes",
    endpoints: [
      "GET /orgs/{org}/repos", "GET /orgs/{org}/teams",
      "GET /orgs/{org}/teams/{t}/repos", "GET /orgs/{org}/teams/{t}/members",
    ],
    files: ["jobs/lightGraphRefresh.ts"],
    scalesWith: "repositories and teams",
    note: "Repository metadata arrives with the listing at no extra cost; a "
      + "team is two calls.",
  },
  "Nightly access graph rebuild": {
    trigger: "22:00 America/New_York",
    endpoints: [
      "GET /repos/{o}/{r}/collaborators", "GET /repos/{o}/{r}/branches",
      "GET /repos/{o}/{r}/contributors", "GET /repos/{o}/{r}/dependabot/alerts",
    ],
    files: ["jobs/graphAggregator.ts", "services/graphEdgeService.ts"],
    scalesWith: "repositories",
    note: "About four requests per repository, plus the org-wide listings. The "
      + "heaviest single thing the app does, which is why it runs once a day at "
      + "a named hour.",
  },
  "Full GitHub recrawl": {
    trigger: "The recrawl button, at most once an hour org-wide",
    endpoints: ["the same walk as the nightly rebuild"],
    files: ["jobs/graphAggregator.ts"],
    scalesWith: "repositories",
    note: "Identical work to the nightly rebuild, kept separate because one is "
      + "the cost of running the app and the other is somebody choosing to "
      + "spend it.",
  },
  "Repository detail page": {
    trigger: "Somebody opening a repository",
    endpoints: [
      "GET /repos/{o}/{r}", "…/languages", "…/branches", "…/contributors",
      "…/pulls", "…/releases", "…/actions/workflows", "…/environments",
      "…/commits", "…/contents/{README,LICENSE,CODEOWNERS ×3}",
    ],
    files: ["services/repoDetailsService.ts"],
    scalesWith: "how many repositories somebody opens",
    note: "Fourteen requests: one that must succeed and thirteen fanned out in "
      + "parallel, five of them file probes. Clicking through twenty "
      + "repositories is about 280 requests, which is the easiest way to spend "
      + "a lot without doing anything that feels expensive.",
  },
  "Scanner run": {
    trigger: "A saved scanner, the run button, or a matching webhook",
    endpoints: [
      "GET /orgs/{org}/repos", "GET /repos/{o}/{r}/branches",
      "GET /repos/{o}/{r}/branches/{b}/protection",
    ],
    files: [
      "services/scannerService.ts", "routes/scanners.ts",
      "webhooks/processDelivery.ts",
    ],
    scalesWith: "repositories in scope and branch conditions",
    note: "A scanner limited to a few repositories costs a few requests; one "
      + "left org-wide with branch conditions walks every repository's branches. "
      + "A webhook matching a scanner starts one too, which is the only GitHub "
      + "spend a delivery causes.",
  },
  "Expertise lookup": {
    trigger: "The expertise panel",
    endpoints: [
      "GET /repos/{o}/{r}/commits", "…/pulls/comments", "…/issues/comments",
      "GET /search/code",
    ],
    files: ["routes/expertise.ts"],
    scalesWith: "repositories asked about",
    note: "Runs on the asker's own token rather than the app's, so it draws on "
      + "their allowance and cannot read what they cannot.",
  },
  "Signing in": {
    trigger: "Somebody signing in, and the membership check behind it",
    endpoints: [
      "GET /user", "GET /orgs/{org}/members/{u}",
      "GET /orgs/{org}/memberships/{u}", "GET /orgs/{org}/teams/{t}/memberships/{u}",
    ],
    files: [
      "routes/auth.ts", "services/orgMembership.ts",
      "services/authorizationService.ts", "github/permissions.ts",
    ],
    scalesWith: "people signing in",
    note: "A couple of requests per sign-in, cached for the session. "
      + "`permissions.ts` is here because it reads with whichever client it is "
      + "handed, so its requests are counted against whoever called it.",
  },
  "Organization tab": {
    trigger: "Opening organization settings",
    endpoints: [
      "GET /orgs/{org}/teams", "GET /orgs/{org}/installations",
      "GET /orgs/{org}/custom-repository-roles", "GET /orgs/{org}/members",
    ],
    files: ["routes/org.ts", "services/orgMembersService.ts", "services/repoService.ts"],
    scalesWith: "teams and members",
  },
  "Branch and protection changes": {
    trigger: "Protecting a branch, applying a ruleset, creating or deleting a branch",
    endpoints: [
      "PUT /repos/{o}/{r}/branches/{b}/protection", "POST /repos/{o}/{r}/rulesets",
      "POST /repos/{o}/{r}/git/refs", "PUT /repos/{o}/{r}/vulnerability-alerts",
    ],
    files: [
      "routes/branches.ts", "routes/protection.ts", "routes/activity.ts",
      "services/branchService.ts",
    ],
    scalesWith: "how much gets changed",
    note: "A write and usually a read back to confirm. Never the reason an "
      + "allowance runs out; here so the inventory is complete.",
  },
  "Pull request actions": {
    trigger: "Commenting on or nudging a pull request",
    endpoints: [
      "GET /repos/{o}/{r}/issues/{n}/comments", "POST …/comments", "DELETE …/comments/{id}",
    ],
    files: ["routes/pulls.ts"],
    scalesWith: "how many pull requests are acted on",
  },
  "Access graph tab": {
    trigger: "Opening the access graph",
    endpoints: ["GET /repos/{o}/{r}/actions/workflows"],
    files: ["routes/graph.ts"],
    scalesWith: "what the tab is asked to show",
  },
  "Alarm pass": {
    trigger: "Every 5 minutes",
    endpoints: ["whatever a check needs that is not already stored"],
    files: ["alarms/handler.ts"],
    scalesWith: "how many widgets and alarms exist",
    note: "The pass itself, for the reads that do not belong to one of the "
      + "named checks above. Most of what it does is arithmetic over stored "
      + "data and costs nothing.",
  },
  "Vulnerabilities tab": {
    trigger: "Opening the Vulnerabilities or Dependencies tab",
    endpoints: [
      "GET /orgs/{org}/dependabot/alerts", "POST /graphql", "GET /search/issues",
    ],
    files: ["routes/dependencies.ts", "services/dependencyView.ts"],
    scalesWith: "repositories and open alerts",
    note: "Shares the held sweep and search with the alarm pass, so opening the "
      + "tab beside a pass does not pay for either twice. The pass also stores "
      + "what it swept, at most every half hour, so most opens are served from "
      + "storage and cost nothing at all.",
  },
  "Dependabot pull request count": {
    trigger: "Opening the Vulnerabilities tab",
    endpoints: ["GET /search/issues"],
    files: ["routes/dependencies.ts", "services/pullRequestDetails.ts"],
    scalesWith: "open Dependabot pull requests, a hundred per request",
    note: "One search for the whole organization rather than a query per "
      + "repository, because search allows thirty requests a minute against "
      + "the core budget's fifteen thousand an hour. Held for a minute, so a "
      + "refresh and a second view share one answer. The checks and conflict "
      + "state behind each one come over GraphQL, fifty pull requests to a "
      + "request, sharing the module and the budget the Renovate view uses.",
  },
  "Rolling out Dependabot configuration": {
    trigger: "Open config PRs, or Commit to default branch, on the Vulnerabilities tab",
    endpoints: [
      "GET /repos/{o}/{r}/contents/.github/dependabot.yml", "GET /repos/{o}/{r}",
      "GET /repos/{o}/{r}/git/ref/heads/{branch}", "POST /repos/{o}/{r}/git/refs",
      "PUT /repos/{o}/{r}/contents/.github/dependabot.yml", "POST /repos/{o}/{r}/pulls",
    ],
    files: ["routes/dependencies.ts", "services/dependabotRollout.ts"],
    scalesWith: "how many repositories are rolled out to",
    note: "Six requests per repository for a pull request, four for a straight "
      + "commit, and capped at fifty repositories a run. Paced harder than the "
      + "settings bulk: these are writes, and creating branches and pull "
      + "requests in quick succession is what GitHub's secondary rate limit "
      + "exists to refuse.",
  },
  "Renovate dependency dashboards": {
    trigger: "Opening the Dependency dashboard view, or pressing one of its buttons",
    endpoints: [
      "GET /search/issues", "GET /repos/{o}/{r}/issues/{n}", "PATCH /repos/{o}/{r}/issues/{n}",
    ],
    files: ["routes/dependencies.ts", "services/renovateDashboards.ts"],
    scalesWith: "repositories with a dashboard, and how many are opened",
    note: "A self-hosted Renovate has no API, so its state is read from the "
      + "Dependency Dashboard issue it keeps in each repository. One search "
      + "finds them all and carries their bodies, so the view costs one "
      + "request. The dependency inventory is a separate read per repository, "
      + "on expansion, because across an organization it is megabytes and "
      + "almost nobody opens it. A button is one read and one write: the issue "
      + "is re-read at the moment of writing, since Renovate rewrites it on "
      + "every run and a stale body written back would revert what it changed.",
  },
  "Closing Dependabot pull requests": {
    trigger: "Close open Dependabot pull requests, on the Vulnerabilities tab",
    endpoints: ["GET /search/issues", "PATCH /repos/{o}/{r}/pulls/{n}"],
    files: ["routes/dependencies.ts", "services/dependabotClose.ts"],
    scalesWith: "how many pull requests are open on the chosen repositories",
    note: "One search to find them, then one write each, paced: closing pull "
      + "requests in quick succession is the shape GitHub's secondary rate "
      + "limit refuses, and a run of eighty that trips halfway is worse than a "
      + "slower one that finishes.",
  },
  "Turning Dependabot on or off": {
    trigger: "The toggle on a repository, or the bulk action on the Vulnerabilities tab",
    endpoints: [
      "PUT /repos/{o}/{r}/vulnerability-alerts", "DELETE …",
      "PUT /repos/{o}/{r}/automated-security-fixes", "DELETE …",
    ],
    files: ["routes/dependencies.ts", "services/dependabotBulk.ts"],
    scalesWith: "how many repositories are switched",
    note: "Two requests per repository when security updates are turned on, "
      + "because GitHub raises no updates for a repository it is not scanning. "
      + "Paced deliberately: these are writes, and GitHub refuses a burst of "
      + "them under a secondary rate limit.",
  },
  "Repository list": {
    trigger: "Any screen that lists repositories",
    endpoints: ["GET /orgs/{org}/repos"],
    files: ["routes/repos.ts", "services/repoService.ts"],
    scalesWith: "repositories",
  },
  "Why can't I push?": {
    trigger: "The push explainer on My work",
    endpoints: ["GET /repos/{o}/{r}/branches/{b}/protection"],
    files: ["routes/me.ts"],
    scalesWith: "how often it is asked",
    note: "Runs on the asker's own token, so it draws on their allowance.",
  },
  "Reading this page": {
    trigger: "Opening this tab",
    endpoints: ["GET /rate_limit"],
    files: ["services/githubBudgetService.ts"],
    scalesWith: "nothing",
    note: "The one endpoint GitHub does not charge against the limit it "
      + "reports, so the headroom above costs nothing to read. Counted anyway: "
      + "a page that hid its own requests would be the wrong page to trust "
      + "about everybody else's.",
  },
  "Unattributed": {
    trigger: "A request no running process could name",
    endpoints: [],
    files: [],
    scalesWith: "unlabelled work",
    // This note listed sign-ins, membership checks and writes to GitHub — all
    // of which now have rows of their own, three lines above it. A description
    // written before the labels existed and never revisited is worse than no
    // description: it contradicts the page it sits on.
    note: "Every call site in this app carries a label, and a test fails the "
      + "build if one does not. So a row here almost always means requests are "
      + "arriving from a process running older code — a Lambda deployed before "
      + "the labels existed. The source below says which. Counts are kept by "
      + "clock hour, so anything recorded earlier in this hour stays until it "
      + "rolls over.",
  },
};

export async function buildBudgetReport(hours = 1): Promise<BudgetReport> {
  const token = getSystemToken();

  const [headroom, usage] = await Promise.all([
    token
      ? readLimits(token)
      : Promise.resolve({
        limits: [] as BudgetLimit[],
        error: "No GitHub App token, so headroom cannot be read",
      }),
    readUsage(hours),
  ]);

  const measured = usage.rows.reduce((a, r) => a + r.count, 0);

  const rows: UsageRow[] = usage.rows.map(r => {
    const about = FEATURE_NOTES[r.feature];
    return {
      feature: r.feature,
      bucket: r.bucket,
      count: r.count,
      viaUser: r.viaUser,
      sources: r.sources,
      share: measured > 0 ? r.count / measured : 0,
      ...(about ? { about: { feature: r.feature, ...about } } : {}),
    };
  });

  return {
    limits: headroom.limits,
    usage: rows,
    totals: usage.totals,
    appTotals: usage.appTotals,
    hours: usage.hours,
    empty: usage.empty,
    ...(headroom.error ? { error: headroom.error } : {}),
  };
}
