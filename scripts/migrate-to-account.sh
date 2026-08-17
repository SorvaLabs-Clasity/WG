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
#   - create the org webhook (needs the API Gateway URL, which step 4 prints)
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
# A secret that already exists, kept on enter. The value is never shown, so the
# prompt says it is there rather than what it is. With nothing stored it loops,
# because an empty client secret produces an install that cannot sign anyone in.
ask_secret_keep() {  # ask_secret_keep <var> <prompt> <current>
  local __var="$1" __prompt="$2" __current="$3" __reply
  if [ -n "$__current" ]; then
    read -r -s -p "  $__prompt [enter to keep the stored one]: " __reply; echo
    __reply="${__reply:-$__current}"
  else
    while [ -z "${__reply:-}" ]; do read -r -s -p "  $__prompt: " __reply; echo; done
  fi
  printf -v "$__var" '%s' "$__reply"
}

# Anything that reads as yes counts. This matched a single `y` and nothing else,
# so typing the whole word answered no — and the one place that mattered most
# treated no as "keep whatever is already stored", silently.
confirm() { local r; read -r -p "  $1 [y/N] " r; [[ "$r" =~ ^([yY]|[yY][eE][sS])$ ]]; }

command -v aws >/dev/null || die "aws CLI not found."
command -v node >/dev/null || die "node not found."

# ── who and where ─────────────────────────────────────────────────────
step "Target account"

# Credentials pasted into the environment beat any profile, so asking for one
# would be asking a question with no effect — and answering it "default" reads
# as though the default account is the target when it is not.
#
# This is the shape the AWS access portal hands you: three exports, good for a
# few hours. It needs no profile to exist at all, which is the point.
# Which account, asked with no default.
#
# It used to offer "default", so pressing enter targeted whatever that happened
# to be — on a machine with one profile per environment, the wrong account most
# of the time, and this creates tables, secrets and a stack before anyone reads
# the id it prints. Removing the default is the fix; removing the question just
# moved the work to an export nobody should have to remember.
#
# `ask` with no default loops until something is typed, so there is no enter to
# press by mistake.
# Which way credentials arrived, remembered so the failure below can give advice
# that matches. Without it the error names $AWS_PROFILE, which is never set on
# this branch — so the script died on an unbound variable while trying to print
# why it was dying, and the person running it saw neither reason.
# Credentials, whichever way they arrived.
#
# Exports in the shell that have since expired used to stop this dead: it took
# the environment branch, failed, and asked for fresh exports while the person
# was already signed in with a working SSO profile.
#
# They have to be *unset* to fall back, not merely ignored — AWS's credential
# chain puts AWS_ACCESS_KEY_ID ahead of AWS_PROFILE, so a stale key silently
# overrides the profile that would have worked.
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
      || die "Could not sign in to '$AWS_PROFILE'. Check the profile name in ~/.aws/config."
  fi
fi

if ! CALLER=$(aws sts get-caller-identity --output json 2>&1); then
  printf "  %s\n" "$CALLER"
  die "Those credentials are not usable, even after signing in. Check that the profile names an account you have access to."
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
ask GH_ORG    "GitHub org name, as it appears in github.com/orgs/<name>"
ask PREFIX    "Resource name prefix" "github-control-hub"

SECRET_NAME="${PREFIX}/secrets"
# Separate on purpose: the receiver Lambda is the only internet-facing piece
# and must not hold a key to the App private key it never reads.
WEBHOOK_SECRET_NAME="${PREFIX}/webhook-secret"

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
# Counted rather than stated. This line has claimed 13 and 14 at various points,
# each time going stale the moment a table was added or removed — so it now asks
# the script that just ran how many it creates.
TABLE_COUNT=$(( $(sed -n '/^TABLES=(/,/^)/p' "$HERE/setup-aws-account.sh" | grep -cE '^[[:space:]]+[a-z-]+')
                + $(grep -cE 'create_table "\$\{PREFIX\}-[a-z-]+"' "$HERE/setup-aws-account.sh") ))
ok "$TABLE_COUNT tables present (on-demand billing; idle tables cost nothing)"

# ── 2. secrets ────────────────────────────────────────────────────────
step "2/7  GitHub credentials"
echo "  These live in Secrets Manager and are never written to disk by this"
echo "  script. Secret values are read without echoing."
echo

# What is stored now, so a re-run can correct one field without retyping the
# rest — and so keys this script does not know about survive the write.
#
# This used to ask "replace its contents?" and, on anything but a bare `y`, skip
# the entire step in silence. Two installs sharing a GitHub org therefore ended
# up with one AWS account holding the other's App credentials, and the run that
# did it printed nothing to say so. The symptom arrived days later as GitHub
# refusing a JWT it could not verify, which names no field at all.
#
# There is no all-or-nothing question any more. Every field offers what is
# already there as its default.
EXISTING=""
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  EXISTING=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
    --query SecretString --output text 2>/dev/null || echo "")
  if [ -n "$EXISTING" ]; then
    ok "Secret $SECRET_NAME exists — enter keeps what it already holds"
  else
    warn "Secret $SECRET_NAME exists but its value could not be read"
    warn "Every field below has to be entered."
  fi
fi

# One field out of the stored JSON; empty if absent, or if the value is not JSON
# at all. Never fails the run — a secret written by hand is still something to
# offer defaults from where it can.
cur() {
  [ -n "$EXISTING" ] || return 0
  CUR="$EXISTING" node -e '
    try {
      const v = JSON.parse(process.env.CUR)[process.argv[1]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch {}' "$1" 2>/dev/null
}

# The webhook HMAC lives in its own secret, so it is read from there.
EXISTING_WEBHOOK=$(aws secretsmanager get-secret-value --secret-id "$WEBHOOK_SECRET_NAME" \
  --query SecretString --output text 2>/dev/null || echo "")

if [ -z "$EXISTING" ]; then
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
  echo "  The client id and secret come from the ${bold}OAuth App${off} page. The GitHub"
  echo "  App page has fields with those names too, and they are not the ones"
  echo "  wanted here — the App authenticates with its private key instead."
  echo
  read -r -p "  Press enter once both exist… " _
fi

echo
ask             GH_CLIENT_ID     "OAuth App client ID"        "$(cur GITHUB_CLIENT_ID)"
ask_secret_keep GH_CLIENT_SECRET "OAuth App client secret"    "$(cur GITHUB_CLIENT_SECRET)"
ask             GH_APP_ID        "GitHub App ID"              "$(cur GITHUB_APP_ID)"
ask             GH_INSTALL_ID    "GitHub App installation ID" "$(cur GITHUB_APP_INSTALLATION_ID)"

# The App ID must be the short number from the App's General page. The Client ID
# beside it looks like a credential and is the wrong one; stored here it yields
# a JWT with an `iss` GitHub cannot resolve, and the error names neither field.
case "$GH_APP_ID" in
  ''|*[!0-9]*) die "'$GH_APP_ID' is not a GitHub App ID. That is the short numeric id on the App's General page — not the Client ID, which starts with Iv or Ov." ;;
esac
case "$GH_INSTALL_ID" in
  ''|*[!0-9]*) die "'$GH_INSTALL_ID' is not an installation ID. It is the number at the end of the install URL." ;;
esac

STORED_PEM="$(cur GITHUB_APP_PRIVATE_KEY)"
# Initialised, because `read` leaves it unset on EOF and `set -u` is on — the
# next test would then abort the run instead of the prompt simply being empty.
GH_PEM_PATH=""
if [ -n "$STORED_PEM" ]; then
  read -r -p "  Path to the .pem, or enter to keep the stored key: " GH_PEM_PATH || true
else
  ask GH_PEM_PATH "Path to the GitHub App private key (.pem), or drag the file here"
fi

if [ -n "$GH_PEM_PATH" ]; then
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
  PEM_DESC="$GH_PEM_PATH"
else
  PEM_DESC="keeping the key already stored"
fi
echo

# Kept, not re-rolled.
#
# These were regenerated on every write. Correcting an App ID therefore rotated
# the webhook HMAC as a side effect: the org webhook in GitHub kept the old one,
# every delivery began failing signature verification, and nothing said so. A
# secret that already exists is reused; only a missing one is generated.
WEBHOOK_SECRET="$EXISTING_WEBHOOK"
JWT_SECRET="$(cur JWT_SECRET)"
WEBHOOK_IS_NEW=""
if [ -z "$WEBHOOK_SECRET" ]; then
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  WEBHOOK_IS_NEW=1
  WEBHOOK_DESC="generating a new one — the org webhook must be updated to match"
else
  WEBHOOK_DESC="keeping the existing one — the org webhook stays as it is"
fi
# Rotating this signs everyone out, so it is preserved on the same terms.
[ -n "$JWT_SECRET" ] || JWT_SECRET=$(openssl rand -hex 48)


# Merged onto what is already there, so a key this script does not know about is
# not deleted by a run that only meant to correct one field — the previous write
# replaced the whole document with the seven fields below and dropped the rest.
# Built with node so the private key's newlines survive JSON encoding, and so no
# secret ever appears in an argument list or the shell history.
SECRET_JSON=$(EXISTING="$EXISTING" GH_PEM_PATH="$GH_PEM_PATH" \
  GH_CLIENT_ID="$GH_CLIENT_ID" GH_CLIENT_SECRET="$GH_CLIENT_SECRET" \
  GH_APP_ID="$GH_APP_ID" GH_INSTALL_ID="$GH_INSTALL_ID" GH_ORG="$GH_ORG" JWT_SECRET="$JWT_SECRET" \
  node -e '
      const fs = require("fs");
      let base = {};
      try { base = JSON.parse(process.env.EXISTING || "{}") || {}; } catch {}
      const key = process.env.GH_PEM_PATH
        ? fs.readFileSync(process.env.GH_PEM_PATH, "utf8")
        : base.GITHUB_APP_PRIVATE_KEY;
      if (!key) throw new Error("no private key to store");
      process.stdout.write(JSON.stringify(Object.assign(base, {
        GITHUB_CLIENT_ID:            process.env.GH_CLIENT_ID,
        GITHUB_CLIENT_SECRET:        process.env.GH_CLIENT_SECRET,
        GITHUB_APP_ID:               process.env.GH_APP_ID,
        GITHUB_APP_INSTALLATION_ID:  process.env.GH_INSTALL_ID,
        GITHUB_APP_PRIVATE_KEY:      key,
        GITHUB_ORG:                  process.env.GH_ORG,
        JWT_SECRET:                  process.env.JWT_SECRET,
      })));')
# GITHUB_WEBHOOK_SECRET is not in here. It goes to its own secret below, so
# the internet-facing receiver never holds a key to GITHUB_APP_PRIVATE_KEY.

# This script runs without `set -e`, so a node that threw would leave
# SECRET_JSON empty and the upload would carry on and store nothing —
# producing an install that looks configured and has no credentials in it.
case "$SECRET_JSON" in
  *GITHUB_APP_PRIVATE_KEY*) ;;
  *) die "Could not assemble the secret, so nothing was written." ;;
esac

# ── ask GitHub before writing, not after ──
#
# This ran after the write, which was the wrong way round for the case it exists
# to catch. An account seeded with another install's credentials offers those
# credentials back as the defaults for a re-run, so pressing enter through the
# prompts re-confirms exactly the values that were already wrong. Checking first
# means that run stops with the old secret still in place, rather than rewriting
# it and reporting the problem afterwards.
#
# Signed with node's own crypto, so this needs nothing installed.
check_github() {
  SECRET_JSON="$SECRET_JSON" node -e '
    const crypto = require("crypto");
    const j = JSON.parse(process.env.SECRET_JSON);
    if (typeof fetch !== "function") { console.log("SKIP this node has no fetch"); return; }
    const seg = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const signed = seg({ alg: "RS256", typ: "JWT" }) + "." +
                   seg({ iat: now - 60, exp: now + 540, iss: j.GITHUB_APP_ID });
    let jwt;
    try {
      jwt = signed + "." + crypto.sign("RSA-SHA256", Buffer.from(signed),
        crypto.createPrivateKey(j.GITHUB_APP_PRIVATE_KEY)).toString("base64url");
    } catch (e) { console.log("BADKEY " + e.message); return; }
    const headers = { authorization: "Bearer " + jwt, accept: "application/vnd.github+json" };
    (async () => {
      let r, b;
      try {
        r = await fetch("https://api.github.com/app", { headers });
        b = await r.json();
      } catch (e) { console.log("SKIP could not reach github.com: " + e.message); return; }
      if (r.status !== 200) { console.log("MISMATCH " + b.message); return; }
      try {
        const i = await fetch("https://api.github.com/app/installations", { headers });
        const list = await i.json();
        const ids = Array.isArray(list) ? list.map(x => String(x.id)) : [];
        if (!ids.includes(String(j.GITHUB_APP_INSTALLATION_ID))) {
          console.log("BADINSTALL " + b.slug + " | this app is installed as: " + (ids.join(", ") || "nowhere"));
          return;
        }
        console.log("OK " + b.slug);
      } catch (e) { console.log("SKIP " + e.message); }
    })();' 2>&1
}

echo "  Checking these credentials with GitHub…"
VERDICT="$(check_github)" || VERDICT="SKIP the check could not run"
case "$VERDICT" in
  OK*)         GH_DESC="accepted — App is \"${VERDICT#OK }\"" ;;
  MISMATCH*)   GH_DESC="${bold}REJECTED${off} — ${VERDICT#MISMATCH }" ;;
  BADINSTALL*) GH_DESC="${bold}wrong installation id${off} — ${VERDICT#BADINSTALL }" ;;
  BADKEY*)     GH_DESC="${bold}unusable key${off} — ${VERDICT#BADKEY }" ;;
  *)           GH_DESC="not checked (${VERDICT#SKIP })" ;;
esac

# Nothing about which account this is going to was on screen at this point. The
# account was printed once, before the tables, and never again — so a run that
# put one environment's App credentials into another environment's account had
# no moment where that was visible.
echo
echo "    account      : $ACCOUNT"
echo "    region       : $REGION"
echo "    secret       : $SECRET_NAME"
echo "    org          : $GH_ORG"
echo "    app id       : $GH_APP_ID"
echo "    installation : $GH_INSTALL_ID"
echo "    private key  : $PEM_DESC"
echo "    webhook HMAC : $WEBHOOK_DESC"
echo "    github says  : $GH_DESC"
echo

case "$VERDICT" in
  MISMATCH*)
    warn "The private key does not belong to App ID $GH_APP_ID."
    warn "That happens when two Apps' .pem downloads sit in the same folder, or"
    warn "when this account was set up with another install's credentials and the"
    warn "defaults above came from that. Check the App ID on the App's General"
    warn "page, and use a key generated on that same App."
    echo ;;
  BADINSTALL*)
    warn "The key and App ID are a pair, but installation $GH_INSTALL_ID is not"
    warn "one of this App's installations. The ids it does have are listed above."
    echo ;;
  BADKEY*)
    warn "The key assembled here is not a usable private key."
    echo ;;
esac

# Three outcomes, not two. "Could not reach GitHub" is not the same claim as
# "GitHub rejected this", and a prompt that conflates them teaches people to
# click through the one that matters.
case "$VERDICT" in
  OK*)
    confirm "Write these to $SECRET_NAME in account $ACCOUNT?" \
      || die "Aborted. The secret was not changed." ;;
  MISMATCH*|BADINSTALL*|BADKEY*)
    confirm "GitHub rejected these. Write them anyway?" \
      || die "Aborted. The secret was not changed — nothing is worse than before." ;;
  *)
    confirm "Credentials could not be checked. Write them unverified?" \
      || die "Aborted. The secret was not changed." ;;
esac

if [ -n "$EXISTING" ] || aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
    --secret-string "$SECRET_JSON" >/dev/null || die "Could not write $SECRET_NAME."
else
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description "GitHub Control Hub — GitHub credentials" \
    --secret-string "$SECRET_JSON" >/dev/null || die "Could not create $SECRET_NAME."
fi
ok "Stored $SECRET_NAME"

# Stored as the bare value, not JSON: the receiver reads this secret and
# nothing else, so there is nothing to wrap it in.
#
# Only written when it was generated. An unconditional write here published a new
# version of a secret whose value had not changed, and worse, made every re-run
# look like a rotation whether or not one happened.
if [ -n "$WEBHOOK_IS_NEW" ]; then
  if aws secretsmanager describe-secret --secret-id "$WEBHOOK_SECRET_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$WEBHOOK_SECRET_NAME" \
      --secret-string "$WEBHOOK_SECRET" >/dev/null || die "Could not write $WEBHOOK_SECRET_NAME."
  else
    aws secretsmanager create-secret --name "$WEBHOOK_SECRET_NAME" \
      --description "GitHub webhook HMAC secret. Read only by the internet-facing receiver Lambda." \
      --secret-string "$WEBHOOK_SECRET" >/dev/null || die "Could not create $WEBHOOK_SECRET_NAME."
  fi
  ok "Stored $WEBHOOK_SECRET_NAME (new — update the org webhook in step 5)"
else
  skip "$WEBHOOK_SECRET_NAME unchanged — the org webhook keeps working"
fi

unset SECRET_JSON GH_CLIENT_SECRET WEBHOOK_SECRET EXISTING EXISTING_WEBHOOK STORED_PEM

if [ -n "$GH_PEM_PATH" ]; then
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
step "4/7  API Gateway, Lambda, SQS and event rules"
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

# The stack takes no required context. Guardrail rules are added in the app
# afterwards, and each starts in report mode: it finds violations and records
# the fix it would have made, writing nothing until that rule is switched to
# enforce.
#
# Anything extra is passed straight through:
#
#   CDK_CONTEXT="-c someFlag=value" ./scripts/migrate-to-account.sh
#
# Unquoted on purpose: this may hold several flags and has to word-split.
# shellcheck disable=SC2086
# shellcheck disable=SC2086
STACK_NAME="$PREFIX" npx cdk deploy --require-approval never ${CDK_CONTEXT:-} \
  || die "cdk deploy failed."

WEBHOOK_URL=$(aws cloudformation describe-stacks --stack-name GitHubControlHub \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text 2>/dev/null)
ok "Webhook is up at $WEBHOOK_URL"
# Read after the deploy, not before: cdk deploy is what creates the API
# Gateway stage this URL points at, so reading it earlier would read nothing.
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
# The ten the code actually handles, by the labels GitHub puts on the checkboxes
# — the API names are not what the page shows. `organization` and `issues` were
# on this list and are handled by nothing: every delivery for them is fetched,
# queued and dropped. See docs/operations/setup.md for the full table.
echo "    Events      : \"Let me select individual events\", then tick ten —"
echo "                  Branch or tag creation, Branch or tag deletion,"
echo "                  Branch protection rules, Collaborator add remove or changed,"
echo "                  Dependabot alerts, Pull requests, Pushes, Repositories,"
echo "                  Repository rulesets, Teams"
echo "                  (leave Organization unticked — nothing reads it)"
echo "    SSL         : leave verification enabled — API Gateway serves a valid"
echo "                  ACM certificate, so there is nothing to disable it for"
echo
echo "  ${dim}aws secretsmanager get-secret-value --secret-id $WEBHOOK_SECRET_NAME \\"
echo "    --query SecretString --output text${off}"
echo
read -r -p "  Press enter once the webhook is saved… " _


# ── 6. guardrail rules ────────────────────────────────────────────────
step "6/7  Guardrail rules"

# None are created here, deliberately.
#
# Which rules an account runs is a decision about that account, and the S3 one
# rewrites bucket policies the moment it is switched to enforce. A rule that
# arrives with the install is an opinion nobody stated, sitting one toggle away
# from acting on real resources.
#
# They are added in the app, under the AWS tab, where the catalogue explains
# what each one does and what it would change.
skip "None created — add them in the app, under the AWS tab"

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
# Tell, do not do.
#
# Forgetting this leaves the release workflow building without a company name,
# and nothing fails to say so — the app simply ships blank. But committing on
# someone's behalf assumes their branch will accept it, and main is often
# protected, which would strand a commit somewhere it cannot be pushed from.
# So this names the file and the branch, and stops.
if git -C "$ROOT" diff --quiet -- "$ENV_FILE" 2>/dev/null; then
  skip "No change to $(basename "$ENV_FILE") — already committed"
else
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
  echo
  warn "One file needs committing before a release build will carry this"
  warn "install's identity. Until it does, released apps show no company name"
  warn "and their AWS console links go nowhere."
  echo
  echo "    ${bold}Commit${off}  github-control-hub/frontend/.env.production"
  echo "    ${bold}On${off}      $BRANCH — or a branch off it, if $BRANCH is protected"
  echo "    ${bold}Then${off}    push it, so the release workflow can see it"
fi

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
  webhook   $WEBHOOK_URL

  The webhook is already live: cdk deploy (above) packages the receiver and
  worker Lambdas from source and deploys them along with the rest of the
  infrastructure, so there is no separate app-shipping step. The webhook URL
  above is answering requests now.

  Not done by this script, because it needs decisions rather than commands:
    · Other AWS accounts. Open AWS -> Accounts -> "How do I add an account?"
      in the app; it generates the template, the parameters and the links.
      docs/aws-guardrails/accounts.md
    · Whether guardrails may change anything. Both rules are report-only and
      every rule starts in report mode. Switch one to enforce in the app to grant
      three write actions.  docs/aws-guardrails/permissions.md

  Worth doing next:
    · Create a repo in $GH_ORG and confirm it appears in the activity feed.
      If it does not, the webhook secret or the events list is wrong.
    · Set a log group's retention to 1 day and watch the guardrail flag it.
    · Activity rows expire after 13 months (a year plus slack, so a
      twelve-month audit always finds a complete record). Override with
      ACTIVITY_RETENTION_MONTHS if your policy differs.
EOF
