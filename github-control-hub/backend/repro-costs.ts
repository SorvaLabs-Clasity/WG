/**
 * What each of this app's resources has cost.
 *
 * The obvious implementation is Cost Explorer, and it cannot answer the
 * question. It bills a cent a call and groups by *service*: "DynamoDB, $18",
 * never which table, because AWS does not meter cost per resource for DynamoDB
 * or Lambda at all. The resource-level answer needs Cost and Usage Reports, an
 * S3 bucket and Athena, which is a data pipeline for something CloudWatch
 * already knows.
 *
 * So this multiplies metered usage by published prices. The trade is that the
 * number is list price and knows nothing about the free tier, discounts or
 * tax, and the panel has to say so where the number is rather than let somebody
 * reconcile it against an invoice and conclude one of them is broken.
 *
 * Run:  npx tsx repro-costs.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { PRICES } from "./src/services/costService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  // ── the arithmetic ──────────────────────────────────────────────────
  {
    // Checked against the published rates rather than against themselves: a
    // typo here reports a wrong number for ever and nothing fails.
    check("a million DynamoDB reads cost a quarter",
      Math.abs(1_000_000 * PRICES.dynamo.readUnit - 0.25) < 1e-9,
      1_000_000 * PRICES.dynamo.readUnit);
    check("  and a million writes cost five times that",
      Math.abs(1_000_000 * PRICES.dynamo.writeUnit - 1.25) < 1e-9);
    check("a million Lambda requests cost twenty cents",
      Math.abs(1_000_000 * PRICES.lambda.request - 0.20) < 1e-9);
    check("  and a GB-second is priced to ten significant figures",
      Math.abs(PRICES.lambda.gbSecond - 0.0000166667) < 1e-12,
      "rounding this is a percent off every Lambda line");

    // A price with no date is a price nobody can tell is stale.
    check("the prices are stamped with a region and a month",
      /^\d{4}-\d{2}$/.test(PRICES.asOf) && PRICES.region.length > 0,
      { asOf: PRICES.asOf, region: PRICES.region });
  }

  // ── how the usage is read ───────────────────────────────────────────
  {
    const svc = fs.readFileSync("./src/services/costService.ts", "utf8");

    check("usage is asked for in batches, not one call per resource",
      /queries\.slice\(i, i \+ 500\)/.test(svc),
      "a dozen tables and five functions would be thirty round trips for one screen");

    // Duration is summed in milliseconds across every invocation, and the
    // memory is per function. Getting either wrong is a plausible number that
    // is quietly out by orders of magnitude.
    check("Lambda compute is duration times the memory that function has",
      /const gbSeconds = \(ms \/ 1000\) \* \(f\.memoryMb \/ 1024\);/.test(svc),
      "a fixed memory figure is wrong for every function that is not 1GB");

    check("storage is charged for the share of a month asked about",
      /PRICES\.dynamo\.storageGbMonth \* \(days \/ 30\)/.test(svc),
      "a seven-day window billed a full month of storage would overstate it fourfold");

    check("a monthly figure is scaled from the window, not assumed",
      /monthly: total \* \(30 \/ days\)/.test(svc));

    // Absent metrics are genuinely zero: CloudWatch publishes no datapoint for
    // something that never happened. Absent *permission* is not, and the two
    // must not collapse into the same number.
    check("a section that cannot be read is recorded, not counted as zero",
      /errors\.push\(/.test(svc) && /errors: string\[\]/.test(svc),
      "a total quietly missing DynamoDB reads as a cheap app");

    check("  and one failing section does not lose the rest",
      (svc.match(/catch \(err: any\) \{\s*\n\s*errors\.push/g) ?? []).length >= 4,
      "each service is read in its own try, so no permission gap empties the page");
  }

  // ── only this app's resources ───────────────────────────────────────
  //
  // These accounts hold other people's work. A company with two hundred of its
  // own DynamoDB tables must not open "what this app costs" and see the
  // department's bill. The name prefix is the only thing separating the two,
  // and it is written per service because each SDK narrows a listing
  // differently, so a service added without one would attribute somebody
  // else's spend here and look entirely plausible doing it.
  {
    const svc = fs.readFileSync("./src/services/costService.ts", "utf8");

    for (const [what, re] of [
      ["DynamoDB tables", /TableNames \?\? \[\]\)\.filter\(\(n: string\) => n\.startsWith\(`\$\{prefix\}-`\)\)/],
      ["Lambda functions", /String\(f\.FunctionName\)\.startsWith\(`\$\{prefix\}-`\)/],
      ["log groups", /logGroupNamePrefix: prefix/],
      ["SNS topics", /String\(t\.TopicArn\)\.includes\(`:\$\{prefix\}-notify-`\)/],
      ["secrets", /!String\(s\.Name\)\.startsWith\(prefix\)\) continue/],
    ] as const) {
      check(`${what} are filtered to this app`, re.test(svc),
        "without this the report bills the whole account to this app");
    }

    // The guard that survives a sixth service being added: every listing
    // command in the file has to be within reach of the prefix.
    const listings = [...svc.matchAll(/new (List\w+Command|Describe\w+Command)\(/g)]
      .map(m => ({ cmd: m[1], at: m.index! }))
      // DescribeTable is per-table, already narrowed by the listing above it.
      .filter(l => l.cmd !== "DescribeTableCommand");

    const unfiltered = listings.filter(l => {
      // The filter sits within a few lines of the listing, before or after.
      const around = svc.slice(Math.max(0, l.at - 400), l.at + 700);
      return !/prefix/.test(around);
    });
    check("every listing in the file is narrowed by the prefix",
      unfiltered.length === 0,
      unfiltered.map(l => l.cmd));

    check("  and there is something to check, so the sweep is not vacuous",
      listings.length >= 5, listings.length);
  }

  // ── what the screen claims ──────────────────────────────────────────
  {
    const ui = fs.readFileSync("../frontend/src/components/CostPanel.tsx", "utf8");

    check("the estimate says it is one, next to the number",
      /does not know about the free tier/.test(ui),
      "a footnote is where somebody looks after deciding the number is wrong");

    check("  and says why a bill cannot answer this instead",
      /does\s*\n?\s*not meter cost per resource/.test(ui),
      "otherwise the obvious question is why this is not just read from billing");

    // Most individual resources here cost fractions of a cent, and "$0.00"
    // beside a real number reads as free rather than small.
    check("a cost below a cent is not shown as zero",
      /if \(n < 0\.01\) return `<\$0\.01`;/.test(ui));

    // The reader should not have to take "this app's resources" on trust in an
    // account full of somebody else's.
    check("the screen says what it counted, and what it did not",
      /Only resources named/.test(ui) && /Nothing else in this account is counted/.test(ui),
      "an unstated scope is one the reader assumes is wrong in whichever direction worries them");

    // Two levels, answering two questions. A bill can give the first and never
    // the second, which is the whole reason this page exists, so having only
    // the rollup would make the page pointless.
    check("the report is per resource, named, not per service",
      /\{line\.name\}/.test(ui) && /data\.lines\.map\(line =>/.test(ui),
      "a category total says which service, never which of your resources");

    check("  with a service rollup beside it, not instead of it",
      /By service/.test(ui) && /By resource/.test(ui),
      "one says where to look, the other says what to do");

    check("  and each resource opens into what it actually did",
      /line\.usage\.map\(u =>/.test(ui),
      "a cost with no usage behind it cannot be argued with or acted on");

    check("prices from another region are flagged",
      /pricesMayNotApply/.test(ui),
      "list prices differ by region, and a silent mismatch is a wrong number");

    const routes = fs.readFileSync("./src/routes/awsGuardrails.ts", "utf8");
    check("the report is cached, since it moves slowly and costs API calls",
      /COST_CACHE_MS = 60 \* 60_000/.test(routes));

    check("  and the window is clamped",
      /Math\.min\(90, Math\.max\(1, Number\(req\.query\.days\) \|\| 30\)\)/.test(routes),
      "an unbounded window is an unbounded CloudWatch query");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
