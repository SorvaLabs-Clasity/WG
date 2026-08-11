#!/usr/bin/env bash
#
# Creates a CloudTrail trail so guardrails can run the moment a resource is
# created instead of waiting for the 15-minute sweep.
#
# Management events on the first trail in an account are free; the only cost is
# S3 storage for the log files, which a 7-day lifecycle rule keeps negligible.
#
# Safe to re-run: every step checks for what it is about to create.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TRAIL_NAME="${TRAIL_NAME:-github-control-hub-trail}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="github-control-hub-cloudtrail-${ACCOUNT}"
TRAIL_ARN="arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/${TRAIL_NAME}"

echo "account ${ACCOUNT}  region ${REGION}"

# ── log bucket ────────────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "bucket ${BUCKET} already exists"
else
  echo "creating bucket ${BUCKET}"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  # Audit logs are the one thing you must not lose to a fat-fingered delete.
  aws s3api put-bucket-versioning --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --lifecycle-configuration '{"Rules":[{"ID":"expire","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":7},"NoncurrentVersionExpiration":{"NoncurrentDays":1}}]}'
fi

# ── bucket policy ─────────────────────────────────────────────────────
# CloudTrail needs to read the bucket ACL and write objects. SourceArn pins
# both statements to this trail so no other account's trail can write here.
# The SecureTransport deny is the same thing the s3_https_only guardrail
# enforces — a bucket created by our own tooling should not be a finding.
cat > /tmp/ct-bucket-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AWSCloudTrailAclCheck",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:GetBucketAcl",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": { "StringEquals": { "aws:SourceArn": "${TRAIL_ARN}" } }
    },
    {
      "Sid": "AWSCloudTrailWrite",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${BUCKET}/AWSLogs/${ACCOUNT}/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-acl": "bucket-owner-full-control",
          "aws:SourceArn": "${TRAIL_ARN}"
        }
      }
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/ct-bucket-policy.json
rm -f /tmp/ct-bucket-policy.json
echo "bucket policy applied"

# ── trail ─────────────────────────────────────────────────────────────
if aws cloudtrail get-trail --name "$TRAIL_NAME" >/dev/null 2>&1; then
  echo "trail ${TRAIL_NAME} already exists"
else
  echo "creating trail ${TRAIL_NAME}"
  aws cloudtrail create-trail \
    --name "$TRAIL_NAME" \
    --s3-bucket-name "$BUCKET" \
    --is-multi-region-trail \
    --enable-log-file-validation \
    --region "$REGION" >/dev/null
fi

# Management events only. Data events (per-object S3 reads) are the expensive
# ones and nothing here needs them.
aws cloudtrail put-event-selectors --trail-name "$TRAIL_NAME" --region "$REGION" \
  --event-selectors '[{"ReadWriteType":"All","IncludeManagementEvents":true,"DataResources":[]}]' >/dev/null

aws cloudtrail start-logging --name "$TRAIL_NAME" --region "$REGION"

echo
aws cloudtrail get-trail-status --name "$TRAIL_NAME" --region "$REGION" \
  --query '{IsLogging:IsLogging,LatestDeliveryError:LatestDeliveryError}' --output table
echo "done — EventBridge will now see CreateBucket / CreateLogGroup"
