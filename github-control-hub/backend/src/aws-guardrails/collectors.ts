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
          GetBucketTaggingCommand } = await import("@aws-sdk/client-s3");
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




    const tagSet = await optional(
      async () => (await s3.send(new GetBucketTaggingCommand({ Bucket: name }))).TagSet,
      [], ["NoSuchTagSet"]);



    out.push({
      id: name,
      type: "s3:bucket",
      tags: Object.fromEntries((tagSet ?? []).map(t => [t.Key!, t.Value!])),
      state: {
        policy: policyRaw ? safeJson(policyRaw) : null,
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




/** Account-level singletons. Each returns exactly one snapshot. */




/** Collector for a resource type, so the engine can dispatch by rule kind. */
export const COLLECTORS: Record<string, (only?: string[]) => Promise<ResourceSnapshot[]>> = {
  "s3:bucket": collectBuckets,
  "logs:log-group": collectLogGroups,
};
