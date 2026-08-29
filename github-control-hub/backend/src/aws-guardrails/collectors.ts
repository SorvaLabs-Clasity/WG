import { ResourceSnapshot, Scope, Collection } from "./types";

/**
 * Reads current state from AWS and shapes it into ResourceSnapshots.
 *
 * Collectors are the only place that talks to AWS for reads. Rule kinds stay
 * pure functions over the snapshots these produce, which is what keeps the
 * catalog testable without AWS.
 *
 * Every collector takes the account and region to look in rather than reading
 * the environment. That argument is the whole of multi-account support: with a
 * hidden default, one of these would eventually be called for "prod" and answer
 * about the account the app happens to be deployed in.
 *
 * Every optional lookup is wrapped: a bucket with no policy, no encryption or
 * no public-access block is an ordinary state, not an error, and AWS signals
 * each of those with a distinct exception rather than an empty response.
 */

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

/** Client options carrying the scope's credentials, or none for the home account. */
function clientConfig(scope: Scope) {
  return { region: scope.region, ...(scope.credentials && { credentials: scope.credentials }) };
}

export async function collectBuckets(scope: Scope, only?: string[]): Promise<Collection> {
  const { S3Client, ListBucketsCommand, GetBucketPolicyCommand, GetBucketTaggingCommand } =
    await import("@aws-sdk/client-s3");
  const s3 = new S3Client(clientConfig(scope));

  const listed = only?.length
    ? only.map(name => ({ Name: name, BucketRegion: scope.region }))
    : await listEveryBucket(s3, ListBucketsCommand);

  const out: ResourceSnapshot[] = [];
  const elsewhere = new Map<string, number>();

  for (const b of listed) {
    const name = b.Name!;
    if (!name) continue;

    // ListBuckets is global: every bucket in the account comes back whatever
    // region was asked for. Without this filter a two-region account would
    // report every bucket twice and remediate each of them twice, and reading
    // a bucket from the wrong region's endpoint fails outright with a redirect.
    // Genuinely absent only for very old us-east-1 buckets, whose location
    // constraint AWS has always returned as null. Every other bucket carries
    // its region now that the listing asks for one, so this is a real fallback
    // rather than the answer for the whole account.
    const home = b.BucketRegion || "us-east-1";
    if (home !== scope.region) {
      // Counted rather than dropped. A bucket in a region nobody added to the
      // account is invisible, and an invisible bucket reads on screen exactly
      // like a compliant one.
      elsewhere.set(home, (elsewhere.get(home) ?? 0) + 1);
      continue;
    }

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
  return {
    resources: out,
    unswept: [...elsewhere].map(([region, count]) => ({ region, count })),
  };
}

/**
 * Every bucket in the account, each carrying the region it actually lives in.
 *
 * `ListBuckets({})` does not do this, and the way it fails is silent. AWS
 * documents `BucketRegion` as returned only "if the request contains at least
 * one valid parameter", an empty request has none, so the field comes back
 * undefined on every bucket. The caller's `b.BucketRegion || "us-east-1"` then
 * decides that the entire account lives in us-east-1: a sweep of any other
 * region scans nothing and reports every bucket as unswept *in us-east-1*, and
 * a sweep of us-east-1 tries to read buckets that are somewhere else.
 *
 * `MaxBuckets` is that one valid parameter. It also turns the call into a paged
 * one, which the empty version was not: an account past the page size would
 * have silently lost its tail.
 */
async function listEveryBucket(s3: any, ListBucketsCommand: any): Promise<any[]> {
  const buckets: any[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListBucketsCommand({
      MaxBuckets: 1000,
      ...(token ? { ContinuationToken: token } : {}),
    }));
    buckets.push(...(page.Buckets ?? []));
    token = page.ContinuationToken;
    // A page that returns nothing but keeps handing back a token would spin
    // forever against a paid API.
    if (!page.Buckets?.length) break;
  } while (token);
  return buckets;
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export async function collectLogGroups(scope: Scope, only?: string[]): Promise<Collection> {
  const { CloudWatchLogsClient, DescribeLogGroupsCommand, ListTagsForResourceCommand } =
    await import("@aws-sdk/client-cloudwatch-logs");
  const logs = new CloudWatchLogsClient(clientConfig(scope));

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
      // Absent retentionInDays means "never expire", the rule relies on that.
      state: { retentionInDays: g.retentionInDays, arn: g.arn },
    });
  }
  // Log groups are genuinely per-region: asking in one region cannot see
  // another's, so there is nothing here that was skipped.
  return { resources: out };
}

/** Log group ARNs come back with a trailing ":*" that the tagging API rejects. */
function stripTrailingColonStar(arn: string | undefined): string | undefined {
  return arn?.endsWith(":*") ? arn.slice(0, -2) : arn;
}

/** Collector for a resource type, so the engine can dispatch by rule kind. */
export const COLLECTORS: Record<string, (scope: Scope, only?: string[]) => Promise<Collection>> = {
  "s3:bucket": collectBuckets,
  "logs:log-group": collectLogGroups,
};
