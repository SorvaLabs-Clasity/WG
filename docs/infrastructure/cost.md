# Cost

Figures below assume an organization of roughly 350 repositories.

| Item | Monthly |
|---|---|
| WAF (web ACL $5 + one rule $1) | **$6.00** |
| API Gateway (REST), $3.50/M requests | ~$0.35 |
| Secrets Manager, 2 secrets | ~$0.80 |
| CloudWatch alarms (2) | $0.20 |
| Lambda — 5 functions: webhook receiver and worker, guardrail enforcer, alarm evaluator, audit ingest | ~$0.01 |
| DynamoDB (on-demand, 13 tables) | ~$0.02 |
| SNS email, $2 per 100,000 | pennies |
| S3 (audit log archive), SQS, CloudWatch Logs | pennies |
| **Total** | **≈ $7.50** |

The WAF is 80% of that, and it protects a rate limit that cannot bind: its rule
allows 2,000 requests per five minutes per IP (≈6.6/second) while API Gateway's
own throttle is 20/second aggregate, which is always the tighter of the two.
It is kept for the compliance checkbox and the option of adding real rules
later. Removing it takes the bill to roughly **60 cents**.

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

One lever, and it is the WAF: dropping it removes roughly $6 of a $7.50 bill.
See above for why that is a real option rather than a saving to regret.

Secrets Manager is the only other fixed cost, at ~40¢ per secret. There are two
deliberately — the webhook secret is kept apart from the application bundle so
the internet-facing Lambda cannot read the GitHub App private key. That
separation is worth far more than the 40 cents it costs, and consolidating them
would undo it.
