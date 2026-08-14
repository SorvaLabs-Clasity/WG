import { createOctokit, getOrg, getSystemToken } from "../github/client";

/**
 * What the organisation consumed, per repository.
 *
 * GitHub retired `/orgs/{org}/settings/billing/actions` — it answers 410 "This
 * endpoint has been moved". Its replacement,
 * `/organizations/{org}/settings/billing/usage`, is a better source anyway: it
 * already attributes usage to a repository, so this needs one request rather
 * than a call per repository.
 */

export interface UsageItem {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  pricePerUnit: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  organizationName: string;
  repositoryName: string;
}

export interface RepoUsage {
  repo: string;
  /** Usage GitHub could not attribute to a repository. */
  unattributed: boolean;
  quantity: number;
  unitType: string;
  gross: number;
  net: number;
  products: string[];
}

export interface UsageSummary {
  /** One entry per month present in the data, oldest first. */
  months: { month: string; quantity: number; gross: number; net: number }[];
  byRepo: RepoUsage[];
  byProduct: { product: string; quantity: number; unitType: string; gross: number; net: number }[];
  totals: { quantity: number; gross: number; net: number; repos: number };
  /** True when nothing was returned at all, which is different from zero spend. */
  empty: boolean;
}

/** The name shown for usage GitHub attributed to no repository. */
export const UNATTRIBUTED = "(not attributed to a repository)";

async function fetchMonth(token: string, org: string, year?: number, month?: number): Promise<UsageItem[]> {
  const octokit = createOctokit(token);
  const query = year && month ? `?year=${year}&month=${month}` : "";
  const res = await octokit.request(
    `GET /organizations/${org}/settings/billing/usage${query}`,
  );
  return ((res.data as any)?.usageItems ?? []) as UsageItem[];
}

/**
 * Round money to the cent.
 *
 * Summing floats and printing the raw result produces 0.30000000000000004 on a
 * page about money, which reads as a bug in the numbers rather than in the
 * formatting.
 */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sum minutes without the same float drift — quantities can be fractional. */
function qty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function summarise(items: UsageItem[]): UsageSummary {
  const months = new Map<string, { quantity: number; gross: number; net: number }>();
  const repos = new Map<string, { quantity: number; unitType: string; gross: number; net: number; products: Set<string> }>();
  const products = new Map<string, { quantity: number; unitType: string; gross: number; net: number }>();
  let quantity = 0, gross = 0, net = 0;

  for (const it of items) {
    const month = (it.date ?? "").slice(0, 7);
    const m = months.get(month) ?? { quantity: 0, gross: 0, net: 0 };
    m.quantity += it.quantity; m.gross += it.grossAmount; m.net += it.netAmount;
    months.set(month, m);

    // An empty repositoryName is org-level usage, not a repository called "".
    // It is kept as its own row: dropping it makes the totals disagree with
    // GitHub's, and folding it into a repository would be a lie.
    const key = it.repositoryName || UNATTRIBUTED;
    const r = repos.get(key) ?? { quantity: 0, unitType: it.unitType, gross: 0, net: 0, products: new Set<string>() };
    r.quantity += it.quantity; r.gross += it.grossAmount; r.net += it.netAmount;
    r.products.add(it.product);
    repos.set(key, r);

    const p = products.get(it.product) ?? { quantity: 0, unitType: it.unitType, gross: 0, net: 0 };
    p.quantity += it.quantity; p.gross += it.grossAmount; p.net += it.netAmount;
    products.set(it.product, p);

    quantity += it.quantity; gross += it.grossAmount; net += it.netAmount;
  }

  return {
    months: [...months.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, quantity: qty(v.quantity), gross: money(v.gross), net: money(v.net) })),
    byRepo: [...repos.entries()]
      .map(([repo, v]) => ({
        repo, unattributed: repo === UNATTRIBUTED,
        quantity: qty(v.quantity), unitType: v.unitType,
        gross: money(v.gross), net: money(v.net), products: [...v.products].sort(),
      }))
      .sort((a, b) => b.quantity - a.quantity),
    byProduct: [...products.entries()]
      .map(([product, v]) => ({ product, quantity: qty(v.quantity), unitType: v.unitType, gross: money(v.gross), net: money(v.net) }))
      .sort((a, b) => b.gross - a.gross),
    totals: { quantity: qty(quantity), gross: money(gross), net: money(net), repos: repos.size },
    empty: items.length === 0,
  };
}

/**
 * Usage for the last `months` calendar months, including the current one.
 *
 * The endpoint buckets by month and accepts year/month, so this asks for each
 * in turn. Without arguments it returns the current billing period only, which
 * is not enough to show a trend.
 */
export async function getUsage(months = 6): Promise<UsageSummary> {
  const token = getSystemToken();
  if (!token) throw new Error("No GitHub token available for billing");
  const org = getOrg();

  const now = new Date();
  const wanted: Array<[number, number]> = [];
  for (let i = 0; i < Math.max(1, Math.min(24, months)); i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    wanted.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
  }

  const all: UsageItem[] = [];
  const seen = new Set<string>();
  for (const [year, month] of wanted) {
    // A month with no usage is a 200 with an empty list, so a failure here is a
    // real failure and should surface rather than read as a quiet month.
    const items = await fetchMonth(token, org, year, month);
    for (const it of items) {
      // The same row can appear under more than one requested month when a
      // period straddles them. Keyed rather than trusted.
      const k = `${it.date}|${it.product}|${it.sku}|${it.repositoryName}|${it.quantity}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(it);
    }
  }

  return summarise(all);
}
