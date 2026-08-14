# Cost

Figures below assume an organization of roughly 350 repositories.

| Item | Monthly |
|---|---|
| API Gateway (REST), $3.50/M requests | pennies |
| Lambda (guardrail enforcer, webhook receiver, webhook worker) | ~$0.01 |
| SQS | pennies |
| DynamoDB (on-demand, including the deliveries table) | ~$0.02 |
| Secrets Manager | ~$0.40 |
| CloudWatch Logs | pennies |
| **Total** | **≈ $0.50** |

## Where it went

Receiving webhooks used to mean an EC2 instance and an Elastic IP, running
around the clock whether or not GitHub ever sent anything — together roughly
**$21/month**, about 90% of the bill. API Gateway and Lambda are billed per
request instead of per hour, and at this volume — a few thousand webhook
deliveries a month, at most — that is the difference between roughly $15/month
and roughly nothing.

DynamoDB — the thing people expect to be expensive because there are a dozen
tables — is about **two cents**. On-demand billing charges per request, and
this workload is a few thousand requests a day.

## What scales

Almost nothing. Doubling the repository count doubles the graph sync's API
calls and roughly doubles a two-cent DynamoDB bill. Nothing left in this stack
is a fixed cost the way the instance was — everything remaining is billed by
use.

## Reducing it further

Not urgent at fifty cents a month. The one lever left is Secrets Manager,
which charges per secret regardless of how often it's read — consolidating
further would save at most a few dimes and is not worth the complexity.
