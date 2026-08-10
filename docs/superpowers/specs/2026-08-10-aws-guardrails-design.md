# AWS Guardrails — Phase 1 design

**Date:** 2026-08-10

## Goal

Rules that say what an AWS resource must look like, applied to resources as they
are created and runnable on demand against existing ones, with exclusion lists —
the shape of the GitHub template system, pointed at AWS.

Single account: the production account. Other environments are out of scope.

## Architecture

Enforcement runs in **Lambda**, not on the EC2 instance.

```
CreateBucket / CreateLogGroup / …
        │  CloudTrail → EventBridge
        ▼
┌────────────────────────┐   rules + exclusions    ┌──────────┐
│  guardrail-enforcer    │◄───────────────────────►│ DynamoDB │
│       (Lambda)         │   findings + activity   └──────────┘
└────────────────────────┘
        ▲            ▲
        │            └─ on-demand invoke from the app (manual run)
        └─ EventBridge schedule, every 15 min (sweep)
```

**One implementation, three triggers.** Event, schedule and manual run invoke the
same handler with different payloads. The GitHub side already demonstrated what
happens when the automatic and manual paths diverge; this avoids repeating it.

The app's backend never evaluates or remediates. It does CRUD on rules and
exclusions, reads findings, and invokes the Lambda. That keeps a single copy of
the logic.

### CloudTrail is a prerequisite for the fast path

`CreateBucket` and `CreateLogGroup` reach EventBridge only as "AWS API Call via
CloudTrail" events, which requires a trail logging management events in the
region. The test account has no trail today.

The 15-minute sweep therefore is not an optimisation, it is the floor: without a
trail the system still works, just with sweep latency. `cloudtrail_enabled` is
also a rule in the catalog, so the app reports when its own prerequisite is
missing.

## Data

Three tables, following the existing naming:

| Table | Key | Holds |
|---|---|---|
| `<prefix>-aws-guardrails` | `id` | rule definitions |
| `<prefix>-aws-exclusions` | `id` | exclusion lists |
| `<prefix>-aws-findings` | `pk` = `FINDING`, `sk` = `<ruleId>#<resourceId>` | latest evaluation per resource |

Findings are stored rather than recomputed so the UI loads instantly and history
survives a sweep.

### Rule

```ts
{
  id, name, description,
  kind: GuardrailKind,
  enabled: boolean,
  mode: "report" | "enforce",     // report is the default
  applyOnCreate: boolean,
  params: Record<string, unknown>, // kind-specific, all thresholds live here
  exclusionLists: string[],
  createdBy, createdAt, updatedAt
}
```

### Exclusions

Mirrors the GitHub model — explicit names, `starts_with`, `contains`, a
whitelist that wins over patterns — plus `tag_equals`, the AWS equivalent of
the CODEOWNERS pattern.

## Catalog

Safe to auto-remediate:

| kind | params |
|---|---|
| `s3_https_only` | `sid` |
| `log_retention_min` | `minDays`, `leaveLongerAlone`, `neverExpireIsCompliant` |
| `s3_block_public_access` | — |
| `s3_default_encryption` | `algorithm` |
| `s3_versioning` | — |
| `ebs_encryption_default` | — (account-level) |
| `rds_backup_retention_min` | `minDays` |
| `iam_password_policy` | `minLength`, `maxAgeDays`, `reusePrevention` |

Report-only by default — remediation can cut live access:

| kind | params |
|---|---|
| `sg_no_public_admin_ingress` | `ports` |
| `rds_no_public_access` | — |
| `ec2_imdsv2_required` | — |
| `cloudtrail_enabled` | `requireMultiRegion` |

## Safety

Bucket policies can lock an account out of its own bucket, so:

- rules default to `report`; promotion to `enforce` requires `control-hub-admins`
- the HTTPS statement is merged **by `Sid`**, never replacing the document
- the prior state is written into the activity entry's `undoPayload`, so the
  existing undo works
- a preview endpoint returns the exact before/after without applying

## API

```
GET    /api/aws/guardrails            list rules
POST   /api/aws/guardrails            create          (enforce mode -> admin)
PUT    /api/aws/guardrails/:id        update          (enforce mode -> admin)
DELETE /api/aws/guardrails/:id
GET    /api/aws/findings              latest findings, filterable
POST   /api/aws/run                   invoke a sweep or a single-resource run
POST   /api/aws/preview               evaluate + diff, never writes
GET    /api/aws/exclusions            CRUD, mirroring the GitHub routes
```

## UI

A new top-level **AWS** tab. Resource types, rules and exclusions share nothing
with GitHub repos; merging them would make both harder to navigate.

Rules list with mode badges, a findings table grouped by rule, a Run button, and
the exclusion-list editor reused in shape from the GitHub side.

## Out of scope for Phase 1

Multi-account, non-production environments, and any rule kind not listed above.
New kinds should be catalog entries, not architecture.

## Testing

Rule kinds are pure functions of (resource state, params) → verdict, tested
directly. Remediation is tested against a fake AWS client, asserting: policy
merge preserves unrelated statements; retention leaves longer periods and
never-expire alone; exclusions suppress both evaluation and remediation;
`report` mode never writes.
