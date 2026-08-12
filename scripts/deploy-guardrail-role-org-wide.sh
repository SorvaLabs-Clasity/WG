#!/usr/bin/env bash
#
# Give the GitHub Control Hub read access to every account in your AWS
# organisation, in one command.
#
# This deploys guardrail-account-role.yaml as a CloudFormation StackSet with
# automatic deployment turned on, which means:
#
#   - every account currently in the organisation gets the role
#   - every account created or invited *later* gets it too, without anyone
#     remembering to do anything
#   - removing an account from the organisation removes the role with it
#
# The alternative — letting the app assume OrganizationAccountAccessRole, which
# AWS already puts in every account — needs no setup at all, and this app is
# deliberately incapable of it. That role carries AdministratorAccess, and an
# application running in a production account should not be able to become an
# administrator of anything. This script is the one-off cost of not doing that.
#
# The role it creates can read S3 and CloudWatch Logs *configuration*: whether
# a bucket has a policy, how long a log group keeps data. It cannot read the
# contents of any bucket or any log line, and by default it cannot change
# anything at all.
#
# Run from your organisation's MANAGEMENT account (or a CloudFormation
# delegated administrator).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/guardrail-account-role.yaml"
STACKSET_NAME="github-control-hub-guardrail-access"

[[ -f "$TEMPLATE" ]] || { echo "Cannot find $TEMPLATE"; exit 1; }

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local __v="$1" prompt="$2" default="${3:-}" reply
        if [[ -n "$default" ]]; then read -r -p "$prompt [$default]: " reply || true
                                    reply="${reply:-$default}"
        else                        read -r -p "$prompt: " reply || true; fi
        printf -v "$__v" '%s' "$reply"; }

# ── Who are we ────────────────────────────────────────────────────────
ask PROFILE "AWS profile for the organisation MANAGEMENT account" "default"
AWS="aws --profile $PROFILE"

say "Checking that profile"
$AWS sts get-caller-identity --output table

if ! ORG_JSON=$($AWS organizations describe-organization --output json 2>/dev/null); then
  cat <<'EOF'

That profile cannot read an AWS Organization. Either this account is not in
one, or the profile is not the management account.

If you only have a handful of accounts, deploy the role to each of them
individually instead:

  aws cloudformation deploy \
    --template-file scripts/guardrail-account-role.yaml \
    --stack-name control-hub-guardrail-access \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile <each account> \
    --parameter-overrides ControlHubRoleArn=<the app's role ARN>

EOF
  exit 1
fi

ROOT_ID=$($AWS organizations list-roots --query 'Roots[0].Id' --output text)
ACCOUNT_COUNT=$($AWS organizations list-accounts --query 'length(Accounts)' --output text)
FEATURE_SET=$(printf '%s' "$ORG_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Organization"]["FeatureSet"])')

if [[ "$FEATURE_SET" != "ALL" ]]; then
  echo
  echo "This organisation is in CONSOLIDATED_BILLING mode. StackSets need all features enabled:"
  echo "  aws organizations enable-all-features --profile $PROFILE"
  echo "(every member account has to approve the invitation, so this is not instant)"
  exit 1
fi

# ── What the role should trust ────────────────────────────────────────
cat <<'EOF'

The role created in each account will trust exactly one principal: the role the
Control Hub itself runs as. Its ARN is printed by the Control Hub's own
CloudFormation stack as "GuardrailLambdaRoleArn".

  aws cloudformation describe-stacks --stack-name GitHubControlHub \
    --query "Stacks[0].Outputs[?OutputKey=='GuardrailLambdaRoleArn'].OutputValue" --output text

EOF

ask CONTROL_HUB_ROLE_ARN "The Control Hub's role ARN"
if [[ ! "$CONTROL_HUB_ROLE_ARN" =~ ^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$ ]]; then
  echo "That is not an IAM role ARN."; exit 1
fi

ask ROLE_NAME "Name for the role in each account" "github-control-hub-guardrail-access"

# An external ID closes the confused-deputy case: without one, any other
# installation of this app that knows your account numbers could ask to be let
# in. Generated rather than typed, because a memorable one is a guessable one.
ask EXTERNAL_ID "External ID (blank to generate one)" ""
if [[ -z "$EXTERNAL_ID" ]]; then
  EXTERNAL_ID=$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 32)
  echo "    generated: $EXTERNAL_ID"
  echo "    Put this in the Control Hub when adding accounts. Keep a copy."
fi

echo
echo "Should the Control Hub be able to CHANGE anything in these accounts?"
echo "  no  — it reports violations and is incapable of fixing them (recommended)"
echo "  yes — it may also call PutBucketPolicy, PutRetentionPolicy and"
echo "        DeleteRetentionPolicy. Nothing else, ever."
ask ALLOW_WRITES "Allow changes? (yes/no)" "no"
READ_ONLY="true"; [[ "$ALLOW_WRITES" == "yes" ]] && READ_ONLY="false"

# IAM is global, so the StackSet only needs to run in one region. Deploying to
# several would try to create the same role name repeatedly and fail.
ask REGION "Region to run the StackSet in (the role itself is global)" "${AWS_REGION:-us-east-1}"

say "About to do this"
cat <<EOF
    organisation root:  $ROOT_ID
    accounts affected:  $ACCOUNT_COUNT now, plus any created later
    role name:          $ROLE_NAME
    trusts:             $CONTROL_HUB_ROLE_ARN
    external ID:        ${EXTERNAL_ID:0:6}… (${#EXTERNAL_ID} chars)
    can change things:  $([[ "$READ_ONLY" == "true" ]] && echo "no, read-only" || echo "yes, three actions")
EOF
read -r -p "Proceed? [y/N] " confirm
[[ "$confirm" == [yY] ]] || { echo "Aborted."; exit 1; }

PARAMS="ParameterKey=ControlHubRoleArn,ParameterValue=$CONTROL_HUB_ROLE_ARN \
        ParameterKey=RoleName,ParameterValue=$ROLE_NAME \
        ParameterKey=ExternalId,ParameterValue=$EXTERNAL_ID \
        ParameterKey=ReadOnly,ParameterValue=$READ_ONLY"

# ── Create or update the StackSet ─────────────────────────────────────
if $AWS cloudformation describe-stack-set --stack-set-name "$STACKSET_NAME" \
     --call-as SELF --region "$REGION" >/dev/null 2>&1; then
  say "Updating the existing StackSet"
  $AWS cloudformation update-stack-set \
    --stack-set-name "$STACKSET_NAME" \
    --template-body "file://$TEMPLATE" \
    --parameters $PARAMS \
    --capabilities CAPABILITY_NAMED_IAM \
    --permission-model SERVICE_MANAGED \
    --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
    --region "$REGION" >/dev/null
else
  say "Creating the StackSet"
  $AWS cloudformation create-stack-set \
    --stack-set-name "$STACKSET_NAME" \
    --description "Read-only access for the GitHub Control Hub" \
    --template-body "file://$TEMPLATE" \
    --parameters $PARAMS \
    --capabilities CAPABILITY_NAMED_IAM \
    --permission-model SERVICE_MANAGED \
    --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
    --region "$REGION" >/dev/null

  say "Rolling it out to every account in the organisation"
  # FailureTolerancePercentage 100: one account that cannot take the role — a
  # suspended one, say — must not stop the other forty from getting it.
  $AWS cloudformation create-stack-instances \
    --stack-set-name "$STACKSET_NAME" \
    --deployment-targets "OrganizationalUnitIds=$ROOT_ID" \
    --regions "$REGION" \
    --operation-preferences FailureTolerancePercentage=100,MaxConcurrentPercentage=100 \
    --region "$REGION" >/dev/null
fi

say "Started"
cat <<EOF
Rollout runs in the background — a few minutes for a large organisation.

Watch it:
  aws cloudformation list-stack-instances --stack-set-name $STACKSET_NAME \\
    --profile $PROFILE --region $REGION \\
    --query 'Summaries[].[Account,Status,StatusReason]' --output table

Then open the Control Hub, go to AWS -> Accounts -> Find my accounts. Every
account with the role will be listed as ready to add.
EOF

if [[ -n "$EXTERNAL_ID" ]]; then
  echo
  echo "External ID (needed when adding accounts): $EXTERNAL_ID"
fi
