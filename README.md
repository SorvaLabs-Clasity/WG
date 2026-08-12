# GitHub Control Hub

A desktop app that reports on a GitHub organization's security posture and
enforces a small number of AWS guardrails.

It reads far more than it writes. Every write is made with the token of the
person who clicked, so GitHub decides what is allowed — the app holds no
authority of its own.

```bash
cd github-control-hub/desktop && npm run dev
```

Nothing set up yet? [docs/operations/first-run.md](docs/operations/first-run.md)

## Documentation

Everything lives in **[docs/](docs/)**.

| | |
|---|---|
| [Architecture](docs/architecture/) | The three processes and what each is for |
| [Authentication](docs/auth/) | The two keys, and the three tokens |
| [Features](docs/features/) | One page per tab |
| [AWS guardrails](docs/aws-guardrails/) | Rules, accounts, and the full IAM inventory |
| [Data](docs/data/) | Tables, the graph model, retention |
| [Infrastructure](docs/infrastructure/) | CDK, EC2, Lambda, cost |
| [Desktop](docs/desktop/) | The Electron app and its updates |
| [Operations](docs/operations/) | First run, deploying, troubleshooting |
| [Development](docs/development/) | Layout, conventions, testing |

## What it can do to your AWS account

Less than you would expect, deliberately. It reads configuration — never the
contents of a bucket or a log line — cannot delete anything, cannot grant
anyone access to anything, and cannot become an administrator of any account.

Those are properties of IAM rather than promises made by this code, and
[docs/aws-guardrails/permissions.md](docs/aws-guardrails/permissions.md) is the
complete inventory, written to be handed to whoever approves the deployment.
