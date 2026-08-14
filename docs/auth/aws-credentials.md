# AWS credentials

The app needs AWS before it can do anything, because its configuration and its
GitHub secrets live there.

## Desktop

Three ways in, offered on the sign-in page:

| Method | What it does |
|---|---|
| **SSO** | Runs `aws sso login --profile <name>` and waits for the browser |
| **Profile** | Uses an existing profile from `~/.aws/config` |
| **Access keys** | Pasted directly, held in memory for the session |

The chosen profile is remembered in `~/.github-control-hub/desktop.json` and
restored at startup, so a still-valid SSO session simply connects.

What is remembered, and what is not:

- **Only profiles that worked.** Written after DynamoDB actually answered, not
  when the name was typed — otherwise a typo becomes the suggestion forever.
- **Forgotten on sign-out**, so the next launch does not silently reconnect to
  an account you deliberately left.
- **Never any secret.** A profile name is the name of a section in a file you
  already have. Keys and tokens are not written there, and a test asserts it.
- **An explicit `AWS_PROFILE` wins**, because someone setting it is being
  deliberate.

## Lambda

No profiles. Each function — `webhook-receiver`, `webhook-worker`, the
guardrail engine — gets its own execution role and reads its own credentials
from the Lambda runtime, scoped to exactly what that function needs. See
[Lambda](../infrastructure/lambda.md).

## What AWS access buys

Reading DynamoDB (the app's own tables) and Secrets Manager (GitHub secrets).
It is *not* how the AWS guardrails reach other accounts — those assume a role.
See [AWS guardrails](../aws-guardrails/).

## When the session expires

SSO tokens expire on your organization's schedule. The app cannot renew them;
it will ask you to sign in again. That is SSO working as designed.
