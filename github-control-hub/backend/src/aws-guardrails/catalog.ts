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
    const already = statements.some(s =>
      s?.Effect === "Deny" &&
      s?.Condition?.Bool?.["aws:SecureTransport"] === "false" ||
      s?.Condition?.Bool?.["aws:SecureTransport"] === false
    );
    if (already) return ok("Denies non-TLS requests");

    const next = [...statements.filter(s => s?.Sid !== sid), httpsOnlyStatement(resource.id, sid)];
    return bad("No policy statement denying non-TLS requests", {
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

// ── Security groups: no public admin ingress ──────────────────────────

const sgNoPublicAdminIngress: RuleKind = {
  kind: "sg_no_public_admin_ingress",
  title: "Security groups — no public admin ports",
  summary: "Admin ports must not be reachable from the whole internet.",
  paramSchema: [
    { key: "ports", label: "Ports that must not be open to 0.0.0.0/0", type: "ports", default: [22, 3389],
      help: "Comma separated. A rule spanning a port range that covers any of these is flagged too." },
  ],
  resourceType: "ec2:security-group",
  defaultMode: "report",
  defaultParams: { ports: [22, 3389] },
  createEvents: ["AuthorizeSecurityGroupIngress", "CreateSecurityGroup"],
  evaluate(resource, params) {
    const ports: number[] = params.ports ?? [22, 3389];
    const rules: any[] = resource.state.ingress ?? [];
    const offending = rules.filter(r => {
      const open = (r.ipRanges ?? []).includes("0.0.0.0/0") || (r.ipv6Ranges ?? []).includes("::/0");
      if (!open) return false;
      const from = r.fromPort ?? 0;
      const to = r.toPort ?? 65535;
      return ports.some(p => p >= from && p <= to);
    });
    if (offending.length === 0) return ok("No admin ports open to the internet");
    return bad(`Open to 0.0.0.0/0 on ${ports.join("/")}`, {
      description: "Revoke the offending ingress rules",
      before: offending,
      after: [],
    });
  },
};

// ── RDS: not publicly accessible ──────────────────────────────────────

const rdsNoPublicAccess: RuleKind = {
  kind: "rds_no_public_access",
  title: "RDS — not publicly accessible",
  summary: "Database instances must not have a public endpoint.",
  paramSchema: [],
  resourceType: "rds:db-instance",
  defaultMode: "report",
  defaultParams: {},
  createEvents: ["CreateDBInstance", "ModifyDBInstance"],
  evaluate(resource) {
    return resource.state.publiclyAccessible === true
      ? bad("Instance is publicly accessible", {
          description: "Disable public accessibility",
          before: true,
          after: false,
        })
      : ok("Not publicly accessible");
  },
};

// ── EC2: IMDSv2 required ──────────────────────────────────────────────

const ec2Imdsv2Required: RuleKind = {
  kind: "ec2_imdsv2_required",
  title: "EC2 — IMDSv2 required",
  summary: "Instances must require session tokens on the metadata endpoint.",
  paramSchema: [],
  resourceType: "ec2:instance",
  defaultMode: "report",
  defaultParams: {},
  createEvents: ["RunInstances"],
  evaluate(resource) {
    return resource.state.httpTokens === "required"
      ? ok("IMDSv2 required")
      : bad(`IMDSv2 not required (httpTokens=${resource.state.httpTokens ?? "unset"})`, {
          description: "Require IMDSv2 on the instance metadata endpoint",
          before: resource.state.httpTokens ?? "optional",
          after: "required",
        });
  },
};

// ── CloudTrail: enabled and logging ───────────────────────────────────

const cloudtrailEnabled: RuleKind = {
  kind: "cloudtrail_enabled",
  title: "CloudTrail — enabled and logging",
  summary: "An active trail must exist. Also the prerequisite for creation events reaching this app.",
  paramSchema: [
    { key: "requireMultiRegion", label: "Require the trail to be multi-region", type: "boolean", default: true,
      help: "A single-region trail leaves activity in other regions unrecorded." },
  ],
  resourceType: "cloudtrail:account",
  defaultMode: "report",
  defaultParams: { requireMultiRegion: true },
  createEvents: [],
  evaluate(resource, params) {
    const trails: any[] = resource.state.trails ?? [];
    const usable = trails.filter(t => t.isLogging && (!params.requireMultiRegion || t.isMultiRegion));
    if (usable.length > 0) return ok(`${usable.length} trail(s) logging`);
    // Also the prerequisite for this app's own creation events.
    return bad(
      trails.length === 0
        ? "No CloudTrail trail exists — creation events cannot reach EventBridge"
        : "No trail is both logging and multi-region",
      { description: "Create a multi-region trail with management events enabled", before: trails, after: "multi-region trail, logging" }
    );
  },
};

export const CATALOG: RuleKind[] = [
  s3HttpsOnly,
  logRetentionMin,
  s3BlockPublicAccess,
  s3DefaultEncryption,
  s3Versioning,
  ebsEncryptionDefault,
  rdsBackupRetentionMin,
  iamPasswordPolicy,
  sgNoPublicAdminIngress,
  rdsNoPublicAccess,
  ec2Imdsv2Required,
  cloudtrailEnabled,
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
