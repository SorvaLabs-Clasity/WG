# Standing up an install, step by step

From a fresh clone to a running app. Every prompt the migration script asks,
what each step does, and what tends to go wrong.

Two people are involved. Phases 1 and 3 need someone with GitHub organization
settings access; phases 0 and 2 need an AWS profile with admin on the target
account. The handover points are where this stalls, so each phase says whose it
is.

| Phase | Who | Roughly |
|---|---|---|
| [0 — Prerequisites](#phase-0--prerequisites) | operator | 5 min |
| [1 — GitHub organization](#phase-1--github-organization) | org owner | 15 min |
| [2 — The migration script](#phase-2--the-migration-script) | operator | 20 min |
| [3 — The webhook](#phase-3--the-webhook) | org owner | 5 min |
| [Verifying](#verifying) | operator | 5 min |

---

## Phase 0 — Prerequisites

### Tools

```bash
node -v                          # must be 24.x
aws --version
```

**Node 24, not 25.** Node's even releases are LTS and its odd ones never are —
25 reached end of life in June 2026 and gets no further security patches. CI
runs on 24, so building locally on anything else risks a build that works on
your machine and fails in CI.

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

> **Create both of these under the organization, not under your own account.**
>
> GitHub has two separate Developer settings pages, and an app appears only
> under the account that created it. The avatar menu's Settings → Developer
> settings always lands on your personal one, so the links below go to the
> org's page directly. Use them.
>
> Getting this wrong is not cosmetic: a personal app created with "Only on this
> account" *cannot be installed on the organization at all*, and the mistake
> only surfaces at install time. Recovering means Advanced → Transfer ownership,
> or starting the app again.

### 1. An OAuth App

`https://github.com/organizations/<org>/settings/applications` → **New OAuth App**

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

`https://github.com/organizations/<org>/settings/apps` → **New GitHub App**

| Field | Value |
|---|---|
| Name | `<company>-control-hub` — unique across all of GitHub |
| Homepage URL | `http://localhost:4321` |
| Webhook → Active | **untick** — the org webhook in phase 3 does this |
| Where can this app be installed | **Only on this account** |

Do not tick "Request user authorization (OAuth) during installation" — the
separate OAuth App handles sign-in, and ticking it confuses the flow.

**Repository permissions**

| Permission | Access | Why |
|---|---|---|
| Administration | Read | Branch protection, rulesets, Dependabot |
| Contents | Read | Compliance checks reading file contents |
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
| `control-hub-admins` | Scanners, widgets, alerts, config import, and undoing changes to any of them |
| `aws-guardrail-admins` | AWS rules, accounts, sweeps, enforce mode |

The slugs must be exactly these — membership is checked by slug, and both are
overridable only by environment variable. Anyone outside them gets a read-only
app.

They are separate deliberately. The person curating scanners and alert rules
is not necessarily the person who should be able to let an application write to
production S3 buckets.

**Neither team grants anything outside this app.** Membership only changes
what the app's own UI lets a person click; GitHub and AWS still decide what
happens when they click it, using that person's own credentials. See
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

Creates **11** tables, the activity table's two indexes, and TTL. All
on-demand, so idle tables cost nothing — measured at about two cents a month in
use.

Delegates to `setup-aws-account.sh`. Existing tables are reported as `exists:`
and left alone. A twelfth table — the webhook delivery dedup lock — is created
later, in [step 4](#step-4--api-gateway-lambda-and-event-rules), by `cdk
deploy` rather than this script: it holds nothing but five-minute state, so it
lives with the infrastructure that depends on it instead of the durable
application data this script owns.

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
generated here — `openssl rand -hex 32` and `-hex 48` — which is why phase 3
cannot happen earlier.

### Step 3 — CloudTrail

Detects an existing trail and leaves it alone; a second trail is billed per
event. Without any trail, guardrails run only on the 15-minute sweep instead of
reacting within seconds of a resource changing. Optional.

### Step 4 — API Gateway, Lambda and event rules

Bootstraps CDK if needed, then deploys the stack: API Gateway, the webhook
receiver and worker Lambdas, the guardrail Lambda, the SQS queue and its
dead-letter queue, the EventBridge rules, the CloudWatch alarms and the IAM.
Every Lambda bundles its code straight from `backend/src`, so this step ships
working functions, not just infrastructure to load code onto later.

**Guardrail enforcement is deployed read-only.** The app can report on the
account and is incapable of changing it. A rule set to enforce still finds
violations and records the fix it would have made; AWS refuses the write and
the finding says so. Redeploy with `-c enforce=true` later to grant exactly
three write actions. This has no bearing on the webhook path, which has no
concept of enforce mode.

Prints the webhook URL (the stack's `WebhookUrl` output) among the other
outputs. Takes a few minutes.

### Step 5 — Org webhook

Prints everything the org owner needs and waits. **You cannot do this yet** —
press enter and come back at [phase 3](#phase-3--the-webhook).

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

## Phase 3 — The webhook

Back to the org owner. The migration script already deployed a working
endpoint in [step 4](#step-4--api-gateway-lambda-and-event-rules) — there is
no separate step to ship application code, because `cdk deploy` bundled the
Lambdas from source. This phase only points GitHub at the URL it printed.

**Organization → Settings → Webhooks → Add webhook**

Under **Code, planning, and automation** in the sidebar, well below Teams — or
go straight to `https://github.com/organizations/<org>/settings/hooks`. Only org
**owners** see it.

| Field | Value |
|---|---|
| Payload URL | the `WebhookUrl` output from the migration script |
| Content type | `application/json` |
| Secret | from the migration script |

> **If a webhook already exists here, edit its URL — do not add a second
> one.** GitHub gives each webhook its own delivery id for the same
> underlying event, so two webhooks pointing at two receivers means two
> unrelated deliveries, and the deduplication lock has no way to recognise
> them as the same event. Both would process: duplicate activity rows,
> duplicate alerts. This matters most when repointing an existing install at
> a new deployment, but it is worth checking on a first setup too, in case a
> teammate already ran phase 1 twice.

**Events** — "Let me select individual events":

`push` · `repository` · `create` · `delete` · `member` · `team` ·
`organization` · `pull_request` · `branch_protection_rule` ·
`repository_ruleset`

Reading the secret back if needed:

```bash
aws secretsmanager get-secret-value --secret-id <prefix>/webhook-secret \
  --query SecretString --output text
```

The webhook secret lives in its own Secrets Manager entry, **not** in
`<prefix>/secrets` with everything else, and rotating it means changing it
here and in GitHub — nowhere else.

The reason is blast radius. The receiver Lambda is the only part of this
system reachable from the internet, and it has to handle bytes nobody has
authenticated yet in order to authenticate them. Sharing the bundle meant it
held a key to `GITHUB_APP_PRIVATE_KEY` it never used, so any bug on that path
gave up the whole organisation instead of the ability to check signatures. Its
IAM grants this secret and nothing else.

These events record the changes nobody made through the app — someone disabling
branch protection, a repository going public, a team gaining access. Without
them the activity log shows only the app's own actions, which is the less useful
half of an audit trail. See [webhooks](../github-api/webhooks.md).

---

## If the organisation already enforces bucket TLS

Some accounts run an AWS Config rule that applies a TLS-only policy to every new
S3 bucket, within seconds of it appearing. That control and this stack's own
`enforceSSL` want the same thing and cannot both have it:

```
CloudFormation creates the audit bucket
  -> the remediation writes its policy
  -> CloudFormation's CreateBucketPolicy fails, "the bucket policy already exists"
  -> rollback; RemovalPolicy.RETAIN keeps the bucket and the foreign policy
  -> the next attempt hits the same race one resource earlier
```

No number of retries wins it. Deploy with the flag instead:

```bash
npx cdk deploy -c enforce=true -c bucketPolicy=false
```

That tells the stack something outside it owns the audit bucket's policy. Two
situations want it, and they want the same answer:

1. **The organisation's control writes it.** The race above.
2. **You intend to enforce it with this app's own S3 guardrail.** Equivalent
   protection, and arguably better: CloudFormation only reconciles the policy
   on the next deploy, where the guardrail re-adds the deny on its next sweep
   if anyone removes it. The gap is the minutes between the deploy and that
   first sweep, on an empty bucket nothing is streaming to yet.

`-c orgEnforcesBucketSsl=true` still works — it was the first name, and it only
described the first case.

Either way, check afterwards that a policy exists, because with the flag set
this stack is no longer the thing guaranteeing it:

```bash
aws s3api get-bucket-policy \
  --bucket github-control-hub-audit-log-$(aws sts get-caller-identity --query Account --output text) \
  --query Policy --output text | python3 -m json.tool
```

A `Deny` on `aws:SecureTransport: false` is what you want. `NoSuchBucketPolicy`
means nothing is enforcing it — add the S3 rule in the app and run it, or drop
the flag and redeploy.

To confirm that is what you are hitting, ask who wrote the policy. The error
names the bucket, never whatever wrote to it:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=PutBucketPolicy \
  --max-results 5 --query 'Events[].[EventTime,Username]' --output text
```

A username that is not yours — `s3-ssl-auto-remediate` or similar — is the
answer.

A bucket left behind by a failed attempt is still there and unmanaged by the
stack. Delete it first, or CloudFormation will refuse to create one of the same
name:

```bash
BUCKET=github-control-hub-audit-log-$(aws sts get-caller-identity --query Account --output text)
aws s3api list-objects-v2 --bucket "$BUCKET" --query 'KeyCount' --output text   # expect 0
aws s3api delete-bucket --bucket "$BUCKET"                                      # refuses if not empty
```

## Standing up a whole environment

`scripts/migrate-to-account.sh` is the guided path for a fresh account: seven
steps covering tables, credentials, CloudTrail, the CDK deploy, the org
webhook, guardrail rules and the desktop app. It calls
`setup-aws-account.sh` for the tables rather than duplicating them, and runs
`cdk bootstrap` first.

It asks which account and region to act on rather than reading them from the
environment and hoping: it prints the account ID and identity ARN it
authenticated as, prompts for the region, and refuses one the account cannot
see. Nothing is assumed — a stack deployed to the wrong region is a stack you
have to find first.

**Authenticate before running it.** The script refuses to start otherwise
rather than offering `default`, because on a machine with one profile per
environment that suggestion is wrong most of the time and pressing enter is how
a stack lands in the wrong account. Either kind of credential works:

```bash
export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_SESSION_TOKEN=...
CDK_CONTEXT="-c enforce=true -c orgEnforcesBucketSsl=true" ./scripts/migrate-to-account.sh
```

That is the shape the AWS access portal hands out, and it needs no profile to
exist at all. With a profile instead, `export AWS_PROFILE=<name>` after
`aws sso login --profile <name>`.

It creates **no guardrail rules**. Which rules an account runs is a decision
about that account, and the S3 one rewrites bucket policies the moment it is
switched to enforce — a rule that arrives with the install is an opinion nobody
stated, one toggle away from acting on real resources. Add them in the app,
under the AWS tab.

Its deploy takes no context by default. Pass any through:

```bash
CDK_CONTEXT="-c enforce=true -c orgEnforcesBucketSsl=true" ./scripts/migrate-to-account.sh
```

In an organisation running an S3 TLS auto-remediation, the second flag is not
optional — see the bucket-TLS section below for what happens without it.

## Running more than one environment

The stack carries no assumption that an organisation has one deployment. Each
AWS account runs its own copy — its own tables, secrets, queue and API Gateway —
against the same GitHub organisation, and the desktop app moves between them by
switching AWS profile. Dev, UAT and production are the same deployment done
three times, not three variants of it.

What is shared is only what lives on GitHub's side: the organisation, and
optionally the App and OAuth App.

- **A GitHub organisation can hold more than one webhook.** Add one per
  environment, each pointing at that account's `WebhookUrl` with its own
  secret. Every hook receives every event; each account's worker writes to its
  own tables.
- **A separate GitHub App per environment is optional but worth it.** Apps are
  free and unlimited. The reason is not permission isolation — it is that the
  12,500 requests an hour are *per installation*, so sharing one App means a
  busy afternoon in UAT spends production's budget.
- **The OAuth App can be shared.** Every desktop app redirects to
  `http://localhost:4321/auth/callback`, so one registration serves all of
  them.

### What to set differently outside production

**The web ACL is worth skipping where there is no bill to protect:**

```bash
npx cdk deploy -c enforce=true -c waf=false
```

A flat $5 a month plus $1 a rule is most of a small stack's bill. What it
actually buys is cost containment — it cuts off a single address sustaining
more than about seven requests a second, which otherwise runs up API Gateway
charges on requests the resource policy is already rejecting. That is worth
paying for where the bill matters and not where it does not. The IP allow-list
and the signature check, which are what keep strangers out, are unaffected
either way.

**Security-alert email belongs in one environment, or in different groups.**
Three environments with notifications on means three emails per event and no
way to tell which one shouted.

**Keep production AWS accounts out of a non-production guardrail's
monitored-account list.** Nothing else in another environment can reach
production, but that list is an explicit invitation to.

### What is not supported yet

Two deployments in the **same account and region**. The stack name, table
prefix and secret names are fixed, so a second copy beside the first would
collide on all three — and two guardrail engines in one account would scan the
same resources and both try to remediate them. A separate account per
environment is the supported shape.

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
