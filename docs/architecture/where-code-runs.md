# Where code runs

The same backend is compiled once and started three ways. What differs is who
it authenticates as and what triggers it.

## Desktop app

Started by Electron at launch, listening on `localhost:4321`.

- Uses your AWS profile (`~/.aws/config`) to read DynamoDB and Secrets Manager
- Uses your GitHub OAuth token for anything that touches a repository
- Serves the React UI to the Electron window

Everything you click happens here. Turn off the EC2 and the app still works.

## EC2 instance

Started by Docker via `scripts/deploy.sh`, listening on 443 behind a security
group that allows only GitHub's four webhook CIDR ranges.

Its job is webhooks. It records into the activity log the things nobody did
through the app:

- a branch deleted
- branch protection disabled, or a ruleset edited
- a repository made public or private
- someone added to or removed from the organization
- a team gaining or losing access to a repository

It also applies auto-apply templates to newly created repositories, since only
it hears about them.

**If the EC2 is off, those events are not delayed — they are lost.** GitHub
retries for a while, then gives up.

## Lambda

`github-control-hub-guardrail-enforcer`, invoked three ways:

| Trigger | When |
|---|---|
| EventBridge schedule | every 15 minutes |
| EventBridge CloudTrail rule | a covered resource is created or changed |
| Direct invoke | someone presses Sweep in the app |

All three run the same function with different options, so a manual run cannot
behave differently from an automatic one.

## What runs nowhere on a schedule

Graph aggregation. It rebuilds only when someone presses **Sync data**, on
whichever backend they are using. This is why a fresh feature that adds new
edge types shows nothing until you sync.
