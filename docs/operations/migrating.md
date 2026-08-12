# Migrating to another account and org

`scripts/migrate-to-account.sh` stands the whole app up somewhere new. It is
safe to re-run — every step checks for what it is about to create.

## Before you start

- An AWS profile with admin on the **target** account
- Ability to create an OAuth App and a GitHub App in the **target** org
- Docker, Node and the AWS CLI locally

## What it asks

| Prompt | Notes |
|---|---|
| AWS profile | Which account to build in |
| Region | Not assumed — nothing is hardcoded to `us-east-1` |
| Company display name | Shown in the app |
| GitHub organisation | The exact login, case-sensitive |
| Resource name prefix | Defaults to `github-control-hub` |

## The seven steps

**1 — DynamoDB tables.** Creates 13 tables via `setup-aws-account.sh`, plus the
activity indexes and TTL. Idle tables cost nothing.

**2 — GitHub credentials.** Pauses while you create the OAuth App and GitHub
App in a browser, then reads the values. Secrets are read without echoing and
go straight to Secrets Manager — never to disk.

> Callback URL: `http://localhost:4321/auth/callback`

**3 — CloudTrail.** Detects an existing trail and leaves it alone. Without one,
guardrails run only on the 15-minute sweep instead of reacting within seconds.
Optional.

**4 — EC2, Lambda and event rules.** Bootstraps CDK if needed, then deploys.
**Read-only** — the app can report on the account and cannot change it.

**5 — Org webhook.** Prints the payload URL and the event list, and waits.
Cannot be automated: the URL only exists after step 4.

**6 — Guardrail rules.** Seeds the two rules in **report** mode. Enforce is a
decision to make after seeing what a real account contains, not a default to
inherit.

**7 — Desktop app.** Writes `.env.production.local` with the company name and
region for console links.

## What it deliberately does not do

- Create the OAuth App or GitHub App — browser, human, and it needs your
  judgement about scopes
- Install the App on the org
- Create the webhook — needs step 4's output
- **Add other AWS accounts.** Use the app's own setup panel; see
  [accounts](../aws-guardrails/accounts.md)
- **Turn on enforcement.** See [permissions](../aws-guardrails/permissions.md)

## Verifying

1. Create a repository in the org — it should appear in the activity feed within
   seconds. If not, the webhook secret or the event list is wrong.
2. Set a log group's retention to 1 day and run a sweep — it should be flagged.
3. Press Sync data, then open Access. It should list people.

## Carrying your configuration across

Export from the old install and import into the new one — templates, rule
templates, exclusions, scanners, widgets and AWS guardrails, in one file. See
[config transfer](../features/config-transfer.md).
