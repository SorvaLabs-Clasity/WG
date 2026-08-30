#!/usr/bin/env bash
#
# Remove the GitHub-only DynamoDB tables from an AWS-only account.
#
# For accounts set up before setup-aws-only.sh stopped creating them.
#
# It used to create all twelve tables and leave the unused ones empty, on the
# reasoning that an idle on-demand table costs nothing. It now passes AWS_ONLY=1
# to setup-aws-account.sh, which skips them, so a freshly created account has
# nothing for this script to find and running it is a no-op.
#
# Run it on an account created before that change. It is tidiness, not a cost
# saving, and it is optional.
#
# ── what this does NOT touch ──
#
# Lambdas, EventBridge rules, queues and the webhook-deliveries table are owned
# by CloudFormation. `-c awsOnly=true` never creates the GitHub ones, so they are
# not there to remove; and if they ever are, deleting them by hand puts the stack
# in drift and the next deploy fights you. The fix there is always to redeploy
# with the flag, which is reported rather than done.
#
# The tables are different: setup-aws-account.sh creates them outside
# CloudFormation on purpose, so that `cdk destroy` cannot take the activity log
# with it. Nothing reconciles them, so removing one by hand is legitimate.
#
# ── the safety rule ──
#
# Only empty tables are deleted, and only from the fixed list below. An empty
# table is the proof that nothing in this account uses it: if something had
# written a row, it would not be empty, and the deletion is refused.
#
# Dry run by default. Pass --apply to actually delete.
#
# Usage:
#   ./scripts/prune-github-tables.sh            # show what would go
#   ./scripts/prune-github-tables.sh --apply    # delete the empty ones

set -uo pipefail

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

# The same credential resolution as the setup scripts, for the same reason:
# exported keys beat a profile in AWS's chain, so a stale export silently wins
# over the profile that would have worked.
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
ask PREFIX "Resource name prefix" "github-control-hub"

echo
echo "    account : $ACCOUNT"
echo "    region  : $REGION"
echo "    prefix  : $PREFIX"

# ── is this actually an AWS-only account? ─────────────────────────────
step "Checking this is an AWS-only install"

# Refusing on the credential rather than on a flag somebody typed. The whole
# definition of an AWS-only account is that the GitHub App private key is not in
# it, so that is the thing to look at. Running this against a full install would
# delete the access graph.
SECRET=$(aws secretsmanager get-secret-value --secret-id "${PREFIX}/secrets" \
  --query SecretString --output text 2>/dev/null || echo "")
if [ -z "$SECRET" ]; then
  warn "No ${PREFIX}/secrets in $ACCOUNT/$REGION."
  warn "That may just mean a different prefix or region. Check before continuing."
  confirm "Continue anyway?" || die "Stopped."
else
  HAS_KEY=$(SECRET="$SECRET" node -e '
    try { process.stdout.write(JSON.parse(process.env.SECRET).GITHUB_APP_PRIVATE_KEY ? "yes" : "no"); }
    catch { process.stdout.write("unknown"); }')
  case "$HAS_KEY" in
    yes)
      die "This account holds a GitHub App private key, so it is a full install.
     These tables are in use here. Refusing.";;
    unknown) warn "Could not read the secret's contents; continuing on the empty check alone.";;
    no)      ok "No GitHub App private key, consistent with an AWS-only install";;
  esac
fi

# ── the CloudFormation half, reported only ────────────────────────────
step "CloudFormation resources"

STRAY=0
for fn in webhook-receiver webhook-worker graph-aggregator; do
  if aws lambda get-function --function-name "${PREFIX}-${fn}" >/dev/null 2>&1; then
    warn "${PREFIX}-${fn} exists. That means this stack was deployed without"
    warn "  -c awsOnly=true at some point."
    STRAY=1
  fi
done
if [ "$STRAY" = "1" ]; then
  echo
  echo "  Do not delete those by hand: CloudFormation owns them, and removing"
  echo "  them out of band leaves the stack in drift. Redeploy instead:"
  echo
  echo "      cd github-control-hub/infra"
  echo "      STACK_NAME=$PREFIX npx cdk deploy -c awsOnly=true"
  echo
  echo "  That removes them, and their rules and queues, in one step."
else
  ok "No GitHub-only Lambdas, which is what -c awsOnly=true should leave"
fi

# ── the tables ────────────────────────────────────────────────────────
step "GitHub-only tables"

# Deliberately short, and deliberately not "everything the AWS half does not
# name". Each of these belongs to a tab the GitHub gate refuses in this kind of
# account, so nothing here can reach them.
#
# `widgets` is missing from this list on purpose. The alarm evaluator resolves a
# subject through it for any alarm that is not a guardrail one, so a deleted
# table turns a missing widget from "undefined", which the evaluator handles and
# reports, into a thrown ResourceNotFoundException in the middle of a pass. It
# is empty and it costs nothing; leaving it is the cheaper mistake.
#
# `webhook-deliveries` is missing because CloudFormation owns it, and because
# -c awsOnly=true never creates it.
CANDIDATES=(
  graph-edges    # the access graph: Access, Repos, Who knows
  alerts         # security alerts, written by the GitHub webhook
  scanners       # scanner configuration, GitHub only
)

DELETED=0 KEPT=0 ABSENT=0
for t in "${CANDIDATES[@]}"; do
  name="${PREFIX}-${t}"

  if ! aws dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then
    skip "$name is not here"
    ABSENT=$((ABSENT + 1))
    continue
  fi

  # Scan for one item rather than trusting describe-table's ItemCount, which
  # AWS updates roughly every six hours. A table emptied an hour ago still
  # reports its old count, and a table written to an hour ago still reports
  # zero: on this decision that second case deletes live data.
  COUNT=$(aws dynamodb scan --table-name "$name" --max-items 1 \
    --query 'length(Items)' --output text 2>/dev/null || echo "error")

  if [ "$COUNT" = "error" ]; then
    warn "$name could not be read, leaving it alone"
    KEPT=$((KEPT + 1))
    continue
  fi

  if [ "$COUNT" != "0" ]; then
    warn "$name has rows in it, so something here uses it. Leaving it alone."
    KEPT=$((KEPT + 1))
    continue
  fi

  if [ "$APPLY" = "0" ]; then
    echo "  would delete: $name ${dim}(empty)${off}"
    DELETED=$((DELETED + 1))
    continue
  fi

  if aws dynamodb delete-table --table-name "$name" >/dev/null 2>&1; then
    ok "deleted $name"
    DELETED=$((DELETED + 1))
  else
    warn "could not delete $name"
    KEPT=$((KEPT + 1))
  fi
done

# ── what stays, and why ───────────────────────────────────────────────
step "Kept, because this account uses them"
echo "    ${PREFIX}-aws-guardrails    the rules"
echo "    ${PREFIX}-aws-exclusions    exclusion lists"
echo "    ${PREFIX}-aws-findings      what the sweep found"
echo "    ${PREFIX}-alarms            alarms on those rules, and their state"
echo "    ${PREFIX}-org-config        Teams delivery, groups, settings"
echo "    ${PREFIX}-activity          the record of what the guardrails did"
echo "    ${PREFIX}-auth-codes        sign-in"
echo "    ${PREFIX}-widgets           empty, and read when an alarm is resolved"

step "Done"
if [ "$APPLY" = "0" ]; then
  echo "  Dry run. $DELETED would be deleted, $KEPT kept, $ABSENT already gone."
  echo
  echo "  Re-run with --apply to delete them:"
  echo "      ./scripts/prune-github-tables.sh --apply"
else
  echo "  $DELETED deleted, $KEPT kept, $ABSENT already gone."
  echo
  echo "  ${dim}Nothing in this account reads them, and setup-aws-only.sh no longer"
  echo "  creates them, so re-running it will not bring them back. If you later"
  echo "  turn this into a full install, setup-aws-account.sh recreates them"
  echo "  without AWS_ONLY=1.${off}"
fi
