# Data

Everything persists in DynamoDB, on-demand billing. There is no other database.

## Tables

All prefixed `github-control-hub-` by default (`STACK_NAME` overrides it).

| Table | Key | Holds |
|---|---|---|
| `activity` | `pk="ACTIVITY"`, `sk="<ts>#<id>"` | The audit feed, TTL 13 months |
| `templates` | `id` | Historical only — the Templates feature was removed; rows are kept readable, nothing writes new ones |
| `rule-templates` | `id` | Historical only, same reason |
| `exclusions` | `id` | Historical only, same reason |
| `widgets` | `id` | Saved Overview cards |
| `scanners` | `id` | Saved multi-condition scans |
| `alerts` | `id` | Alert configuration |
| `graph-edges` | `pk`, `sk` | The graph — see [graph model](graph-model.md) |
| `org-config` | `org` | Feature flags, compliance config, AWS account registry |
| `compliance-cache` | `repo` | Per-repo compliance score |
| `auth-codes` | `code` | Short-lived OAuth exchange codes, TTL |
| `aws-guardrails` | `id` | AWS rules |
| `aws-exclusions` | `id` | AWS exclusion lists |
| `aws-findings` | `pk="FINDING"`, `sk` | Latest verdict per account/region/rule/resource |
| `alarms` | `id` | Widget alarms and their state, email groups, notification settings — one table, rows told apart by `kind` |

## Two design notes worth knowing

**`org-config` is a general key-value table.** It is keyed on a single string
and holds several unrelated rows — feature flags under the org name, compliance
config under `compliance-config`, and the AWS account registry under
`aws-accounts`. Adding the registry there rather than creating a fifteenth table
meant multi-account support needed no new setup step.

**Findings are keyed on account and region.** `<accountId>#<region>#<ruleId>#<resourceId>`.
Two accounts routinely have a log group with the same name, and a shorter key
would have them overwrite each other's verdict on alternate sweeps.

## Cost

Trivially small. On-demand pricing, a few thousand items, a few thousand
requests a day — measured at roughly $0.02/month. See
[cost](../infrastructure/cost.md) for what the rest of the system costs.
