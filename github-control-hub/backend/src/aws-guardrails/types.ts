/** Shared types for the AWS guardrail engine. */

/**
 * Two rules, both of which can fix what they find. Anything that could only
 * report was removed — Vanta already does that, and duplicating it here only
 * created noise nobody acted on.
 */
export type GuardrailKind =
  | "s3_https_only"
  | "log_retention_min";

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
  /**
   * Which accounts this rule runs in. Empty or absent means all of them, which
   * is what every rule written before accounts existed means — and the reading
   * that keeps a rule from silently stopping when a second account is added.
   *
   * Naming accounts is for rules that genuinely differ by environment: a
   * retention floor that is 365 days in prod and 30 in dev is two rules, not a
   * rule with an exception list.
   */
  accounts?: string[];
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
  /** Which account it lives in. Every finding written since accounts existed has one. */
  accountId?: string;
  /** The account's label ("prod", "uat"), so the UI need not resolve twelve digits. */
  accountName?: string;
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
  /**
   * CloudTrail event names that should run this rule immediately. Covers
   * both creating a resource and changing the setting the rule cares about
   * — drift is the more common way an account goes wrong.
   */
  triggerEvents: string[];
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


/**
 * One AWS account the guardrails run against.
 *
 * An organisation is rarely one account. The rules that matter — retention
 * floors, TLS-only buckets — matter most in the accounts nobody logs into
 * daily, and a tool that can only see the account it happens to be deployed in
 * reports a clean bill of health for an estate it has never looked at.
 *
 * Access is by role assumption rather than stored keys: the target account
 * grants a role, the app's Lambda assumes it, and revoking access is a change
 * in the account that owns the resources rather than a secret to go and delete.
 */
export type AwsAccessMethod = "home" | "organization" | "role" | "keys";

export interface AwsAccount {
  /** The twelve-digit AWS account id. Also the primary key. */
  accountId: string;
  /** What people call it: "prod", "uat", "sandbox". */
  name: string;
  /**
   * How to get into it.
   *
   *   home          the account the app runs in; ambient credentials, no setup
   *   organization  a role AWS Organizations already put there — nothing to
   *                 create, nothing to deploy in the target account
   *   role          a role someone made deliberately, named by ARN
   *   keys          an access key pair, kept in Secrets Manager
   *
   * Defaults to "role" when a roleArn is present and "organization" otherwise,
   * so accounts stored before this existed keep behaving as they did.
   */
  access?: AwsAccessMethod;
  /**
   * Role to assume in that account. Absent for the account the app itself runs
   * in, which needs no assumption and cannot be locked out by a bad role.
   */
  roleArn?: string;
  /** Matched against the role's trust policy, when the account requires one. */
  externalId?: string;
  /**
   * Secrets Manager id holding an access key pair. The keys themselves are
   * never stored on this record and never sent to the browser.
   */
  secretId?: string;
  /** Last four characters of the stored key id, so the UI can say which one. */
  keyHint?: string;
  /** Which role actually worked, filled in after a successful assume. */
  reachedVia?: string;
  /** Regions to sweep. Empty means the region the app runs in. */
  regions: string[];
  enabled: boolean;
  /** True for the account hosting the app. Not editable, and always present. */
  isHome?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a collector or remediator should point.
 *
 * Passing this rather than reading process.env is what makes one engine able to
 * cover several accounts: the credentials are an argument, so nothing in the
 * call path holds a hidden assumption about which account it is in.
 */
export interface Scope {
  accountId: string;
  accountName: string;
  region: string;
  /** Absent means the ambient role — the account the app runs in. */
  credentials?: AwsCredentials;
}

/**
 * What a collector found, and what it could not see.
 *
 * `unswept` exists because S3 is global while the sweep is per-region: buckets
 * in a region nobody added to the account are skipped, and a skipped bucket
 * looks on screen exactly like a compliant one. Saying so out loud is the
 * difference between "nothing wrong here" and "nobody looked".
 */
export interface Collection {
  resources: ResourceSnapshot[];
  unswept?: { region: string; count: number }[];
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
