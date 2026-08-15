# Where code runs

The same backend is compiled once and started two ways: as the desktop app,
and as Lambda functions. Within Lambda there are three separate entry points,
each with its own trigger and its own IAM role. What differs across all of
them is who the code authenticates as and what triggers it.

## Desktop app

Started by Electron at launch, listening on `localhost:4321`.

- Uses your AWS profile (`~/.aws/config`) to read DynamoDB and Secrets Manager
- Uses your GitHub OAuth token for anything that touches a repository
- Serves the React UI to the Electron window

Everything you click happens here. Turn off every Lambda and the desktop app
still works for everything except the events GitHub sends on its own.

## Webhook receiver and worker

Two Lambdas behind API Gateway, giving GitHub the public HTTPS endpoint no
desktop app has. `webhook-receiver` verifies the HMAC signature and enqueues
the delivery to SQS, responding `202` in tens of milliseconds. `webhook-worker`
reads off that queue, claims the delivery against a DynamoDB dedup lock, and
does the actual processing.

Splitting them means the only function reachable from the internet
(`webhook-receiver`) can read one secret and send one queue message — nothing
else. `webhook-worker`, which holds every table and the GitHub App token, is
reachable only from that queue.

Together they record into the activity log the things nobody did through the
app:

- a branch deleted
- branch protection disabled, or a ruleset edited
- a repository made public or private
- someone added to or removed from the organization
- a team gaining or losing access to a repository

**If a delivery is rejected at the gateway, it is lost, same as before** —
GitHub retries for a while against the same endpoint, then gives up. A
delivery that reaches the queue is different: if it fails, SQS redelivers it,
and only after five failed attempts does it land in the dead-letter queue,
where a CloudWatch alarm fires and it can be redriven. See
[webhooks](../github-api/webhooks.md).

## Guardrail Lambda

`github-control-hub-guardrail-enforcer`, invoked three ways:

| Trigger | When |
|---|---|
| EventBridge schedule | every 15 minutes |
| EventBridge CloudTrail rule | a covered resource is created or changed |
| Direct invoke | someone presses Sweep in the app |

All three run the same function with different options, so a manual run cannot
behave differently from an automatic one.

## Alarm evaluator

`github-control-hub-alarm-evaluator`, on an EventBridge schedule every **five
minutes**. That is the tick, not the interval: each alarm carries its own and is
evaluated on the first tick after it comes due — Dependabot-backed widgets every
10 minutes, everything else every 15. Ticks with nothing due read the alarms
table and return.

The tick must divide every interval, since an alarm can only be evaluated when
the rule fires. See [alarms](../features/alarms.md).

## Audit log ingest

`github-control-hub-audit-log-ingest`, on no schedule at all. S3 invokes it when
GitHub writes a batch into the audit-log bucket, so it runs only when there is
something to read.

## What runs nowhere on a schedule

Graph aggregation. It rebuilds only when someone presses **Sync data**, on
whichever backend they are using. This is why a fresh feature that adds new
edge types shows nothing until you sync.
