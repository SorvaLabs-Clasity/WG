import { awsRegion } from "../utils/region";

/**
 * What each of this app's resources has actually cost.
 *
 * ## Why this is computed rather than fetched
 *
 * Cost Explorer bills a cent a call and answers per *service*: "DynamoDB, $18".
 * It cannot say which table, because AWS does not meter cost per resource for
 * DynamoDB or Lambda at all. Resource-level attribution would mean Cost and
 * Usage Reports, an S3 bucket and Athena, which is a data pipeline to answer a
 * question this app can answer from metrics it can already read.
 *
 * So this multiplies **metered usage** by **published prices**. CloudWatch
 * knows exactly how many read units a table consumed and how many
 * gigabyte-seconds a function burned, per resource, per day.
 *
 * ## What that means for the number
 *
 * It is an estimate of list price, and it is honest about being one. It does
 * not know about the free tier, a committed-use discount, credits, or tax, so a
 * real bill is usually *lower*. What it is good at is the thing a bill is bad
 * at: saying which of your own resources is responsible.
 */

/**
 * Prices in USD, us-east-2 on-demand, August 2026.
 *
 * Kept together and dated, because a stale price does not fail, it quietly
 * reports the wrong number for ever. The region is stamped on the response so a
 * reader can tell whether these apply to them.
 */
export const PRICES = {
  region: "us-east-2",
  asOf: "2026-08",
  dynamo: {
    readUnit: 0.25 / 1_000_000,
    writeUnit: 1.25 / 1_000_000,
    storageGbMonth: 0.25,
  },
  lambda: {
    request: 0.20 / 1_000_000,
    gbSecond: 0.0000166667,
  },
  sns: {
    publish: 0.50 / 1_000_000,
    emailNotification: 2.00 / 100_000,
  },
  logs: {
    ingestGb: 0.50,
    storageGbMonth: 0.03,
  },
  secret: 0.40,
  /**
   * What asking CloudWatch costs, which is what producing this page costs.
   *
   * The only billed call in the report. Everything else it makes, listing
   * tables, functions, log groups and topics, is control plane and free.
   */
  cloudwatch: { metricRequested: 0.01 / 1_000 },
} as const;

export interface CostLine {
  /** The resource, as it is named in AWS. */
  name: string;
  kind: "table" | "function" | "topic" | "logs" | "secret";
  /** What it did, in the units the price is charged in. */
  usage: Array<{ label: string; amount: number; unit: string; cost: number }>;
  cost: number;
  /** Set when this line could not be read, so zero is not read as free. */
  error?: string;
}

export interface CostReport {
  days: number;
  /**
   * The name prefix every counted resource carries.
   *
   * Returned so the screen can say what it did and did not count, rather than
   * asking the reader to take "this app's resources" on trust in an account
   * full of somebody else's.
   */
  prefix: string;
  from: string;
  to: string;
  region: string;
  pricesAsOf: string;
  /** True when the region billed differs from the one these prices are for. */
  pricesMayNotApply: boolean;
  lines: CostLine[];
  total: number;
  /** Scaled to thirty days, which is the number people actually want. */
  monthly: number;
  /** What could not be read at all, so the total is understood as partial. */
  errors: string[];
  /**
   * What this report cost to produce, and how often it can be asked for.
   *
   * Disclosed because a page about cost that quietly costs something is the one
   * page that must not. It is the CloudWatch metrics it requested; every other
   * call it makes is control plane and free.
   */
  self: { metricsRequested: number; costPerRun: number; monthlyIfHourly: number };
}

/**
 * The name prefix every resource this app owns carries, and the boundary of
 * this whole report.
 *
 * These accounts hold other people's work. A company running this in an account
 * with two hundred of its own tables and fifty of its own functions must not
 * open a page headed "what this app costs" and be shown the department's bill,
 * so **every** listing here is filtered to this prefix before anything is
 * priced.
 *
 * That filter is the only thing separating the two, and it is written out per
 * service because each SDK offers a different way to narrow a listing. A
 * service added without one would silently attribute somebody else's spend to
 * this app, and the number would look plausible. repro-costs.ts asserts that
 * every listing in this file is filtered.
 */
const PREFIX = () => process.env.STACK_NAME || "github-control-hub";

async function cw() {
  const { CloudWatchClient, GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
  return { client: new CloudWatchClient({ region: awsRegion() }), GetMetricDataCommand };
}

/**
 * One number per metric, summed over the window.
 *
 * Asked in one call rather than one per resource: GetMetricData takes up to
 * five hundred queries at a time, and a table-by-table loop on an install with
 * a dozen tables and five functions is thirty round trips for one screen.
 */
async function sums(
  queries: Array<{ id: string; namespace: string; metric: string; dims: Record<string, string>; stat?: string }>,
  from: Date, to: Date,
  counter?: { metrics: number },
): Promise<Record<string, number>> {
  if (queries.length === 0) return {};
  if (counter) counter.metrics += queries.length;
  const { client, GetMetricDataCommand } = await cw();
  const out: Record<string, number> = {};

  // The API caps a request at 500 queries.
  for (let i = 0; i < queries.length; i += 500) {
    const batch = queries.slice(i, i + 500);
    const res: any = await client.send(new GetMetricDataCommand({
      StartTime: from,
      EndTime: to,
      ScanBy: "TimestampDescending",
      MetricDataQueries: batch.map(q => ({
        Id: q.id,
        MetricStat: {
          Metric: {
            Namespace: q.namespace,
            MetricName: q.metric,
            Dimensions: Object.entries(q.dims).map(([Name, Value]) => ({ Name, Value })),
          },
          // One datapoint for the whole window. Period must divide it, so the
          // window's own length is the right period.
          Period: Math.max(60, Math.round((to.getTime() - from.getTime()) / 1000)),
          Stat: q.stat ?? "Sum",
        },
        ReturnData: true,
      })),
    }));
    for (const r of res.MetricDataResults ?? []) {
      // Absent is genuinely zero here: CloudWatch does not publish a datapoint
      // for a metric that never happened.
      out[r.Id] = (r.Values ?? []).reduce((a: number, b: number) => a + b, 0);
    }
  }
  return out;
}

/** A safe id for GetMetricData: letters, digits and underscores, starting with a letter. */
const idFor = (prefix: string, n: number) => `${prefix}${n}`;

export async function buildCostReport(days = 30): Promise<CostReport> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const prefix = PREFIX();
  const errors: string[] = [];
  const lines: CostLine[] = [];
  // Counted as they are asked for, rather than derived from the resource count
  // afterwards: a section that failed asked for nothing and should not be
  // billed for it.
  const counter = { metrics: 0 };

  const region = (await import("../utils/region")).awsRegion() || PRICES.region;

  // ── DynamoDB ──
  try {
    const { DynamoDBClient, ListTablesCommand, DescribeTableCommand } =
      await import("@aws-sdk/client-dynamodb");
    const ddb = new DynamoDBClient({ region: awsRegion() });

    const names: string[] = [];
    let start: string | undefined;
    do {
      const page: any = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
      names.push(...(page.TableNames ?? []).filter((n: string) => n.startsWith(`${prefix}-`)));
      start = page.LastEvaluatedTableName;
    } while (start);

    const q = names.flatMap((name, i) => [
      { id: idFor("dr", i), namespace: "AWS/DynamoDB", metric: "ConsumedReadCapacityUnits", dims: { TableName: name } },
      { id: idFor("dw", i), namespace: "AWS/DynamoDB", metric: "ConsumedWriteCapacityUnits", dims: { TableName: name } },
    ]);
    const metrics = await sums(q, from, to, counter).catch(err => {
      errors.push(`DynamoDB usage could not be read: ${err?.message ?? err}`);
      return {} as Record<string, number>;
    });

    for (const [i, name] of names.entries()) {
      const reads = metrics[idFor("dr", i)] ?? 0;
      const writes = metrics[idFor("dw", i)] ?? 0;
      let bytes = 0;
      try {
        const d: any = await ddb.send(new DescribeTableCommand({ TableName: name }));
        bytes = d.Table?.TableSizeBytes ?? 0;
      } catch { /* size is a nicety; usage is the number that matters */ }

      // Storage is charged per month, so a shorter window sees its share.
      const storageGb = bytes / 1024 ** 3;
      const storage = storageGb * PRICES.dynamo.storageGbMonth * (days / 30);

      const usage = [
        { label: "Reads", amount: reads, unit: "units", cost: reads * PRICES.dynamo.readUnit },
        { label: "Writes", amount: writes, unit: "units", cost: writes * PRICES.dynamo.writeUnit },
        { label: "Storage", amount: storageGb, unit: "GB", cost: storage },
      ];
      lines.push({
        name, kind: "table", usage,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`DynamoDB could not be listed: ${err?.message ?? err}`);
  }

  // ── Lambda ──
  try {
    const { LambdaClient, ListFunctionsCommand } = await import("@aws-sdk/client-lambda");
    const lambda = new LambdaClient({ region: awsRegion() });

    const fns: Array<{ name: string; memoryMb: number }> = [];
    let marker: string | undefined;
    do {
      const page: any = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
      for (const f of page.Functions ?? []) {
        if (String(f.FunctionName).startsWith(`${prefix}-`)) {
          fns.push({ name: f.FunctionName, memoryMb: f.MemorySize ?? 128 });
        }
      }
      marker = page.NextMarker;
    } while (marker);

    const q = fns.flatMap((f, i) => [
      { id: idFor("li", i), namespace: "AWS/Lambda", metric: "Invocations", dims: { FunctionName: f.name } },
      { id: idFor("ld", i), namespace: "AWS/Lambda", metric: "Duration", dims: { FunctionName: f.name } },
    ]);
    const metrics = await sums(q, from, to, counter).catch(err => {
      errors.push(`Lambda usage could not be read: ${err?.message ?? err}`);
      return {} as Record<string, number>;
    });

    for (const [i, f] of fns.entries()) {
      const invocations = metrics[idFor("li", i)] ?? 0;
      // Duration is summed in milliseconds across every invocation.
      const ms = metrics[idFor("ld", i)] ?? 0;
      const gbSeconds = (ms / 1000) * (f.memoryMb / 1024);

      const usage = [
        { label: "Invocations", amount: invocations, unit: "calls", cost: invocations * PRICES.lambda.request },
        { label: "Compute", amount: gbSeconds, unit: "GB-sec", cost: gbSeconds * PRICES.lambda.gbSecond },
      ];
      lines.push({
        name: f.name, kind: "function", usage,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`Lambda could not be listed: ${err?.message ?? err}`);
  }

  // ── CloudWatch Logs ──
  try {
    const { CloudWatchLogsClient, DescribeLogGroupsCommand } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const logs = new CloudWatchLogsClient({ region: awsRegion() });

    const groups: Array<{ name: string; bytes: number }> = [];
    let token: string | undefined;
    do {
      const page: any = await logs.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix, nextToken: token,
      }));
      for (const g of page.logGroups ?? []) {
        groups.push({ name: g.logGroupName, bytes: g.storedBytes ?? 0 });
      }
      token = page.nextToken;
    } while (token);

    const q = groups.map((g, i) => ({
      id: idFor("lg", i), namespace: "AWS/Logs", metric: "IncomingBytes",
      dims: { LogGroupName: g.name },
    }));
    const metrics = await sums(q, from, to, counter).catch(() => ({} as Record<string, number>));

    for (const [i, g] of groups.entries()) {
      const ingestGb = (metrics[idFor("lg", i)] ?? 0) / 1024 ** 3;
      const storedGb = g.bytes / 1024 ** 3;
      const usage = [
        { label: "Ingest", amount: ingestGb, unit: "GB", cost: ingestGb * PRICES.logs.ingestGb },
        { label: "Stored", amount: storedGb, unit: "GB", cost: storedGb * PRICES.logs.storageGbMonth * (days / 30) },
      ];
      lines.push({
        name: g.name, kind: "logs", usage,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`Log groups could not be read: ${err?.message ?? err}`);
  }

  // ── SNS ──
  try {
    const { SNSClient, ListTopicsCommand } = await import("@aws-sdk/client-sns");
    const sns = new SNSClient({ region: awsRegion() });
    const arns: string[] = [];
    let token: string | undefined;
    do {
      const page: any = await sns.send(new ListTopicsCommand({ NextToken: token }));
      for (const t of page.Topics ?? []) {
        if (String(t.TopicArn).includes(`:${prefix}-notify-`)) arns.push(t.TopicArn);
      }
      token = page.NextToken;
    } while (token);

    const q = arns.map((arn, i) => ({
      id: idFor("sn", i), namespace: "AWS/SNS", metric: "NumberOfMessagesPublished",
      dims: { TopicName: arn.split(":").pop()! },
    }));
    const metrics = await sums(q, from, to, counter).catch(() => ({} as Record<string, number>));

    for (const [i, arn] of arns.entries()) {
      const published = metrics[idFor("sn", i)] ?? 0;
      const usage = [
        { label: "Published", amount: published, unit: "messages", cost: published * PRICES.sns.publish },
      ];
      lines.push({
        name: arn.split(":").pop()!, kind: "topic", usage,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`SNS topics could not be read: ${err?.message ?? err}`);
  }

  // ── Secrets Manager ──
  //
  // Priced per secret per month rather than per call, so there is no metric to
  // read: the count is the cost.
  try {
    const { SecretsManagerClient, ListSecretsCommand } =
      await import("@aws-sdk/client-secrets-manager");
    const sm = new SecretsManagerClient({ region: awsRegion() });
    const res: any = await sm.send(new ListSecretsCommand({ MaxResults: 100 }));
    for (const s of res.SecretList ?? []) {
      if (!String(s.Name).startsWith(prefix)) continue;
      lines.push({
        name: s.Name, kind: "secret",
        usage: [{ label: "Stored", amount: 1, unit: "secret", cost: PRICES.secret * (days / 30) }],
        cost: PRICES.secret * (days / 30),
      });
    }
  } catch (err: any) {
    errors.push(`Secrets could not be read: ${err?.message ?? err}`);
  }

  lines.sort((a, b) => b.cost - a.cost);
  const total = lines.reduce((a, l) => a + l.cost, 0);

  return {
    days,
    prefix,
    from: from.toISOString(),
    to: to.toISOString(),
    region,
    pricesAsOf: PRICES.asOf,
    pricesMayNotApply: region !== PRICES.region,
    lines,
    total,
    monthly: total * (30 / days),
    errors,
    self: {
      metricsRequested: counter.metrics,
      costPerRun: counter.metrics * PRICES.cloudwatch.metricRequested,
      // The ceiling, not a guess at how often somebody looks: the report is
      // cached for an hour, so this is the most it can cost however hard the
      // page is refreshed.
      monthlyIfHourly: counter.metrics * PRICES.cloudwatch.metricRequested * 24 * 30,
    },
  };
}
