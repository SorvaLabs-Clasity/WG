import { GuardrailKind, ResourceSnapshot } from "./types";
import { httpsOnlyStatement } from "./catalog";

/**
 * The only code in the engine that writes to AWS.
 *
 * Each remediator returns an undo payload describing how to put the resource
 * back, which is stored on the activity entry so the existing undo works.
 *
 * Kinds absent from this map are report-only by construction: revoking a
 * security group rule or flipping an RDS instance private can cut live access,
 * so those are surfaced for a human rather than fixed automatically.
 */

const REGION = process.env.AWS_REGION || "us-east-1";

export interface RemediationResult {
  changed: boolean;
  description: string;
  undo?: { action: string; params: Record<string, any> };
}

type Remediator = (resource: ResourceSnapshot, params: Record<string, any>) => Promise<RemediationResult>;

const remediators: Partial<Record<GuardrailKind, Remediator>> = {
  async s3_https_only(resource, params) {
    const { S3Client, PutBucketPolicyCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
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
        params: { bucket: resource.id, policy: existing ? JSON.stringify(existing) : null },
      },
    };
  },

  async log_retention_min(resource, params) {
    const { CloudWatchLogsClient, PutRetentionPolicyCommand, DeleteRetentionPolicyCommand } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const logs = new CloudWatchLogsClient({ region: REGION });
    const minDays: number = params.minDays ?? 365;
    const previous: number | undefined = resource.state.retentionInDays;

    await logs.send(new PutRetentionPolicyCommand({ logGroupName: resource.id, retentionInDays: minDays }));
    void DeleteRetentionPolicyCommand; // referenced by the undo action below
    return {
      changed: true,
      description: `Set retention on ${resource.id} to ${minDays} days (was ${previous ?? "never expire"})`,
      undo: { action: "logs_restore_retention", params: { logGroup: resource.id, retentionInDays: previous ?? null } },
    };
  },

  async s3_block_public_access(resource) {
    const { S3Client, PutPublicAccessBlockCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const before = resource.state.publicAccessBlock ?? {};
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: resource.id,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
      },
    }));
    return {
      changed: true,
      description: `Enabled all Block Public Access settings on ${resource.id}`,
      undo: { action: "s3_restore_public_access_block", params: { bucket: resource.id, config: before } },
    };
  },

  async s3_default_encryption(resource, params) {
    const { S3Client, PutBucketEncryptionCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const algorithm = params.algorithm ?? "AES256";
    await s3.send(new PutBucketEncryptionCommand({
      Bucket: resource.id,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: algorithm } }],
      },
    }));
    return {
      changed: true,
      description: `Enabled ${algorithm} default encryption on ${resource.id}`,
      undo: { action: "s3_remove_default_encryption", params: { bucket: resource.id } },
    };
  },

  async s3_versioning(resource) {
    const { S3Client, PutBucketVersioningCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    await s3.send(new PutBucketVersioningCommand({
      Bucket: resource.id, VersioningConfiguration: { Status: "Enabled" },
    }));
    // Versioning cannot be switched off once on, only suspended — the undo
    // reflects that rather than pretending the original state is restorable.
    return {
      changed: true,
      description: `Enabled versioning on ${resource.id}`,
      undo: { action: "s3_suspend_versioning", params: { bucket: resource.id } },
    };
  },

  async ebs_encryption_default() {
    const { EC2Client, EnableEbsEncryptionByDefaultCommand } = await import("@aws-sdk/client-ec2");
    const ec2 = new EC2Client({ region: REGION });
    await ec2.send(new EnableEbsEncryptionByDefaultCommand({}));
    return {
      changed: true,
      description: `Enabled EBS encryption by default in ${REGION}`,
      undo: { action: "ec2_disable_ebs_encryption_default", params: { region: REGION } },
    };
  },

  async rds_backup_retention_min(resource, params) {
    const { RDSClient, ModifyDBInstanceCommand } = await import("@aws-sdk/client-rds");
    const rds = new RDSClient({ region: REGION });
    const minDays: number = params.minDays ?? 7;
    const before = resource.state.backupRetentionPeriod ?? 0;
    await rds.send(new ModifyDBInstanceCommand({
      DBInstanceIdentifier: resource.id, BackupRetentionPeriod: minDays, ApplyImmediately: true,
    }));
    return {
      changed: true,
      description: `Set backup retention on ${resource.id} to ${minDays} days (was ${before})`,
      undo: { action: "rds_restore_backup_retention", params: { instance: resource.id, days: before } },
    };
  },

  async iam_password_policy(resource, params) {
    const { IAMClient, UpdateAccountPasswordPolicyCommand } = await import("@aws-sdk/client-iam");
    const iam = new IAMClient({ region: REGION });
    const before = resource.state.passwordPolicy ?? null;
    await iam.send(new UpdateAccountPasswordPolicyCommand({
      MinimumPasswordLength: params.minLength ?? 14,
      MaxPasswordAge: params.maxAgeDays ?? 90,
      PasswordReusePrevention: params.reusePrevention ?? 24,
      RequireUppercaseCharacters: true,
      RequireLowercaseCharacters: true,
      RequireNumbers: true,
      RequireSymbols: true,
    }));
    return {
      changed: true,
      description: "Updated the account password policy",
      undo: { action: "iam_restore_password_policy", params: { policy: before } },
    };
  },
};

export function canRemediate(kind: GuardrailKind): boolean {
  return !!remediators[kind];
}

export async function remediate(
  kind: GuardrailKind, resource: ResourceSnapshot, params: Record<string, any>
): Promise<RemediationResult> {
  const fn = remediators[kind];
  if (!fn) {
    return {
      changed: false,
      description: `"${kind}" is report-only: fixing it automatically could cut live access, so it needs a human.`,
    };
  }
  return fn(resource, params);
}
