#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# GitHub Control Hub — Provision a fresh AWS account
#
# Creates every resource the app expects in whichever account
# your credentials currently point at:
#   - 14 DynamoDB tables (PAY_PER_REQUEST)
#   - TTL on the auth-codes table
#   - the Secrets Manager secret holding GitHub credentials
#
# Idempotent: existing tables and secrets are left alone
# (the secret is updated in place if it already exists).
#
# Prerequisites:
#   AWS CLI configured for the TARGET account
#     aws sso login --profile <profile>     # SSO
#     aws configure --profile <profile>     # access keys
#
# Usage:
#   AWS_PROFILE=<profile> ./scripts/setup-aws-account.sh
#
#   # skip the secret (create it yourself later):
#   AWS_PROFILE=<profile> SKIP_SECRET=1 ./scripts/setup-aws-account.sh
#
# Environment:
#   AWS_PROFILE    profile to use            (default: default)
#   AWS_REGION     region                    (default: us-east-1)
#   STACK_NAME     table name prefix         (default: github-control-hub)
#   SECRET_NAME    secret name               (default: <STACK_NAME>/secrets)
#   SKIP_SECRET    set to 1 to skip step 3
# ─────────────────────────────────────────────────────────

REGION="${AWS_REGION:-us-east-1}"
PREFIX="${STACK_NAME:-github-control-hub}"
SECRET_NAME="${SECRET_NAME:-${PREFIX}/secrets}"
AWS="aws --region $REGION"

echo "==> Target account"
$AWS sts get-caller-identity --output table
echo
echo "    region:  $REGION"
echo "    prefix:  $PREFIX"
echo "    secret:  $SECRET_NAME"
echo
read -r -p "Create resources in this account? [y/N] " confirm
[[ "$confirm" == [yY] ]] || { echo "Aborted."; exit 1; }

# ── 1. DynamoDB tables ──
# Key schemas are taken from the service layer, NOT from README.md — the
# README's table list is out of date and claims everything is keyed on `id`.
# Source of truth for each table is noted beside it below.
TABLES=(
  templates          # templateService.ts:171     Key: { id }
  rule-templates     # ruleTemplateService.ts:42  Key: { id }
  alerts             # alertService.ts:86         Key: { id }
  exclusions         # exclusionService.ts:49     Key: { id }
  widgets            # widgetService.ts:37        Key: { id }
)

create_table() {
  local name="$1"; shift
  if $AWS dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then
    echo "    exists:  $name"
    return
  fi
  echo "    create:  $name"
  $AWS dynamodb create-table --table-name "$name" --billing-mode PAY_PER_REQUEST "$@" >/dev/null
}

echo "==> Creating DynamoDB tables"
for t in "${TABLES[@]}"; do
  create_table "${PREFIX}-${t}" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH
done

# activity — single-partition time series: pk="ACTIVITY", sk="<timestamp>#<id>"
# activityService.ts:135 (write) and :150 (Query on pk)
#
# Two sparse indexes, because one partition key means neither lookup below can
# be a key condition on the base table. Without them both fall back to reading
# the newest rows and filtering, which answers "is it recent?" instead of "does
# it exist?" — correct on a small log, silently wrong on a large one.
#   id-index        getActivityById   — every row has an id
#   parentId-index  getChildActivities — only child rows have a parentId, so
#                                        the index holds exactly those
create_table "${PREFIX}-activity" \
  --attribute-definitions \
      AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
      AttributeName=id,AttributeType=S AttributeName=parentId,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --global-secondary-indexes \
      'IndexName=id-index,KeySchema=[{AttributeName=id,KeyType=HASH}],Projection={ProjectionType=ALL}' \
      'IndexName=parentId-index,KeySchema=[{AttributeName=parentId,KeyType=HASH}],Projection={ProjectionType=ALL}' 

# scanners — pk="SCANNER", sk=<scanner id>   scannerService.ts:88
create_table "${PREFIX}-scanners" \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE

# graph-edges — graphEdgeService.ts:13
create_table "${PREFIX}-graph-edges" \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE

# org-config — keyed on `org`. Holds the org feature flags (org=<org name>),
# the compliance rule config (org="compliance-config") and the registry of AWS
# accounts the guardrails sweep (org="aws-accounts").
# orgConfigService.ts:29, complianceConfigService.ts:88, aws-guardrails/accounts.ts
create_table "${PREFIX}-org-config" \
  --attribute-definitions AttributeName=org,AttributeType=S \
  --key-schema AttributeName=org,KeyType=HASH

# compliance-cache — one row per repo, keyed on `repo`
# complianceCacheService.ts:31 writing a RepoComplianceScore
create_table "${PREFIX}-compliance-cache" \
  --attribute-definitions AttributeName=repo,AttributeType=S \
  --key-schema AttributeName=repo,KeyType=HASH

# auth-codes is keyed on `code`, and rows expire via a `ttl` attribute
# routes/auth.ts:55
create_table "${PREFIX}-auth-codes" \
  --attribute-definitions AttributeName=code,AttributeType=S \
  --key-schema AttributeName=code,KeyType=HASH

# ── AWS guardrails ──
# aws-guardrails / aws-exclusions are keyed on `id`   aws-guardrails/store.ts
create_table "${PREFIX}-aws-guardrails" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH

create_table "${PREFIX}-aws-exclusions" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH


# findings are keyed pk="FINDING", sk="<ruleId>#<resourceId>" so a re-run
# overwrites in place rather than accumulating   aws-guardrails/store.ts
create_table "${PREFIX}-aws-findings" \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE

# ── 1b. Indexes on an activity table that already existed ──
# create_table leaves existing tables alone, so a re-run against an account
# provisioned before these indexes existed would silently skip them — and the
# lookups they support fail by returning nothing rather than erroring.
echo "==> Checking activity table indexes"
$AWS dynamodb wait table-exists --table-name "${PREFIX}-activity"
for pair in "id-index:id" "parentId-index:parentId"; do
  idx="${pair%%:*}"; attr="${pair##*:}"
  have=$($AWS dynamodb describe-table --table-name "${PREFIX}-activity" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='${idx}'].IndexName" --output text 2>/dev/null || true)
  if [[ "$have" == *"$idx"* ]]; then
    echo "    $idx already present"
    continue
  fi
  echo "    creating $idx (backfill can take several minutes)"
  $AWS dynamodb update-table --table-name "${PREFIX}-activity" \
    --attribute-definitions AttributeName=${attr},AttributeType=S \
    --global-secondary-index-updates \
      "[{\"Create\":{\"IndexName\":\"${idx}\",\"KeySchema\":[{\"AttributeName\":\"${attr}\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}}]" >/dev/null
  # Only one index can be added at a time, so wait before the next.
  until [[ "$($AWS dynamodb describe-table --table-name "${PREFIX}-activity" \
      --query "Table.GlobalSecondaryIndexes[?IndexName=='${idx}'].IndexStatus" --output text)" == "ACTIVE" ]]; do
    sleep 10
  done
  echo "    $idx active"
done
echo

# ── 2. TTL on auth-codes ──
echo "==> Waiting for tables to become ACTIVE"
for t in "${TABLES[@]}" activity scanners graph-edges org-config compliance-cache auth-codes aws-guardrails aws-exclusions aws-findings; do
  $AWS dynamodb wait table-exists --table-name "${PREFIX}-${t}"
done

# ── 2b. Retention on the activity table ──
# Thirteen months: a year of audit history plus a month of slack, so an auditor
# looking back twelve months always finds a complete record. Rows carry a `ttl`
# stamped from their own timestamp; DynamoDB only deletes items that have one,
# so a table with TTL enabled but unstamped rows keeps them forever.
echo "==> Enabling TTL on ${PREFIX}-activity"
act_ttl=$($AWS dynamodb describe-time-to-live \
  --table-name "${PREFIX}-activity" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)
if [[ "$act_ttl" == "ENABLED" || "$act_ttl" == "ENABLING" ]]; then
  echo "    already $act_ttl"
else
  $AWS dynamodb update-time-to-live \
    --table-name "${PREFIX}-activity" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null
  echo "    enabled"
fi

echo "==> Enabling TTL on ${PREFIX}-auth-codes"
ttl_status=$($AWS dynamodb describe-time-to-live \
  --table-name "${PREFIX}-auth-codes" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)
if [[ "$ttl_status" == "ENABLED" || "$ttl_status" == "ENABLING" ]]; then
  echo "    already $ttl_status"
else
  $AWS dynamodb update-time-to-live \
    --table-name "${PREFIX}-auth-codes" \
    --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null
  echo "    enabled"
fi

# ── 3. Secrets Manager ──
if [[ "${SKIP_SECRET:-}" == "1" ]]; then
  echo "==> Skipping secret (SKIP_SECRET=1)"
  echo
  echo "Create it later with:"
  echo "  aws secretsmanager create-secret --name \"$SECRET_NAME\" --secret-string '{...}'"
  exit 0
fi

echo
echo "==> GitHub credentials for $SECRET_NAME"
echo "    These are GitHub values, not AWS — they carry over from the old account."
echo "    The OAuth app callback URL must be http://localhost:4321/auth/callback"
echo
read -r -p "  GITHUB_ORG (organization name): " GITHUB_ORG
read -r -p "  GITHUB_CLIENT_ID (OAuth app):   " GITHUB_CLIENT_ID
read -r -s -p "  GITHUB_CLIENT_SECRET:           " GITHUB_CLIENT_SECRET; echo
read -r -s -p "  SYSTEM_GITHUB_TOKEN (PAT):      " SYSTEM_GITHUB_TOKEN; echo
read -r -s -p "  GITHUB_WEBHOOK_SECRET (blank to skip): " GITHUB_WEBHOOK_SECRET; echo

: "${GITHUB_ORG:?GITHUB_ORG is required}"
: "${GITHUB_CLIENT_ID:?GITHUB_CLIENT_ID is required}"
: "${GITHUB_CLIENT_SECRET:?GITHUB_CLIENT_SECRET is required}"
: "${SYSTEM_GITHUB_TOKEN:?SYSTEM_GITHUB_TOKEN is required}"

SECRET_JSON=$(GITHUB_ORG="$GITHUB_ORG" \
  GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
  GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" \
  SYSTEM_GITHUB_TOKEN="$SYSTEM_GITHUB_TOKEN" \
  GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" \
  node -e '
    const out = {
      GITHUB_ORG: process.env.GITHUB_ORG,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
      SYSTEM_GITHUB_TOKEN: process.env.SYSTEM_GITHUB_TOKEN,
    };
    if (process.env.GITHUB_WEBHOOK_SECRET) out.GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
    process.stdout.write(JSON.stringify(out));
  ')

if $AWS secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "==> Updating existing secret $SECRET_NAME"
  $AWS secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
else
  echo "==> Creating secret $SECRET_NAME"
  $AWS secretsmanager create-secret \
    --name "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
fi

echo
echo "Done. Launch the app with:"
echo "  cd github-control-hub/desktop && npm run dev"
