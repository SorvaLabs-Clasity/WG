# Infrastructure

One CDK stack, `GitHubControlHub`, in TypeScript alongside the app.

## What it creates

| Resource | Purpose |
|---|---|
| EC2 instance (t3.small) | [Webhook receiver](ec2.md) |
| Elastic IP | Stable address for GitHub's webhook config |
| Security group | 443 from GitHub's four CIDR ranges. No SSH |
| Instance role | DynamoDB, Secrets Manager, STS, Organizations |
| Lambda | [Guardrail engine](lambda.md) |
| SQS dead-letter queue | Failed guardrail invocations, 14-day retention |
| EventBridge rules | 15-minute sweep, plus CloudTrail triggers |

DynamoDB tables are **not** in the stack — they are created by
`scripts/setup-aws-account.sh`, so tearing the stack down does not take the data
with it.

## Deploying

```bash
cd github-control-hub/infra
npx cdk deploy                 # read-only: the app cannot change AWS
npx cdk deploy -c enforce=true # also grants three write actions
```

That flag is the whole difference between a tool that could alter production and
one that cannot. It is off by default and the stack prints which it is:

```
CanChangeAnything = no - read-only
```

## Why CDK and not Terraform

Mostly a wash, with one real advantage here: the Lambda is bundled straight from
`backend/src/aws-guardrails/handler.ts`, so the deployed function and the app
share one source tree and cannot drift. The role name is a shared TypeScript
constant across the stack, the app and the account template, with a test
asserting all three agree.

If your organization standardises on Terraform, converting this stack is about
250 lines and a reasonable thing to do.

## Read next

- [EC2](ec2.md) · [Lambda](lambda.md) · [Cost](cost.md)
- [Permissions](../aws-guardrails/permissions.md)
