import { ResourceSnapshot } from "./types";

/**
 * Reads current state from AWS and shapes it into ResourceSnapshots.
 *
 * Collectors are the only place that talks to AWS for reads. Rule kinds stay
 * pure functions over the snapshots these produce, which is what keeps the
 * catalog testable without AWS.
 *
 * Every optional lookup is wrapped: a bucket with no policy, no encryption or
 * no public-access block is an ordinary state, not an error, and AWS signals
 * each of those with a distinct exception rather than an empty response.
 */

const REGION = process.env.AWS_REGION || "us-east-1";

/** Swallow the "this is simply not configured" errors and return a fallback. */
async function optional<T>(fn: () => Promise<T>, fallback: T, notConfigured: string[]): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const code = err?.name || err?.Code || "";
    if (notConfigured.some(c => code.includes(c))) return fallback;
    throw err;
  }
}

export async function collectBuckets(only?: string[]): Promise<ResourceSnapshot[]> {
  const { S3Client, ListBucketsCommand, GetBucketPolicyCommand, GetPublicAccessBlockCommand,
          GetBucketEncryptionCommand, GetBucketVersioningCommand, GetBucketTaggingCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });

  const listed = only?.length
    ? only.map(name => ({ Name: name }))
    : (await s3.send(new ListBucketsCommand({}))).Buckets ?? [];

  const out: ResourceSnapshot[] = [];
  for (const b of listed) {
    const name = b.Name!;
    if (!name) continue;

    const policyRaw = await optional(
      async () => (await s3.send(new GetBucketPolicyCommand({ Bucket: name }))).Policy,
      undefined, ["NoSuchBucketPolicy"]);

    const pab = await optional(
      async () => (await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }))).PublicAccessBlockConfiguration,
      undefined, ["NoSuchPublicAccessBlockConfiguration"]);

    const enc = await optional(
      async () => (await s3.send(new GetBucketEncryptionCommand({ Bucket: name })))
        .ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
      undefined, ["ServerSideEncryptionConfigurationNotFoundError"]);

    const versioning = await optional(
      async () => (await s3.send(new GetBucketVersioningCommand({ Bucket: name }))).Status,
      undefined, []);

    const tagSet = await optional(
      async () => (await s3.send(new GetBucketTaggingCommand({ Bucket: name }))).TagSet,
      [], ["NoSuchTagSet"]);

    out.push({
      id: name,
      type: "s3:bucket",
      tags: Object.fromEntries((tagSet ?? []).map(t => [t.Key!, t.Value!])),
      state: {
        policy: policyRaw ? safeJson(policyRaw) : null,
        publicAccessBlock: pab ?? {},
        encryptionAlgorithm: enc,
        versioning: versioning ?? "Disabled",
      },
    });
  }
  return out;
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export async function collectLogGroups(only?: string[]): Promise<ResourceSnapshot[]> {
  const { CloudWatchLogsClient, DescribeLogGroupsCommand, ListTagsForResourceCommand } =
    await import("@aws-sdk/client-cloudwatch-logs");
  const logs = new CloudWatchLogsClient({ region: REGION });

  const groups: any[] = [];
  let nextToken: string | undefined;
  do {
    const page = await logs.send(new DescribeLogGroupsCommand({ nextToken, limit: 50 }));
    groups.push(...(page.logGroups ?? []));
    nextToken = page.nextToken;
  } while (nextToken);

  const filtered = only?.length ? groups.filter(g => only.includes(g.logGroupName)) : groups;

  const out: ResourceSnapshot[] = [];
  for (const g of filtered) {
    const tags = await optional(
      async () => (await logs.send(new ListTagsForResourceCommand({ resourceArn: stripTrailingColonStar(g.arn) }))).tags ?? {},
      {}, ["ResourceNotFoundException", "InvalidParameterException"]);
    out.push({
      id: g.logGroupName,
      type: "logs:log-group",
      tags: tags as Record<string, string>,
      // Absent retentionInDays means "never expire" — the rule relies on that.
      state: { retentionInDays: g.retentionInDays, arn: g.arn },
    });
  }
  return out;
}

/** Log group ARNs come back with a trailing ":*" that the tagging API rejects. */
function stripTrailingColonStar(arn: string | undefined): string | undefined {
  return arn?.endsWith(":*") ? arn.slice(0, -2) : arn;
}

export async function collectSecurityGroups(only?: string[]): Promise<ResourceSnapshot[]> {
  const { EC2Client, DescribeSecurityGroupsCommand } = await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region: REGION });
  const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({
    ...(only?.length ? { GroupIds: only } : {}),
  }));
  return SecurityGroups.map(sg => ({
    id: sg.GroupId!,
    type: "ec2:security-group",
    tags: Object.fromEntries((sg.Tags ?? []).map(t => [t.Key!, t.Value!])),
    state: {
      name: sg.GroupName,
      ingress: (sg.IpPermissions ?? []).map(p => ({
        fromPort: p.FromPort,
        toPort: p.ToPort,
        protocol: p.IpProtocol,
        ipRanges: (p.IpRanges ?? []).map(r => r.CidrIp!),
        ipv6Ranges: (p.Ipv6Ranges ?? []).map(r => r.CidrIpv6!),
      })),
    },
  }));
}

export async function collectInstances(only?: string[]): Promise<ResourceSnapshot[]> {
  const { EC2Client, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region: REGION });
  const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({
    ...(only?.length ? { InstanceIds: only } : {}),
  }));
  const out: ResourceSnapshot[] = [];
  for (const r of Reservations) {
    for (const i of r.Instances ?? []) {
      if (i.State?.Name === "terminated") continue;
      out.push({
        id: i.InstanceId!,
        type: "ec2:instance",
        tags: Object.fromEntries((i.Tags ?? []).map(t => [t.Key!, t.Value!])),
        state: { httpTokens: i.MetadataOptions?.HttpTokens },
      });
    }
  }
  return out;
}

export async function collectDbInstances(only?: string[]): Promise<ResourceSnapshot[]> {
  const { RDSClient, DescribeDBInstancesCommand } = await import("@aws-sdk/client-rds");
  const rds = new RDSClient({ region: REGION });
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));
  const filtered = only?.length ? DBInstances.filter(d => only.includes(d.DBInstanceIdentifier!)) : DBInstances;
  return filtered.map(d => ({
    id: d.DBInstanceIdentifier!,
    type: "rds:db-instance",
    tags: Object.fromEntries((d.TagList ?? []).map(t => [t.Key!, t.Value!])),
    state: {
      backupRetentionPeriod: d.BackupRetentionPeriod ?? 0,
      publiclyAccessible: d.PubliclyAccessible === true,
    },
  }));
}

/** Account-level singletons. Each returns exactly one snapshot. */

export async function collectEc2Account(): Promise<ResourceSnapshot[]> {
  const { EC2Client, GetEbsEncryptionByDefaultCommand } = await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region: REGION });
  const { EbsEncryptionByDefault } = await ec2.send(new GetEbsEncryptionByDefaultCommand({}));
  return [{ id: `ec2-account-${REGION}`, type: "ec2:account", tags: {}, state: { ebsEncryptionByDefault: !!EbsEncryptionByDefault } }];
}

export async function collectIamAccount(): Promise<ResourceSnapshot[]> {
  const { IAMClient, GetAccountPasswordPolicyCommand } = await import("@aws-sdk/client-iam");
  const iam = new IAMClient({ region: REGION });
  const policy = await optional(
    async () => (await iam.send(new GetAccountPasswordPolicyCommand({}))).PasswordPolicy,
    null, ["NoSuchEntity"]);
  return [{ id: "iam-account", type: "iam:account", tags: {}, state: { passwordPolicy: policy ?? null } }];
}

export async function collectCloudTrail(): Promise<ResourceSnapshot[]> {
  const { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand } = await import("@aws-sdk/client-cloudtrail");
  const ct = new CloudTrailClient({ region: REGION });
  const { trailList = [] } = await ct.send(new DescribeTrailsCommand({}));
  const trails = [];
  for (const t of trailList) {
    const isLogging = await optional(
      async () => !!(await ct.send(new GetTrailStatusCommand({ Name: t.TrailARN! }))).IsLogging,
      false, ["TrailNotFoundException"]);
    trails.push({ name: t.Name, isMultiRegion: !!t.IsMultiRegionTrail, isLogging });
  }
  return [{ id: `cloudtrail-${REGION}`, type: "cloudtrail:account", tags: {}, state: { trails } }];
}

/** Collector for a resource type, so the engine can dispatch by rule kind. */
export const COLLECTORS: Record<string, (only?: string[]) => Promise<ResourceSnapshot[]>> = {
  "s3:bucket": collectBuckets,
  "logs:log-group": collectLogGroups,
  "ec2:security-group": collectSecurityGroups,
  "ec2:instance": collectInstances,
  "rds:db-instance": collectDbInstances,
  "ec2:account": collectEc2Account,
  "iam:account": collectIamAccount,
  "cloudtrail:account": collectCloudTrail,
};
