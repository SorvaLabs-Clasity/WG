# Standing up an install, step by step

From a fresh clone to a running app. Every prompt the migration script asks,
what each step does, and what tends to go wrong.

Two people are involved. Phases 1 and 4 need someone with GitHub organization
settings access; phases 0, 2 and 3 need an AWS profile with admin on the target
account. The handover points are where this stalls, so each phase says whose it
is.

| Phase | Who | Roughly |
|---|---|---|
| [0 — Prerequisites](#phase-0--prerequisites) | operator | 5 min |
| [1 — GitHub organization](#phase-1--github-organization) | org owner | 15 min |
| [2 — The migration script](#phase-2--the-migration-script) | operator | 20 min |
| [3 — Ship the app](#phase-3--ship-the-app) | operator | 5 min |
| [4 — The webhook](#phase-4--the-webhook) | org owner | 5 min |
| [Verifying](#verifying) | operator | 5 min |

---

## Phase 0 — Prerequisites

### Tools

```bash
node -v                          # must be 24.x
docker --version                 # must be running, not just installed
aws --version
session-manager-plugin --version # deploy.sh reaches the instance through it
```

**Node 24, not 25.** Node's even releases are LTS and its odd ones never are —
25 reached end of life in June 2026 and gets no further security patches. The
Docker image and CI are both on 24, so building locally on anything else risks
a build that works on your machine and fails in CI.

If you need to change it: `nvm install 24 && nvm use 24 && nvm alias default 24`,
or `brew install node@24 && brew unlink node && brew link --overwrite --force node@24`.

### Credentials and region

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=<your-region>
export CDK_DEFAULT_REGION=<your-region>

aws sso login --profile <your-profile>
aws sts get-caller-identity        # must print the target account
```

**Both region variables, same value.** They are read by different things and
neither falls back to the other: the AWS CLI and every SDK read `AWS_REGION`,
while the CDK app reads `CDK_DEFAULT_REGION`. Nothing defaults to a region on
your behalf — see [environment](environment.md).

**If `aws sts get-caller-identity` fails** with "the security token included in
the request is invalid", check for stale credentials overriding your profile:

```bash
env | grep AWS_
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

---

## Phase 1 — GitHub organization

Needs organization settings access. If that is not you, hand this section over —
it produces five values the next phase asks for.

### 1. An OAuth App

**Settings → Developer settings → OAuth Apps → New OAuth App**

| Field | Value |
|---|---|
| Application name | `GitHub Control Hub` |
| Homepage URL | `http://localhost:4321` |
| Authorization callback URL | `http://localhost:4321/auth/callback` |

> **The callback URL must match character for character.** Port `4321`, path
> `/auth/callback` — not `/api/auth/callback`. A mismatch fails at sign-in with
> a GitHub error that names redirect URIs and points nowhere near the cause.

`localhost` is correct and permanent. The desktop app runs its own backend on
port 4321, so the OAuth code comes back to the user's own machine and never
transits a shared server.

Then **Generate a new client secret**. GitHub shows it once.

**Keep:** client ID, client secret.

### 2. A GitHub App

**Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
|---|---|
| Name | `<company>-control-hub` — unique across all of GitHub |
| Homepage URL | `http://localhost:4321` |
| Webhook → Active | **untick** — the org webhook in phase 4 does this |
| Where can this app be installed | **Only on this account** |

Do not tick "Request user authorization (OAuth) during installation" — the
separate OAuth App handles sign-in, and ticking it confuses the flow.

**Repository permissions**

| Permission | Access | Why |
|---|---|---|
| Administration | Read & write | Branch protection, rulesets, Dependabot |
| Contents | Read & write | Creating branches, seeding template files |
| Metadata | Read | Mandatory; listing repositories |
| Dependabot alerts | Read | Vulnerability reporting |
| Actions | Read | Listing workflows |
| Pull requests | Read | Activity history |
| Environments | Read | Repository detail |

**Organization permissions**

| Permission | Access | Why |
|---|---|---|
| Members | Read | Teams and membership, for the access map |
| Administration | Read | The org's `default_repository_permission` |

Everything else: **No access**. This list is derived from the ~40 Octokit calls
the codebase actually makes; nothing on it is speculative.

Then, in order:

1. **Create GitHub App**
2. **Generate a private key** — downloads a `.pem`
3. **Install App** → this org → All repositories

> After installing, the browser URL ends in a number. That is the
> **installation ID**, and it appears nowhere else. If lost: Settings →
> Installed GitHub Apps → Configure, and read it off that URL.

**Keep:** App ID (on the app's settings page), installation ID, the `.pem`.

### 3. Two teams

**Organization → Teams → New team**

| Team slug | Controls |
|---|---|
| `control-hub-admins` | Templates, rule templates, exclusions, scanners, widgets, config import |
| `aws-guardrail-admins` | AWS rules, accounts, sweeps, enforce mode |

The slugs must be exactly these — membership is checked by slug, and both are
overridable only by environment variable. Anyone outside them gets a read-only
app.

They are separate deliberately. The person curating branch-protection templates
is not necessarily the person who should be able to let an application write to
production S3 buckets.

**Neither team grants anything in GitHub.** A member of `control-hub-admins`
still cannot apply a template to a repository they do not administer — the call
is made with their own token, and GitHub refuses it. See
[permissions model](../auth/permissions-model.md).

### 4. Add the operator to both teams

Otherwise the app runs read-only and cannot be configured at all.

### Hand over

Five values: **client ID**, **client secret**, **App ID**, **installation ID**,
and the **`.pem` file**.

No personal access token is needed. `getSystemToken()` prefers the GitHub App's
installation token and only falls back to a PAT, so with the App installed there
is nothing left for one to do — and a classic PAT with `admin:org` is a much
broader credential than the scoped App beside it.

---

## Phase 2 — The migration script

```bash
git pull
./scripts/migrate-to-account.sh
```

Safe to re-run: every step checks for what it is about to create. Ctrl-C is safe
at any prompt — nothing is written until the step it is in completes.

### What it asks first

| Prompt | Notes |
|---|---|
| AWS profile | Defaults to `$AWS_PROFILE` |
| AWS region to deploy into | Defaults to your profile's region, never to a literal |
| Company display name | Shown in the app |
| GitHub organisation | The login from the URL, **case-sensitive** |
| Resource name prefix | Enter for `github-control-hub` |

The org login is the part in `github.com/<this>`, which is often not the
display name. GitHub's API is case-insensitive here, but webhook payloads come
back in the canonical casing — match the URL and there is nothing to think
about. `curl -s https://api.github.com/orgs/<org> | grep '"login"'` settles it.

The prefix names every table, the Lambda, the secret and the stack. Change it
only if your organization mandates a scheme, or you want two installs in one
account. Use the same value everywhere afterwards.

### Step 1 — DynamoDB tables

Creates **14** tables, the activity table's two indexes, and TTL. All on-demand,
so idle tables cost nothing — measured at about two cents a month in use.

Delegates to `setup-aws-account.sh`. Existing tables are reported as `exists:`
and left alone.

### Step 2 — GitHub credentials

Pauses with links to create the OAuth App and GitHub App, then reads:

| Prompt | Echoed? |
|---|---|
| OAuth App client ID | yes |
| OAuth App client secret | **no** |
| GitHub App ID | yes |
| GitHub App installation ID | yes |
| Path to the `.pem` | yes |
| Personal access token | **no** — press enter to skip |

> **The `.pem` prompt takes a path, not the file's contents.** Dragging the file
> from Finder into the terminal is easiest; `~`, surrounding quotes and the
> trailing space are all handled.
>
> The file is checked for `-----BEGIN` and `PRIVATE KEY-----` before anything is
> uploaded, so pointing at the wrong download fails here rather than at a token
> refresh hours later.

The App ID and installation ID are both bare numbers and easy to confuse. The
App ID is on the app's settings page under About; the installation ID only ever
appears in the URL after installing.

Secrets are read without echoing and written straight to Secrets Manager at
`<prefix>/secrets`. They never touch disk. The webhook secret and JWT secret are
generated here — `openssl rand -hex 32` and `-hex 48` — which is why phase 4
cannot happen earlier.

### Step 3 — CloudTrail

Detects an existing trail and leaves it alone; a second trail is billed per
event. Without any trail, guardrails run only on the 15-minute sweep instead of
reacting within seconds of a resource changing. Optional.

### Step 4 — EC2, Lambda and event rules

Bootstraps CDK if needed, then deploys the stack: the instance, the guardrail
Lambda, the EventBridge rules, the dead-letter queue and the IAM.

**Deployed read-only.** The app can report on the account and is incapable of
changing it. A rule set to enforce still finds violations and records the fix it
would have made; AWS refuses the write and the finding says so. Redeploy with
`-c enforce=true` later to grant exactly three write actions.

Prints the instance ID and the webhook URL. Takes a few minutes.

### Step 5 — Org webhook

Prints everything the org owner needs and waits. **You cannot do this yet** —
press enter and come back at [phase 4](#phase-4--the-webhook).

### Step 6 — Guardrail rules

Seeds two rules, both in **report** mode:

- **S3 — deny non-TLS requests**
- **CloudWatch Logs — minimum retention** (365 days)

Report mode on purpose. Enforce is a decision to make after seeing what a real
account contains, not a default to inherit.

### Step 7 — This install's identity

Writes the company name and region into
`github-control-hub/frontend/.env.production`, replacing its own two lines and
leaving the rest of the file alone.

**That file is tracked by git, and you must commit it.** These two values are
compiled into the JavaScript at build time, and the release workflow builds on a
fresh runner from what is committed. Until it lands on the branch the workflow
builds from, released apps show no company name and their AWS console links go
nowhere.

Commit it however your organization requires — a branch and a pull request if
main is protected.

---

## Phase 3 — Ship the app

The migration script builds the infrastructure. It does **not** put the
application on the instance.

```bash
./scripts/deploy.sh <InstanceId>
```

Without this the webhook URL answers nothing.

> Use the instance ID the migration script printed **at the end**, not one noted
> from an earlier run. Encryption at rest and the IMDSv2 pin replace the
> instance rather than updating it, so an older ID can name a machine that no
> longer exists — and the failure looks like a networking problem. The Elastic
> IP re-associates, so the webhook URL is unchanged.

Builds for `linux/amd64`, ships the image through an S3 bucket the stack owns,
and loads it over SSM. A few minutes on Apple Silicon, which cross-compiles.
About a minute of downtime, during which webhook deliveries are lost.

Confirm the new code is running:

```bash
aws ssm send-command --instance-ids <InstanceId> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker ps --format \"{{.Image}} {{.Status}}\""]'
```

---

## Phase 4 — The webhook

Back to the org owner.

**Organization → Settings → Webhooks → Add webhook**

Under **Code, planning, and automation** in the sidebar, well below Teams — or
go straight to `https://github.com/organizations/<org>/settings/hooks`. Only org
**owners** see it.

| Field | Value |
|---|---|
| Payload URL | from the migration script |
| Content type | `application/json` |
| Secret | from the migration script |
| SSL verification | **Disable** — self-signed certificate on an IP |

**Events** — "Let me select individual events":

`push` · `repository` · `create` · `delete` · `member` · `team` ·
`organization` · `pull_request` · `branch_protection_rule` ·
`repository_ruleset`

Reading the secret back if needed:

```bash
aws secretsmanager get-secret-value --secret-id <prefix>/secrets \
  --query SecretString --output text \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).GITHUB_WEBHOOK_SECRET))"
```

These events record the changes nobody made through the app — someone disabling
branch protection, a repository going public, a team gaining access. Without
them the activity log shows only the app's own actions, which is the less useful
half of an audit trail. See [webhooks](../github-api/webhooks.md).

---

## Verifying

1. **Create a repository in the org.** It should appear in Activity within
   seconds. If not, the webhook secret or the event list is wrong.
2. **Press Sync data on the Repos page**, then open Access. It should list
   people. This also populates Overview, Security and the rest — before the
   first sync they say they are stale rather than showing an empty organization.
3. **Set a log group's retention to 1 day** and run a sweep from the AWS tab. It
   should be flagged, and reported as something the app is not permitted to fix
   — correct, since the deployment is read-only.

---

## After it is running

**Cutting a release.** Bump `version` in `desktop/package.json` and push to
main. The workflow builds for macOS and Windows and publishes one release;
installed copies update on next launch. See [updates](../desktop/updates.md).

**More AWS accounts.** In the app: AWS → Accounts → *How do I add an account?*
It generates the CloudFormation template, every parameter, a fresh external ID
and the console links, and offers all accounts, chosen accounts, or one. See
[accounts](../aws-guardrails/accounts.md).

**Letting it change things.** Both rules start in report mode and the stack is
read-only. Two independent switches have to move: `cdk deploy -c enforce=true`
for the app's own account, and `ReadOnly=false` on any other account's role. See
[permissions](../aws-guardrails/permissions.md).

**Gatekeeper.** macOS builds are ad-hoc signed, so the first open needs
right-click → Open. Signing removes that warning and lets the updater verify
releases; it needs an Apple Developer account. See
[the security review](../security/review-2026-08-12.md).

Anything that goes wrong: [troubleshooting](troubleshooting.md).
