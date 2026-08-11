import { RuleKind, Evaluation, ResourceSnapshot, GuardrailKind, CLOUDWATCH_RETENTION_DAYS, snapRetention } from "./types";

/**
 * The rule catalog.
 *
 * Every evaluate() is a pure function of (resource state, params). No AWS calls
 * live here, which is what lets the whole catalog be tested directly.
 *
 * Adding a control should mean adding an entry here, not new architecture.
 */

const ok = (summary: string): Evaluation => ({ verdict: "compliant", summary });
const na = (summary: string): Evaluation => ({ verdict: "not_applicable", summary });
const bad = (summary: string, fix?: Evaluation["fix"]): Evaluation => ({ verdict: "violation", summary, fix });

// ── S3: deny non-TLS access ───────────────────────────────────────────

/**
 * Does this statement's Resource cover both the bucket and its objects?
 *
 * A bucket has two addressable halves — "arn:aws:s3:::b" for operations on the
 * bucket (ListBucket, GetBucketPolicy) and "arn:aws:s3:::b/*" for the objects
 * in it. A deny naming only the objects still leaves filenames listable over
 * plain HTTP, so a statement that covers one half is not protection.
 */
export function coversWholeBucket(resource: unknown, bucket: string): boolean {
  const arns = (Array.isArray(resource) ? resource : [resource]).filter((r): r is string => typeof r === "string");
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const matches = (target: string) => arns.some(a => {
    if (a === "*" || a === "arn:aws:s3:::*") return true;
    if (a === target) return true;
    // Trailing wildcard, e.g. "arn:aws:s3:::b*" or "arn:aws:s3:::b/*"
    if (a.endsWith("*")) return target.startsWith(a.slice(0, -1));
    return false;
  });
  return matches(bucketArn) && matches(`${bucketArn}/`);
}

/** The statement we manage. Merged by Sid so unrelated statements survive. */
export function httpsOnlyStatement(bucket: string, sid: string) {
  return {
    Sid: sid,
    Effect: "Deny",
    Principal: "*",
    Action: "s3:*",
    Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
    Condition: { Bool: { "aws:SecureTransport": "false" } },
  };
}

const s3HttpsOnly: RuleKind = {
  kind: "s3_https_only",
  title: "S3 — deny non-TLS requests",
  summary: "Every bucket policy must deny requests that arrive over plain HTTP.",
  resourceType: "s3:bucket",
  defaultMode: "report",
  defaultParams: { sid: "EnforceHTTPSOnly" },
  paramSchema: [
    { key: "sid", label: "Statement name", type: "text", default: "EnforceHTTPSOnly",
      help: "The Sid written into the bucket policy. Statements with this name are replaced; everything else is left alone." },
  ],
  createEvents: ["CreateBucket"],
  evaluate(resource, params) {
    const sid = params.sid || "EnforceHTTPSOnly";
    const policy = resource.state.policy as { Statement?: any[] } | null;
    const statements: any[] = policy?.Statement ?? [];

    // Any statement denying non-TLS traffic satisfies this, however it is named —
    // we should not flag a bucket that is already correct just because someone
    // else wrote the rule.
    //
    // Effect must be checked on BOTH branches. IAM accepts the condition value
    // as the string "false" or the boolean false, and an earlier version bound
    // these with && / || such that a statement ALLOWING non-TLS traffic counted
    // as compliant.
    const already = statements.some(s => {
      if (s?.Effect !== "Deny") return false;
      const v = s?.Condition?.Bool?.["aws:SecureTransport"];
      if (v !== "false" && v !== false) return false;
      // A deny that names only the objects leaves the bucket itself listable
      // over plain HTTP, so half-coverage does not count.
      return coversWholeBucket(s?.Resource, resource.id);
    });
    if (already) return ok("Denies non-TLS requests");

    // Distinguish "no protection at all" from "protection that misses half the
    // bucket" — the second is easy to look at and believe is fine.
    const partial = statements.some(s =>
      s?.Effect === "Deny"
      && (s?.Condition?.Bool?.["aws:SecureTransport"] === "false" || s?.Condition?.Bool?.["aws:SecureTransport"] === false)
    );

    const next = [...statements.filter(s => s?.Sid !== sid), httpsOnlyStatement(resource.id, sid)];
    return bad(partial
      ? "Denies non-TLS for only part of the bucket — the other half is still reachable over HTTP"
      : "No policy statement denying non-TLS requests", {
      description: `Add "${sid}" deny statement to the bucket policy`,
      before: policy,
      after: { Version: policy?.["Version" as keyof typeof policy] ?? "2012-10-17", Statement: next },
    });
  },
};

// ── CloudWatch Logs: minimum retention ────────────────────────────────

const logRetentionMin: RuleKind = {
  kind: "log_retention_min",
  title: "CloudWatch Logs — minimum retention",
  summary: "Log groups must keep logs for at least a set period.",
  resourceType: "logs:log-group",
  defaultMode: "report",
  defaultParams: { minDays: 365, setToDays: 365, leaveLongerAlone: true, neverExpireIsCompliant: true },
  paramSchema: [
    { key: "minDays", label: "Flag anything retaining less than", type: "number", default: 365,
      unit: "days", allowed: CLOUDWATCH_RETENTION_DAYS,
      help: "The threshold a log group must meet to count as compliant." },
    { key: "setToDays", label: "When fixing, set retention to", type: "number", default: 365,
      unit: "days", allowed: CLOUDWATCH_RETENTION_DAYS,
      help: "Usually the same as the threshold, but you can raise it higher. CloudWatch only accepts specific values, so anything else rounds up to the next one it allows." },
    { key: "neverExpireIsCompliant", label: "Treat \u201cnever expire\u201d as compliant", type: "boolean", default: true,
      help: "Off means a log group set to keep logs forever gets pulled down to the value above." },
    { key: "leaveLongerAlone", label: "Leave longer retention untouched", type: "boolean", default: true,
      help: "Off means retention longer than the threshold is reduced to it \u2014 rarely what you want." },
  ],
  createEvents: ["CreateLogGroup"],
  evaluate(resource, params) {
    const minDays: number = params.minDays ?? 365;
    const setTo: number = snapRetention(params.setToDays ?? minDays);
    const leaveLongerAlone: boolean = params.leaveLongerAlone !== false;
    const neverExpireIsCompliant: boolean = params.neverExpireIsCompliant !== false;
    const current: number | undefined = resource.state.retentionInDays;

    // Undefined retention means "never expire".
    if (current === undefined || current === null) {
      return neverExpireIsCompliant
        ? ok("Never expires")
        : bad("Set to never expire", {
            description: `Set retention to ${setTo} days`,
            before: "never expires",
            after: `${setTo} days`,
          });
    }

    if (current >= minDays) {
      return leaveLongerAlone
        ? ok(`Retention ${current}d meets the ${minDays}d minimum`)
        : current === minDays
          ? ok(`Retention is exactly ${minDays}d`)
          : bad(`Retention ${current}d exceeds the required ${minDays}d`, {
              description: `Set retention to ${setTo} days`,
              before: `${current} days`,
              after: `${setTo} days`,
            });
    }

    return bad(`Retention ${current}d is below the ${minDays}d minimum`, {
      description: `Raise retention from ${current} to ${setTo} days`,
      before: `${current} days`,
      after: `${setTo} days`,
    });
  },
};

// ── S3: block public access ───────────────────────────────────────────

const s3BlockPublicAccess: RuleKind = {
  kind: "s3_block_public_access",
  title: "S3 — block public access",
  summary: "All four Block Public Access settings must be on.",
  paramSchema: [],
  resourceType: "s3:bucket",
  defaultMode: "report",
  defaultParams: {},
  createEvents: ["CreateBucket"],
  evaluate(resource) {
    const c = resource.state.publicAccessBlock ?? {};
    const wanted = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"];
    const missing = wanted.filter(k => c[k] !== true);
    if (missing.length === 0) return ok("All four public access blocks enabled");
    return bad(`Public access blocks off: ${missing.join(", ")}`, {
      description: "Enable all four Block Public Access settings",
      before: c,
      after: Object.fromEntries(wanted.map(k => [k, true])),
    });
  },
};

// ── S3: default encryption ────────────────────────────────────────────

const s3DefaultEncryption: RuleKind = {
  kind: "s3_default_encryption",
  title: "S3 — default encryption",
  summary: "Buckets must encrypt objects at rest by default.",
  paramSchema: [
    { key: "algorithm", label: "Encryption to apply when fixing", type: "choice", default: "AES256",
      options: [
        { value: "AES256", label: "SSE-S3 (AES256) \u2014 no key management" },
        { value: "aws:kms", label: "SSE-KMS \u2014 uses your KMS key" },
      ],
      help: "A bucket already encrypted with either algorithm counts as compliant; this only decides what to set on ones that are not." },
  ],
  resourceType: "s3:bucket",
  defaultMode: "report",
  defaultParams: { algorithm: "AES256" },
  createEvents: ["CreateBucket"],
  evaluate(resource, params) {
    const algo = resource.state.encryptionAlgorithm as string | undefined;
    if (algo) return ok(`Default encryption: ${algo}`);
    return bad("No default encryption configured", {
      description: `Enable default encryption (${params.algorithm ?? "AES256"})`,
      before: null,
      after: params.algorithm ?? "AES256",
    });
  },
};

// ── S3: versioning ────────────────────────────────────────────────────

const s3Versioning: RuleKind = {
  kind: "s3_versioning",
  title: "S3 — versioning enabled",
  summary: "Object versions must be retained, so deletions are recoverable.",
  paramSchema: [],
  resourceType: "s3:bucket",
  defaultMode: "report",
  defaultParams: {},
  createEvents: ["CreateBucket"],
  evaluate(resource) {
    const status = resource.state.versioning as string | undefined;
    if (status === "Enabled") return ok("Versioning enabled");
    return bad(`Versioning ${status ? status.toLowerCase() : "not enabled"}`, {
      description: "Enable bucket versioning",
      before: status ?? "Disabled",
      after: "Enabled",
    });
  },
};

// ── EBS: encryption by default (account-level) ────────────────────────

const ebsEncryptionDefault: RuleKind = {
  kind: "ebs_encryption_default",
  title: "EBS — encryption by default",
  summary: "New EBS volumes in this region must be encrypted automatically.",
  paramSchema: [],
  resourceType: "ec2:account",
  defaultMode: "report",
  defaultParams: {},
  createEvents: [],
  evaluate(resource) {
    return resource.state.ebsEncryptionByDefault === true
      ? ok("EBS encryption by default is on")
      : bad("EBS encryption by default is off", {
          description: "Enable EBS encryption by default for the account",
          before: false,
          after: true,
        });
  },
};

// ── RDS: backup retention ─────────────────────────────────────────────

const rdsBackupRetentionMin: RuleKind = {
  kind: "rds_backup_retention_min",
  title: "RDS — minimum backup retention",
  summary: "Database instances must keep automated backups for a set period.",
  paramSchema: [
    { key: "minDays", label: "Flag anything retaining less than", type: "number", default: 7, unit: "days", min: 1,
      help: "RDS allows 1\u201335 days. Zero disables automated backups entirely." },
    { key: "setToDays", label: "When fixing, set retention to", type: "number", default: 7, unit: "days", min: 1,
      help: "Applied immediately, which can cause a brief I/O pause on some engines." },
  ],
  resourceType: "rds:db-instance",
  defaultMode: "report",
  defaultParams: { minDays: 7, setToDays: 7 },
  createEvents: ["CreateDBInstance"],
  evaluate(resource, params) {
    const minDays: number = params.minDays ?? 7;
    const current: number = resource.state.backupRetentionPeriod ?? 0;
    if (current >= minDays) return ok(`Backup retention ${current}d meets the ${minDays}d minimum`);
    return bad(`Backup retention ${current}d is below the ${minDays}d minimum`, {
      description: `Raise backup retention from ${current} to ${minDays} days`,
      before: `${current} days`,
      after: `${minDays} days`,
    });
  },
};

// ── IAM: password policy (account-level) ──────────────────────────────

const iamPasswordPolicy: RuleKind = {
  kind: "iam_password_policy",
  title: "IAM — account password policy",
  summary: "The account password policy must meet minimum strength rules.",
  paramSchema: [
    { key: "minLength", label: "Minimum password length", type: "number", default: 14, unit: "characters", min: 6 },
    { key: "maxAgeDays", label: "Force rotation after", type: "number", default: 90, unit: "days", min: 1,
      help: "Set 0 to not require rotation." },
    { key: "reusePrevention", label: "Block reuse of the last", type: "number", default: 24, unit: "passwords", min: 0 },
  ],
  resourceType: "iam:account",
  defaultMode: "report",
  defaultParams: { minLength: 14, maxAgeDays: 90, reusePrevention: 24 },
  createEvents: [],
  evaluate(resource, params) {
    const p = resource.state.passwordPolicy as Record<string, any> | null;
    if (!p) {
      return bad("No account password policy set", {
        description: "Create an account password policy",
        before: null,
        after: params,
      });
    }
    const problems: string[] = [];
    if ((p.MinimumPasswordLength ?? 0) < (params.minLength ?? 14)) problems.push(`min length ${p.MinimumPasswordLength ?? 0} < ${params.minLength ?? 14}`);
    if (params.maxAgeDays && (p.MaxPasswordAge ?? Infinity) > params.maxAgeDays) problems.push(`max age ${p.MaxPasswordAge ?? "unset"} > ${params.maxAgeDays}`);
    if (params.reusePrevention && (p.PasswordReusePrevention ?? 0) < params.reusePrevention) problems.push(`reuse prevention ${p.PasswordReusePrevention ?? 0} < ${params.reusePrevention}`);
    if (problems.length === 0) return ok("Password policy meets requirements");
    return bad(problems.join("; "), {
      description: "Tighten the account password policy",
      before: p,
      after: params,
    });
  },
};


// ── RDS: pgaudit on PostgreSQL engines ────────────────────────────────


// ── RDS: SSL/TLS enforced ─────────────────────────────────────────────


export const CATALOG: RuleKind[] = [
  s3HttpsOnly,
  logRetentionMin,
  s3BlockPublicAccess,
  s3DefaultEncryption,
  s3Versioning,
  ebsEncryptionDefault,
  rdsBackupRetentionMin,
  iamPasswordPolicy,
];

const BY_KIND = new Map<GuardrailKind, RuleKind>(CATALOG.map(r => [r.kind, r]));

export function getRuleKind(kind: GuardrailKind): RuleKind | undefined {
  return BY_KIND.get(kind);
}

/** Rule kinds a given CloudTrail event should trigger. */
export function kindsForEvent(eventName: string): RuleKind[] {
  return CATALOG.filter(r => r.createEvents.includes(eventName));
}

export function evaluateResource(
  kind: GuardrailKind, resource: ResourceSnapshot, params: Record<string, any>
): Evaluation {
  const rule = getRuleKind(kind);
  if (!rule) return na(`Unknown rule kind "${kind}"`);
  return rule.evaluate(resource, params);
}
