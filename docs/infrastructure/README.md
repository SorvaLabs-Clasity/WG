# Infrastructure

One CDK stack, `GitHubControlHub`, in TypeScript alongside the app.

## What it creates

| Resource | Purpose |
|---|---|
| API Gateway (REST) | Public endpoint for GitHub webhooks; resource policy allow-lists GitHub's four CIDR ranges |
| Lambda × 3 | [Webhook receiver, webhook worker](lambda.md), and the [guardrail engine](lambda.md) |
| SQS queue | Between the receiver and the worker |
| SQS dead-letter queues | Failed webhook deliveries and failed guardrail invocations, 14-day retention, each with a CloudWatch alarm |
| DynamoDB table (deliveries) | The one table this stack owns — five-minute dedup state for the worker |
| EventBridge rules | 15-minute guardrail sweep, plus CloudTrail triggers |

The other eleven DynamoDB tables are **not** in the stack — they are created by
`scripts/setup-aws-account.sh`, so tearing the stack down does not take the
data with it. The deliveries table is the exception: it holds nothing but
short-lived dedup state, so it belongs with the infrastructure that depends on
it and is destroyed along with the stack.

## Deploying

```bash
cd github-control-hub/infra
npx cdk deploy                 # read-only: the app cannot change AWS
npx cdk deploy # also grants three write actions
```

That flag is the whole difference between a tool that could alter production and
one that cannot. It is off by default and the stack prints which it is:

```
CanChangeAnything = no - read-only
```

## Why the stack is TypeScript

All three Lambdas bundle straight from `backend/src` — the guardrail engine
from `aws-guardrails/handler.ts`, the receiver and worker from `webhooks/`. The
deployed functions and the desktop app share one source tree and cannot drift
apart. The guardrail role name is a shared constant across the stack, the app
and the account role template, with a test asserting all three agree.

Defining infrastructure in the same language as the code it deploys is what
makes both of those possible.

## Read next

- [Lambda](lambda.md) · [Cost](cost.md)
- [Permissions](../aws-guardrails/permissions.md)
