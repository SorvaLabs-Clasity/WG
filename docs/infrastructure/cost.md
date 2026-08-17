# Cost

Two columns, because the answer depends almost entirely on how much there is to
read. **Small** is a live deployment measured over seven days: two privileged
accounts, 355 repositories, seven of them with a protected branch. **Busy** is
modelled from those measurements at ten active users, a hundred organization
members and ten admins, with every feature switched on.

| Item | Small (measured) | Busy (modelled) |
|---|---|---|
| WAF (web ACL $5 + one rule $1) | **$6.00** | **$6.00** |
| DynamoDB (on-demand, 17 tables) | $0.11 – $0.61 | **$5 – 6** |
| Secrets Manager, 2 secrets | $0.80 | $0.80 |
| CloudWatch alarms (2) | $0.20 | $0.20 |
| API Gateway (REST), $3.50/M requests | $0.01 | $0.05 |
| Lambda — 5 functions | **$0.00** | **$0.00** |
| CloudWatch Logs | pennies | $0.10 – 0.50 |
| S3 (audit log archive) | pennies | $0.15 |
| SNS email, SQS, EventBridge | $0.00 | $0.00 |
| **Total** | **≈ $7.20** | **≈ $13** |

Lambda is zero in both columns, and not by rounding. The perpetual free tier is
1M requests and 400,000 GB-seconds a month; the busy column uses about 42,500
invocations and 33,000 GB-seconds — 8% of it. This would need roughly **twelve
times** the busy load before Lambda costs anything.

Measured over seven days on the live deployment:

| Function | Calls | Average | Memory |
|---|---|---|---|
| webhook-receiver | 2,264 | 166 ms | 256 MB |
| webhook-worker | 2,257 | 137 ms | 512 MB |
| alarm-evaluator | 448 | 1,290 ms | 512 MB |
| guardrail-enforcer | 609 | 2,504 ms | 512 MB |
| audit-ingest | 309 | 183 ms | 512 MB |

The WAF is most of the small bill. It is kept for the compliance checkbox and
the option of adding real rules later; see [reducing it](#reducing-it-further).

## Where it went

Receiving webhooks used to mean an EC2 instance and an Elastic IP, running
around the clock whether or not GitHub ever sent anything — together roughly
**$21/month**, about 90% of the bill. API Gateway and Lambda are billed per
request instead of per hour, and at this volume — a few thousand webhook
deliveries a month, at most — that is the difference between roughly $15/month
and roughly nothing.

DynamoDB is pennies on a small organization and the **largest variable line** on
a busy one — the opposite of the usual expectation, and worth understanding
before it surprises anyone.

## The AWS resource features

The AWS features here read only configuration — every call is a `List` or a
`Describe`, and those are free.


## What scales

Two things, and only two.

**DynamoDB reads, with the size of the graph.** Every security check begins by
reading the whole graph table, which at a hundred members across a few hundred
repositories is about a megabyte. That read is held for six seconds so the
several checks in one evaluation pass share it rather than each scanning
separately — before that, six query widgets meant six identical scans and it was
roughly 60% of the DynamoDB bill on its own.

**S3, with audit-log volume**, if enterprise streaming is on. Capped by the
400-day lifecycle rule and moved to Infrequent Access after 30 days, so it
settles rather than growing forever.

Everything else is flat. Doubling the repository count does not double the bill;
it moves one line in the table above.

## Reducing it further

**The WAF is the one real lever** — $6 of a $7.20 small bill, and it protects a
rate limit that cannot bind: its rule allows 2,000 requests per five minutes per
IP (≈6.6/second) while API Gateway's own throttle is 20/second aggregate, always
the tighter of the two. Dropping it takes the small deployment to roughly
**$1.20**.

**Evaluation frequency** is the other. The alarm evaluator runs every five
minutes; every DynamoDB read above scales linearly with that. Halving it halves
the largest variable line.
See above for why that is a real option rather than a saving to regret.

Secrets Manager is the only other fixed cost, at ~40¢ per secret. There are two
deliberately — the webhook secret is kept apart from the application bundle so
the internet-facing Lambda cannot read the GitHub App private key. That
separation is worth far more than the 40 cents it costs, and consolidating them
would undo it.
