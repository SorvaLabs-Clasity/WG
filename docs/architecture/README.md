# Architecture

Three processes run the same codebase for different reasons.

```
┌──────────────────────┐         ┌──────────────────────┐
│  Desktop (Electron)  │         │  EC2 instance        │
│  ──────────────────  │         │  ──────────────────  │
│  React UI            │         │  Same Express app,   │
│  Express backend     │         │  no UI in practice   │
│  Your AWS profile    │         │  Instance role       │
│                      │         │                      │
│  Everything you do   │         │  Receives webhooks   │
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

## Why three

**Desktop** is the product. It runs its own backend on `localhost:4321` so that
GitHub calls carry *your* OAuth token — see [authentication](../auth/).

**EC2** exists for one reason: GitHub webhooks need a public HTTPS endpoint and
a laptop does not have one. See [where code runs](where-code-runs.md) for what
is lost if it is off.

**Lambda** evaluates [AWS guardrails](../aws-guardrails/). It is separate
because it needs no inbound connectivity, which lets the EC2 security group
stay closed to everything but GitHub.

## What there isn't

- **No agent** installed in any repository or AWS account. GitHub is read and
  changed through its REST API, live, with the caller's own permissions.
- **No database** other than DynamoDB.
- **No scheduled jobs in the backend.** The only schedule is the Lambda's.
  Graph rebuilds happen when someone presses Sync data.

## Read next

- [Where code runs](where-code-runs.md) — what breaks if each piece is down
- [Request path](request-path.md) — a click, traced to the end
