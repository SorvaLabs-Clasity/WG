# Cost

Measured against a real organization of 356 repositories.

| Item | Monthly |
|---|---|
| EC2 `t3.small`, on-demand | ~$15 |
| EBS volume | ~$2 |
| Elastic IP | ~$3.60 |
| DynamoDB (on-demand) | ~$0.02 |
| Lambda | ~$0.01 |
| Secrets Manager | ~$0.40 |
| CloudWatch Logs | pennies |
| **Total** | **≈ $21** |

## Where it goes

The EC2 instance and its address are roughly **90%** of the bill, and their only
essential job is receiving GitHub webhooks.

DynamoDB — the thing people expect to be expensive because there are fourteen
tables — is about **two cents**. On-demand billing charges per request, and this
workload is a few thousand requests a day.

## What scales

Almost nothing. Doubling the repository count doubles the graph sync's API calls
and roughly doubles a two-cent DynamoDB bill. The EC2 is a fixed cost regardless
of organization size.

## Reducing it

- **Reserved instance or Savings Plan** on the EC2: roughly 30–40% off
- **Replace the EC2 with API Gateway + Lambda** for webhooks: takes the bill to
  a few dollars, at the cost of rewriting the receiver
- **Smaller instance**: `t3.micro` would probably serve, though the graph sync
  is memory-hungry when run server-side

None of these are urgent at $21/month. They matter if the same design is
deployed several times.
