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
  cloudwatch: {
    metricRequested: 0.01 / 1_000,
    /** Per alarm per month, whether or not it ever fires. */
    alarmMonth: 0.10,
  },
  /**
   * WAF is the one resource here with a real fixed charge, and it is the
   * largest single line on a quiet install: a web ACL costs the same whether it
   * inspects one request a day or a million.
   *
   * **These monthly rates are pro-rated hourly by AWS**, which is what makes
   * charging them for the days a resource has existed correct rather than
   * merely reasonable. A web ACL a month old is billed $5, one nine days old is
   * billed $1.50, and this reports the same. If AWS ever charged a whole month
   * for a partial one, every figure here would understate instead.
   *
   * The same is true of the alarm and secret rates above and below.
   */
  waf: { webAclMonth: 5.00, ruleMonth: 1.00, millionRequests: 0.60 },
  /** REST API, which is what this uses: HTTP APIs cannot carry a resource policy. */
  apiGateway: { millionRequests: 3.50 },
  sqs: { millionRequests: 0.40 },
} as const;

/**
 * How much of the asked-for window a resource actually existed for.
 *
 * Fixed charges are pro-rated by the resource's own life, not by the length of
 * the window: ninety days of WAF on a nine-day-old install is $18 of a $1.80
 * charge, and it grows the further back you look, so it reads as history.
 *
 * Usage-based lines need none of this, since CloudWatch has no datapoints from
 * before a resource existed.
 *
 * An unknown creation date falls back to the CloudFormation stack, which
 * nothing in it can predate.
 */
export function billedDays(
  createdAt: Date | undefined, from: Date, to: Date,
): number {
  const started = createdAt && createdAt > from ? createdAt : from;
  const ms = to.getTime() - started.getTime();
  // A resource created after the window closed bills nothing, which is not the
  // same as a resource that has existed for zero time.
  return Math.max(0, ms / 86_400_000);
}

/**
 * When this install was made, as the floor for anything that cannot say.
 *
 * WAF and CloudWatch alarms report no creation date, and both belong to the
 * stack, so the stack's own age bounds theirs.
 */
async function installedAt(prefix: string): Promise<Date | undefined> {
  try {
    const { CloudFormationClient, DescribeStacksCommand } =
      await import("@aws-sdk/client-cloudformation");
    const cfn = new CloudFormationClient({ region: awsRegion() });
    // The stack name is the construct id, not the prefix, so both are tried.
    for (const name of ["GitHubControlHub", prefix]) {
      try {
        const res: any = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        const t = res.Stacks?.[0]?.CreationTime;
        if (t) return new Date(t);
      } catch { /* try the other name */ }
    }
  } catch { /* no permission, or no stack: the window stands */ }
  return undefined;
}

export interface CostLine {
  /** The resource, as it is named in AWS. */
  name: string;
  kind: "table" | "function" | "topic" | "logs" | "secret" | "waf" | "api" | "queue" | "alarm";
  /** What it did, in the units the price is charged in. */
  usage: Array<{ label: string; amount: number; unit: string; cost: number }>;
  cost: number;
  /**
   * Days of the window this resource actually existed for.
   *
   * Shown when it is shorter than the window asked about, so a small number is
   * read as "new" rather than as "cheap".
   */
  billedDays: number;
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
  /**
   * Scaled to thirty days, which is the number people actually want.
   *
   * Per line, from that resource's own billed period, then summed. Scaling the
   * total by the window instead understates a young install: nine days of use
   * over a ninety-day window would be divided by ninety rather than by nine.
   */
  monthly: number;
  /**
   * When this install was made, when it could be read.
   *
   * Shown so that a window longer than the install explains itself, rather than
   * leaving somebody to wonder why ninety days and thirty days give the same
   * answer.
   */
  installedAt?: string;
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

  // Read once, before anything is priced: two sections need it and it is a
  // single call.
  const stackAge = await installedAt(prefix);

  const region = (await import("../utils/region")).awsRegion() || PRICES.region;

  // ── DynamoDB ──
  const dynamoSection = async () => {
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

    /**
     * Sizes fetched together, not one after another.
     *
     * DescribeTable is a round trip per table, and awaiting it inside the loop
     * made a dozen tables a dozen sequential waits before the page could
     * render anything. They do not depend on each other.
     */
    const described = await Promise.all(names.map(async name => {
      try {
        const d: any = await ddb.send(new DescribeTableCommand({ TableName: name }));
        return {
          bytes: d.Table?.TableSizeBytes ?? 0,
          created: d.Table?.CreationDateTime ? new Date(d.Table.CreationDateTime) : undefined,
        };
      } catch {
        // Size is a nicety; usage is the number that matters, so a table that
        // will not describe still gets its reads and writes priced.
        return { bytes: 0, created: undefined };
      }
    }));

    for (const [i, name] of names.entries()) {
      const reads = metrics[idFor("dr", i)] ?? 0;
      const writes = metrics[idFor("dw", i)] ?? 0;
      const bytes = described[i]?.bytes ?? 0;
      const alive = billedDays(described[i]?.created ?? stackAge, from, to);

      // Storage is charged per month, so a shorter window sees its share.
      const storageGb = bytes / 1024 ** 3;
      // The table's own life in the window, not the window: storage on a table
      // created last week is not a month of storage.
      const storage = storageGb * PRICES.dynamo.storageGbMonth * (alive / 30);

      const usage = [
        { label: "Reads", amount: reads, unit: "units", cost: reads * PRICES.dynamo.readUnit },
        { label: "Writes", amount: writes, unit: "units", cost: writes * PRICES.dynamo.writeUnit },
        { label: "Storage", amount: storageGb, unit: "GB", cost: storage },
      ];
      lines.push({
        name, kind: "table", usage, billedDays: alive,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`DynamoDB could not be listed: ${err?.message ?? err}`);
  }

  };

  // ── Lambda ──
  const lambdaSection = async () => {
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
        name: f.name, kind: "function", usage, billedDays: days,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`Lambda could not be listed: ${err?.message ?? err}`);
  }

  };

  // ── CloudWatch Logs ──
  const logsSection = async () => {
  try {
    const { CloudWatchLogsClient, DescribeLogGroupsCommand } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const logs = new CloudWatchLogsClient({ region: awsRegion() });

    const groups: Array<{ name: string; bytes: number; created?: Date }> = [];
    let token: string | undefined;
    do {
      const page: any = await logs.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix, nextToken: token,
      }));
      for (const g of page.logGroups ?? []) {
        groups.push({
          name: g.logGroupName, bytes: g.storedBytes ?? 0,
          created: g.creationTime ? new Date(g.creationTime) : undefined,
        });
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
      const alive = billedDays(g.created ?? stackAge, from, to);
      const usage = [
        { label: "Ingest", amount: ingestGb, unit: "GB", cost: ingestGb * PRICES.logs.ingestGb },
        { label: "Stored", amount: storedGb, unit: "GB", cost: storedGb * PRICES.logs.storageGbMonth * (alive / 30) },
      ];
      lines.push({
        name: g.name, kind: "logs", usage, billedDays: alive,
        cost: usage.reduce((a, u) => a + u.cost, 0),
      });
    }
  } catch (err: any) {
    errors.push(`Log groups could not be read: ${err?.message ?? err}`);
  }

  };

  // ── SNS ──
  const snsSection = async () => {
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
        name: arn.split(":").pop()!, kind: "topic", usage, billedDays: days,
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
  };

  const secretsSection = async () => {
  try {
    const { SecretsManagerClient, ListSecretsCommand } =
      await import("@aws-sdk/client-secrets-manager");
    const sm = new SecretsManagerClient({ region: awsRegion() });
    const res: any = await sm.send(new ListSecretsCommand({ MaxResults: 100 }));
    for (const s of res.SecretList ?? []) {
      if (!String(s.Name).startsWith(prefix)) continue;
      const alive = billedDays(s.CreatedDate ? new Date(s.CreatedDate) : stackAge, from, to);
      const cost = PRICES.secret * (alive / 30);
      lines.push({
        name: s.Name, kind: "secret", billedDays: alive,
        usage: [{ label: "Stored", amount: 1, unit: "secret", cost }],
        cost,
      });
    }
  } catch (err: any) {
    errors.push(`Secrets could not be read: ${err?.message ?? err}`);
  }

  };

  // ── WAF ──
  //
  // The one resource here with a charge that does not depend on use: a web ACL
  // is five dollars a month whether it inspects one request or a million, and
  // each rule is another. On a quiet install it is the largest line on the
  // page, which is exactly why leaving it out was the worst omission.
  const wafSection = async () => {
    try {
      const { WAFV2Client, ListWebACLsCommand, GetWebACLCommand } =
        await import("@aws-sdk/client-wafv2");
      const waf = new WAFV2Client({ region: awsRegion() });

      // REGIONAL, because it protects an API Gateway stage rather than
      // CloudFront. A CLOUDFRONT-scope ACL lives in us-east-1 and is not ours.
      const list: any = await waf.send(new ListWebACLsCommand({ Scope: "REGIONAL" }));
      for (const acl of list.WebACLs ?? []) {
        if (!String(acl.Name).startsWith(`${prefix}-`)) continue;

        let rules = 0;
        try {
          const got: any = await waf.send(new GetWebACLCommand({
            Name: acl.Name, Id: acl.Id, Scope: "REGIONAL",
          }));
          rules = (got.WebACL?.Rules ?? []).length;
        } catch { /* the ACL still costs its base charge without the rule count */ }

        const requests = (await sums([{
          id: "waf0", namespace: "AWS/WAFV2", metric: "AllowedRequests",
          dims: { WebACL: acl.Name, Rule: "ALL", Region: awsRegion() ?? PRICES.region },
        }], from, to, counter).catch(() => ({} as Record<string, number>)))["waf0"] ?? 0;

        // WAF reports no creation date, so the stack it belongs to bounds its
        // age. This is the line the bug was worst on: a fixed five dollars a
        // month, pro-rated over a window the resource had not existed for.
        const alive = billedDays(stackAge, from, to);
        const usage = [
          { label: "Web ACL", amount: 1, unit: "ACL", cost: PRICES.waf.webAclMonth * (alive / 30) },
          { label: "Rules", amount: rules, unit: "rules", cost: rules * PRICES.waf.ruleMonth * (alive / 30) },
          { label: "Requests", amount: requests, unit: "requests", cost: (requests / 1_000_000) * PRICES.waf.millionRequests },
        ];
        lines.push({
          name: acl.Name, kind: "waf", usage, billedDays: alive,
          cost: usage.reduce((a, u) => a + u.cost, 0),
        });
      }
    } catch (err: any) {
      errors.push(`WAF could not be read: ${err?.message ?? err}`);
    }
  };

  // ── API Gateway ──
  const apiSection = async () => {
    try {
      const { APIGatewayClient, GetRestApisCommand } = await import("@aws-sdk/client-api-gateway");
      const api = new APIGatewayClient({ region: awsRegion() });
      const res: any = await api.send(new GetRestApisCommand({ limit: 500 }));
      const ours = (res.items ?? []).filter((a: any) => String(a.name).startsWith(`${prefix}-`));

      const metrics = await sums(ours.map((a: any, i: number) => ({
        id: idFor("ag", i), namespace: "AWS/ApiGateway", metric: "Count",
        dims: { ApiName: a.name },
      })), from, to, counter).catch(() => ({} as Record<string, number>));

      for (const [i, a] of ours.entries()) {
        const calls = metrics[idFor("ag", i)] ?? 0;
        const usage = [{
          label: "Requests", amount: calls, unit: "requests",
          cost: (calls / 1_000_000) * PRICES.apiGateway.millionRequests,
        }];
        lines.push({
          name: a.name, kind: "api", usage, cost: usage[0].cost,
          billedDays: billedDays(a.createdDate ? new Date(a.createdDate) : stackAge, from, to),
        });
      }
    } catch (err: any) {
      errors.push(`API Gateway could not be read: ${err?.message ?? err}`);
    }
  };

  // ── SQS ──
  const sqsSection = async () => {
    try {
      const { SQSClient, ListQueuesCommand } = await import("@aws-sdk/client-sqs");
      const sqs = new SQSClient({ region: awsRegion() });
      const res: any = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
      const names = (res.QueueUrls ?? []).map((u: string) => u.split("/").pop()!);

      // Sent and received are billed the same, and a queue with a worker on it
      // is charged for both halves of every message.
      const q = names.flatMap((n: string, i: number) => [
        { id: idFor("qs", i), namespace: "AWS/SQS", metric: "NumberOfMessagesSent", dims: { QueueName: n } },
        { id: idFor("qr", i), namespace: "AWS/SQS", metric: "NumberOfMessagesReceived", dims: { QueueName: n } },
      ]);
      const metrics = await sums(q, from, to, counter).catch(() => ({} as Record<string, number>));

      for (const [i, n] of names.entries()) {
        const requests = (metrics[idFor("qs", i)] ?? 0) + (metrics[idFor("qr", i)] ?? 0);
        const usage = [{
          label: "Requests", amount: requests, unit: "requests",
          cost: (requests / 1_000_000) * PRICES.sqs.millionRequests,
        }];
        lines.push({ name: n, kind: "queue", usage, cost: usage[0].cost, billedDays: days });
      }
    } catch (err: any) {
      errors.push(`SQS queues could not be read: ${err?.message ?? err}`);
    }
  };

  // ── CloudWatch alarms ──
  //
  // Ten cents each per month, fires or not. Small, and the sort of thing that
  // is only small until somebody adds forty of them.
  const alarmSection = async () => {
    try {
      const { CloudWatchClient, DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
      const client = new CloudWatchClient({ region: awsRegion() });
      let token: string | undefined;
      const names: string[] = [];
      do {
        const page: any = await client.send(new DescribeAlarmsCommand({
          AlarmNamePrefix: prefix, NextToken: token,
        }));
        for (const a of page.MetricAlarms ?? []) names.push(a.AlarmName);
        token = page.NextToken;
      } while (token);

      // An alarm reports only when it was last *configured*, which is not when
      // it was created, so the stack bounds these too.
      const alive = billedDays(stackAge, from, to);
      for (const name of names) {
        const cost = PRICES.cloudwatch.alarmMonth * (alive / 30);
        lines.push({
          name, kind: "alarm", billedDays: alive,
          usage: [{ label: "Standing charge", amount: 1, unit: "alarm", cost }],
          cost,
        });
      }
    } catch (err: any) {
      errors.push(`CloudWatch alarms could not be read: ${err?.message ?? err}`);
    }
  };

  /**
   * All of them run together, because none needs another's answer.
   *
   * In turn, this was a round trip of listing per service before the first number
   * appeared, and the page sat empty for the length of all of them. They push
   * into the same two arrays, which is safe here: JavaScript runs one of them
   * at a time, and the order of the lines is decided by the sort below rather
   * than by which listing came back first.
   *
   * Each already catches its own failures, so `all` cannot reject and one
   * missing permission still leaves the other four on screen.
   */
  await Promise.all([
    dynamoSection(), lambdaSection(), logsSection(), snsSection(), secretsSection(),
    wafSection(), apiSection(), sqsSection(), alarmSection(),
  ]);

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
    // Per resource, from its own life, then summed. A table created yesterday
    // and a table created a year ago do not share a denominator.
    monthly: lines.reduce(
      (a, l) => a + (l.billedDays > 0 ? (l.cost / l.billedDays) * 30 : 0), 0),
    installedAt: stackAge?.toISOString(),
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
