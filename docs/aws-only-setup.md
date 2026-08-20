# The AWS-only setup

An account that runs the AWS guardrails and holds nothing about your GitHub
organization. No App private key, no access graph, no webhook endpoint, no
repository data.

It exists for the ordinary case where the guardrails are worth running in
production while everything GitHub-shaped belongs somewhere quieter. Keeping
GitHub out of an account is done by keeping GitHub's credentials out of it —
there is no switch to set and none to forget.

```bash
./scripts/setup-aws-only.sh
```

Safe to re-run: every step checks for what it is about to create.

---

## What actually runs

**One Lambda, two triggers, three tables it writes to.** That is the whole
deployment.

```
  every 15 minutes ─────────┐
                            │
  something in this AWS     ├──▶ the sweeper ──▶ what it found
  account just changed ─────┘    (a Lambda)      (a table the AWS tab reads)
                                       │
                                       └─▶ a note in the activity feed,
                                           only when it changed something
```

Nothing else is running between triggers. There is no server, no queue, no
public endpoint of any kind.

**What each box really is:**

| In the diagram | What it is |
|---|---|
| every 15 minutes | An EventBridge rule — an AWS timer pointed at the sweeper |
| something just changed | A second EventBridge rule watching CloudTrail for six specific API calls: `CreateBucket`, `PutBucketPolicy`, `DeleteBucketPolicy`, `CreateLogGroup`, `PutRetentionPolicy`, `DeleteRetentionPolicy`. It runs the sweeper within seconds, scoped to the one resource |
| the sweeper | A Lambda: `github-control-hub-guardrail-enforcer`, 512 MB, 10-minute limit |
| what it found | `github-control-hub-aws-findings` — one row per rule-and-resource pair |
| the activity feed | `github-control-hub-activity` |

Plus a dead-letter queue, `GuardrailDlq`, holding invocations that failed to
start at all, and a CloudWatch log group with three months' retention.

The full mechanism — how a sweep decides, why the findings table overwrites
rather than appends, what report mode does — is in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md#aws-guardrails). Nothing about it differs
here; this deployment is the same engine with the GitHub half absent.

---

## The tables

Twelve are created. **Six are used; six are created empty and stay that way.**

| Table | In this account |
|---|---|
| `aws-guardrails` | **used** — one row per rule you write |
| `aws-exclusions` | **used** — one row per exclusion list |
| `aws-findings` | **used** — every verdict from the last sweep |
| `activity` | **used** — what the guardrails actually changed |
| `org-config` | **used** — which regions to sweep |
| `auth-codes` | **used** — the one-time ticket during sign-in |
| `alerts` | empty |
| `widgets` | empty |
| `alarms` | empty |
| `scanners` | empty |
| `graph-edges` | empty |
| `compliance-cache` | empty |

The six empty ones are created deliberately rather than skipped. They are made
by the same script the full install uses, so their schemas cannot drift from
what the app expects — these are not uniform tables, and a hand-written subset
got three of them wrong in a way nothing noticed until sign-in failed with
*"Missing the key id in the item"*, which names neither the table nor the cause.
An idle on-demand table costs nothing. A second copy of twelve schemas kept in
step by hand does not stay right.

---

## The secret

One secret, `github-control-hub/secrets`, holding **four keys and no more**:

| Key | What it is for |
|---|---|
| `GITHUB_CLIENT_ID` | Identifies the OAuth App you sign in through |
| `GITHUB_CLIENT_SECRET` | Its secret, for exchanging the sign-in code |
| `GITHUB_ORG` | Which organization's teams decide who may change guardrails |
| `JWT_SECRET` | Signs your session so the app knows the session is one it issued |

**The GitHub App private key and installation id are not asked for and must not
be put here.** That key reads your entire organization, and keeping it out of
this account is the whole exercise. Its absence is also what switches the app's
behaviour: the backend refuses every GitHub route in an account whose secret
holds no App credentials, and says why, rather than hiding a button.

---

## What is not deployed

`cdk deploy -c awsOnly=true` creates none of the following:

| Not here | What that means |
|---|---|
| The webhook endpoint | No API Gateway, no WAF, no public address at all. Nothing outside your account can reach anything |
| The webhook receiver and worker Lambdas | Nothing reacts to GitHub events, because none arrive |
| The alarm evaluator Lambda | No alarm emails, no SNS topics, no pull request walk |
| The access graph rebuilder Lambda | No `graph-edges` data, so no access map and no security checks |
| The audit-log pipeline | No S3 bucket, no OIDC provider, no enterprise audit rows |
| The webhook queue and its dead-letter queue | — |
| The deliveries table | — |

Six Lambda functions become one.

---

## Signing in still uses GitHub

This is the part that surprises people, so it is worth stating plainly.

**You sign in with GitHub even here.** That is how the app knows who you are and
which team you are on — and `aws-guardrail-admins` membership is exactly what
decides whether you may change a rule, switch one to enforce, or start a sweep.
That question is worth asking in an account holding no GitHub data.

What that costs you is an OAuth App's client id and secret: an identity check
against github.com, carrying no access to your repositories beyond what the
person signing in already has. What it does not need is the App private key,
which is the credential that could read the organization.

The **first** sign-in of a session needs an account that has GitHub credentials.
You cannot launch the app cold, connect only this account, and get in. The way
in is to connect the account where GitHub lives, sign in there, and then switch
— your session is yours rather than the account's, so it survives the switch.
See [switching accounts](HOW-IT-WORKS.md#sign-in-and-permissions).

---

## What the app looks like here

Two tabs: **AWS** and **Activity**.

Everything else — Overview, Security, Alarms, Access, Vulnerabilities, Repos,
PRs, Who knows — is gone, refused by the backend rather than hidden by the
frontend. The Activity tab stays and filters itself to the AWS stream, because
an account running the guardrails needs the record of what they did.

---

## What it can do to your AWS account

**Read:** configuration only, and only two services.

```
s3:ListAllMyBuckets   s3:GetBucketLocation   s3:GetBucketPolicy   s3:GetBucketTagging
logs:DescribeLogGroups   logs:ListTagsForResource
sts:GetCallerIdentity
```

Nothing reads the contents of anything. It can see that a bucket has a policy
and how long a log group keeps data. It cannot read an object or a log line.

**Write:** three actions, in the entire account.

```
s3:PutBucketPolicy   logs:PutRetentionPolicy   logs:DeleteRetentionPolicy
```

No `iam:` action of any kind. No `sts:AssumeRole`, so it cannot reach another
account — this deployment reads the account it runs in, with the credentials it
already has, and nothing else. The stack says so out loud in an output named
`CanChangeAnything`.

Those three are granted unconditionally, and whether a rule *uses* them is a
per-rule choice in the AWS tab that defaults to report. That decision is visible
where it is made; it used to be a deploy flag as well, which meant forgetting
the flag produced an app that reported violations and quietly fixed nothing.

---

## CloudTrail

The 15-minute sweep works with no trail at all. The fast path — reacting within
seconds of a bucket or log group changing — needs CloudTrail to be recording,
because those events only exist if something is writing them.

Setup offers to create a trail **only if the account has none**. The first
trail's management events are free; a second one is billed per event, which is a
bill nobody expects for a feature they thought they already had.

---

## What it costs

Roughly **50¢ a month**, and most of that is the secret.

| Item | Monthly |
|---|---|
| Secrets Manager, 1 secret | $0.40 |
| DynamoDB, 12 tables on-demand (6 of them empty) | pennies |
| Lambda | $0.00 — 2,880 sweeps a month is about 1% of the perpetual free tier |
| EventBridge, SQS, CloudWatch Logs | $0.00 – pennies |

There is no WAF and no API Gateway here, which in the full install are the
largest fixed line by a distance. See [cost.md](infrastructure/cost.md) for the
full deployment's numbers.
