/**
 * What this account spends, and how much of that can honestly be attributed.
 *
 * Run from github-control-hub/backend:  npx tsx repro-cost.ts
 *
 * Two things make this feature different from everything else in the app.
 *
 * **The API costs money.** Every other AWS call here is a List or Describe,
 * which AWS does not charge for. Cost Explorer charges a cent per request —
 * nothing once a day, $26 a month for one tab refreshing every thirty seconds.
 * So the caching is not an optimisation, it is the feature being affordable,
 * and it is tested as such.
 *
 * **The precise answer is usually unavailable.** Per-project spend needs either
 * resource-level granularity (a payer-account opt-in, 14 days of history) or
 * active cost allocation tags (activated in Billing, populates over a day).
 * Measured on a real account: neither was on. So the honest output is a
 * per-service total plus instructions, and the thing this suite mostly guards
 * is that a less precise answer is never dressed up as a more precise one.
 *
 * A number labelled "per project" that is really a service total split by a
 * guess is worse than no number: it gets quoted in a meeting and then cannot be
 * defended.
 */
import {
  readCost, clearCostCache, currentMonth, ownershipByService, providerFor,
  SERVICE_ALIASES, COST_CACHE_MS, withinResourceWindow, RESOURCE_WINDOW_DAYS,
  projectSpend, resourceKeyFor, __resetCostForTests, MIN_FORCED_REFRESH_MS,
  type CostDeps, type SpendRow,
} from "./src/services/costService";
import { defaultProviders } from "./src/services/awsProviders";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const PERIOD = { start: "2026-08-01", end: "2026-09-01" };
/** Inside the resource endpoint's 14-day window, unlike a calendar month. */
const NOW = Date.parse("2026-08-30T00:00:00Z");
const RECENT = { start: "2026-08-28", end: "2026-08-31" };
const row = (key: string, amount: number): SpendRow => ({ key, amount, currency: "USD" });

/** Counts requests, because each one is a cent. */
function deps(over: Partial<CostDeps> = {}) {
  const calls = { grouped: 0, resource: 0, tags: 0 };
  const base: CostDeps = {
    async getCostAndUsage() { calls.grouped++; return [row("AWS Lambda", 12), row("Amazon DynamoDB", 30)]; },
    async activeCostTags() { calls.tags++; return []; },
    ...over,
  };
  return { deps: base, calls };
}

(async () => {
  // ── falling back honestly ────────────────────────────────────────────
  {
    __resetCostForTests();
    const { deps: d } = deps();
    const a = await readCost(d, PERIOD);
    check("with no tags and no resource data, the answer is per service",
      a.mode === "service", a.mode);
    check("  totalled", a.total === 42, a.total);
    check("  biggest first", a.rows[0].key === "Amazon DynamoDB", a.rows.map(r => r.key));
    check("  and says how to get a per-project answer",
      a.notes.some(n => /Activate one in Billing/.test(n)), a.notes);
  }
  {
    __resetCostForTests();
    const { deps: d } = deps({ activeCostTags: async () => ["Project"] });
    const a = await readCost(d, PERIOD);
    check("an active cost allocation tag is used", a.mode === "tag", a.mode);
    check("  and named, so the grouping is not a mystery",
      a.notes.some(n => /"Project" cost allocation tag/.test(n)), a.notes);
  }
  {
    __resetCostForTests();
    const { deps: d } = deps({
      activeCostTags: async () => ["Project", "Team"],
      getCostAndUsage: async () => [row("payments", 40)],
    });
    const a = await readCost(d, PERIOD, "Team");
    check("a requested tag is honoured when active",
      a.notes.some(n => /"Team"/.test(n)), a.notes);

    __resetCostForTests();
    const b = await readCost(d, PERIOD, "NotActivated");
    check("  and a requested tag that is not active falls back rather than failing",
      b.mode === "tag" && b.notes.some(n => /"Project"/.test(n)), b.notes);
  }
  {
    __resetCostForTests();
    const { deps: d } = deps({
      getCostAndUsageWithResources: async () => [row("arn:aws:sqs:::q", 5)],
    });
    const a = await readCost(d, RECENT, undefined, NOW);
    check("per-resource data is preferred when available", a.mode === "resource", a.mode);
  }
  {
    // The measured reality: resource-level is an opt-in and was off.
    __resetCostForTests();
    const { deps: d } = deps({
      getCostAndUsageWithResources: async () => {
        throw new Error("Resource-level data granularity is an opt-in only feature. "
          + "You can be enable this feature from the PAYER account's Cost Explorer Settings page.");
      },
    });
    const a = await readCost(d, RECENT, undefined, NOW);
    check("the opt-in message becomes an instruction, not a stack trace",
      a.notes.some(n => /Turn on resource-level data/.test(n)), a.notes);
    check("  and it falls through to a mode that works", a.mode === "service", a.mode);
    check("  mentioning the fourteen-day limit, which decides whether it is worth turning on",
      a.notes.some(n => /14 days/.test(n)), a.notes);
  }
  {
    __resetCostForTests();
    const { deps: d } = deps({
      getCostAndUsageWithResources: async () => [],
    });
    const a = await readCost(d, RECENT, undefined, NOW);
    check("resource mode returning nothing is not treated as a zero bill",
      a.mode === "service", a.mode);
  }

  // ── the endpoint's 14-day window, checked before spending a cent ────
  //
  // Measured against a real account: asking for a calendar month returns "start
  // date is too old for hourly, the max supported days for hourly granularity
  // is 14 days" — which does not mention resources, is not actionable, and cost
  // a Cost Explorer request to discover.
  {
    __resetCostForTests();
    let asked = false;
    const { deps: d } = deps({
      getCostAndUsageWithResources: async () => { asked = true; return [row("x", 1)]; },
    });
    const now = Date.parse("2026-08-30T00:00:00Z");
    const a = await readCost(d, { start: "2026-08-01", end: "2026-09-01" }, undefined, now);
    check("a period older than the window is not asked for at all", !asked);
    check("  saving the request rather than discovering it costs one", a.mode === "service", a.mode);
    check("  and says what the window is",
      a.notes.some(n => /last 14 days/.test(n)), a.notes);

    __resetCostForTests();
    const recent = await readCost(
      d, { start: "2026-08-28", end: "2026-08-31" }, undefined, now);
    check("a recent period is asked for", asked && recent.mode === "resource", recent.mode);

    check("the window matches what the endpoint keeps", RESOURCE_WINDOW_DAYS === 14);
    check("today is inside the window",
      withinResourceWindow({ start: "2026-08-30", end: "2026-08-31" }, now));
    check("  and a month ago is not",
      !withinResourceWindow({ start: "2026-07-30", end: "2026-07-31" }, now));
  }

  // ── every request is a cent ──────────────────────────────────────────
  {
    __resetCostForTests();
    const { deps: d, calls } = deps();
    await readCost(d, PERIOD);
    await readCost(d, PERIOD);
    await readCost(d, PERIOD);
    check("asking three times costs one request", calls.grouped === 1, calls.grouped);

    const later = Date.now() + COST_CACHE_MS + 1;
    await readCost(d, PERIOD, undefined, later);
    check("  and a day later it asks again", calls.grouped === 2, calls.grouped);

    check("the cache window is a day, not minutes",
      COST_CACHE_MS >= 12 * 3600_000, COST_CACHE_MS);
  }
  {
    __resetCostForTests();
    const { deps: d, calls } = deps();
    await readCost(d, PERIOD);
    await readCost(d, { start: "2026-07-01", end: "2026-08-01" });
    check("a different period is a different question, and is asked",
      calls.grouped === 2, calls.grouped);
  }

  // ── the month a bill is measured in ──────────────────────────────────
  {
    const p = currentMonth(new Date("2026-08-16T12:00:00Z"));
    check("the period is the calendar month", p.start === "2026-08-01" && p.end === "2026-09-01", p);
    const dec = currentMonth(new Date("2026-12-05T00:00:00Z"));
    check("  and rolls into the next year correctly",
      dec.start === "2026-12-01" && dec.end === "2027-01-01", dec);
  }

  // ── service names, which do not match and never will ─────────────────
  {
    check("Cost Explorer's name maps to the provider's",
      providerFor("Amazon Simple Queue Service") === "sqs");
    check("  and an unmapped service is null rather than a guess",
      providerFor("Amazon Braket") === null);
    // Checked against the real provider list, not against a shape.
    //
    // The first version of this asserted the values looked like lowercase
    // words, which several did while naming providers that do not exist. Each
    // would have resolved, found no resources, and reported "no repository
    // references this" as though it were a finding.
    const providers = new Set(defaultProviders().map(p => p.service));
    const orphans = Object.entries(SERVICE_ALIASES).filter(([, v]) => !providers.has(v));
    check("every alias names a service this app actually inventories",
      orphans.length === 0, orphans);
  }

  // ── whose work is behind the bill ────────────────────────────────────
  {
    const resources = [
      { service: "dynamodb", name: "orders" },
      { service: "dynamodb", name: "legacy-sessions" },
      { service: "lambda", name: "worker" },
    ];
    const refs = new Map([
      ["dynamodb/orders", ["payments-api"]],
      ["lambda/worker", ["payments-api", "ops"]],
    ]);
    const own = ownershipByService(
      [row("Amazon DynamoDB", 30), row("AWS Lambda", 12)], resources, refs);

    check("the biggest bill comes first", own[0].service === "Amazon DynamoDB", own.map(o => o.service));
    check("  naming the repositories that reference it",
      own[0].repos.join() === "payments-api", own[0].repos);
    check("  and the resources nothing references",
      own[0].unreferenced.join() === "legacy-sessions", own[0].unreferenced);
    check("a service touched by two repositories names both",
      own[1].repos.join() === "ops,payments-api", own[1].repos);

    // The line this must not cross. Without per-resource data there is no
    // honest way to say how much of DynamoDB's $30 is payments-api's, and a
    // number invented here would be quoted and then undefendable.
    check("no per-repository dollar figure is invented",
      !JSON.stringify(own).includes("amountByRepo"), Object.keys(own[0]));
  }
  {
    const own = ownershipByService([row("Amazon Braket", 9)], [], new Map());
    check("a service with no mapping still shows its cost",
      own[0].amount === 9 && own[0].repos.length === 0, own[0]);
  }

  // ── spend per project, the mode the whole feature is for ────────────
  //
  // Only possible with per-resource costs. Nothing in AWS knows which resource
  // cost what unless the payer account opts in, and no amount of source
  // analysis can supply that — which is why the answer on most accounts is a
  // per-service total and an instruction, not a project breakdown.
  {
    const resources = [
      { service: "dynamodb", name: "orders", arn: "arn:aws:dynamodb:::table/orders" },
      { service: "dynamodb", name: "sessions" },
      { service: "sqs", name: "shared-events" },
      { service: "s3", name: "nobody-owns-this" },
    ];
    const refs = new Map([
      ["dynamodb/orders", ["payments-api"]],
      ["dynamodb/sessions", ["payments-api"]],
      ["sqs/shared-events", ["payments-api", "ops"]],
    ]);
    const b = projectSpend([
      row("arn:aws:dynamodb:::table/orders", 30),
      row("sessions", 12),
      row("shared-events", 8),
      row("nobody-owns-this", 5),
      row("some-ec2-instance", 24),
    ], resources, refs);

    const payments = b.projects.find(p => p.repo === "payments-api")!;
    check("a repository's own resources are exclusive spend",
      payments.exclusive === 42, payments.exclusive);
    // Not divided, and not blended into one number. Halving it is a guess;
    // reporting it in full under both without saying so double-counts.
    check("  a shared resource is kept separate, not split",
      payments.shared === 8, payments.shared);
    check("  naming who it is shared with", payments.sharedWith.join() === "ops", payments.sharedWith);
    check("  and the other side sees the same shared amount",
      b.projects.find(p => p.repo === "ops")!.shared === 8);
    check("  with nothing exclusive of its own",
      b.projects.find(p => p.repo === "ops")!.exclusive === 0);
    check("  and the double-count is called out in words",
      b.notes.some(n => /does not add up across projects/.test(n)), b.notes);

    check("biggest project first", b.projects[0].repo === "payments-api", b.projects.map(p => p.repo));

    // The two buckets that stop the parts from silently not adding up.
    check("a resource no repository references is unattributed",
      b.unattributed === 5, b.unattributed);
    check("  and named, because those are the ones nobody owns",
      b.unattributedResources[0].id === "nobody-owns-this", b.unattributedResources);
    check("a cost row for something not inventoried is counted as unmatched",
      b.unmatched === 24, b.unmatched);
    check("  and explained rather than dropped",
      b.notes.some(n => /does not inventory/.test(n)), b.notes);

    // Every dollar lands somewhere. A breakdown whose parts do not reach the
    // bill is one nobody trusts twice.
    const accounted = payments.exclusive + b.projects.find(p => p.repo === "ops")!.exclusive
      + 8 + b.unattributed + b.unmatched;
    check("every dollar is accounted for exactly once", accounted === 79, accounted);
  }
  {
    const resources = [
      { service: "dynamodb", name: "orders", arn: "arn:aws:dynamodb:::table/orders" },
      { service: "dynamodb", name: "orders-archive" },
    ];
    check("a row keyed by ARN finds its resource",
      resourceKeyFor("arn:aws:dynamodb:::table/orders", resources) === "dynamodb/orders");
    check("a row keyed by bare name finds it too",
      resourceKeyFor("orders", resources) === "dynamodb/orders");
    // Money attributed to the wrong team is discovered in a budget meeting.
    check("a longer name is not the same resource",
      resourceKeyFor("orders-archive", resources) === "dynamodb/orders-archive");

    // Ordering-sensitive, and deliberately so. With the longer name listed
    // first, a substring match returns *it* for the shorter key — attributing
    // the orders table's bill to the archive. Listing the exact match first,
    // as the previous fixture happened to, hides that entirely.
    const reversed = [
      { service: "dynamodb", name: "orders-archive" },
      { service: "dynamodb", name: "orders" },
    ];
    check("  and is not matched even when it is listed first",
      resourceKeyFor("orders", reversed) === "dynamodb/orders",
      resourceKeyFor("orders", reversed));
    check("something not inventoried matches nothing",
      resourceKeyFor("i-0abc123", resources) === null);
    check("an empty key matches nothing", resourceKeyFor("   ", resources) === null);
  }
  {
    const empty = projectSpend([], [], new Map());
    check("no rows is an empty breakdown, not an error",
      empty.projects.length === 0 && empty.unattributed === 0, empty);
  }

  // ── the refresh button cannot be held down ──────────────────────────
  //
  // Everything else in this app refreshes as often as somebody likes, because
  // everything else is free. This is a cent a request, and a button that
  // bypasses the cache is a button somebody can hold down.
  {
    __resetCostForTests();
    const t0 = 5_000_000;
    check("the first forced refresh clears the cache", clearCostCache(t0));
    check("  a second, moments later, does not", !clearCostCache(t0 + 1_000));
    check("  nor at the end of the window", !clearCostCache(t0 + MIN_FORCED_REFRESH_MS - 1));
    check("  and one after the window does", clearCostCache(t0 + MIN_FORCED_REFRESH_MS));

    check("the gap is minutes, not seconds", MIN_FORCED_REFRESH_MS >= 60_000, MIN_FORCED_REFRESH_MS);
    // The worst case somebody can spend by holding the button: one request per
    // window, all day.
    const worstPerDay = Math.floor(86_400_000 / MIN_FORCED_REFRESH_MS);
    check(`  capping a held button at ${worstPerDay} requests a day`,
      worstPerDay * 0.01 < 5, worstPerDay * 0.01);
  }
  {
    // A throttled refresh must not silently hand back a cached answer as
    // though it were fresh — the caller is told, and says so.
    __resetCostForTests();
    const { deps: d, calls } = deps();
    await readCost(d, PERIOD);
    const cleared = clearCostCache(Date.now());
    check("clearing reports whether it happened", typeof cleared === "boolean");
    await readCost(d, PERIOD);
    check("  and a cleared cache does re-ask", calls.grouped === 2, calls.grouped);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
