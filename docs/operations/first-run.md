# Standing it up from scratch

What has to exist before the app can start, in the order it has to exist.

`scripts/setup-aws-account.sh` does the AWS half. The GitHub half needs a
browser and your judgement, so it is listed rather than scripted.

## 1. GitHub — an OAuth App

Org settings → Developer settings → OAuth Apps → New.

| Field | Value |
|---|---|
| Homepage URL | anything |
| Authorization callback URL | `http://localhost:4321/auth/callback` |

The callback is the one thing that must be exact. The desktop app serves its
own backend on **4321**, and the route is `/auth/callback` — not
`/api/auth/callback`. A mismatch fails at sign-in with an error that points
nowhere near the cause.

Keep the **client ID** and **client secret**.

## 2. GitHub — a GitHub App

Org settings → Developer settings → GitHub Apps → New.

Repository permissions: Administration, Contents, Metadata, Dependabot alerts —
read, plus write where you want the app to act. Organization permissions:
Members (read), Administration (read).

Install it on the organization. Keep the **App ID**, the **installation ID**
(the number at the end of the install URL) and the **private key** (`.pem`).

Why both an OAuth App and a GitHub App: they do different jobs. See
[authentication](../auth/README.md).

## 3. AWS — tables and secret

```bash
STACK_NAME=github-control-hub AWS_REGION=us-east-1 \
  ./scripts/setup-aws-account.sh
```

Creates 14 DynamoDB tables, the activity table's two indexes, and TTL. All
on-demand — idle tables cost nothing.

Then put the GitHub values into Secrets Manager under
`<prefix>/secrets` as one JSON document. See
[environment variables](environment.md) for the key names.

## 4. AWS — the stack

```bash
cd github-control-hub/infra
npx cdk bootstrap        # first time in this account/region only
npx cdk deploy           # read-only; add -c enforce=true to allow writes
```

Creates the EC2 webhook receiver, the guardrail Lambda, the event rules and the
IAM. Prints the instance id and the webhook URL.

## 5. GitHub — the org webhook

Org settings → Webhooks → Add.

| Field | Value |
|---|---|
| Payload URL | the `WebhookUrl` output from step 4 |
| Content type | `application/json` |
| Secret | the `GITHUB_WEBHOOK_SECRET` from step 3 |
| SSL verification | disabled — the instance uses a self-signed certificate |

Events: `push`, `repository`, `create`, `delete`, `member`, `team`,
`organization`, `branch_protection_rule`, `repository_ruleset`.

This step is last because the URL does not exist until step 4 has run.

## 6. Run it

```bash
cd github-control-hub/desktop && npm run dev
```

## Verifying

1. Create a repository in the org — it should appear in Activity within
   seconds. If not, the webhook secret or the event list is wrong.
2. Press **Sync data** on the Repos page, then open **Access**. It should list
   people.
3. Set a log group's retention to 1 day and run a sweep — it should be flagged.
