# The guardrail Lambda

`github-control-hub-guardrail-enforcer` — the only thing that evaluates AWS
guardrails.

## Configuration

| | |
|---|---|
| Runtime | `nodejs22.x` |
| Timeout | 10 minutes |
| Memory | 512 MB |
| Bundle | ~2 MB, AWS SDK included |
| DLQ | SQS, 14-day retention |

## Why it is separate from the EC2

It needs no inbound connectivity. Keeping enforcement here lets the instance's
security group stay closed to everything but GitHub's webhook ranges.

## Triggers

| Trigger | Scope |
|---|---|
| EventBridge schedule, every 15 minutes | Full sweep |
| EventBridge on a CloudTrail event | Just the resource that changed, in the account it changed in |
| Direct invoke from the app | Whatever the caller asked for |

The event path narrows to the originating account — sweeping the whole estate
because one bucket policy changed would turn a routine `PutBucketPolicy` into a
full multi-account pass, and the app's own remediations fire those events.

The scheduled sweep is the floor, not an optimisation: it catches drift, covers
anything the event path missed, and works with no CloudTrail at all.

## Why the SDK is bundled

Managed runtimes have shipped AWS SDK v3, and leaning on that keeps the artifact
small — at the cost of running against whichever version AWS happens to ship,
which can change with no deploy of ours. Bundling removes that variable and
makes the function correct on any runtime.

It costs about two megabytes and a fraction of a second of cold start, on a
function that runs every fifteen minutes and then makes hundreds of AWS calls.
