#!/usr/bin/env bash
#
# GitHub Control Hub — stand the app up in a new AWS account and GitHub org.
#
# Asks for everything that differs between installs, then runs the same steps
# in the same order they were run by hand. Nothing here is specific to the
# account it was first built in — region, org and company name are all asked
# for rather than assumed.
#
# Safe to re-run. Every step checks for what it is about to create and says so
# rather than failing. Stop at any prompt with Ctrl-C; nothing is left half
# done except what the step you were in had already created.
#
# What it does NOT do, because it cannot:
#   - create the GitHub OAuth App / GitHub App (browser, human)
#   - install the GitHub App on the org (browser, human)
#   - create the org webhook (needs the EC2 address, which step 5 prints)
# Each of those pauses with the exact values to paste.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# ── output ────────────────────────────────────────────────────────────
bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; ylw=$'\033[33m'; off=$'\033[0m'
step() { printf "\n%s──  %s  ─────────────────────────────────────────%s\n" "$bold" "$1" "$off"; }
ok()   { printf "  %s✓%s %s\n" "$grn" "$off" "$1"; }
skip() { printf "  %s·%s %s\n" "$dim" "$off" "$1"; }
warn() { printf "  %s!%s %s\n" "$ylw" "$off" "$1"; }
die()  { printf "\n  %s✗ %s%s\n\n" "$red" "$1" "$off"; exit 1; }

ask() {  # ask <var> <prompt> [default]
  local __var="$1" __prompt="$2" __default="${3:-}" __reply
  if [ -n "$__default" ]; then
    read -r -p "  $__prompt [$__default]: " __reply
    __reply="${__reply:-$__default}"
  else
    while [ -z "${__reply:-}" ]; do read -r -p "  $__prompt: " __reply; done
  fi
  printf -v "$__var" '%s' "$__reply"
}

ask_secret() {  # never echoed, never logged
  local __var="$1" __prompt="$2" __reply
  read -r -s -p "  $__prompt: " __reply; echo
  printf -v "$__var" '%s' "$__reply"
}

confirm() { local r; read -r -p "  $1 [y/N] " r; [[ "$r" == [yY] ]]; }

command -v aws >/dev/null || die "aws CLI not found."
command -v node >/dev/null || die "node not found."

# ── who and where ─────────────────────────────────────────────────────
step "Target account"

ask AWS_PROFILE_IN "AWS profile" "${AWS_PROFILE:-default}"
export AWS_PROFILE="$AWS_PROFILE_IN"

if ! CALLER=$(aws sts get-caller-identity --output json 2>&1); then
  printf "  %s\n" "$CALLER"
  die "Those credentials are not usable. Run 'aws sso login --profile $AWS_PROFILE' first."
fi
ACCOUNT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).Account)" "$CALLER")
ARN=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).Arn)" "$CALLER")

echo
echo "    account : $ACCOUNT"
echo "    identity: $ARN"
echo

# Region is asked for, never assumed. Everything in the app reads AWS_REGION;
# the one place that did not (the console deep links) is now fed from here too.
DEFAULT_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
ask REGION "AWS region to deploy into" "$DEFAULT_REGION"
export AWS_REGION="$REGION"
export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"

aws ec2 describe-regions --region-names "$REGION" >/dev/null 2>&1 \
  || die "'$REGION' is not a region this account can see."

step "This install"
ask COMPANY   "Company display name (shown in the app)" "Acme Inc"
ask GH_ORG    "GitHub organisation (the exact login, case-sensitive)"
ask PREFIX    "Resource name prefix" "github-control-hub"
SECRET_NAME="${PREFIX}/secrets"

echo
echo "    region  : $REGION"
echo "    company : $COMPANY"
echo "    org     : $GH_ORG"
echo "    prefix  : $PREFIX"
echo "    secret  : $SECRET_NAME"
echo
confirm "Proceed against account $ACCOUNT?" || die "Aborted. Nothing was created."

# ── 1. tables ─────────────────────────────────────────────────────────
step "1/7  DynamoDB tables"
AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$REGION" STACK_NAME="$PREFIX" SKIP_SECRET=1 \
  bash "$HERE/setup-aws-account.sh" </dev/null \
  || die "Table creation failed."
ok "14 tables present (on-demand billing; idle tables cost nothing)"

# ── 2. secrets ────────────────────────────────────────────────────────
step "2/7  GitHub credentials"
echo "  These live in Secrets Manager and are never written to disk by this"
echo "  script. Secret values are read without echoing."
echo

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  skip "Secret $SECRET_NAME already exists"
  if ! confirm "Replace its contents?"; then
    SKIP_SECRET_WRITE=1
  fi
fi

if [ -z "${SKIP_SECRET_WRITE:-}" ]; then
  echo
  echo "  ${bold}Create these in GitHub first${off} (open in a browser):"
  echo "    OAuth App   https://github.com/organizations/$GH_ORG/settings/applications"
  echo "                Callback URL: http://localhost:5173/api/auth/callback"
  echo "    GitHub App  https://github.com/organizations/$GH_ORG/settings/apps"
  echo "                Then install it on the org and note the installation id"
  echo "                (it is the number at the end of the install URL)."
  echo
  read -r -p "  Press enter once both exist… " _

  ask        GH_CLIENT_ID    "OAuth App client ID"
  ask_secret GH_CLIENT_SECRET "OAuth App client secret"
  ask        GH_APP_ID       "GitHub App ID"
  ask        GH_INSTALL_ID   "GitHub App installation ID"
  ask        GH_PEM_PATH     "Path to the GitHub App private key (.pem)"
  [ -f "$GH_PEM_PATH" ] || die "No file at $GH_PEM_PATH"
  ask_secret GH_PAT          "Personal access token for system tasks (repo, admin:org, admin:repo_hook)"

  # Generated, not asked for — no reason for a human to invent these.
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  JWT_SECRET=$(openssl rand -hex 48)
  ok "Generated a webhook secret and JWT secret"

  # Built with node so the private key's newlines survive JSON encoding, and
  # so no secret ever appears in an argument list or the shell history.
  SECRET_JSON=$(GH_PEM_PATH="$GH_PEM_PATH" \
    GH_CLIENT_ID="$GH_CLIENT_ID" GH_CLIENT_SECRET="$GH_CLIENT_SECRET" \
    GH_APP_ID="$GH_APP_ID" GH_INSTALL_ID="$GH_INSTALL_ID" GH_PAT="$GH_PAT" \
    GH_ORG="$GH_ORG" WEBHOOK_SECRET="$WEBHOOK_SECRET" JWT_SECRET="$JWT_SECRET" \
    node -e '
      const fs = require("fs");
      process.stdout.write(JSON.stringify({
        GITHUB_CLIENT_ID:            process.env.GH_CLIENT_ID,
        GITHUB_CLIENT_SECRET:        process.env.GH_CLIENT_SECRET,
        GITHUB_APP_ID:               process.env.GH_APP_ID,
        GITHUB_APP_INSTALLATION_ID:  process.env.GH_INSTALL_ID,
        GITHUB_APP_PRIVATE_KEY:      fs.readFileSync(process.env.GH_PEM_PATH, "utf8"),
        SYSTEM_GITHUB_TOKEN:         process.env.GH_PAT,
        GITHUB_ORG:                  process.env.GH_ORG,
        GITHUB_WEBHOOK_SECRET:       process.env.WEBHOOK_SECRET,
        JWT_SECRET:                  process.env.JWT_SECRET,
      }));')

  if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
      --secret-string "$SECRET_JSON" >/dev/null
  else
    aws secretsmanager create-secret --name "$SECRET_NAME" \
      --description "GitHub Control Hub — GitHub credentials" \
      --secret-string "$SECRET_JSON" >/dev/null
  fi
  unset SECRET_JSON GH_CLIENT_SECRET GH_PAT
  ok "Stored $SECRET_NAME"

  echo
  warn "Delete the private key now — the app reads it from Secrets Manager:"
  echo "      rm '$GH_PEM_PATH'"
fi

# ── 3. CloudTrail ─────────────────────────────────────────────────────
step "3/7  CloudTrail"
TRAILS=$(aws cloudtrail describe-trails --query 'length(trailList)' --output text 2>/dev/null || echo 0)
if [ "$TRAILS" != "0" ]; then
  ok "$TRAILS trail(s) already in this account — guardrails will see creation events"
  skip "Not creating another (a second trail is billed per event)"
else
  warn "No trail. Without one, guardrails only run on the 15-minute sweep"
  warn "rather than seconds after a resource is created or changed."
  if confirm "Create one?"; then
    AWS_REGION="$REGION" TRAIL_NAME="${PREFIX}-trail" bash "$HERE/setup-cloudtrail.sh" \
      || warn "Trail creation failed — the sweep still covers everything."
  else
    skip "Skipped"
  fi
fi

# ── 4. infrastructure ─────────────────────────────────────────────────
step "4/7  EC2, Lambda and event rules"
cd "$ROOT/github-control-hub/infra"
[ -d node_modules ] || { echo "  installing CDK deps…"; npm install --silent; }

if ! aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
  echo "  bootstrapping CDK in $REGION…"
  npx cdk bootstrap "aws://$ACCOUNT/$REGION" || die "cdk bootstrap failed."
fi

STACK_NAME="$PREFIX" npx cdk deploy --require-approval never \
  || die "cdk deploy failed."

PUBLIC_IP=$(aws cloudformation describe-stacks --stack-name GitHubControlHub \
  --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text 2>/dev/null)
WEBHOOK_URL=$(aws cloudformation describe-stacks --stack-name GitHubControlHub \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text 2>/dev/null)
ok "Instance is up at $PUBLIC_IP"
cd "$ROOT"

# ── 5. webhook ────────────────────────────────────────────────────────
step "5/7  Org webhook"
echo "  Create it at:"
echo "    https://github.com/organizations/$GH_ORG/settings/hooks/new"
echo
echo "    Payload URL : ${bold}$WEBHOOK_URL${off}"
echo "    Content type: application/json"
echo "    Secret      : the webhook secret generated in step 2"
echo "                  (read it back with the command below if needed)"
echo "    Events      : push, repository, create, delete, member, team,"
echo "                  organization, pull_request, issues,"
echo "                  branch_protection_rule, repository_ruleset"
echo "    SSL         : disable verification — the instance uses a self-signed"
echo "                  certificate on its IP address"
echo
echo "  ${dim}aws secretsmanager get-secret-value --secret-id $SECRET_NAME \\"
echo "    --query SecretString --output text | node -e \"…GITHUB_WEBHOOK_SECRET\"${off}"
echo
read -r -p "  Press enter once the webhook is saved… " _

# ── 6. guardrail rules ────────────────────────────────────────────────
step "6/7  Guardrail rules"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
seed_rule() {
  local id="$1" kind="$2" name="$3" desc="$4" params="$5"
  if aws dynamodb get-item --table-name "${PREFIX}-aws-guardrails" \
       --key "{\"id\":{\"S\":\"$id\"}}" --query 'Item.id.S' --output text 2>/dev/null | grep -q "$id"; then
    skip "$name already exists"
    return
  fi
  aws dynamodb put-item --table-name "${PREFIX}-aws-guardrails" --item "{
    \"id\":{\"S\":\"$id\"}, \"kind\":{\"S\":\"$kind\"}, \"name\":{\"S\":\"$name\"},
    \"description\":{\"S\":\"$desc\"}, \"enabled\":{\"BOOL\":true},
    \"mode\":{\"S\":\"report\"}, \"applyOnCreate\":{\"BOOL\":true},
    \"params\":{\"M\":$params}, \"exclusionLists\":{\"L\":[]},
    \"createdBy\":{\"S\":\"migration\"},
    \"createdAt\":{\"S\":\"$NOW\"}, \"updatedAt\":{\"S\":\"$NOW\"}
  }" >/dev/null && ok "$name (report mode)"
}

# Both start in report mode on purpose. Enforce is a decision to make after
# seeing what a real account actually contains, not a default to inherit.
seed_rule "r-https" "s3_https_only" "S3 — deny non-TLS requests" \
  "Adds a bucket policy statement denying any request made without TLS." \
  '{"sid":{"S":"EnforceHTTPSOnly"}}'
seed_rule "r-retention" "log_retention_min" "CloudWatch Logs — minimum retention" \
  "Raises log groups kept for less than a year, and leaves longer ones alone." \
  '{"minDays":{"N":"365"},"setToDays":{"N":"365"},"leaveLongerAlone":{"BOOL":true},"neverExpireIsCompliant":{"BOOL":true}}'

warn "Both rules report only. Review findings before switching either to enforce."

# ── 7. build ──────────────────────────────────────────────────────────
step "7/7  Desktop app"
ENV_FILE="$ROOT/github-control-hub/frontend/.env.production.local"
cat > "$ENV_FILE" <<EOF
# Written by scripts/migrate-to-account.sh — this install's identity.
VITE_COMPANY_NAME=$COMPANY
VITE_AWS_REGION=$REGION
EOF
ok "Wrote $(basename "$ENV_FILE") (company name, console-link region)"

echo
echo "  Build and run it with:"
echo "    ${bold}cd github-control-hub-cmd-desktop-app && npm run dev${off}"
echo
echo "  Everyone running the desktop app needs AWS credentials for account"
echo "  $ACCOUNT, because that build carries the backend and talks to"
echo "  DynamoDB directly."

# ── done ──────────────────────────────────────────────────────────────
step "Done"
cat <<EOF
  account   $ACCOUNT
  region    $REGION
  org       $GH_ORG
  company   $COMPANY
  instance  $PUBLIC_IP
  webhook   $WEBHOOK_URL

  Worth doing next:
    · Create a repo in $GH_ORG and confirm it appears in the activity feed.
      If it does not, the webhook secret or the events list is wrong.
    · Set a log group's retention to 1 day and watch the guardrail flag it.
    · Decide retention for the activity table — nothing expires from it today.
EOF
