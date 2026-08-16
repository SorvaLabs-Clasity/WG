import {
  readProvider, consoleUrl, type Provider, type Resource, type Relationship,
  type ResourceId, type Inventory, type ProviderResult,
} from "./awsInventoryService";
import { awsRegion, resolveAwsRegion } from "../utils/region";

/**
 * One provider per AWS service: what exists, and what points at what.
 *
 * Every call here is `List*` or `Describe*` — free, and read-only. The clients
 * are constructed from the default credential chain, which in the desktop
 * process is the operator's own SSO session.
 *
 * Adding a service means adding a provider and nothing else. That is the point
 * of the shape: the blast-radius assembly below never names a service.
 */

/**
 * Handed to every client, and deliberately allowed to be undefined *there*.
 *
 * Passing nothing lets the SDK resolve the region itself — environment, then
 * the signed-in profile — and a hardcoded fallback would override that chain.
 * An operator whose profile lives in eu-west-1 would otherwise be shown an
 * inventory of an empty us-east-1 with nothing failing.
 *
 * But **naming** a region and **calling with** one are different jobs, and this
 * conflated them. A console URL has to contain a region, and `awsRegion()`
 * returns undefined whenever the region comes from the profile rather than the
 * environment — which is exactly how the desktop app runs. Every console link
 * was therefore null, and every dependency rendered as plain text that looked
 * like a link and did nothing.
 *
 * It survived testing because the test scripts exported `AWS_REGION` and the
 * app does not. So the resolved value is fetched once, from the SDK, and used
 * for the naming half only.
 */
let namedRegion: string | undefined;

/**
 * Ask the SDK what region it is actually using, once per process.
 *
 * Called before an inventory is built. Cheap — the SDK answers from its own
 * resolved config without a network call — and cached, because the answer
 * cannot change without the app restarting.
 */
export async function resolveProviderRegion(): Promise<string | undefined> {
  if (namedRegion) return namedRegion;
  namedRegion = await resolveAwsRegion();
  return namedRegion;
}

/** Test seam. */
export function __setProviderRegionForTests(region: string | undefined): void {
  namedRegion = region;
}

const REGION = () => namedRegion ?? awsRegion();

/** Paginates a List call that returns a token, with a ceiling. */
async function pageAll<T>(
  fetch: (token?: string) => Promise<{ items: T[]; next?: string }>,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < 200; i++) {
    const { items, next } = await fetch(token);
    out.push(...items);
    if (!next) return out;
    token = next;
  }
  throw new Error("Listing did not finish within 200 pages");
}

const arnName = (arn: string) => arn.split(":").pop()!.split("/").pop()!;

// ── SQS ───────────────────────────────────────────────────────────────

export function sqsProvider(): Provider {
  return {
    service: "sqs",
    list: () => readProvider<Resource>("sqs", async () => {
      const { SQSClient, ListQueuesCommand } = await import("@aws-sdk/client-sqs");
      const c = new SQSClient({ region: REGION() });
      const urls = await pageAll<string>(async (NextToken) => {
        const r = await c.send(new ListQueuesCommand({ NextToken, MaxResults: 1000 }));
        return { items: r.QueueUrls ?? [], next: r.NextToken };
      });
      return urls.map(url => {
        // Read out of the URL rather than out of the environment. The URL is
        // what AWS just returned, so its region and account are right even when
        // the process never named one — and an ARN built from a guess is an ARN
        // somebody pastes into a policy that then matches nothing.
        const parts = url.split("/");
        const name = parts.pop()!;
        const account = parts.pop();
        const region = /sqs\.([a-z0-9-]+)\.amazonaws/.exec(url)?.[1];
        return {
          service: "sqs", name, region,
          arn: region && account ? `arn:aws:sqs:${region}:${account}:${name}` : undefined,
          detail: { url },
        };
      });
    }),
  };
}

// ── Lambda ────────────────────────────────────────────────────────────

export function lambdaProvider(): Provider {
  return {
    service: "lambda",
    list: () => readProvider<Resource>("lambda", async () => {
      const { LambdaClient, ListFunctionsCommand } = await import("@aws-sdk/client-lambda");
      const c = new LambdaClient({ region: REGION() });
      const fns = await pageAll<any>(async (Marker) => {
        const r = await c.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }));
        return { items: r.Functions ?? [], next: r.NextMarker };
      });
      return fns.map(f => ({
        service: "lambda",
        name: f.FunctionName,
        arn: f.FunctionArn,
        region: REGION(),
        detail: {
          runtime: f.Runtime, memory: f.MemorySize, timeout: f.Timeout,
          role: f.Role, lastModified: f.LastModified,
          // Kept because it is the single richest source of cross-resource
          // references: table names, queue URLs and bucket names all live here.
          env: f.Environment?.Variables ?? {},
        },
      }));
    }),

    /**
     * Lambdas that would break if `target` disappeared.
     *
     * Three separate ways a function can depend on something, and each finds
     * references the others miss:
     *
     *   - an **event source mapping** — the queue or stream it is triggered by
     *   - an **environment variable** — how nearly every function names the
     *     table or bucket it writes to
     *   - its **execution role**, when the target is that role
     */
    referencesTo: (target, inventory) => readProvider<Relationship>("lambda", async () => {
      const fns = inventory.byService.get("lambda");
      if (!fns?.ok) return [];

      const out: Relationship[] = [];
      const id = (f: Resource): ResourceId =>
        ({ service: "lambda", name: f.name, arn: f.arn, region: f.region });
      const link = (f: Resource) => consoleUrl(id(f), f.detail);

      // Environment variables and role, from what was already listed.
      for (const f of fns.items) {
        const env = (f.detail?.env ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(env)) {
          if (typeof v !== "string") continue;
          if (matchesTarget(v, target)) {
            out.push({
              from: id(f), fromUrl: link(f), to: target, kind: "env-var",
              // The variable's name *and* what it is set to, trimmed. "an
              // environment variable references this" sends somebody to read
              // the function's configuration; naming it does not.
              detail: `${k} = ${v.length > 60 ? v.slice(0, 57) + "…" : v}`,
            });
          }
        }
        const role = String(f.detail?.role ?? "");
        if (role && matchesTarget(role, target)) {
          out.push({
            from: id(f), fromUrl: link(f), to: target,
            kind: "execution-role", detail: "runs as this role",
          });
        }
      }

      // Event source mappings, which need one call and are the strongest signal
      // there is: a mapping means the function is actively consuming.
      const { LambdaClient, ListEventSourceMappingsCommand } = await import("@aws-sdk/client-lambda");
      const c = new LambdaClient({ region: REGION() });
      const mappings = await pageAll<any>(async (Marker) => {
        const r = await c.send(new ListEventSourceMappingsCommand({ Marker, MaxItems: 100 }));
        return { items: r.EventSourceMappings ?? [], next: r.NextMarker };
      });
      for (const m of mappings) {
        if (!m.EventSourceArn || !matchesTarget(m.EventSourceArn, target)) continue;
        const fnName = m.FunctionArn ? arnName(m.FunctionArn) : "unknown";
        const consumer = { service: "lambda", name: fnName, arn: m.FunctionArn, region: REGION() };
        out.push({
          from: consumer,
          fromUrl: consoleUrl(consumer),
          to: target,
          kind: "event-source",
          detail: m.State === "Enabled"
            ? "consumes messages from this (enabled)"
            : `consumes messages from this (${m.State ?? "unknown state"})`,
        });
      }
      return out;
    }),
  };
}

// ── S3 ────────────────────────────────────────────────────────────────

export function s3Provider(): Provider {
  return {
    service: "s3",
    list: () => readProvider<Resource>("s3", async () => {
      const { S3Client, ListBucketsCommand } = await import("@aws-sdk/client-s3");
      const c = new S3Client({ region: REGION() });
      const r = await c.send(new ListBucketsCommand({}));
      return (r.Buckets ?? []).map(b => ({
        service: "s3", name: b.Name!, arn: `arn:aws:s3:::${b.Name}`,
        detail: { created: b.CreationDate?.toISOString() },
      }));
    }),
  };
}

// ── DynamoDB ──────────────────────────────────────────────────────────

export function dynamoProvider(): Provider {
  return {
    service: "dynamodb",
    list: () => readProvider<Resource>("dynamodb", async () => {
      const { DynamoDBClient, ListTablesCommand } = await import("@aws-sdk/client-dynamodb");
      const c = new DynamoDBClient({ region: REGION() });
      const names = await pageAll<string>(async (ExclusiveStartTableName) => {
        const r = await c.send(new ListTablesCommand({ ExclusiveStartTableName, Limit: 100 }));
        return { items: r.TableNames ?? [], next: r.LastEvaluatedTableName };
      });
      return names.map(n => ({ service: "dynamodb", name: n, region: REGION() }));
    }),
  };
}

// ── IAM ───────────────────────────────────────────────────────────────

export function iamProvider(): Provider {
  return {
    service: "iam",
    list: () => readProvider<Resource>("iam", async () => {
      const { IAMClient, ListRolesCommand } = await import("@aws-sdk/client-iam");
      const c = new IAMClient({ region: REGION() });
      const roles = await pageAll<any>(async (Marker) => {
        const r = await c.send(new ListRolesCommand({ Marker, MaxItems: 100 }));
        return { items: r.Roles ?? [], next: r.IsTruncated ? r.Marker : undefined };
      });
      return roles.map(r => ({
        service: "iam", name: r.RoleName, arn: r.Arn,
        detail: { created: r.CreateDate?.toISOString?.() },
      }));
    }),
  };
}

// ── EC2 security groups ───────────────────────────────────────────────

export function securityGroupProvider(): Provider {
  return {
    service: "ec2-sg",
    list: () => readProvider<Resource>("ec2-sg", async () => {
      const { EC2Client, DescribeSecurityGroupsCommand } = await import("@aws-sdk/client-ec2");
      const c = new EC2Client({ region: REGION() });
      const groups = await pageAll<any>(async (NextToken) => {
        const r = await c.send(new DescribeSecurityGroupsCommand({ NextToken, MaxResults: 200 }));
        return { items: r.SecurityGroups ?? [], next: r.NextToken };
      });
      return groups.map(g => ({
        service: "ec2-sg",
        name: g.GroupName,
        region: REGION(),
        detail: {
          groupId: g.GroupId,
          vpcId: g.VpcId,
          description: g.Description,
          // Kept in a shape drift comparison can use directly, rather than the
          // SDK's nested form.
          ingress: (g.IpPermissions ?? []).map((p: any) => ({
            protocol: p.IpProtocol,
            from: p.FromPort, to: p.ToPort,
            cidrs: (p.IpRanges ?? []).map((r: any) => r.CidrIp),
          })),
        },
      }));
    }),
  };
}

// ── CloudWatch log groups ─────────────────────────────────────────────

export function logGroupProvider(): Provider {
  return {
    service: "logs",
    list: () => readProvider<Resource>("logs", async () => {
      const { CloudWatchLogsClient, DescribeLogGroupsCommand } =
        await import("@aws-sdk/client-cloudwatch-logs");
      const c = new CloudWatchLogsClient({ region: REGION() });
      const groups = await pageAll<any>(async (nextToken) => {
        const r = await c.send(new DescribeLogGroupsCommand({ nextToken, limit: 50 }));
        return { items: r.logGroups ?? [], next: r.nextToken };
      });
      return groups.map(g => ({
        service: "logs", name: g.logGroupName, arn: g.arn, region: REGION(),
        detail: { retentionDays: g.retentionInDays ?? null, bytes: g.storedBytes },
      }));
    }),
  };
}

// ── RDS ───────────────────────────────────────────────────────────────

export function rdsProvider(): Provider {
  return {
    service: "rds",
    list: () => readProvider<Resource>("rds", async () => {
      const { RDSClient, DescribeDBInstancesCommand } = await import("@aws-sdk/client-rds");
      const c = new RDSClient({ region: REGION() });
      const dbs = await pageAll<any>(async (Marker) => {
        const r = await c.send(new DescribeDBInstancesCommand({ Marker, MaxRecords: 100 }));
        return { items: r.DBInstances ?? [], next: r.Marker };
      });
      return dbs.map(d => ({
        service: "rds", name: d.DBInstanceIdentifier, arn: d.DBInstanceArn, region: REGION(),
        detail: {
          engine: d.Engine, class: d.DBInstanceClass, status: d.DBInstanceStatus,
          securityGroups: (d.VpcSecurityGroups ?? []).map((g: any) => g.VpcSecurityGroupId),
        },
      }));
    }),

    /** A database sitting behind the security group being asked about. */
    referencesTo: (target, inventory) => readProvider<Relationship>("rds", async () => {
      const dbs = inventory.byService.get("rds");
      if (!dbs?.ok || target.service !== "ec2-sg") return [];
      const groupId = String(
        inventory.all.find(r => r.service === "ec2-sg" && r.name === target.name)
          ?.detail?.groupId ?? "");
      if (!groupId) return [];

      return dbs.items
        .filter(d => ((d.detail?.securityGroups ?? []) as string[]).includes(groupId))
        .map(d => ({
          from: { service: "rds", name: d.name, arn: d.arn, region: d.region },
          fromUrl: consoleUrl({ service: "rds", name: d.name, region: d.region }),
          to: target,
          kind: "security-group",
          detail: "network access is governed by this group",
        }));
    }),
  };
}

/**
 * Whether a string names the target.
 *
 * Compared against the ARN *and* the bare name because the same resource is
 * written both ways in different places — an IAM policy names the ARN, a Lambda
 * environment variable usually names the queue URL or the plain table name, and
 * matching only one form finds a fraction of the references.
 *
 * The name comparison requires a whole-token match. Substring matching here
 * would make `orders` match `orders-archive-dlq`, and a blast radius that
 * over-reports is one nobody reads.
 */
export function matchesTarget(value: string, target: ResourceId): boolean {
  const v = value.trim();
  if (!v) return false;
  if (target.arn && v.toLowerCase().includes(target.arn.toLowerCase())) return true;

  const name = target.name.toLowerCase();
  return v
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .some(tok => tok === name || tok.split("/").pop() === name);
}

/** Everything readable with the credentials the desktop process already has. */
export function defaultProviders(): Provider[] {
  return [
    sqsProvider(),
    lambdaProvider(),
    s3Provider(),
    dynamoProvider(),
    iamProvider(),
    securityGroupProvider(),
    logGroupProvider(),
    rdsProvider(),
  ];
}

/** Which of `providers` can say something about `target`. */
export async function relationshipsTo(
  target: ResourceId, inventory: Inventory, providers: Provider[],
): Promise<ProviderResult<Relationship>[]> {
  return Promise.all(
    providers.filter(p => p.referencesTo).map(p => p.referencesTo!(target, inventory)),
  );
}
