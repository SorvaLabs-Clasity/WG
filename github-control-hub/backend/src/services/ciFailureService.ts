import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, ScanCommand } from "../utils/dynamo";

/**
 * Correlating CI failures.
 *
 * Thirteen repositories failing at once is almost never thirteen problems. It
 * is one problem — a runner image that changed, a shared action that published
 * a bad tag, an expired token, a registry outage — and the cost of not seeing
 * that is thirteen people each debugging their own repository in isolation.
 *
 * Fed by the `workflow_job` webhook, which was already arriving and being
 * dropped. That matters: the alternative is polling Actions per repository,
 * which is one request per repository per cycle and would dwarf everything
 * else this app spends. Here the data is free and already in flight.
 *
 * Only failures are stored. A successful job tells us nothing we would ever
 * ask about, and storing them all would be thousands of rows a day.
 */

const TABLE = () => tableName("CI_FAILURES_TABLE");

/** Long enough to see a pattern across a working week, short enough to stay small. */
export const RETENTION_DAYS = 7;

export interface CiFailure {
  id: string;
  repo: string;
  workflow: string;
  job: string;
  /** The first step that failed, which is the most diagnostic single field. */
  step: string | null;
  /** Runner labels, e.g. ubuntu-latest. The usual shared cause. */
  labels: string[];
  url: string;
  failedAt: string;
  ttl: number;
}

let memStore: CiFailure[] = [];

export async function recordFailure(
  f: Omit<CiFailure, "id" | "ttl">,
): Promise<void> {
  const row: CiFailure = {
    ...f,
    id: crypto.randomUUID(),
    ttl: Math.floor(Date.now() / 1000) + RETENTION_DAYS * 86_400,
  };
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: row }));
    return;
  }
  memStore.push(row);
}

export async function listFailures(): Promise<CiFailure[]> {
  if (usesDynamo()) {
    const res = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return (res.Items || []) as CiFailure[];
  }
  return memStore;
}

export function __resetCiStoreForTests(): void {
  memStore = [];
}

// ── the part worth testing ────────────────────────────────────────────

export interface Cluster {
  /** What the members have in common, already phrased for a person to read. */
  shared: string;
  /** The attributes that matched, for filtering and for alarms. */
  key: { step: string | null; label: string | null; workflow: string | null };
  repos: string[];
  failures: number;
  firstAt: string;
  lastAt: string;
  /** Sample URLs, so somebody can open one without another query. */
  examples: string[];
}

/**
 * Failures within this of each other are candidates for one cause.
 *
 * Two hours rather than a few minutes: a shared cause does not hit every
 * repository at the same instant. Repositories are affected as their schedules
 * and pushes happen to land, so a runner image change shows up over hours.
 */
export const WINDOW_HOURS = 2;

/**
 * A cluster must span this many repositories to be reported.
 *
 * One repository failing ten times is that repository's problem and its owner
 * already knows. The whole value here is noticing that separate repositories
 * are failing for the same reason, which is exactly what nobody sees.
 */
export const MIN_REPOS = 2;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Group failures by what they have in common.
 *
 * Three groupings are tried, most specific first, and a failure joins only the
 * most specific cluster it fits. Reporting the same failure under "step" and
 * again under "runner" would turn one incident into three findings and put the
 * reader back where they started.
 */
export function correlate(
  failures: CiFailure[],
  now = Date.now(),
  opts: { windowHours?: number; minRepos?: number } = {},
): Cluster[] {
  const windowMs = (opts.windowHours ?? WINDOW_HOURS) * 3_600_000;
  const minRepos = opts.minRepos ?? MIN_REPOS;

  const recent = failures
    .filter(f => {
      const t = new Date(f.failedAt).getTime();
      return Number.isFinite(t) && now - t <= windowMs && now - t >= -60_000;
    })
    .sort((a, b) => a.failedAt.localeCompare(b.failedAt));

  const claimed = new Set<string>();
  const clusters: Cluster[] = [];

  const build = (
    keyOf: (f: CiFailure) => string | null,
    describe: (sample: CiFailure, n: number, repos: number) => string,
    keyFields: (f: CiFailure) => Cluster["key"],
  ) => {
    const groups = new Map<string, CiFailure[]>();
    for (const f of recent) {
      if (claimed.has(f.id)) continue;
      const k = keyOf(f);
      if (!k) continue;
      const g = groups.get(k);
      if (g) g.push(f); else groups.set(k, [f]);
    }
    for (const members of groups.values()) {
      const repos = [...new Set(members.map(m => m.repo))];
      if (repos.length < minRepos) continue;
      for (const m of members) claimed.add(m.id);
      clusters.push({
        shared: describe(members[0], members.length, repos.length),
        key: keyFields(members[0]),
        repos: repos.sort(),
        failures: members.length,
        firstAt: members[0].failedAt,
        lastAt: members[members.length - 1].failedAt,
        examples: members.slice(0, 3).map(m => m.url).filter(Boolean),
      });
    }
  };

  // Most specific: the same step failing on the same runner. This is the
  // signature of a shared action or a runner image change.
  build(
    f => (f.step && f.labels.length ? `${norm(f.step)}|${norm(f.labels[0])}` : null),
    (s, n, r) => `${n} failures across ${r} repositories, all at step "${s.step}" on ${s.labels[0]}`,
    f => ({ step: f.step, label: f.labels[0] ?? null, workflow: null }),
  );

  // Then the same step anywhere.
  build(
    f => (f.step ? norm(f.step) : null),
    (s, n, r) => `${n} failures across ${r} repositories, all at step "${s.step}"`,
    f => ({ step: f.step, label: null, workflow: null }),
  );

  // Then the same workflow name, which catches a shared reusable workflow.
  build(
    f => (f.workflow ? norm(f.workflow) : null),
    (s, n, r) => `${n} failures across ${r} repositories, all in workflow "${s.workflow}"`,
    f => ({ step: null, label: null, workflow: f.workflow }),
  );

  // Largest first: the biggest correlation is the one most likely to be the
  // single cause, and it is what somebody scanning the page should see.
  return clusters.sort((a, b) =>
    b.repos.length - a.repos.length || b.failures - a.failures);
}

/** The first failing step, which is what actually broke rather than what ran. */
export function firstFailedStep(steps: Array<{ name?: string; conclusion?: string }> | undefined): string | null {
  if (!Array.isArray(steps)) return null;
  const failed = steps.find(s => s?.conclusion === "failure");
  return failed?.name?.slice(0, 200) ?? null;
}
