/** Shared types for the AWS guardrail engine. */

export type GuardrailKind =
  // Safe to auto-remediate
  | "s3_https_only"
  | "log_retention_min"
  | "s3_block_public_access"
  | "s3_default_encryption"
  | "s3_versioning"
  | "ebs_encryption_default"
  | "rds_backup_retention_min"
  | "iam_password_policy"
  // Report-only by default — remediation can cut live access
  | "sg_no_public_admin_ingress"
  | "rds_no_public_access"
  | "ec2_imdsv2_required"
  | "cloudtrail_enabled"
  // Added from the company's Vanta control set. All report-only: each fix
  // needs a reboot, a destination bucket, or an irreversible setting.
  | "rds_pgaudit_enabled"
  | "rds_ssl_enforced"
  | "s3_cross_region_replication"
  | "cloudtrail_bucket_protected";

export type GuardrailMode = "report" | "enforce";

export interface Guardrail {
  id: string;
  name: string;
  description: string;
  kind: GuardrailKind;
  enabled: boolean;
  /** `report` never writes. Promotion to `enforce` requires the admin team. */
  mode: GuardrailMode;
  applyOnCreate: boolean;
  params: Record<string, any>;
  exclusionLists: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type AwsExclusionPatternType = "starts_with" | "contains" | "tag_equals";

export interface AwsExclusionPattern {
  id: string;
  type: AwsExclusionPatternType;
  /** For tag_equals, "Key=Value". Otherwise matched against the resource id. */
  value: string;
}

export interface AwsExclusionList {
  id: string;
  name: string;
  description: string;
  /** Exact resource identifiers — bucket names, log group names, and so on. */
  resources: string[];
  patterns: AwsExclusionPattern[];
  /** Wins over patterns, so one resource can be pulled back in. */
  whitelist: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A resource as the engine sees it: an id, its tags, and kind-specific state. */
export interface ResourceSnapshot {
  id: string;
  type: string;
  tags: Record<string, string>;
  state: Record<string, any>;
}

export type Verdict = "compliant" | "violation" | "not_applicable";

export interface Evaluation {
  verdict: Verdict;
  /** One line, shown in the findings table. Always populated. */
  summary: string;
  /** What remediation would change. Absent when nothing needs doing. */
  fix?: {
    description: string;
    before: unknown;
    after: unknown;
  };
}

export interface Finding {
  ruleId: string;
  ruleName: string;
  kind: GuardrailKind;
  resourceId: string;
  resourceType: string;
  verdict: Verdict;
  summary: string;
  /** What remediation would do. Present on violations that can be fixed. */
  proposedFix?: string;
  /** Region the resource lives in, so the UI can build a console link. */
  region?: string;
  excluded: boolean;
  excludedBy?: string;
  remediated: boolean;
  error?: string;
  checkedAt: string;
}

/**
 * Describes one setting on a rule so the UI can render a real control for it.
 *
 * Without this the editor falls back to a raw JSON blob, which asks the person
 * configuring a compliance rule to know the internal key names. The schema is
 * the contract: label and help are what the user reads, `key` never appears.
 */
export interface ParamSpec {
  key: string;
  label: string;
  help?: string;
  type: "number" | "boolean" | "text" | "ports" | "choice";
  default: any;
  /** For type "number": restrict to these values (CloudWatch retention, etc.). */
  allowed?: number[];
  /** For type "choice". */
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
}

/**
 * One rule kind.
 *
 * `evaluate` is pure — state and params in, verdict out — which is what makes
 * the catalog testable without touching AWS. `remediate` is the only part that
 * writes, and it is never called in report mode.
 */
export interface RuleKind {
  kind: GuardrailKind;
  /** Shown in the UI. The `kind` string is an internal identifier. */
  title: string;
  summary: string;
  resourceType: string;
  /** Sensible default when a rule of this kind is created. */
  defaultMode: GuardrailMode;
  defaultParams: Record<string, any>;
  /** One entry per configurable setting, in the order the UI should show them. */
  paramSchema: ParamSpec[];
  /** CloudTrail event names that should trigger this rule immediately. */
  createEvents: string[];
  evaluate(resource: ResourceSnapshot, params: Record<string, any>): Evaluation;
}

/** CloudWatch Logs only accepts these retention periods. */
export const CLOUDWATCH_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731,
  1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

/** Round up to the nearest value CloudWatch will accept. */
export function snapRetention(days: number): number {
  return CLOUDWATCH_RETENTION_DAYS.find(d => d >= days) ?? 3653;
}
