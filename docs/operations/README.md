# Operations

| | |
|---|---|
| [Setup](setup.md) | Every step from a fresh clone to a running install |
| [Environment](environment.md) | Every variable, and where it comes from |
| [Deploying](deploying.md) | Getting a change onto a Lambda or a desktop |
| [Troubleshooting](troubleshooting.md) | Things that have actually gone wrong |

## The deploy targets, and when each matters

| Change | Needs |
|---|---|
| Backend or frontend code | Desktop rebuild; `cdk deploy` only for webhook or guardrail behavior |
| IAM, Lambda, EventBridge, API Gateway | `cdk deploy` |
| Guardrail or webhook logic | `cdk deploy` (every Lambda bundles from source) |
| A new DynamoDB table | `scripts/setup-aws-account.sh` |

They are independent. Most days only the desktop needs rebuilding.
