#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# GitHub Control Hub — Deploy to EC2
#
# Prerequisites:
#   1. EC2 instance running (deploy with: cd github-control-hub/infra && npx cdk deploy)
#   2. AWS CLI configured with credentials
#   3. Session Manager plugin installed: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
#   4. Docker installed locally
#
# Usage:
#   ./scripts/deploy.sh <instance-id>
#
# Example:
#   ./scripts/deploy.sh i-0abc123def456789
# ─────────────────────────────────────────────────────────

INSTANCE_ID="${1:?Usage: deploy.sh <instance-id>}"
IMAGE_NAME="github-control-hub"
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

echo "==> Building Docker image (linux/amd64)..."
docker build --platform linux/amd64 -t "$IMAGE_NAME" .

echo "==> Saving image..."
docker save "$IMAGE_NAME" | gzip > /tmp/${IMAGE_NAME}.tar.gz

echo "==> Uploading image to EC2 via SSM..."
# Start a port-forward to copy the file, then load it on the instance

# First, upload the image using S3 as a transfer mechanism
BUCKET="github-control-hub-deploy-$(aws sts get-caller-identity --query Account --output text)"
aws s3 mb "s3://${BUCKET}" --region "$REGION" 2>/dev/null || true
aws s3 cp /tmp/${IMAGE_NAME}.tar.gz "s3://${BUCKET}/${IMAGE_NAME}.tar.gz"

echo "==> Loading image and starting container on EC2..."
# `set -e` on the remote script matters: without it a failed download still falls
# through to `docker run`, which silently restarts the PREVIOUS image and reports
# success. That shipped stale code more than once.
COMMAND_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    'set -e',
    'aws s3 cp s3://${BUCKET}/${IMAGE_NAME}.tar.gz /tmp/${IMAGE_NAME}.tar.gz --region ${REGION}',
    'docker load < <(gunzip -c /tmp/${IMAGE_NAME}.tar.gz)',
    'rm -f /tmp/${IMAGE_NAME}.tar.gz',
    'chown 1000:1000 /etc/ssl/github-control-hub/server.key 2>/dev/null || true',
    'chmod 600 /etc/ssl/github-control-hub/server.key 2>/dev/null || true',
    'chmod 644 /etc/ssl/github-control-hub/server.crt 2>/dev/null || true',
    'docker stop ${IMAGE_NAME} 2>/dev/null || true',
    'docker rm ${IMAGE_NAME} 2>/dev/null || true',
    'docker run -d --name ${IMAGE_NAME} --restart unless-stopped -p 443:4321 -v /etc/ssl/github-control-hub:/etc/ssl/github-control-hub:ro -e AWS_REGION=${REGION} ${IMAGE_NAME}',
    'sleep 3',
    'curl -sfk https://localhost/health && echo \"App is healthy!\"'
  ]" \
  --region "$REGION" \
  --output text \
  --query "Command.CommandId")

echo "    command id: $COMMAND_ID"
echo "==> Waiting for the instance to finish loading the image..."
# Must complete BEFORE the S3 object is deleted below, or the download races the
# cleanup and the instance keeps running the old image.
while true; do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --region "$REGION" --query Status --output text 2>/dev/null || echo "Pending")
  case "$STATUS" in
    Success) break;;
    Failed|Cancelled|TimedOut|Undeliverable|Terminated)
      echo "==> Remote deploy $STATUS:"
      aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
        --region "$REGION" --query 'StandardErrorContent' --output text | tail -20
      aws s3 rm "s3://${BUCKET}/${IMAGE_NAME}.tar.gz" 2>/dev/null || true
      rm -f /tmp/${IMAGE_NAME}.tar.gz
      exit 1;;
  esac
  sleep 5
done

aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --region "$REGION" --query 'StandardOutputContent' --output text | tail -3

# Clean up — safe now that the instance has the image
aws s3 rm "s3://${BUCKET}/${IMAGE_NAME}.tar.gz" 2>/dev/null || true
rm -f /tmp/${IMAGE_NAME}.tar.gz

# Get the public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text \
  --region "$REGION")

echo ""
echo "==> Deploy complete!"
echo "    App:     https://${PUBLIC_IP}"
echo "    Webhook: https://${PUBLIC_IP}/api/webhooks/github"
echo "    Connect: aws ssm start-session --target ${INSTANCE_ID}"
echo ""
echo "    Next steps:"
echo "    1. Update your GitHub OAuth App callback URL to: https://${PUBLIC_IP}/auth/callback"
echo "    2. Add a GitHub webhook with payload URL: https://${PUBLIC_IP}/api/webhooks/github"
