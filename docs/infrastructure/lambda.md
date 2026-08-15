# Lambda

Three functions, each bundled straight from `backend/src` so the deployed code
and the app share one source tree.

| Function | Entry | Job |
|---|---|---|
| `github-control-hub-guardrail-enforcer` | `aws-guardrails/handler.ts` | Evaluates AWS guardrails |
| `github-control-hub-webhook-receiver` | `webhooks/receiver.ts` | Verifies a GitHub webhook's signature and enqueues it |
| `github-control-hub-webhook-worker` | `webhooks/worker.ts` | Reads the queue, claims the delivery, does the actual processing |
| `github-control-hub-alarm-evaluator` | `alarms/handler.ts` | Evaluates widget alarms that are due, emails the ones that cross |
| `github-control-hub-audit-ingest` | `audit/ingest.ts` | Turns each streamed enterprise audit object into activity rows |

## Configuration

| | Guardrail enforcer | Webhook receiver | Webhook worker |
|---|---|---|---|
| Runtime | `nodejs24.x` | `nodejs24.x` | `nodejs24.x` |
| Timeout | 10 minutes | 8 seconds | 10 minutes |
| Memory | 512 MB | 256 MB | 512 MB |
| DLQ | SQS, 14-day retention | — | SQS, 14-day retention |

The receiver's eight seconds is a ceiling below GitHub's own ten-second
timeout — past that point nobody is listening for the response. The worker's
ten minutes is Lambda's maximum: a single delivery can chain a compliance
refresh, graph edge updates and scanner runs, and duration is billed as used,
not as allocated, so the higher ceiling costs nothing on the ordinary delivery
that finishes in two seconds.

Only the receiver is reachable from outside AWS. The worker takes work from a
queue, the enforcer and the evaluator are woken by EventBridge, and the audit
ingester by an S3 notification — none of them has a path from the internet.

## Why the functions are separate from each other

Each holds only what its own job needs. The receiver — the only one of the
three reachable from the internet — can read one secret and send one queue
message; it has no DynamoDB access, no STS, no Organizations, no Lambda
invoke. The worker holds the application's tables and the GitHub App token,
and is reachable only from the queue, never directly. The guardrail engine
needs neither of those and instead needs `sts:AssumeRole` into other AWS
accounts. None of the three needs inbound connectivity of its own — API
Gateway is what's public, not the functions behind it — which is what let the
EC2 instance these replaced go, security group and all.

## Triggers

| Function | Trigger | Scope |
|---|---|---|
| Guardrail enforcer | EventBridge schedule, every 15 minutes | Full sweep |
| Guardrail enforcer | EventBridge on a CloudTrail event | Just the resource that changed, in the account it changed in |
| Alarm evaluator | EventBridge schedule, every 5 minutes | Only alarms whose own interval is up — Dependabot-backed ones every 10 minutes, everything else every 15 |
| Audit ingest | S3 object-created notification | One streamed batch |
| Guardrail enforcer | Direct invoke from the app | Whatever the caller asked for |
| Webhook receiver | API Gateway, `POST /webhooks/github` | One delivery |
| Webhook worker | SQS event source mapping, batch size 1 | One delivery, claimed from the queue |

The guardrail event path narrows to the originating account — sweeping the
whole estate because one bucket policy changed would turn a routine
`PutBucketPolicy` into a full multi-account pass, and the app's own
remediations fire those events.

The scheduled sweep is the floor, not an optimisation: it catches drift, covers
anything the event path missed, and works with no CloudTrail at all.

## Why the SDK is bundled

Managed runtimes have shipped AWS SDK v3, and leaning on that keeps the artifact
small — at the cost of running against whichever version AWS happens to ship,
which can change with no deploy of ours. Bundling removes that variable and
makes the function correct on any runtime.

It costs about two megabytes and a fraction of a second of cold start on the
guardrail enforcer, which runs every fifteen minutes and then makes hundreds of
AWS calls. The webhook functions pay the same bundling cost against a much
smaller invocation.
