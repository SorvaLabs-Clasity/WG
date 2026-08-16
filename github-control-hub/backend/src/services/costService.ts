/**
 * What this account spends, and on whose work.
 *
 * ## The one API here that costs money
 *
 * Every other AWS call in this app is a `List` or `Describe`, which AWS does
 * not charge for. Cost Explorer charges **$0.01 per request**. That is nothing
 * once a day and $26 a month for one tab left open refreshing every thirty
 * seconds, so nothing here runs on a timer, on a render, or on a hover. It runs
 * when somebody asks, and the answer is held for a day.
 *
 * ## Three ways to attribute spend, and only one of them is free of setup
 *
 * The useful question is "what is this project costing", and AWS answers it
 * three ways, in descending order of precision:
 *
 *   1. **Per resource** — exact, and lets spend be attributed through the
 *      source index without any tagging at all. Requires the payer account to
 *      opt in to resource-level granularity, and only keeps 14 days.
 *   2. **Per cost allocation tag** — exact for anything tagged. Requires the
 *      tags to be activated in Billing, and takes about a day to populate.
 *   3. **Per service** — always available, and cannot be split between
 *      projects.
 *
 * Which one produced an answer is carried on the answer. A number labelled
 * "per project" that is really a service total divided by a guess is worse than
 * no number, so the mode is reported and the UI says so.
 */

export interface CostPeriod {
  start: string;
  end: string;
}

export interface SpendRow {
  /** A service name, a tag value, or a resource id, depending on the mode. */
  key: string;
  amount: number;
  currency: string;
}

export type CostMode = "resource" | "tag" | "service";

export interface CostDeps {
  /** Grouped spend. One Cost Explorer request, one cent. */
  getCostAndUsage(
    period: CostPeriod, groupBy: { Type: string; Key: string },
  ): Promise<SpendRow[]>;
  /** Per-resource spend, where the payer account has opted in. */
  getCostAndUsageWithResources?(
    period: CostPeriod, service?: string,
  ): Promise<SpendRow[]>;
  /** Cost allocation tag keys that are active. */
  activeCostTags(): Promise<string[]>;
}

export interface CostAnswer {
  mode: CostMode;
  period: CostPeriod;
  rows: SpendRow[];
  total: number;
  currency: string;
  /**
   * Why a more precise mode was not used, and what to do about it.
   *
   * Written as instructions rather than as an apology: somebody looking at a
   * per-service total wants to know how to get a per-project one.
   */
  notes: string[];
  /** When this was read. Cost data is a day old by design. */
  readAt: string;
}

/**
 * How long an answer is reused.
 *
 * A day, because Cost Explorer's own data settles daily and because the request
 * costs a cent. Refreshing this every few minutes would spend more on asking
 * than most of the resources being asked about.
 */
export const COST_CACHE_MS = 24 * 60 * 60_000;

let cache: { at: number; key: string; answer: CostAnswer } | null = null;

export function clearCostCache(): void {
  cache = null;
}

/** The calendar month containing `now`, which is what a bill is measured in. */
export function currentMonth(now = new Date()): CostPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/**
 * Whether `GetCostAndUsageWithResources` can answer for this period.
 *
 * The endpoint keeps 14 days and refuses anything older, with a message about
 * hourly granularity that does not mention resources at all. Checked here so a
 * doomed request is never sent — every one of them is a cent.
 */
export const RESOURCE_WINDOW_DAYS = 14;

export function withinResourceWindow(period: CostPeriod, now = Date.now()): boolean {
  const start = Date.parse(period.start + "T00:00:00Z");
  if (!Number.isFinite(start)) return false;
  return now - start <= RESOURCE_WINDOW_DAYS * 86_400_000;
}

function total(rows: SpendRow[]): number {
  return rows.reduce((n, r) => n + r.amount, 0);
}

/**
 * The most precise breakdown this account can produce, and why.
 *
 * Tries each mode in turn rather than asking the caller to know which is
 * available — whether resource-level granularity is on is a billing setting
 * nobody using this app can be expected to have memorised.
 */
export async function readCost(
  deps: CostDeps, period: CostPeriod, tagKey?: string, now = Date.now(),
): Promise<CostAnswer> {
  const key = `${period.start}:${period.end}:${tagKey ?? ""}`;
  if (cache && cache.key === key && now - cache.at < COST_CACHE_MS) return cache.answer;

  const notes: string[] = [];
  let answer: CostAnswer | null = null;

  // 1. Per resource, if the payer account opted in *and* the period is recent
  //     enough for the endpoint to answer at all.
  //
  //     Measured against a real account: asking for a calendar month returns
  //     "start date is too old for hourly, the max supported days for hourly
  //     granularity is 14 days" — not the opt-in message, and not anything a
  //     reader could act on. Worse, it is a wasted Cost Explorer request, and
  //     those cost a cent each. Checked before asking rather than after.
  if (deps.getCostAndUsageWithResources && !withinResourceWindow(period, now)) {
    notes.push(
      "Per-resource spend only covers the last 14 days, so it cannot break down a whole "
      + "calendar month. Ask for a shorter period to attribute spend to individual resources.",
    );
  } else if (deps.getCostAndUsageWithResources) {
    try {
      const rows = await deps.getCostAndUsageWithResources(period);
      if (rows.length > 0) {
        answer = {
          mode: "resource", period, rows, total: total(rows),
          currency: rows[0]?.currency ?? "USD", notes, readAt: new Date(now).toISOString(),
        };
      }
    } catch (err: any) {
      // The opt-in message is worth passing through nearly verbatim: it names
      // the exact page, and it is the difference between per-project numbers
      // and no per-project numbers.
      notes.push(
        /opt-in|opt in/i.test(err?.message ?? "")
          ? "Per-resource spend is off. Turn on resource-level data in the payer account's "
            + "Cost Explorer settings to attribute spend to individual resources — it takes a "
            + "day to populate and keeps 14 days of history."
          : `Per-resource spend could not be read: ${(err?.message ?? "unknown").slice(0, 160)}`,
      );
    }
  }

  // 2. Per cost allocation tag, if any are active.
  if (!answer) {
    let active: string[] = [];
    try {
      active = await deps.activeCostTags();
    } catch (err: any) {
      notes.push(`Cost allocation tags could not be listed: ${(err?.message ?? "unknown").slice(0, 160)}`);
    }

    const chosen = tagKey && active.includes(tagKey) ? tagKey : active[0];
    if (chosen) {
      const rows = await deps.getCostAndUsage(period, { Type: "TAG", Key: chosen });
      answer = {
        mode: "tag", period, rows, total: total(rows),
        currency: rows[0]?.currency ?? "USD",
        notes: [...notes, `Grouped by the "${chosen}" cost allocation tag.`],
        readAt: new Date(now).toISOString(),
      };
    } else {
      notes.push(
        "No cost allocation tags are active, so spend cannot be split between projects. "
        + "Activate one in Billing → Cost allocation tags — it applies from that day forward, "
        + "not retroactively.",
      );
    }
  }

  // 3. Per service, which always works and cannot be split.
  if (!answer) {
    const rows = await deps.getCostAndUsage(period, { Type: "DIMENSION", Key: "SERVICE" });
    answer = {
      mode: "service", period, rows, total: total(rows),
      currency: rows[0]?.currency ?? "USD", notes, readAt: new Date(now).toISOString(),
    };
  }

  answer.rows = [...answer.rows].sort((a, b) => b.amount - a.amount);
  cache = { at: now, key, answer };
  return answer;
}

// ── connecting spend to repositories ──────────────────────────────────

export interface ServiceOwnership {
  /** The AWS service, as Cost Explorer names it. */
  service: string;
  amount: number;
  /** Repositories whose source references resources of this service. */
  repos: string[];
  /** Resources of this service that no repository references. */
  unreferenced: string[];
}

/**
 * Cost Explorer's names for services, mapped to this app's provider names.
 *
 * They do not match and never will — Cost Explorer says "Amazon Simple Queue
 * Service", the SDK says `sqs`. Written out rather than fuzzy-matched, because
 * a wrong match here silently attributes one service's bill to another
 * service's repositories, and nothing about the output would look wrong.
 */
export const SERVICE_ALIASES: Record<string, string> = {
  "Amazon Simple Queue Service": "sqs",
  "AWS Lambda": "lambda",
  "Amazon Simple Storage Service": "s3",
  "Amazon DynamoDB": "dynamodb",
  "Amazon Relational Database Service": "rds",
  "AmazonCloudWatch": "logs",
  "Amazon CloudWatch": "logs",
};

/**
 * Only services this app actually inventories appear above.
 *
 * The first version also mapped EC2 compute, VPC, Secrets Manager, API Gateway
 * and SNS — to provider names that do not exist. Every one of those would have
 * resolved to a provider, found no resources under it, and reported "no
 * repository references this service" with the confidence of a real answer,
 * when the truth was that nothing had been listed. A service with no mapping is
 * shown with its cost and no ownership claim, which is the honest shape for the
 * same situation.
 *
 * Mapping EC2 compute to `ec2-sg` would have been worse still: security groups
 * are free, so an instance bill would have been attributed to the repositories
 * that reference a firewall rule.
 */

export function providerFor(costServiceName: string): string | null {
  return SERVICE_ALIASES[costServiceName] ?? null;
}

/**
 * Which repositories are behind each service's bill.
 *
 * **Not a dollar split.** Without per-resource data there is no honest way to
 * say how much of a service's bill belongs to one repository, and inventing a
 * proportion is exactly the kind of number that gets quoted in a meeting and
 * then cannot be defended. This says which repositories touch the service at
 * all, which is a claim the source actually supports.
 *
 * `unreferenced` is the more interesting half in practice: resources of a
 * service that nothing in any repository names are the ones nobody owns.
 */
export function ownershipByService(
  spend: SpendRow[],
  resources: Array<{ service: string; name: string }>,
  reposByResource: Map<string, string[]>,
): ServiceOwnership[] {
  return spend
    .map(row => {
      const provider = providerFor(row.key);
      const mine = provider ? resources.filter(r => r.service === provider) : [];
      const repos = new Set<string>();
      const unreferenced: string[] = [];

      for (const r of mine) {
        const refs = reposByResource.get(`${r.service}/${r.name}`) ?? [];
        if (refs.length === 0) unreferenced.push(r.name);
        for (const repo of refs) repos.add(repo);
      }

      return {
        service: row.key,
        amount: row.amount,
        repos: [...repos].sort(),
        unreferenced: unreferenced.sort(),
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

import { awsRegion } from "../utils/region";

/**
 * Cost Explorer, in the shape this module wants.
 *
 * The client is built from the default credential chain, which in the desktop
 * process is the operator's own session — the same as every other AWS read
 * here, and the reason this needed no new IAM grant.
 *
 * **Cost Explorer only answers in us-east-1**, whatever region the rest of the
 * app is using. That is a property of the service, not a fallback: the endpoint
 * exists nowhere else, so naming it here is correct where naming a region
 * anywhere else in this codebase would be a bug.
 */
export function costDepsFromAws(): CostDeps {
  const client = async () => {
    const { CostExplorerClient } = await import("@aws-sdk/client-cost-explorer");
    return new CostExplorerClient({ region: "us-east-1" });
  };

  const rowsFrom = (result: any): SpendRow[] => {
    const out = new Map<string, SpendRow>();
    for (const period of result?.ResultsByTime ?? []) {
      for (const group of period.Groups ?? []) {
        const key = (group.Keys ?? []).join(" / ") || "unattributed";
        const metric = group.Metrics?.UnblendedCost;
        const amount = Number(metric?.Amount ?? 0);
        if (!Number.isFinite(amount)) continue;
        const existing = out.get(key);
        // Summed across periods rather than replaced: a monthly granularity
        // request still returns one entry per period, and keeping only the last
        // would silently report a fraction of the bill.
        if (existing) existing.amount += amount;
        else out.set(key, { key, amount, currency: metric?.Unit ?? "USD" });
      }
    }
    return [...out.values()].filter(r => r.amount > 0);
  };

  return {
    async getCostAndUsage(period, groupBy) {
      const { GetCostAndUsageCommand } = await import("@aws-sdk/client-cost-explorer");
      const c = await client();
      return rowsFrom(await c.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: period.start, End: period.end },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [groupBy as any],
      })));
    },

    async getCostAndUsageWithResources(period) {
      const region = awsRegion();
      const { GetCostAndUsageWithResourcesCommand } = await import("@aws-sdk/client-cost-explorer");
      const c = await client();
      return rowsFrom(await c.send(new GetCostAndUsageWithResourcesCommand({
        TimePeriod: { Start: period.start, End: period.end },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
        // Required by this endpoint and by this endpoint only. A filter naming
        // every region is the documented way to say "no filter" — without one
        // the request is rejected before the opt-in check even runs, and the
        // useful "turn resource-level data on" message never arrives.
        Filter: { Dimensions: { Key: "REGION", Values: [region ?? "us-east-1"], MatchOptions: ["EQUALS"] } },
      })));
    },

    async activeCostTags() {
      const { ListCostAllocationTagsCommand } = await import("@aws-sdk/client-cost-explorer");
      const c = await client();
      const r: any = await c.send(new ListCostAllocationTagsCommand({ Status: "Active" }));
      return (r?.CostAllocationTags ?? []).map((t: any) => t.TagKey).filter(Boolean);
    },
  };
}
