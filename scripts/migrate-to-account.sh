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
# The profile's own region, or nothing. Offering us-east-1 to someone who never
# chose it is how a stack ends up in a region nobody looks at.
DEFAULT_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
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
# SKIP_CONFIRM because this script already asked, above, naming the account.
AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$REGION" STACK_NAME="$PREFIX" \
  SKIP_SECRET=1 SKIP_CONFIRM=1 \
  bash "$HERE/setup-aws-account.sh" </dev/null \
  || die "Table creation failed. The output above says why."
ok "13 tables present (on-demand billing; idle tables cost nothing)"

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
  echo "                Callback URL: ${bold}http://localhost:4321/auth/callback${off}"
  echo "                (the desktop app serves its own backend on 4321, and the"
  echo "                 route is /auth/callback — not /api/auth/callback)"
  echo "    GitHub App  https://github.com/organizations/$GH_ORG/settings/apps"
  echo "                Then install it on the org and note the installation id"
  echo "                (it is the number at the end of the install URL)."
  echo
  read -r -p "  Press enter once both exist… " _

  ask        GH_CLIENT_ID    "OAuth App client ID"
  ask_secret GH_CLIENT_SECRET "OAuth App client secret"
  ask        GH_APP_ID       "GitHub App ID"
  ask        GH_INSTALL_ID   "GitHub App installation ID"
  ask        GH_PEM_PATH     "Path to the GitHub App private key (.pem), or drag the file here"
  # A tilde typed at a prompt arrives as a literal character — the shell expands
  # ~ before a variable ever holds it, so `[ -f "~/key.pem" ]` looks for a
  # directory actually named "~". Expanding it here is the difference between
  # the obvious thing working and a "No file at ~/key.pem" that reads like the
  # file is missing.
  GH_PEM_PATH="${GH_PEM_PATH/#\~/$HOME}"
  # Dragging a file into a terminal quotes anything awkward and leaves a
  # trailing space. Whitespace comes off first: with the quote stripped first,
  # a path arriving as  'x.pem'␣  still ends in a space, so nothing matches the
  # trailing quote and both quotes survive — which is the exact shape dragging
  # produces.
  GH_PEM_PATH="${GH_PEM_PATH#"${GH_PEM_PATH%%[![:space:]]*}"}"
  GH_PEM_PATH="${GH_PEM_PATH%"${GH_PEM_PATH##*[![:space:]]}"}"
  GH_PEM_PATH="${GH_PEM_PATH%\'}"; GH_PEM_PATH="${GH_PEM_PATH#\'}"
  GH_PEM_PATH="${GH_PEM_PATH%\"}"; GH_PEM_PATH="${GH_PEM_PATH#\"}"
  [ -f "$GH_PEM_PATH" ] || die "No file at $GH_PEM_PATH"
  # And that it is the key, not merely a file. Pointing at the wrong download
  # is easy — GitHub hands you a .pem beside a dozen other things — and an
  # unchecked path uploads whatever it found. The app would then fail much
  # later, at a token refresh, complaining about a key rather than about the
  # file someone chose an hour earlier.
  grep -q -- "-----BEGIN" "$GH_PEM_PATH" && grep -q -- "PRIVATE KEY-----" "$GH_PEM_PATH" \
    || die "$GH_PEM_PATH is not a PEM private key. GitHub's file is named <app>.<date>.private-key.pem and starts with -----BEGIN."
  echo
  echo "  ${dim}The next one is optional. getSystemToken() prefers the GitHub App${off}"
  echo "  ${dim}token you just configured and only falls back to a PAT, so with the${off}"
  echo "  ${dim}App installed there is nothing left for it to do. Press enter to skip.${off}"
  ask_secret GH_PAT          "Personal access token, or enter to skip (repo, admin:org, admin:repo_hook)"

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

  # This script runs without `set -e`, so a node that threw would leave
  # SECRET_JSON empty and the upload would carry on and store nothing —
  # producing an install that looks configured and has no credentials in it.
  case "$SECRET_JSON" in
    *GITHUB_APP_PRIVATE_KEY*) ;;
    *) die "Could not assemble the secret, so nothing was written. Check that $GH_PEM_PATH is readable." ;;
  esac

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
# The workspace root, not only infra.
#
# The Lambda is bundled from backend/src, so its projectRoot is the workspace
# root and CDK runs `npx --no-install esbuild` from there — meaning esbuild has
# to resolve against github-control-hub/node_modules, which a fresh clone does
# not have. Installing only infra left the deploy failing on a machine that had
# never built the app, and passing on any machine that had.
cd "$ROOT/github-control-hub"
[ -d node_modules ] || { echo "  installing workspace deps (needed to bundle the Lambda)…"; npm install --silent; }

cd "$ROOT/github-control-hub/infra"
[ -d node_modules ] || { echo "  installing CDK deps…"; npm install --silent; }

if ! aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
  echo "  bootstrapping CDK in $REGION…"
  npx cdk bootstrap "aws://$ACCOUNT/$REGION" || die "cdk bootstrap failed."
fi

# Read-only by default. The app can report on this account and is incapable of
# changing it; a rule set to enforce still finds violations and records the fix
# it would have made. Add -c enforce=true here only if you want it to act.
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
# The committed file, not .env.production.local.
#
# These two are compiled into the JavaScript at build time, and the release
# workflow builds on a fresh runner that has only what is in the repository —
# so a value written to a gitignored file reached local builds and nothing
# else, and every release shipped with no company name and dead console links.
ENV_FILE="$ROOT/github-control-hub/frontend/.env.production"
# Rewrite the two this script owns and leave the rest alone. The file already
# carries VITE_API_URL and VITE_BACKEND_URL, which the app needs to reach its
# own backend — overwriting it wholesale produced a build that could not call
# anything.
{
  # Drop the previous pair and their heading, so re-running replaces rather
  # than accumulates.
  grep -vE '^(VITE_COMPANY_NAME=|VITE_AWS_REGION=|# The two below are written)' "$ENV_FILE" 2>/dev/null || true
  echo "# The two below are written by scripts/migrate-to-account.sh."
  echo "VITE_COMPANY_NAME=$COMPANY"
  echo "VITE_AWS_REGION=$REGION"
} > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
ok "Wrote $(basename "$ENV_FILE") (company name, console-link region)"
warn "That file is tracked by git. Commit it, or the release workflow will"
warn "build without these and the app will show no company name."
echo "    ${dim}git add github-control-hub/frontend/.env.production${off}"
echo "    ${dim}git commit -m 'Set this install'\''s company name and region'${off}"

echo
echo "  Build and run it with:"
echo "    ${bold}cd github-control-hub/desktop && npm run dev${off}"
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

  Not done by this script, because it needs decisions rather than commands:
    · Other AWS accounts. Open AWS -> Accounts -> "How do I add an account?"
      in the app; it generates the template, the parameters and the links.
      docs/aws-guardrails/accounts.md
    · Whether guardrails may change anything. Both rules are report-only and
      the stack is deployed read-only. Redeploy with -c enforce=true to grant
      three write actions.  docs/aws-guardrails/permissions.md

  Worth doing next:
    · Create a repo in $GH_ORG and confirm it appears in the activity feed.
      If it does not, the webhook secret or the events list is wrong.
    · Set a log group's retention to 1 day and watch the guardrail flag it.
    · Activity rows expire after 13 months (a year plus slack, so a
      twelve-month audit always finds a complete record). Override with
      ACTIVITY_RETENTION_MONTHS if your policy differs.
EOF
