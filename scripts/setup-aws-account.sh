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

# No default. A script that invents a region creates tables, buckets and
# instances somewhere nobody named, and the only symptom is an account that
# looks empty.
region_or_die() {
  local r="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  [ -n "$r" ] || r="$(aws configure get region 2>/dev/null || true)"
  if [ -z "$r" ]; then
    echo "No AWS region set. Export AWS_REGION, or give your AWS profile one." >&2
    exit 1
  fi
  printf '%s' "$r"
}
REGION="$(region_or_die)"
PREFIX="${STACK_NAME:-github-control-hub}"
SECRET_NAME="${SECRET_NAME:-${PREFIX}/secrets}"
# The webhook secret lives on its own, because the receiver Lambda is the only
# internet-facing component and must not hold a key to the App private key it
# never reads. See the receiver's grant in infra/cdk-stack.ts.
WEBHOOK_SECRET_NAME="${WEBHOOK_SECRET_NAME:-${PREFIX}/webhook-secret}"
AWS="aws --region $REGION"

echo "==> Target account"
$AWS sts get-caller-identity --output table
echo
echo "    region:  $REGION"
echo "    prefix:  $PREFIX"
echo "    secret:  $SECRET_NAME"
echo
# Confirm, unless the caller has already done so.
#
# migrate-to-account.sh asks its own "proceed against account N?" and then runs
# this with stdin closed, so `read` returned EOF, `confirm` was empty, and this
# aborted every time — reported one frame up as "Table creation failed", which
# describes a DynamoDB problem that was never there. A script driving another
# script has to be able to say it has consent.
if [ "${SKIP_CONFIRM:-}" = "1" ] || [ ! -t 0 ]; then
  echo "  (proceeding without prompting: not an interactive terminal)"
else
  read -r -p "Create resources in this account? [y/N] " confirm
  [[ "$confirm" == [yY] ]] || { echo "Aborted."; exit 1; }
fi

# ── 1. DynamoDB tables ──
# Key schemas are taken from the service layer, NOT from README.md — the
# README's table list is out of date and claims everything is keyed on `id`.
# Source of truth for each table is noted beside it below.
#
# The templates, rule-templates and exclusions tables were removed from this
# list when the templates feature was deleted, so a fresh account stops creating
# them. Accounts that already have them keep them, rows and all: nothing here
# drops a table, an unread table costs nothing at PAY_PER_REQUEST, and a
# deletion cannot be reversed.
TABLES=(
  alerts             # alertService.ts:86         Key: { id }
  widgets            # widgetService.ts:37        Key: { id }
  alarms             # alarmService.ts            Key: { id }
  ci-failures        # ciFailureService.ts        Key: { id }
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

# The alarms table also holds the pending-notification buffer, which is the only
# thing in it that expires. Without TTL those rows accumulate forever in a table
# the alarm evaluator scans on every tick.
# CI failure records expire after a week; correlation only looks at hours.
echo "==> Enabling TTL on ${PREFIX}-ci-failures"
ci_ttl=$($AWS dynamodb describe-time-to-live \
  --table-name "${PREFIX}-ci-failures" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)
if [[ "$ci_ttl" == "ENABLED" || "$ci_ttl" == "ENABLING" ]]; then
  echo "    already $ci_ttl"
else
  $AWS dynamodb update-time-to-live \
    --table-name "${PREFIX}-ci-failures" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null
  echo "    enabled"
fi

echo "==> Enabling TTL on ${PREFIX}-alarms"
alarm_ttl=$($AWS dynamodb describe-time-to-live \
  --table-name "${PREFIX}-alarms" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)
if [[ "$alarm_ttl" == "ENABLED" || "$alarm_ttl" == "ENABLING" ]]; then
  echo "    already $alarm_ttl"
else
  $AWS dynamodb update-time-to-live \
    --table-name "${PREFIX}-alarms" \
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
# What the account already holds, so an update does not demand credentials it
# could read. Re-running this on a configured account is the supported way to
# pick up new tables and new secrets; making that mean retyping the OAuth
# secret and the PAT is how people paste the wrong thing into the wrong prompt.
EXISTING_JSON=$($AWS secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
  --query SecretString --output text 2>/dev/null || echo '{}')

existing_val() {
  EXISTING_JSON="$EXISTING_JSON" KEY="$1" node -e '
    const d = JSON.parse(process.env.EXISTING_JSON || "{}");
    process.stdout.write(d[process.env.KEY] || "");
  ' 2>/dev/null
}

# Visible values show what is there; secrets only say that something is.
ask_visible() {  # ask_visible VAR_NAME "prompt" existing
  local __var="$1" __prompt="$2" __cur="$3" __in
  if [ -n "$__cur" ]; then
    read -r -p "  $__prompt [$__cur]: " __in
    printf -v "$__var" '%s' "${__in:-$__cur}"
  else
    read -r -p "  $__prompt: " __in
    printf -v "$__var" '%s' "$__in"
  fi
}

ask_secret() {   # ask_secret VAR_NAME "prompt" existing
  local __var="$1" __prompt="$2" __cur="$3" __in
  if [ -n "$__cur" ]; then
    read -r -s -p "  $__prompt [set — enter to keep]: " __in; echo
    printf -v "$__var" '%s' "${__in:-$__cur}"
  else
    read -r -s -p "  $__prompt: " __in; echo
    printf -v "$__var" '%s' "$__in"
  fi
}

ask_visible GITHUB_ORG        "GITHUB_ORG (as in github.com/orgs/<name>)" "$(existing_val GITHUB_ORG)"
ask_visible GITHUB_CLIENT_ID  "GITHUB_CLIENT_ID (OAuth app)"   "$(existing_val GITHUB_CLIENT_ID)"
ask_secret  GITHUB_CLIENT_SECRET "GITHUB_CLIENT_SECRET"        "$(existing_val GITHUB_CLIENT_SECRET)"
ask_secret  SYSTEM_GITHUB_TOKEN  "SYSTEM_GITHUB_TOKEN (PAT)"   "$(existing_val SYSTEM_GITHUB_TOKEN)"

# The webhook secret moved out of the bundle into its own secret. On an account
# set up before that, the bundle still holds it — offered here so the move needs
# no retyping and cannot end up with the two copies disagreeing.
WEBHOOK_CURRENT=$($AWS secretsmanager get-secret-value --secret-id "$WEBHOOK_SECRET_NAME" \
  --query SecretString --output text 2>/dev/null || existing_val GITHUB_WEBHOOK_SECRET)
ask_secret GITHUB_WEBHOOK_SECRET "GITHUB_WEBHOOK_SECRET (blank to skip)" "$WEBHOOK_CURRENT"

: "${GITHUB_ORG:?GITHUB_ORG is required}"
: "${GITHUB_CLIENT_ID:?GITHUB_CLIENT_ID is required}"
: "${GITHUB_CLIENT_SECRET:?GITHUB_CLIENT_SECRET is required}"
: "${SYSTEM_GITHUB_TOKEN:?SYSTEM_GITHUB_TOKEN is required}"

SECRET_JSON=$(GITHUB_ORG="$GITHUB_ORG" \
  GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
  GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" \
  SYSTEM_GITHUB_TOKEN="$SYSTEM_GITHUB_TOKEN" \
  node -e '
    const out = {
      GITHUB_ORG: process.env.GITHUB_ORG,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
      SYSTEM_GITHUB_TOKEN: process.env.SYSTEM_GITHUB_TOKEN,
    };
    process.stdout.write(JSON.stringify(out));
  ')

if $AWS secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "==> Updating existing secret $SECRET_NAME"
  # Merged, not replaced.
  #
  # put-secret-value overwrites the whole document, and this script only asks
  # for four of the values in it. Re-running it on a configured account used to
  # delete GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID
  # and JWT_SECRET — App auth would fail and every call would quietly drop to
  # the PAT's lower rate limit, which looks like the app getting slower rather
  # than like a wiped credential.
  EXISTING=$($AWS secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
    --query SecretString --output text 2>/dev/null || echo '{}')
  SECRET_JSON=$(EXISTING="$EXISTING" INCOMING="$SECRET_JSON" node -e '
    const existing = JSON.parse(process.env.EXISTING || "{}");
    const incoming = JSON.parse(process.env.INCOMING || "{}");
    // Only overwrite with values that were actually supplied.
    for (const [k, v] of Object.entries(incoming)) if (v) existing[k] = v;
    process.stdout.write(JSON.stringify(existing));
  ')
  KEPT=$(EXISTING="$EXISTING" node -e '
    const k = Object.keys(JSON.parse(process.env.EXISTING || "{}"));
    process.stdout.write(String(k.length));
  ')
  echo "    merged into $KEPT existing key(s); nothing removed"
  $AWS secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
else
  echo "==> Creating secret $SECRET_NAME"
  $AWS secretsmanager create-secret \
    --name "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
fi

# Written separately, and stored as the bare value rather than as JSON — the
# receiver reads this secret and nothing else, so there is nothing to wrap.
# Skipped rather than blanked when empty: an empty webhook secret would make
# the receiver fail closed and reject every delivery, which reads exactly like
# a broken deploy.
if [ -n "$GITHUB_WEBHOOK_SECRET" ]; then
  if $AWS secretsmanager describe-secret --secret-id "$WEBHOOK_SECRET_NAME" >/dev/null 2>&1; then
    echo "==> Updating existing secret $WEBHOOK_SECRET_NAME"
    $AWS secretsmanager put-secret-value \
      --secret-id "$WEBHOOK_SECRET_NAME" --secret-string "$GITHUB_WEBHOOK_SECRET" >/dev/null
  else
    echo "==> Creating secret $WEBHOOK_SECRET_NAME"
    $AWS secretsmanager create-secret --name "$WEBHOOK_SECRET_NAME" \
      --description "GitHub webhook HMAC secret. Read only by the internet-facing receiver Lambda." \
      --secret-string "$GITHUB_WEBHOOK_SECRET" >/dev/null
  fi
else
  echo "==> No webhook secret given; skipping $WEBHOOK_SECRET_NAME"
  echo "    Webhook deliveries will be rejected until it is set."
fi

echo
echo "Done. Launch the app with:"
echo "  cd github-control-hub/desktop && npm run dev"
