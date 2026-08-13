# Operations

| | |
|---|---|
| [Setup](setup.md) | Every step from a fresh clone to a running install |
| [Environment](environment.md) | Every variable, and where it comes from |
| [Deploying](deploying.md) | Getting a change onto the EC2, the Lambda, or a desktop |
| [Troubleshooting](troubleshooting.md) | Things that have actually gone wrong |

## The three deploy targets, and when each matters

| Change | Needs |
|---|---|
| Backend or frontend code | Desktop rebuild; EC2 deploy only for webhook behaviour |
| IAM, Lambda, EventBridge | `cdk deploy` |
| Guardrail engine logic | `cdk deploy` (the Lambda bundles from source) |
| A new DynamoDB table | `scripts/setup-aws-account.sh` |

They are independent. Most days only the desktop needs rebuilding.
