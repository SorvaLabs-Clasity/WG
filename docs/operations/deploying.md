# Deploying

## Desktop

```bash
cd github-control-hub/desktop
npm run dist:mac         # .dmg + .zip into release/
```

Bump `version` in `desktop/package.json` first if anyone else will install it —
that is what the auto-updater compares.

Replace `/Applications/GitHub Control Hub.app` with the built one, or open the
`.dmg` and drag it.

**Verify it launched**, do not assume. A clean typecheck says nothing about
whether the packaged app starts:

```bash
"release/mac-arm64/GitHub Control Hub.app/Contents/MacOS/GitHub Control Hub"
```

## EC2

```bash
./scripts/deploy.sh <instance-id>
```

Builds for `linux/amd64`, ships the image through the stack's S3 bucket, loads
it over SSM. ~1 minute of downtime, during which **webhook deliveries are
lost** — so avoid doing repository admin at the same time.

Confirm the new code is actually running:

```bash
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["docker ps --format \"{{.Image}} {{.Status}}\""]'
```

## Infrastructure

```bash
cd github-control-hub/infra
npx cdk diff                    # read the IAM changes before applying them
npx cdk deploy                  # read-only
npx cdk deploy -c enforce=true  # plus three write actions
```

The stack prints `CanChangeAnything` so the deployment states which it is.

## After deploying a feature that adds graph edges

Press **Sync data** on the Repos page. New edge types do not exist in an old
graph, and the pages that need them will say they are stale.
