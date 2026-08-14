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

## Infrastructure, including the webhook and guardrail Lambdas

```bash
cd github-control-hub/infra
npx cdk diff                    # read the IAM changes before applying them
npx cdk deploy                  # no required context
```

This is the only deploy step for backend changes that affect webhook handling
or guardrail evaluation — `cdk deploy` bundles all three Lambdas straight from
`backend/src`, so there is nothing to build or ship separately. A few minutes
of deploy time, with no downtime for webhooks: API Gateway and the queue keep
accepting deliveries while the functions behind them update.

The stack prints `CanChangeAnything` so the deployment states which it is.

## After deploying a feature that adds graph edges

Press **Sync data** on the Repos page. New edge types do not exist in an old
graph, and the pages that need them will say they are stale.
