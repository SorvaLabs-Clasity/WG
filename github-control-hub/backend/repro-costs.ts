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
import { PRICES, billedDays } from "./src/services/costService";

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

    // These two asserted the bug: storage pro-rated by the window, and a
    // monthly figure scaled from the total. Both are now checked against the
    // resource's own billed period, further down.
    check("storage is charged for a share of a month, not a whole one",
      /PRICES\.dynamo\.storageGbMonth \* \(alive \/ 30\)/.test(svc),
      "a seven-day window billed a full month of storage would overstate it fourfold");

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

  // ── a fixed charge is billed for the resource's life, not the window ─
  //
  // The bug: every fixed charge was pro-rated by the length of the window
  // rather than by how long the resource had existed in it. Asking about
  // ninety days on a nine-day-old install reported ninety days of WAF, so a
  // $1.80 charge read as $18.
  //
  // Worse than an overestimate: the number grew the further back you looked,
  // which is exactly the shape of real history, so it looked right.
  {
    const to = new Date("2026-08-31T00:00:00Z");
    const win = (d: number) => new Date(to.getTime() - d * 86_400_000);
    const madeNineDaysAgo = new Date("2026-08-22T00:00:00Z");

    check("a window shorter than the resource bills the window",
      Math.abs(billedDays(madeNineDaysAgo, win(7), to) - 7) < 0.01,
      billedDays(madeNineDaysAgo, win(7), to));

    check("  and a window longer than it bills only its life",
      Math.abs(billedDays(madeNineDaysAgo, win(90), to) - 9) < 0.01,
      billedDays(madeNineDaysAgo, win(90), to));

    // The number the user actually saw.
    const waf90 = (5 + 1) * billedDays(madeNineDaysAgo, win(90), to) / 30;
    check("  so ninety days of WAF on a nine-day install is $1.80, not $18",
      Math.abs(waf90 - 1.80) < 0.01, waf90.toFixed(2));

    // The question asked directly: a WAF that has existed for one month, on the
    // ninety-day view, must read as the one month it was billed for.
    const madeOneMonthAgo = new Date(to.getTime() - 30 * 86_400_000);
    const wafOneMonth = (5 + 1) * billedDays(madeOneMonthAgo, win(90), to) / 30;
    check("a month-old WAF reads as $6 on the ninety-day view",
      Math.abs(wafOneMonth - 6.00) < 0.01, wafOneMonth.toFixed(2));

    // And the window still bounds it: the same ACL over a week is a week.
    const wafOneWeek = (5 + 1) * billedDays(madeOneMonthAgo, win(7), to) / 30;
    check("  and as $1.40 on the seven-day view",
      Math.abs(wafOneWeek - 1.40) < 0.01, wafOneWeek.toFixed(2));

    // Three months of a $6 charge really is $18, so the original number was not
    // wrong in form, only in claiming a life the resource had not had.
    const wafThreeMonths = (5 + 1) * billedDays(new Date(to.getTime() - 90 * 86_400_000), win(90), to) / 30;
    check("  and a genuinely three-month-old one is $18",
      Math.abs(wafThreeMonths - 18.00) < 0.01, wafThreeMonths.toFixed(2));

    check("a resource created after the window bills nothing",
      billedDays(new Date("2027-01-01"), win(30), to) === 0,
      "negative days would credit the account");

    check("  and an unknown creation date bills the whole window",
      Math.abs(billedDays(undefined, win(30), to) - 30) < 0.01,
      "guessing it is new would understate a real charge");

    const svc = fs.readFileSync("./src/services/costService.ts", "utf8");

    // Every pro-rated line, not just the one that was noticed.
    check("no charge is still pro-rated by the window",
      !/\* \(days \/ 30\)/.test(svc),
      "the same mistake was in six places, and WAF was only the loudest");

    check("  they are pro-rated by the resource's own life",
      (svc.match(/\* \(alive \/ 30\)/g) ?? []).length >= 5,
      "each fixed charge needs its own billed period");

    // WAF and alarms report no creation date, and both belong to the stack.
    check("resources that cannot say when they were made fall back to the stack",
      /const alive = billedDays\(stackAge, from, to\)/.test(svc)
      && /DescribeStacksCommand/.test(svc),
      "nothing in a stack can predate it");

    // Scaling the total by the window instead would divide nine days of use by
    // ninety and report a fifth of the real monthly rate.
    check("the monthly rate is projected per resource, not from the total",
      /lines\.reduce\(\s*\n?\s*\(a, l\) => a \+ \(l\.billedDays > 0 \? \(l\.cost \/ l\.billedDays\) \* 30 : 0\), 0\)/.test(svc),
      "a table made yesterday and one made a year ago do not share a denominator");

    const ui = fs.readFileSync("../frontend/src/components/CostPanel.tsx", "utf8");
    check("the screen explains a window longer than the install",
      /This install is \{Math\.floor\(installedDays\)\} days old/.test(ui),
      "two windows giving one answer reads as a stuck number");

    check("  and marks any line billed for less than the window",
      /billed \{Math\.max\(0, Math\.floor\(line\.billedDays\)\)\} of \{data\.days\} days/.test(ui),
      "a small number should read as new, not as cheap");
  }

  // ── nothing billable is left out ────────────────────────────────────
  //
  // WAF was missing, and it was the worst possible omission: a web ACL is five
  // dollars a month whether it inspects one request or a million, so on a quiet
  // install it is the largest line on the page. A report that silently drops
  // the biggest fixed charge is worse than no report.
  //
  // Derived from the stack rather than from a list kept here, so a resource
  // added to the infrastructure and not to the pricing is caught.
  {
    const svc = fs.readFileSync("./src/services/costService.ts", "utf8");
    const stack = fs.readFileSync("../infra/cdk-stack.ts", "utf8");

    // What the stack creates that AWS charges for, and where each is priced.
    const billable: Array<[string, RegExp, RegExp]> = [
      ["DynamoDB tables", /new dynamodb\.Table\(/, /PRICES\.dynamo\./],
      ["Lambda functions", /new NodejsFunction\(/, /PRICES\.lambda\./],
      ["log groups", /new logs\.LogGroup\(/, /PRICES\.logs\./],
      ["SQS queues", /new sqs\.Queue\(/, /PRICES\.sqs\./],
      ["the WAF", /new wafv2\.CfnWebACL\(/, /PRICES\.waf\./],
      ["API Gateway", /new apigateway\.RestApi\(/, /PRICES\.apiGateway\./],
      ["CloudWatch alarms", /new cloudwatch\.Alarm\(|\.createAlarm\(/, /PRICES\.cloudwatch\.alarmMonth/],
    ];

    for (const [what, inStack, inPrices] of billable) {
      if (!inStack.test(stack)) {
        check(`${what} are no longer created, so nothing to price`, true);
        continue;
      }
      check(`${what} are created and priced`, inPrices.test(svc),
        "the stack creates this and the report would not show it");
    }

    // The fixed charges are the ones a usage-based page hides worst: everything
    // else reads as "spend less by doing less", and these do not move.
    check("the fixed monthly charges are all priced",
      /webAclMonth: 5\.00/.test(svc) && /ruleMonth: 1\.00/.test(svc)
      && /alarmMonth: 0\.10/.test(svc) && /secret: 0\.40/.test(svc),
      "a web ACL costs the same on an idle install as a busy one");

    const ui = fs.readFileSync("../frontend/src/components/CostPanel.tsx", "utf8");
    check("  and marked on screen as fixed",
      /const FIXED: ReadonlySet<CostLine\["kind"\]> = new Set\(\["waf", "alarm", "secret"\]\)/.test(ui),
      "otherwise the page reads as if every line could be reduced by doing less");

    // Each one still has to be scoped to this app, like the rest.
    for (const [what, re] of [
      ["the WAF", /String\(acl\.Name\)\.startsWith\(`\$\{prefix\}-`\)/],
      ["API Gateway", /String\(a\.name\)\.startsWith\(`\$\{prefix\}-`\)/],
      ["SQS", /QueueNamePrefix: prefix/],
      ["alarms", /AlarmNamePrefix: prefix/],
    ] as const) {
      check(`  ${what} is still scoped to this app`, re.test(svc),
        "a new section without the prefix bills the whole account here");
    }

    // REGIONAL, because it fronts an API Gateway stage. A CLOUDFRONT-scope ACL
    // lives in us-east-1 and belongs to somebody else.
    check("the WAF is looked for at the right scope",
      /Scope: "REGIONAL"/.test(svc),
      "the wrong scope finds nothing and reports the largest line as absent");
  }

  // ── what the report itself spends ───────────────────────────────────
  {
    const svc = fs.readFileSync("./src/services/costService.ts", "utf8");

    check("the only billed call is the metrics read",
      /metricRequested: 0\.01 \/ 1_000/.test(svc),
      "$0.01 per 1,000 metrics; everything else it calls is control plane");

    // The thing somebody actually worries about when a tool offers cost
    // reporting: that it quietly stands up a pipeline to do it.
    for (const forbidden of ["client-cost-explorer", "client-athena", "client-s3", "GetCostAndUsage"]) {
      check(`  and it does not reach for ${forbidden}`,
        !new RegExp(`import[^;]*${forbidden}|new [A-Za-z]*${forbidden}`).test(svc),
        "a cost page that builds a data pipeline costs more than it reports");
    }

    check("metrics are counted as they are requested, not guessed afterwards",
      /if \(counter\) counter\.metrics \+= queries\.length;/.test(svc),
      "a section that failed asked for nothing and should not be billed for it");
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

    // It started under AWS Guardrails, which was wrong: that tab is about rules
    // over *your* resources, and this is the app's own bill, which covers both
    // halves. The webhook receiver and worker, the graph aggregator and the
    // tables they write are the GitHub side.
    const activity = fs.readFileSync("../frontend/src/pages/ActivityPage.tsx", "utf8");
    const aws = fs.readFileSync("../frontend/src/pages/AwsPage.tsx", "utf8");
    check("costs live on the tab that carries both halves",
      /\["costs", "ph-currency-dollar", "Costs"\]/.test(activity)
      && /lens === "costs" \? \(\s*\n?\s*<CostPanel \/>/.test(activity),
      "a bill for the whole app under a guardrails page reads as an AWS-only concern");

    check("  and not on the guardrails tab any more",
      !/CostPanel/.test(aws),
      "two homes for one page is one of them going stale");

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

    // A page about cost that quietly costs something is the one page that must
    // not, so what it spends is on it.
    check("the page discloses what producing it costs",
      /data\.self\.metricsRequested/.test(ui) && /data\.self\.monthlyIfHourly/.test(ui),
      "an unstated cost on a cost page is the one surprise that undermines the rest");

    check("  as a ceiling, since it is cached and cannot be asked more often",
      /monthlyIfHourly: counter\.metrics \* PRICES\.cloudwatch\.metricRequested \* 24 \* 30/
        .test(fs.readFileSync("./src/services/costService.ts", "utf8")),
      "a guess at how often somebody looks is a number nobody can check");

    check("  and names what it does not use",
      /no Cost Explorer, no\s*\n?\s*S3, no Athena/.test(ui),
      "the obvious worry is that a cost page builds a data pipeline");

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
