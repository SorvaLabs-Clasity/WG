#!/usr/bin/env bash
#
# GitHub Control Hub — the AWS guardrails, and nothing about GitHub.
#
# For an account that should run the guardrails while holding nothing about your
# GitHub organization: no App private key, no access graph, no webhook, no
# repository data. The app still runs and the AWS tab still works; every GitHub
# tab is refused, by the backend rather than by hiding a button.
#
# What lands here:
#   - the DynamoDB tables, created by setup-aws-account.sh so their schemas
#     cannot drift from the ones the app reads. The six only the GitHub half
#     writes to are created and stay empty; an idle on-demand table costs
#     nothing, and a second hand-written copy of twelve schemas does not stay
#     right.
#   - one Lambda on a fifteen-minute schedule, plus a CloudTrail rule so it also
#     reacts to resources being created
#   - a secret holding only what sign-in needs
#
# What deliberately does not:
#   - the GitHub App private key and installation id. This is the credential
#     that reads your organization, and it is the whole point of the exercise.
#   - the webhook endpoint, the access graph, the alarm evaluator, the audit-log
#     pipeline. `cdk deploy -c awsOnly=true` creates none of them.
#
# Sign-in still uses GitHub, because that is how this app knows who you are and
# which team you are on. That needs the OAuth App's client id and secret — an
# identity check against github.com, carrying no access to your repositories
# beyond what the person signing in already has.
#
# Safe to re-run. Every step checks for what it is about to create.

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
ask_secret_keep() {
  local __var="$1" __prompt="$2" __current="$3" __reply
  if [ -n "$__current" ]; then
    read -r -s -p "  $__prompt [enter to keep the stored one]: " __reply; echo
    __reply="${__reply:-$__current}"
  else
    while [ -z "${__reply:-}" ]; do read -r -s -p "  $__prompt: " __reply; echo; done
  fi
  printf -v "$__var" '%s' "$__reply"
}
confirm() { local r; read -r -p "  $1 [y/N] " r; [[ "$r" =~ ^([yY]|[yY][eE][sS])$ ]]; }

command -v aws >/dev/null || die "aws CLI not found."
command -v node >/dev/null || die "node not found."

# ── who and where ─────────────────────────────────────────────────────
step "Target account"

# The same credential resolution as migrate-to-account.sh, for the same reason:
# exported keys beat a profile in AWS's chain, so a stale export silently wins
# over the profile that would have worked.
if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && aws sts get-caller-identity >/dev/null 2>&1; then
  echo "  using credentials from the environment"
else
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    echo "  the credentials exported in this shell are expired — ignoring them"
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  fi
  ask AWS_PROFILE_IN "AWS profile" "${AWS_PROFILE:-}"
  export AWS_PROFILE="$AWS_PROFILE_IN"
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "  no valid session for $AWS_PROFILE — signing in"
    aws sso login --profile "$AWS_PROFILE" \
      || die "Could not sign in to '$AWS_PROFILE'."
  fi
fi

if ! CALLER=$(aws sts get-caller-identity --output json 2>&1); then
  printf "  %s\n" "$CALLER"
  die "Those credentials are not usable."
fi
ACCOUNT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).Account)" "$CALLER")
ARN=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).Arn)" "$CALLER")

echo
echo "    account : $ACCOUNT"
echo "    identity: $ARN"
echo

DEFAULT_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
ask REGION "AWS region to deploy into" "$DEFAULT_REGION"
export AWS_REGION="$REGION"
export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"

aws ec2 describe-regions --region-names "$REGION" >/dev/null 2>&1 \
  || die "'$REGION' is not a region this account can see."

step "This install"
ask GH_ORG "GitHub org name, as it appears in github.com/orgs/<name>"
ask PREFIX "Resource name prefix" "github-control-hub"
SECRET_NAME="${PREFIX}/secrets"

echo
echo "    account : $ACCOUNT  ${dim}(guardrails only)${off}"
echo "    region  : $REGION"
echo "    org     : $GH_ORG   ${dim}(for sign-in and team checks)${off}"
echo "    secret  : $SECRET_NAME"
echo
echo "  ${bold}No GitHub App key, no webhook, no access graph.${off} The app's"
echo "  GitHub tabs will be refused in this account."
echo
confirm "Proceed against account $ACCOUNT?" || die "Aborted. Nothing was created."

# ── 1. tables ─────────────────────────────────────────────────────────
step "1/4  DynamoDB tables"

# Delegated, not duplicated.
#
# These schemas are not uniform — auth-codes is keyed on `code`, findings and
# activity on pk/sk, and activity carries two secondary indexes without which
# looking a row up by id degrades into scanning the newest ones. Writing a
# subset out again here got three of them wrong, and the failures were invisible
# until something tried to use the table: sign-in died with "Missing the key id
# in the item", which names neither the table nor the cause.
#
# So the same script the full install uses creates them. It also creates the six
# tables only the GitHub half writes to. They stay empty here — nothing in this
# account writes to them, and an empty on-demand table costs nothing — and that
# is a better trade than a second copy of twelve schemas that has to be kept in
# step by hand.
AWS_PROFILE="${AWS_PROFILE:-}" AWS_REGION="$REGION" STACK_NAME="$PREFIX" \
  SKIP_SECRET=1 SKIP_CONFIRM=1 \
  bash "$HERE/setup-aws-account.sh" </dev/null \
  || die "Table creation failed. The output above says why."
ok "tables present (on-demand billing; the unused ones cost nothing)"

# ── 2. the secret ─────────────────────────────────────────────────────
step "2/4  Sign-in credentials"
echo "  Only what sign-in needs. The GitHub App's private key is deliberately"
echo "  not asked for and must not be put here — it is the credential that can"
echo "  read your organization, and keeping it out of this account is the point."
echo

EXISTING=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
  --query SecretString --output text 2>/dev/null || echo "")
cur() {
  [ -n "$EXISTING" ] || return 0
  CUR="$EXISTING" node -e '
    try { const v = JSON.parse(process.env.CUR)[process.argv[1]]; if (v) process.stdout.write(String(v)); } catch {}
  ' "$1" 2>/dev/null
}

if [ -n "$EXISTING" ]; then
  ok "Secret exists — enter keeps what it already holds"
  if [ -n "$(cur GITHUB_APP_PRIVATE_KEY)" ]; then
    warn "This secret already holds a GitHub App private key."
    warn "That is exactly what this account is meant not to have. It is left"
    warn "alone here — remove it deliberately, once you are sure nothing in"
    warn "this account still depends on it."
  fi
else
  echo "  The OAuth App is at:"
  echo "    https://github.com/organizations/$GH_ORG/settings/applications"
  echo "  Use the same one as your other install — its callback is localhost,"
  echo "  so one OAuth App serves every account."
  echo
fi

ask             GH_CLIENT_ID     "OAuth App client ID"     "$(cur GITHUB_CLIENT_ID)"
ask_secret_keep GH_CLIENT_SECRET "OAuth App client secret" "$(cur GITHUB_CLIENT_SECRET)"

JWT_SECRET="$(cur JWT_SECRET)"
[ -n "$JWT_SECRET" ] || JWT_SECRET=$(openssl rand -hex 48)

SECRET_JSON=$(EXISTING="$EXISTING" GH_CLIENT_ID="$GH_CLIENT_ID" \
  GH_CLIENT_SECRET="$GH_CLIENT_SECRET" GH_ORG="$GH_ORG" JWT_SECRET="$JWT_SECRET" \
  node -e '
    let base = {};
    try { base = JSON.parse(process.env.EXISTING || "{}") || {}; } catch {}
    process.stdout.write(JSON.stringify(Object.assign(base, {
      GITHUB_CLIENT_ID:     process.env.GH_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GH_CLIENT_SECRET,
      GITHUB_ORG:           process.env.GH_ORG,
      JWT_SECRET:           process.env.JWT_SECRET,
    })));')

case "$SECRET_JSON" in
  *GITHUB_CLIENT_ID*) ;;
  *) die "Could not assemble the secret, so nothing was written." ;;
esac

if [ -n "$EXISTING" ]; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
    --secret-string "$SECRET_JSON" >/dev/null || die "Could not write $SECRET_NAME."
else
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description "GitHub Control Hub — sign-in only. No GitHub App key in this account." \
    --secret-string "$SECRET_JSON" >/dev/null || die "Could not create $SECRET_NAME."
fi
ok "Stored $SECRET_NAME"
unset SECRET_JSON GH_CLIENT_SECRET EXISTING

# ── 3. CloudTrail ─────────────────────────────────────────────────────
step "3/4  CloudTrail"
TRAILS=$(aws cloudtrail describe-trails --query 'length(trailList)' --output text 2>/dev/null || echo 0)
if [ "$TRAILS" != "0" ]; then
  ok "$TRAILS trail(s) already here — guardrails will see creation events"
  skip "Not creating another (a second trail is billed per event)"
else
  warn "No trail. Guardrails will still run every fifteen minutes; they just"
  warn "will not react within seconds of a resource being created."
  if confirm "Create one?"; then
    AWS_REGION="$REGION" TRAIL_NAME="${PREFIX}-trail" bash "$HERE/setup-cloudtrail.sh" \
      || warn "Trail creation failed — the sweep still covers everything."
  else
    skip "Skipped"
  fi
fi

# ── 4. the guardrail stack ────────────────────────────────────────────
step "4/4  Guardrail Lambda and schedule"

cd "$ROOT/github-control-hub"
[ -d node_modules ] || { echo "  installing workspace deps…"; npm install --silent; }
cd "$ROOT/github-control-hub/infra"
[ -d node_modules ] || { echo "  installing CDK deps…"; npm install --silent; }

if ! aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
  echo "  bootstrapping CDK in $REGION…"
  npx cdk bootstrap "aws://$ACCOUNT/$REGION" || die "cdk bootstrap failed."
fi

# The flag that leaves the GitHub half uncreated.
STACK_NAME="$PREFIX" npx cdk deploy --require-approval never -c awsOnly=true \
  || die "cdk deploy failed."
cd "$ROOT"

# ── done ──────────────────────────────────────────────────────────────
step "Done"
echo "  This account now runs the AWS guardrails and holds nothing about your"
echo "  GitHub organization."
echo
echo "  ${bold}In the app, signed in to this account:${off}"
echo "    · the AWS tab works as normal"
echo "    · Activity shows what the guardrails did, and only that"
echo "    · every other tab is refused, because there are no GitHub credentials"
echo
echo "  ${bold}Add rules${off} in the app, under the AWS tab. Every rule starts in"
echo "  report mode: it finds violations and records the exact fix it would have"
echo "  made, and writes nothing until you switch that rule to enforce."
echo
echo "  ${dim}Anyone using the app here needs AWS credentials for $ACCOUNT, and"
echo "  membership of the aws-guardrail-admins team to change anything.${off}"
