import { awsRegion } from "../utils/region";

/**
 * Enterprise audit-log streaming, set up from the app.
 *
 * Two AWS resources stand between GitHub and the bucket: an OIDC provider for
 * GitHub's audit-log issuer, and a role that issuer may assume. Both used to be
 * created by the CDK stack behind `-c auditEnterprise=<slug>`, which meant the
 * feature was reachable only by someone who knew a flag documented in a code
 * comment — and produced, for everyone else, an empty bucket with no hint of
 * what it was for.
 *
 * They are created here instead, when somebody asks for them, and the stack no
 * longer creates them at all. One owner per resource: two would race to create
 * the same role and whichever lost would fail, which is precisely the loop the
 * audit bucket's policy used to produce.
 *
 * Every AWS call is injected. The decisions — is this set up, which enterprise
 * is it pinned to, what is left to do — are then testable without IAM.
 */

export const OIDC_URL = "https://oidc-configuration.audit-log.githubusercontent.com";
export const OIDC_HOST = "oidc-configuration.audit-log.githubusercontent.com";

export interface AuditStreamStatus {
  /** The role exists and trusts a GitHub enterprise. */
  configured: boolean;
  /** Which enterprise it trusts, read back from the trust policy. */
  enterprise: string | null;
  roleArn: string | null;
  bucket: string;
  /** True once GitHub has actually written something. */
  receiving: boolean;
  /** Objects seen in the bucket, capped — a floor, not a total. */
  objectCount: number;
}

export interface AuditStreamDeps {
  accountId: string;
  prefix: string;
  /** Returns the role's trust policy document, or null if there is no role. */
  getRoleTrustPolicy: (roleName: string) => Promise<any | null>;
  listOidcProviderUrls: () => Promise<string[]>;
  createOidcProvider: (url: string) => Promise<string>;
  createRole: (roleName: string, trustPolicy: any) => Promise<string>;
  putRolePolicy: (roleName: string, policyName: string, policy: any) => Promise<void>;
  /** Repoints an existing role at a different enterprise. */
  updateTrustPolicy: (roleName: string, trustPolicy: any) => Promise<void>;
  countBucketObjects: (bucket: string) => Promise<number>;
}

export function bucketName(prefix: string, accountId: string): string {
  return `${prefix}-audit-log-${accountId}`;
}

export function roleName(prefix: string): string {
  return `${prefix}-audit-log-stream`;
}

/**
 * A GitHub enterprise slug, as it appears in github.com/enterprises/<slug>.
 *
 * Validated because it is interpolated into a trust policy condition. A value
 * with a wildcard or a second subject in it would widen who may assume the
 * role, which is the one thing this policy exists to narrow.
 */
export function isValidEnterpriseSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(slug);
}

/**
 * Who may assume the role.
 *
 * Pinned to one enterprise. Trusting the issuer without naming a subject would
 * let any GitHub enterprise assume it and write into this bucket, which is a
 * bucket whose whole purpose is being the record nobody can rewrite.
 */
export function trustPolicyFor(accountId: string, enterprise: string) {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/${OIDC_HOST}` },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          [`${OIDC_HOST}:aud`]: "sts.amazonaws.com",
          [`${OIDC_HOST}:sub`]: `https://github.com/${enterprise}`,
        },
      },
    }],
  };
}

/** What the role may do: write this bucket, and nothing else anywhere. */
export function writePolicyFor(bucket: string) {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:PutObject"],
      Resource: `arn:aws:s3:::${bucket}/*`,
    }],
  };
}

/** The enterprise a trust policy is pinned to, if it is pinned to one. */
export function enterpriseFromTrustPolicy(doc: any): string | null {
  for (const st of doc?.Statement ?? []) {
    const sub = st?.Condition?.StringEquals?.[`${OIDC_HOST}:sub`];
    if (typeof sub === "string" && sub.startsWith("https://github.com/")) {
      return sub.slice("https://github.com/".length) || null;
    }
  }
  return null;
}

export async function getStatus(deps: AuditStreamDeps): Promise<AuditStreamStatus> {
  const bucket = bucketName(deps.prefix, deps.accountId);
  const role = roleName(deps.prefix);

  const trust = await deps.getRoleTrustPolicy(role).catch(() => null);
  const enterprise = trust ? enterpriseFromTrustPolicy(trust) : null;

  // Counted rather than assumed from the role's existence: a role can be
  // perfect and streaming still switched off in GitHub, which is the state
  // this screen most needs to tell apart from "not set up".
  const objectCount = await deps.countBucketObjects(bucket).catch(() => 0);

  return {
    configured: !!enterprise,
    enterprise,
    roleArn: enterprise ? `arn:aws:iam::${deps.accountId}:role/${role}` : null,
    bucket,
    receiving: objectCount > 0,
    objectCount,
  };
}

export interface SetupResult {
  roleArn: string;
  bucket: string;
  createdProvider: boolean;
  createdRole: boolean;
}

export async function setupStream(
  enterprise: string,
  deps: AuditStreamDeps,
): Promise<SetupResult> {
  if (!isValidEnterpriseSlug(enterprise)) {
    throw new Error(`"${enterprise}" is not a valid GitHub enterprise slug`);
  }

  const bucket = bucketName(deps.prefix, deps.accountId);
  const role = roleName(deps.prefix);

  // The provider is account-wide and shared: a second one for the same issuer
  // is rejected by AWS, so an existing one is reused rather than replaced.
  const existing = await deps.listOidcProviderUrls();
  const havePro = existing.some(u => u.replace(/^https:\/\//, "") === OIDC_HOST);
  if (!havePro) await deps.createOidcProvider(OIDC_URL);

  const trust = trustPolicyFor(deps.accountId, enterprise);
  const current = await deps.getRoleTrustPolicy(role).catch(() => null);

  let createdRole = false;
  if (!current) {
    await deps.createRole(role, trust);
    createdRole = true;
  } else if (enterpriseFromTrustPolicy(current) !== enterprise) {
    // Re-running setup with a different slug has to move the trust. Without
    // this the app would report the new enterprise while the role still
    // trusted the old one — and the old one could still write.
    await deps.updateTrustPolicy(role, trust);
  }

  // Written every time. It is the same document each run, and putting it again
  // costs one call and repairs a role whose inline policy somebody removed.
  await deps.putRolePolicy(role, `${deps.prefix}-audit-log-write`, writePolicyFor(bucket));

  return {
    roleArn: `arn:aws:iam::${deps.accountId}:role/${role}`,
    bucket,
    createdProvider: !havePro,
    createdRole,
  };
}

// ── the live wiring ───────────────────────────────────────────────────

export async function liveDeps(accountId: string, prefix: string): Promise<AuditStreamDeps> {
  const {
    IAMClient, GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand,
    ListOpenIDConnectProvidersCommand, CreateOpenIDConnectProviderCommand,
    GetOpenIDConnectProviderCommand, UpdateAssumeRolePolicyCommand,
  } = await import("@aws-sdk/client-iam");
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");

  const iam = new IAMClient({ region: awsRegion() });
  const s3 = new S3Client({ region: awsRegion() });

  return {
    accountId,
    prefix,
    async getRoleTrustPolicy(name) {
      try {
        const r = await iam.send(new GetRoleCommand({ RoleName: name }));
        const doc = r.Role?.AssumeRolePolicyDocument;
        return doc ? JSON.parse(decodeURIComponent(doc)) : null;
      } catch (err: any) {
        if (err?.name === "NoSuchEntityException") return null;
        throw err;
      }
    },
    async listOidcProviderUrls() {
      const r = await iam.send(new ListOpenIDConnectProvidersCommand({}));
      const arns = (r.OpenIDConnectProviderList ?? []).map(p => p.Arn!).filter(Boolean);
      const urls: string[] = [];
      for (const Arn of arns) {
        const d = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: Arn }));
        if (d.Url) urls.push(d.Url);
      }
      return urls;
    },
    async createOidcProvider(url) {
      const r = await iam.send(new CreateOpenIDConnectProviderCommand({
        Url: url, ClientIDList: ["sts.amazonaws.com"],
      }));
      return r.OpenIDConnectProviderArn!;
    },
    async createRole(name, trustPolicy) {
      const r = await iam.send(new CreateRoleCommand({
        RoleName: name,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: "GitHub Enterprise audit-log streaming. Created by GitHub Control Hub.",
      }));
      return r.Role!.Arn!;
    },
    async putRolePolicy(name, policyName, policy) {
      await iam.send(new PutRolePolicyCommand({
        RoleName: name, PolicyName: policyName, PolicyDocument: JSON.stringify(policy),
      }));
    },
    async updateTrustPolicy(name, trustPolicy) {
      await iam.send(new UpdateAssumeRolePolicyCommand({
        RoleName: name, PolicyDocument: JSON.stringify(trustPolicy),
      }));
    },
    async countBucketObjects(bucket) {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }));
      return r.KeyCount ?? 0;
    },
  };
}
