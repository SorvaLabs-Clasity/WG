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
REGION="${AWS_REGION:-us-east-1}"

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
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    'aws s3 cp s3://${BUCKET}/${IMAGE_NAME}.tar.gz /tmp/${IMAGE_NAME}.tar.gz --region ${REGION}',
    'docker load < <(gunzip -c /tmp/${IMAGE_NAME}.tar.gz)',
    'rm -f /tmp/${IMAGE_NAME}.tar.gz',
    'chmod 644 /etc/ssl/github-control-hub/server.key /etc/ssl/github-control-hub/server.crt 2>/dev/null || true',
    'docker stop ${IMAGE_NAME} 2>/dev/null || true',
    'docker rm ${IMAGE_NAME} 2>/dev/null || true',
    'docker run -d --name ${IMAGE_NAME} --restart unless-stopped -p 443:4321 -v /etc/ssl/github-control-hub:/etc/ssl/github-control-hub:ro -e AWS_REGION=${REGION} ${IMAGE_NAME}',
    'sleep 3',
    'curl -sfk https://localhost/health && echo \"App is healthy!\" || echo \"Health check failed\"'
  ]" \
  --region "$REGION" \
  --output text \
  --query "Command.CommandId"

echo "==> Command sent. Waiting for completion..."
sleep 5

# Clean up
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
