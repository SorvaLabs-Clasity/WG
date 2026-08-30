#!/usr/bin/env bash
#
# Put an account back to AWS-only after a deploy that forgot the flag.
#
# `cdk deploy` without `-c awsOnly=true` creates the GitHub half in whatever
# account you were pointed at: the webhook API and its queues, the webhook
# receiver and worker, the access-graph aggregator and its schedules, the WAF,
# and the webhook-deliveries table.
#
# ── why this is not a prune script ──
#
# Every one of those is owned by CloudFormation. Deleting them by hand leaves
# the stack in drift, and the next deploy tries to reconcile a reality that no
# longer matches its template. prune-github-tables.sh exists because the
# DynamoDB tables are deliberately *outside* CloudFormation; these are not.
#
# So the removal here is a redeploy with the flag that should have been there.
# CloudFormation removes what the template no longer declares, and it does it in
# the right order and with the right dependencies. Everything the stack creates
# carries RemovalPolicy.DESTROY, so nothing is left orphaned.
#
# What this script adds over typing that command is the part that is easy to get
# wrong: checking the account really is meant to be AWS-only before changing it,
# showing what is about to go, and verifying afterwards that it actually went.
#
# Usage:
#   ./scripts/revert-to-aws-only.sh            # show what would change
#   ./scripts/revert-to-aws-only.sh --apply    # redeploy with -c awsOnly=true

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

bold=$(tput bold 2>/dev/null || true); off=$(tput sgr0 2>/dev/null || true)
dim=$(tput dim 2>/dev/null || true)

step() { echo; echo "${bold}── $* ──${off}"; }
ok()   { echo "  ✓ $*"; }
skip() { echo "  ${dim}· $*${off}"; }
warn() { echo "  ! $*" >&2; }
die()  { echo; echo "  ✗ $*" >&2; exit 1; }
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply
  if [ -n "$__default" ]; then
    read -r -p "  $__prompt [$__default]: " __reply
    __reply="${__reply:-$__default}"
  else
    while [ -z "${__reply:-}" ]; do read -r -p "  $__prompt: " __reply; done
  fi
  printf -v "$__var" '%s' "$__reply"
}
confirm() { local r; read -r -p "  $1 [y/N] " r; [[ "$r" =~ ^([yY]|[yY][eE][sS])$ ]]; }

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

command -v aws >/dev/null || die "aws CLI not found."
command -v node >/dev/null || die "node not found."

# ── who and where ─────────────────────────────────────────────────────
step "Target account"

if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && aws sts get-caller-identity >/dev/null 2>&1; then
  echo "  using credentials from the environment"
else
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    echo "  the credentials exported in this shell are expired, ignoring them"
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  fi
  ask AWS_PROFILE_IN "AWS profile" "${AWS_PROFILE:-}"
  export AWS_PROFILE="$AWS_PROFILE_IN"
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "  no valid session for $AWS_PROFILE, signing in"
    aws sso login --profile "$AWS_PROFILE" || die "Could not sign in to '$AWS_PROFILE'."
  fi
fi

CALLER=$(aws sts get-caller-identity --output json 2>&1) \
  || { printf "  %s\n" "$CALLER"; die "Those credentials are not usable."; }
ACCOUNT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).Account)" "$CALLER")

DEFAULT_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
ask REGION "AWS region" "$DEFAULT_REGION"
export AWS_REGION="$REGION"
export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
ask PREFIX "Resource name prefix" "github-control-hub"

echo
echo "    account : $ACCOUNT"
echo "    region  : $REGION"
echo "    prefix  : $PREFIX"

# ── is this account meant to be AWS-only? ─────────────────────────────
step "Checking this account is meant to be AWS-only"

# On the credential, not on a flag somebody types. The definition of an
# AWS-only account is that the GitHub App private key is not in it, so that is
# what to look at. Running this against a full install would tear down its
# webhook pipeline and its access graph.
SECRET=$(aws secretsmanager get-secret-value --secret-id "${PREFIX}/secrets" \
  --query SecretString --output text 2>/dev/null || echo "")
if [ -z "$SECRET" ]; then
  warn "No ${PREFIX}/secrets in $ACCOUNT/$REGION. Check the prefix and region."
  confirm "Continue anyway?" || die "Stopped."
else
  HAS_KEY=$(SECRET="$SECRET" node -e '
    try { process.stdout.write(JSON.parse(process.env.SECRET).GITHUB_APP_PRIVATE_KEY ? "yes" : "no"); }
    catch { process.stdout.write("unknown"); }')
  case "$HAS_KEY" in
    yes)
      die "This account holds a GitHub App private key, so it is a full install.
     Reverting it would remove the webhook pipeline and the access graph.
     Refusing.";;
    unknown) warn "Could not read the secret; continuing on your confirmation alone.";;
    no)      ok "No GitHub App private key, so the GitHub half has nothing to run on";;
  esac
fi

# ── what is there now ─────────────────────────────────────────────────
step "GitHub resources currently deployed"

FOUND=0
for fn in webhook-receiver webhook-worker graph-aggregator; do
  if aws lambda get-function --function-name "${PREFIX}-${fn}" >/dev/null 2>&1; then
    echo "    lambda    ${PREFIX}-${fn}"
    FOUND=$((FOUND + 1))
  fi
done
if aws dynamodb describe-table --table-name "${PREFIX}-webhook-deliveries" >/dev/null 2>&1; then
  echo "    table     ${PREFIX}-webhook-deliveries"
  FOUND=$((FOUND + 1))
fi
for rule in graph-light-refresh; do
  if aws events describe-rule --name "${PREFIX}-${rule}" >/dev/null 2>&1; then
    echo "    rule      ${PREFIX}-${rule}"
    FOUND=$((FOUND + 1))
  fi
done

# The alarm evaluator and the guardrail enforcer are in both modes. Naming them
# here stops somebody reading the list above as "everything gets removed".
echo
echo "  ${dim}Staying, because an AWS-only install has them too:"
echo "    ${PREFIX}-guardrail-enforcer, ${PREFIX}-alarm-evaluator${off}"

if [ "$FOUND" = "0" ]; then
  echo
  ok "Nothing GitHub-only is deployed. This account already looks AWS-only."
  echo "  ${dim}If a deploy is in progress, wait for it and run this again.${off}"
  exit 0
fi

# ── the redeploy ──────────────────────────────────────────────────────
step "Redeploy with -c awsOnly=true"

if [ "$APPLY" = "0" ]; then
  echo "  Dry run. $FOUND GitHub resource(s) would be removed by:"
  echo
  echo "      cd github-control-hub/infra"
  echo "      STACK_NAME=$PREFIX AWS_REGION=$REGION npx cdk deploy -c awsOnly=true"
  echo
  echo "  Re-run with --apply to do it here:"
  echo "      ./scripts/revert-to-aws-only.sh --apply"
  exit 0
fi

echo "  CloudFormation removes what the template no longer declares."
echo "  Queues drain and API Gateway detaches, so this takes a few minutes."
confirm "Redeploy $PREFIX in $ACCOUNT/$REGION as AWS-only?" || die "Stopped."

cd "$ROOT/github-control-hub/infra" || die "Could not find the infra directory."
[ -d node_modules ] || { echo "  installing CDK deps…"; npm install --silent; }

STACK_NAME="$PREFIX" npx cdk deploy --require-approval never -c awsOnly=true \
  || die "cdk deploy failed. Nothing has been half-removed: CloudFormation rolls back."
cd "$ROOT"

# ── verify ────────────────────────────────────────────────────────────
step "Verifying"

LEFT=0
for fn in webhook-receiver webhook-worker graph-aggregator; do
  if aws lambda get-function --function-name "${PREFIX}-${fn}" >/dev/null 2>&1; then
    warn "${PREFIX}-${fn} is still there"
    LEFT=$((LEFT + 1))
  else
    ok "${PREFIX}-${fn} removed"
  fi
done
if aws dynamodb describe-table --table-name "${PREFIX}-webhook-deliveries" >/dev/null 2>&1; then
  warn "${PREFIX}-webhook-deliveries is still there"
  LEFT=$((LEFT + 1))
else
  ok "${PREFIX}-webhook-deliveries removed"
fi

for fn in guardrail-enforcer alarm-evaluator; do
  aws lambda get-function --function-name "${PREFIX}-${fn}" >/dev/null 2>&1 \
    && ok "${PREFIX}-${fn} still running, as it should be" \
    || warn "${PREFIX}-${fn} is missing, which an AWS-only install needs"
done

# The tables the GitHub half writes to are outside CloudFormation, so this
# deploy neither created nor removed them. If an earlier full setup made them,
# prune-github-tables.sh is what takes them away.
step "Not covered by this"
STRAY=0
for t in alerts scanners graph-edges; do
  if aws dynamodb describe-table --table-name "${PREFIX}-${t}" >/dev/null 2>&1; then
    echo "    ${PREFIX}-${t}"
    STRAY=$((STRAY + 1))
  fi
done
# API Gateway's CloudWatch role is account-wide, one per account and region, and
# CDK retains it on purpose: deleting it would take logging away from every
# other API Gateway in the account, which this stack knows nothing about. It is
# an IAM role holding one AWS-managed policy, it costs nothing, and it does
# nothing while no API exists. Reported so it is not a surprise, never deleted.
API_ROLE=$(aws iam list-roles \
  --query "Roles[?contains(RoleName, 'WebhookApiCloudWatchRole')].RoleName" \
  --output text 2>/dev/null || true)
if [ -n "$API_ROLE" ] && [ "$API_ROLE" != "None" ]; then
  echo "    $API_ROLE  ${dim}(IAM role, account-wide)${off}"
  echo "    ${dim}Left deliberately: API Gateway has one CloudWatch role per"
  echo "    account and region, and removing it would take logging away from"
  echo "    any other API Gateway here. Harmless while unused.${off}"
  echo
fi

if [ "$STRAY" = "0" ]; then
  ok "No GitHub-only tables, so there is nothing left to prune"
else
  echo
  echo "  Those are DynamoDB tables, which live outside CloudFormation on"
  echo "  purpose so that a stack teardown cannot take the activity log with"
  echo "  them. Remove them with:"
  echo "      ./scripts/prune-github-tables.sh --apply"
fi

step "Done"
if [ "$LEFT" = "0" ]; then
  echo "  This account is AWS-only again."
else
  warn "$LEFT resource(s) survived. Check the CloudFormation events for the"
  warn "  $PREFIX stack; a queue with messages in flight can delay a delete."
fi
