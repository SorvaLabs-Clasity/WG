import { GuardrailKind, ResourceSnapshot, Scope } from "./types";
import { httpsOnlyStatement } from "./catalog";
import { snapRetention } from "./types";

/**
 * The only code in the engine that writes to AWS.
 *
 * Each remediator returns an undo payload describing how to put the resource
 * back, which is stored on the activity entry so the existing undo works.
 *
 * Kinds absent from this map are report-only by construction: revoking a
 * security group rule or flipping an RDS instance private can cut live access,
 * so those are surfaced for a human rather than fixed automatically.
 *
 * Each takes the scope it is writing in. Reading the region from the
 * environment here would mean a fix computed against prod being applied in
 * whichever account the app runs in — the one failure mode of multi-account
 * enforcement that cannot be walked back.
 */

/** Client options carrying the scope's credentials, or none for the home account. */
function clientConfig(scope: Scope) {
  return { region: scope.region, ...(scope.credentials && { credentials: scope.credentials }) };
}

export interface RemediationResult {
  changed: boolean;
  description: string;
  undo?: { action: string; params: Record<string, any> };
}

type Remediator = (resource: ResourceSnapshot, params: Record<string, any>, scope: Scope) => Promise<RemediationResult>;

const remediators: Partial<Record<GuardrailKind, Remediator>> = {
  async s3_https_only(resource, params, scope) {
    const { S3Client, PutBucketPolicyCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client(clientConfig(scope));
    const sid = params.sid || "EnforceHTTPSOnly";

    const existing = resource.state.policy as { Version?: string; Statement?: any[] } | null;
    const kept = (existing?.Statement ?? []).filter(s => s?.Sid !== sid);
    // Merge by Sid rather than replacing the document: an unrelated statement
    // removed here could silently cut off legitimate access.
    const next = {
      Version: existing?.Version ?? "2012-10-17",
      Statement: [...kept, httpsOnlyStatement(resource.id, sid)],
    };

    await s3.send(new PutBucketPolicyCommand({ Bucket: resource.id, Policy: JSON.stringify(next) }));
    return {
      changed: true,
      description: `Added "${sid}" to the bucket policy of ${resource.id}`,
      undo: {
        action: "s3_restore_bucket_policy",
        // null means there was no policy, and undo should delete rather than restore.
        // The account and region ride along: a bucket name alone does not say
        // where to put the policy back.
        params: {
          bucket: resource.id, policy: existing ? JSON.stringify(existing) : null,
          accountId: scope.accountId, region: scope.region,
        },
      },
    };
  },

  async log_retention_min(resource, params, scope) {
    const { CloudWatchLogsClient, PutRetentionPolicyCommand, DeleteRetentionPolicyCommand } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const logs = new CloudWatchLogsClient(clientConfig(scope));
    // CloudWatch rejects arbitrary retention values, so round up to one it takes.
    const target = snapRetention(params.setToDays ?? params.minDays ?? 365);
    const previous: number | undefined = resource.state.retentionInDays;

    await logs.send(new PutRetentionPolicyCommand({ logGroupName: resource.id, retentionInDays: target }));
    void DeleteRetentionPolicyCommand; // referenced by the undo action below
    return {
      changed: true,
      description: `Set retention on ${resource.id} to ${target} days (was ${previous ?? "never expire"})`,
      undo: {
        action: "logs_restore_retention",
        params: {
          logGroup: resource.id, retentionInDays: previous ?? null,
          accountId: scope.accountId, region: scope.region,
        },
      },
    };
  },
};

export function canRemediate(kind: GuardrailKind): boolean {
  return !!remediators[kind];
}

export async function remediate(
  kind: GuardrailKind, resource: ResourceSnapshot, params: Record<string, any>, scope: Scope
): Promise<RemediationResult> {
  const fn = remediators[kind];
  if (!fn) {
    return {
      changed: false,
      description: `"${kind}" is report-only: fixing it automatically could cut live access, so it needs a human.`,
    };
  }
  return fn(resource, params, scope);
}
