# The EC2 instance

A `t3.small` running the backend in Docker. It exists for one reason.

## Its job

**Receiving GitHub webhooks.** GitHub must POST to a public HTTPS endpoint, and
a desktop app has no public address.

Everything else it can do — serving the API, serving the UI — the desktop app
also does, locally, which is how you actually use the product.

## Security posture

- Inbound: **443 only, from GitHub's four webhook CIDR ranges**
- **No SSH port at all.** Access is via SSM Session Manager
- Runs as a non-root user in the container
- Self-signed TLS; GitHub is configured to accept it

The public IP is not usable by anyone else — the security group rejects
everything outside those ranges.

## What is lost if it is off

Webhook deliveries. Not delayed — **lost**. GitHub retries for a while, then
gives up. Concretely, the activity feed stops recording changes made directly in
GitHub, and auto-apply templates stop firing on new repositories.

AWS guardrails are unaffected: they run in the Lambda.

## Deploying to it

`scripts/deploy.sh <instance-id>` builds the image for `linux/amd64`, ships it
through an S3 bucket the stack owns, and loads it over SSM. About a minute of
downtime.

The remote script uses `set -e` deliberately: without it a failed download falls
through to `docker run`, silently restarting the *previous* image while
reporting success.

## Could it be replaced

Yes. API Gateway plus a Lambda would receive webhooks for roughly nothing at
this volume, and the instance is about 72% of the running cost. Worth
considering before provisioning the same box somewhere else.
