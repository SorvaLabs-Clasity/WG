# GitHub Control Hub — documentation

A desktop app that reports on a GitHub organization's security posture and
enforces a small number of AWS guardrails. It reads far more than it writes,
and everything it writes is attributable to a person.

Start here depending on what you need.

## I want to understand the system

| | |
|---|---|
| [How it works](HOW-IT-WORKS.md) | **Start here.** Every feature's mechanism — where its data lives, what writes it, how often, and how stale it can get |
| [Architecture](architecture/) | The processes, and which one does what |
| [Authentication](auth/) | The two keys: AWS and GitHub, and why both |
| [Data](data/) | The DynamoDB tables and the graph model |

## I want to understand a feature

[Features](features/) — one page per tab in the app: what it answers, where the
data comes from, and what it deliberately does not do.

Two that cut across tabs: [alarms and email](features/alarms.md) — thresholds on
widgets and security alerts by email — and the
[enterprise audit log](features/audit-log.md).

## I want to run or change it

| | |
|---|---|
| [Operations](operations/) | Setting one up, deploying, troubleshooting |
| [Security](security/) | What the app can and cannot do, and the last review |
| [Infrastructure](infrastructure/) | The CDK stack, Lambda, cost |
| [Development](development/) | Testing, conventions |

## I want to know what it can do to my AWS account

[AWS guardrails](aws-guardrails/), and specifically
[permissions](aws-guardrails/permissions.md) — the full inventory, written to be
handed to whoever approves the deployment.

---

## The one-paragraph version

An Electron app runs a local Express backend and talks to the GitHub REST API
as **you**, so GitHub decides what you are allowed to do. API Gateway and two
Lambdas receive GitHub webhooks, which no desktop app can, and process them off
a queue. A third Lambda evaluates AWS guardrails on a schedule. State lives in
DynamoDB. Nothing is installed into the repositories or accounts being watched.
