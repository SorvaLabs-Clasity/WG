/**
 * Tests for the AWS guardrail catalog and exclusion matching.
 *
 * Every evaluate() is pure, so the whole catalog is testable without AWS. The
 * cases that matter are the ones where a wrong answer causes real damage:
 * flagging a bucket that is already correct, or lowering a retention period
 * that was deliberately set longer.
 */
import { evaluateResource, httpsOnlyStatement, coversWholeBucket, CATALOG, kindsForEvent } from "./src/aws-guardrails/catalog";
import { snapRetention, CLOUDWATCH_RETENTION_DAYS } from "./src/aws-guardrails/types";
import { isExcluded } from "./src/aws-guardrails/exclusions";
import type { ResourceSnapshot, AwsExclusionList } from "./src/aws-guardrails/types";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const res = (id: string, state: Record<string, any>, tags: Record<string, string> = {}): ResourceSnapshot =>
  ({ id, type: "test", tags, state });

// ── log_retention_min: the rule most likely to do harm if wrong ───────
{
  const p = { minDays: 365, leaveLongerAlone: true, neverExpireIsCompliant: true };

  const low = evaluateResource("log_retention_min", res("lg", { retentionInDays: 30 }), p);
  check("retention below minimum is a violation", low.verdict === "violation", low);
  check("  and proposes raising it to the minimum", low.fix?.after === "365 days", low.fix);

  const exact = evaluateResource("log_retention_min", res("lg", { retentionInDays: 365 }), p);
  check("retention exactly at minimum is compliant", exact.verdict === "compliant", exact);

  const high = evaluateResource("log_retention_min", res("lg", { retentionInDays: 3653 }), p);
  check("LONGER retention is left alone", high.verdict === "compliant", high);
  check("  and proposes no change", high.fix === undefined, high.fix);

  const never = evaluateResource("log_retention_min", res("lg", {}), p);
  check("never-expire is left alone", never.verdict === "compliant", never);

  const strictNever = evaluateResource("log_retention_min", res("lg", {}),
    { ...p, neverExpireIsCompliant: false });
  check("never-expire flagged when configured to be", strictNever.verdict === "violation", strictNever);

  const clamp = evaluateResource("log_retention_min", res("lg", { retentionInDays: 3653 }),
    { ...p, leaveLongerAlone: false });
  check("longer retention flagged when leaveLongerAlone is off", clamp.verdict === "violation", clamp);
}

// ── s3_https_only: must not clobber existing policy ───────────────────
{
  const sid = "EnforceHTTPSOnly";
  const existing = {
    Version: "2012-10-17",
    Statement: [{ Sid: "AllowReads", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" }],
  };

  const v = evaluateResource("s3_https_only", res("b", { policy: existing }), { sid });
  check("bucket without TLS deny is a violation", v.verdict === "violation", v);
  const after: any = v.fix?.after;
  check("  keeps the unrelated statement", after.Statement.some((s: any) => s.Sid === "AllowReads"), after);
  check("  adds the deny statement", after.Statement.some((s: any) => s.Sid === sid), after);
  check("  deny targets bucket and objects",
    JSON.stringify(after.Statement.find((s: any) => s.Sid === sid).Resource) ===
    JSON.stringify(["arn:aws:s3:::b", "arn:aws:s3:::b/*"]), after);

  const already = evaluateResource("s3_https_only",
    res("b", { policy: { Version: "2012-10-17", Statement: [httpsOnlyStatement("b", sid)] } }), { sid });
  check("already-correct bucket is compliant", already.verdict === "compliant", already);

  // Someone else's equivalent statement under a different name must also count.
  const foreign = evaluateResource("s3_https_only",
    res("b", { policy: { Statement: [{ ...httpsOnlyStatement("b", "SomeoneElsesName") }] } }), { sid });
  check("equivalent deny under another Sid is compliant", foreign.verdict === "compliant", foreign);

  // An Allow conditioned on non-TLS must NOT count as denying it. A precedence
  // slip once made this pass, which is a false clean bill of health.
  const allowNonTls = evaluateResource("s3_https_only",
    res("b", { policy: { Statement: [{ Sid: "Weird", Effect: "Allow", Principal: "*", Action: "s3:*",
      Condition: { Bool: { "aws:SecureTransport": false } } }] } }), { sid });
  check("an ALLOW conditioned on non-TLS is not compliant", allowNonTls.verdict === "violation", allowNonTls);

  // IAM accepts the condition value as a boolean as well as a string. Resource
  // is required in a bucket policy, so a valid statement always names it.
  const boolDeny = evaluateResource("s3_https_only",
    res("b", { policy: { Statement: [{ Sid: "X", Effect: "Deny", Principal: "*", Action: "s3:*",
      Resource: ["arn:aws:s3:::b", "arn:aws:s3:::b/*"],
      Condition: { Bool: { "aws:SecureTransport": false } } }] } }), { sid });
  check("a DENY using boolean false is compliant", boolDeny.verdict === "compliant", boolDeny);

  // A bucket has two addressable halves. Denying non-TLS on only one of them
  // still leaves the other reachable over plain HTTP.
  const objectsOnly = evaluateResource("s3_https_only",
    res("b", { policy: { Statement: [{ Sid: "Half", Effect: "Deny", Principal: "*", Action: "s3:*",
      Resource: "arn:aws:s3:::b/*", Condition: { Bool: { "aws:SecureTransport": "false" } } }] } }), { sid });
  check("a deny covering only objects is a violation", objectsOnly.verdict === "violation", objectsOnly);
  check("  and says which half is missing", /only part of the bucket/.test(objectsOnly.summary), objectsOnly.summary);

  const bucketOnly = evaluateResource("s3_https_only",
    res("b", { policy: { Statement: [{ Sid: "Half", Effect: "Deny", Principal: "*", Action: "s3:*",
      Resource: "arn:aws:s3:::b", Condition: { Bool: { "aws:SecureTransport": "false" } } }] } }), { sid });
  check("a deny covering only the bucket is a violation", bucketOnly.verdict === "violation", bucketOnly);

  check("coversWholeBucket: both ARNs", coversWholeBucket(["arn:aws:s3:::b", "arn:aws:s3:::b/*"], "b"));
  check("coversWholeBucket: objects only", !coversWholeBucket(["arn:aws:s3:::b/*"], "b"));
  check("coversWholeBucket: bucket only", !coversWholeBucket("arn:aws:s3:::b", "b"));
  check("coversWholeBucket: global wildcard", coversWholeBucket("*", "b"));
  check("coversWholeBucket: s3 wildcard", coversWholeBucket("arn:aws:s3:::*", "b"));
  check("coversWholeBucket: prefix wildcard", coversWholeBucket("arn:aws:s3:::b*", "b"));
  check("coversWholeBucket: another bucket does not count", !coversWholeBucket(["arn:aws:s3:::other", "arn:aws:s3:::other/*"], "b"));

  const none = evaluateResource("s3_https_only", res("b", { policy: null }), { sid });
  check("bucket with no policy is a violation", none.verdict === "violation", none);
  check("  and builds a fresh document", (none.fix?.after as any).Statement.length === 1, none.fix);
}

// ── a sample of the rest ──────────────────────────────────────────────
{
  check("block public access: all on is compliant",
    evaluateResource("s3_block_public_access", res("b", { publicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }), {}).verdict === "compliant");
  check("block public access: partial is a violation",
    evaluateResource("s3_block_public_access", res("b", { publicAccessBlock: { BlockPublicAcls: true } }), {}).verdict === "violation");

  check("sg: 0.0.0.0/0 on 22 is a violation",
    evaluateResource("sg_no_public_admin_ingress", res("sg", { ingress: [{ fromPort: 22, toPort: 22, ipRanges: ["0.0.0.0/0"] }] }), { ports: [22, 3389] }).verdict === "violation");
  check("sg: 0.0.0.0/0 on 443 is fine",
    evaluateResource("sg_no_public_admin_ingress", res("sg", { ingress: [{ fromPort: 443, toPort: 443, ipRanges: ["0.0.0.0/0"] }] }), { ports: [22, 3389] }).verdict === "compliant");
  check("sg: wide port range covering 22 is caught",
    evaluateResource("sg_no_public_admin_ingress", res("sg", { ingress: [{ fromPort: 0, toPort: 65535, ipRanges: ["0.0.0.0/0"] }] }), { ports: [22] }).verdict === "violation");
  check("sg: 22 open to a specific CIDR is fine",
    evaluateResource("sg_no_public_admin_ingress", res("sg", { ingress: [{ fromPort: 22, toPort: 22, ipRanges: ["10.0.0.0/8"] }] }), { ports: [22] }).verdict === "compliant");

  check("cloudtrail: no trail is a violation",
    evaluateResource("cloudtrail_enabled", res("acct", { trails: [] }), { requireMultiRegion: true }).verdict === "violation");
  check("cloudtrail: logging multi-region trail is compliant",
    evaluateResource("cloudtrail_enabled", res("acct", { trails: [{ isLogging: true, isMultiRegion: true }] }), { requireMultiRegion: true }).verdict === "compliant");
  check("cloudtrail: trail that is not logging is a violation",
    evaluateResource("cloudtrail_enabled", res("acct", { trails: [{ isLogging: false, isMultiRegion: true }] }), { requireMultiRegion: true }).verdict === "violation");

  check("imdsv2: required is compliant",
    evaluateResource("ec2_imdsv2_required", res("i", { httpTokens: "required" }), {}).verdict === "compliant");
  check("imdsv2: optional is a violation",
    evaluateResource("ec2_imdsv2_required", res("i", { httpTokens: "optional" }), {}).verdict === "violation");

  check("rds: public access is a violation",
    evaluateResource("rds_no_public_access", res("db", { publiclyAccessible: true }), {}).verdict === "violation");
  check("rds: backup retention below minimum is a violation",
    evaluateResource("rds_backup_retention_min", res("db", { backupRetentionPeriod: 1 }), { minDays: 7 }).verdict === "violation");
}

// ── the Vanta-derived rules ───────────────────────────────────────────
{
  const db = (state: Record<string, any>) => res("db-1", state);

  // pgaudit — only meaningful on PostgreSQL engines.
  check("pgaudit: non-Postgres engine is not applicable",
    evaluateResource("rds_pgaudit_enabled", db({ engine: "mysql", parameters: {} }), {}).verdict === "not_applicable");
  check("pgaudit: loaded is compliant",
    evaluateResource("rds_pgaudit_enabled", db({ engine: "postgres", parameters: { shared_preload_libraries: "pg_stat_statements,pgaudit" } }), {}).verdict === "compliant");
  check("pgaudit: missing is a violation",
    evaluateResource("rds_pgaudit_enabled", db({ engine: "aurora-postgresql", parameters: { shared_preload_libraries: "pg_stat_statements" } }), {}).verdict === "violation");
  check("pgaudit: proposed fix appends rather than replacing",
    evaluateResource("rds_pgaudit_enabled", db({ engine: "postgres", parameters: { shared_preload_libraries: "pg_stat_statements" } }), {}).fix?.after === "pg_stat_statements,pgaudit");
  check("pgaudit: a library merely containing the name does not count",
    evaluateResource("rds_pgaudit_enabled", db({ engine: "postgres", parameters: { shared_preload_libraries: "pgaudit_extra" } }), {}).verdict === "violation");

  // TLS enforcement — the parameter differs by engine.
  check("tls: postgres with force_ssl=1 is compliant",
    evaluateResource("rds_ssl_enforced", db({ engine: "postgres", parameters: { "rds.force_ssl": "1" } }), {}).verdict === "compliant");
  check("tls: postgres with force_ssl=0 is a violation",
    evaluateResource("rds_ssl_enforced", db({ engine: "postgres", parameters: { "rds.force_ssl": "0" } }), {}).verdict === "violation");
  check("tls: mysql uses require_secure_transport",
    evaluateResource("rds_ssl_enforced", db({ engine: "mysql", parameters: { require_secure_transport: "ON" } }), {}).verdict === "compliant");
  check("tls: mysql unset is a violation",
    evaluateResource("rds_ssl_enforced", db({ engine: "mysql", parameters: {} }), {}).verdict === "violation");
  check("tls: an engine with no such parameter is not applicable",
    evaluateResource("rds_ssl_enforced", db({ engine: "oracle-se2", parameters: {} }), {}).verdict === "not_applicable");

  // Cross-region replication.
  const bucket = (state: Record<string, any>, tags: Record<string, string> = {}) => res("b", state, tags);
  check("replication: an enabled rule is compliant",
    evaluateResource("s3_cross_region_replication", bucket({ replicationRules: [{ status: "Enabled", destinationBucket: "arn:aws:s3:::dr-bucket" }] }), {}).verdict === "compliant");
  check("replication: none configured is a violation",
    evaluateResource("s3_cross_region_replication", bucket({ replicationRules: [] }), {}).verdict === "violation");
  check("replication: a disabled rule does not count",
    evaluateResource("s3_cross_region_replication", bucket({ replicationRules: [{ status: "Disabled" }] }), {}).verdict === "violation");
  check("replication: untagged buckets skipped when a tag is required",
    evaluateResource("s3_cross_region_replication", bucket({ replicationRules: [] }), { onlyTagged: "Backup" }).verdict === "not_applicable");
  check("replication: tagged buckets are still checked",
    evaluateResource("s3_cross_region_replication", bucket({ replicationRules: [] }, { Backup: "yes" }), { onlyTagged: "Backup" }).verdict === "violation");

  // CloudTrail bucket protection.
  check("trail bucket: ordinary buckets are not applicable",
    evaluateResource("cloudtrail_bucket_protected", bucket({ isCloudTrailBucket: false }), {}).verdict === "not_applicable");
  check("trail bucket: versioning + object lock is compliant",
    evaluateResource("cloudtrail_bucket_protected", bucket({ isCloudTrailBucket: true, versioning: "Enabled", objectLockEnabled: true }), {}).verdict === "compliant");
  check("trail bucket: versioning alone is a violation",
    evaluateResource("cloudtrail_bucket_protected", bucket({ isCloudTrailBucket: true, versioning: "Enabled", objectLockEnabled: false }), {}).verdict === "violation");
  check("trail bucket: names exactly what is missing",
    (evaluateResource("cloudtrail_bucket_protected", bucket({ isCloudTrailBucket: true, versioning: "Suspended", objectLockEnabled: false }), {}).summary ?? "")
      .includes("versioning and Object Lock"));
}

// ── exclusions ────────────────────────────────────────────────────────
{
  const list = (over: Partial<AwsExclusionList>): AwsExclusionList => ({
    id: "l1", name: "Sandbox", description: "", resources: [], patterns: [], whitelist: [],
    createdBy: "t", createdAt: "", updatedAt: "", ...over,
  });

  check("explicit resource is excluded",
    isExcluded(res("my-bucket", {}), [list({ resources: ["my-bucket"] })]).excluded);
  check("starts_with excludes",
    isExcluded(res("tmp-scratch", {}), [list({ patterns: [{ id: "p", type: "starts_with", value: "tmp-" }] })]).excluded);
  check("starts_with does not over-match",
    !isExcluded(res("prod-tmp", {}), [list({ patterns: [{ id: "p", type: "starts_with", value: "tmp-" }] })]).excluded);
  check("contains excludes",
    isExcluded(res("acme-sandbox-logs", {}), [list({ patterns: [{ id: "p", type: "contains", value: "sandbox" }] })]).excluded);
  check("tag_equals excludes",
    isExcluded(res("b", {}, { Env: "dev" }), [list({ patterns: [{ id: "p", type: "tag_equals", value: "Env=dev" }] })]).excluded);
  check("tag_equals does not match a different value",
    !isExcluded(res("b", {}, { Env: "prod" }), [list({ patterns: [{ id: "p", type: "tag_equals", value: "Env=dev" }] })]).excluded);
  check("bare tag key matches presence",
    isExcluded(res("b", {}, { Temporary: "yes" }), [list({ patterns: [{ id: "p", type: "tag_equals", value: "Temporary" }] })]).excluded);
  check("whitelist beats a matching pattern",
    !isExcluded(res("tmp-keepme", {}), [list({ whitelist: ["tmp-keepme"], patterns: [{ id: "p", type: "starts_with", value: "tmp-" }] })]).excluded);
  check("exclusion reports which list and clause matched",
    (isExcluded(res("tmp-x", {}), [list({ patterns: [{ id: "p", type: "starts_with", value: "tmp-" }] })]).reason ?? "").includes("Sandbox"));
  check("no lists means not excluded", !isExcluded(res("anything", {}), []).excluded);
}

// ── threshold vs target, and CloudWatch's fixed retention values ──────
{
  // minDays says what counts as a violation; setToDays says what to set.
  // Conflating them means you cannot flag at 1 year but store for 2.
  const split = { minDays: 365, setToDays: 731, leaveLongerAlone: true, neverExpireIsCompliant: true };
  const v = evaluateResource("log_retention_min", res("lg", { retentionInDays: 30 }), split);
  check("flags against minDays", v.verdict === "violation", v);
  check("but proposes setToDays, not minDays", v.fix?.after === "731 days", v.fix);

  const between = evaluateResource("log_retention_min", res("lg", { retentionInDays: 400 }), split);
  check("retention above minDays is compliant even if below setToDays", between.verdict === "compliant", between);

  const noTarget = evaluateResource("log_retention_min", res("lg", { retentionInDays: 30 }), { minDays: 365 });
  check("setToDays defaults to minDays when omitted", noTarget.fix?.after === "365 days", noTarget.fix);

  // CloudWatch rejects anything not in its fixed list, so values round up.
  check("snapRetention rounds up to an accepted value", snapRetention(500) === 545, snapRetention(500));
  check("snapRetention leaves an accepted value alone", snapRetention(365) === 365, snapRetention(365));
  check("snapRetention caps at the maximum", snapRetention(99999) === 3653, snapRetention(99999));
  check("every allowed value is accepted by CloudWatch",
    CLOUDWATCH_RETENTION_DAYS.every(d => snapRetention(d) === d));

  const odd = evaluateResource("log_retention_min", res("lg", { retentionInDays: 30 }),
    { minDays: 365, setToDays: 500 });
  check("an unaccepted target rounds up in the proposed fix", odd.fix?.after === "545 days", odd.fix);
}

// ── every rule kind is presentable in the UI ──────────────────────────
{
  check("every kind has a human title", CATALOG.every(k => !!k.title && !k.title.includes("_")),
    CATALOG.filter(k => !k.title || k.title.includes("_")).map(k => k.kind));
  check("every kind has a summary", CATALOG.every(k => !!k.summary));
  check("every kind declares a param schema", CATALOG.every(k => Array.isArray(k.paramSchema)));
  check("every default param is described in the schema",
    CATALOG.every(k => Object.keys(k.defaultParams).every(key => k.paramSchema.some(p => p.key === key))),
    CATALOG.filter(k => !Object.keys(k.defaultParams).every(key => k.paramSchema.some(p => p.key === key))).map(k => k.kind));
  check("every schema entry has a label and no raw key leaking into it",
    CATALOG.every(k => k.paramSchema.every(p => !!p.label && !p.label.includes("_"))));
}

// ── wiring ────────────────────────────────────────────────────────────
{
  check("catalog has 16 rule kinds", CATALOG.length === 16, CATALOG.length);
  check("CreateBucket triggers the S3 rules", kindsForEvent("CreateBucket").length >= 4, kindsForEvent("CreateBucket").map(k => k.kind));
  check("CreateLogGroup triggers retention", kindsForEvent("CreateLogGroup").some(k => k.kind === "log_retention_min"));
  check("unknown event triggers nothing", kindsForEvent("SomethingElse").length === 0);
  check("every kind declares a resource type", CATALOG.every(k => !!k.resourceType));
  check("every kind defaults to report mode", CATALOG.every(k => k.defaultMode === "report"));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
