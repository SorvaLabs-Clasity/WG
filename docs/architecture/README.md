# Architecture

The same backend code runs as a desktop app and as Lambda functions, started
differently for different reasons.

```
┌──────────────────────┐         ┌──────────────────────┐
│  Desktop (Electron)  │         │  API Gateway →        │
│  ──────────────────  │         │  webhook-receiver →   │
│  React UI            │         │  SQS → webhook-worker │
│  Express backend     │         │  ──────────────────  │
│  Your AWS profile    │         │  Receives webhooks    │
│                      │         │                       │
│  Everything you do   │         │                       │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                │
           │      ┌──────────────────┐      │
           └─────►│    DynamoDB      │◄─────┘
                  │  shared state    │
                  └────────▲─────────┘
                           │
                  ┌────────┴─────────┐
                  │  Lambda          │
                  │  AWS guardrails  │
                  │  every 15 min    │
                  └──────────────────┘
```

## Why split this way

**Desktop** is the product. It runs its own backend on `localhost:4321` so that
GitHub calls carry *your* OAuth token — see [authentication](../auth/).

**The webhook receiver and worker** exist for one reason: GitHub webhooks need
a public HTTPS endpoint and a laptop does not have one. Splitting receiving
from processing means the only function reachable from the internet holds
almost no privilege. See [where code runs](where-code-runs.md) for what is
lost if either is down.

**The guardrail Lambda** evaluates [AWS guardrails](../aws-guardrails/). It is
separate because it needs no inbound connectivity, and because the AWS
permissions it needs are unrelated to anything GitHub-facing.

## What there isn't

- **No agent** installed in any repository or AWS account. GitHub is read and
  changed through its REST API, live, with the caller's own permissions.
- **No database** other than DynamoDB.
- **No scheduled jobs in the backend.** The only schedule is the Lambda's.
  Graph rebuilds happen when someone presses Sync data.

## Read next

- [Where code runs](where-code-runs.md) — what breaks if each piece is down
- [Request path](request-path.md) — a click, traced to the end
