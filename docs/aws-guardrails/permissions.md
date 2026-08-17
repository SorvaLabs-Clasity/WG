# What this app can do in AWS

Every AWS permission the GitHub Control Hub holds, why it holds it, and what it
cannot do. Written to be handed to whoever has to approve deploying this into a
production account.

The short version: it reads configuration, it cannot read data, and by default
it cannot change anything at all.

`repro-leastprivilege.ts` asserts most of what follows against the actual IAM
this project ships, so the document and the deployment cannot drift apart
without a test failing.

---

## 1. The account the app runs in

Three Lambda roles, each scoped to what that one function does, plus your own
AWS credentials wherever the desktop app is what's asking.

### The webhook receiver

| Action | Scoped to | Why |
|---|---|---|
| `secretsmanager:GetSecretValue` | `github-control-hub/secrets*` | Reads the webhook secret to verify a delivery's signature. |
| `sqs:SendMessage` | the webhook queue | Hands a verified delivery to the worker. |

No DynamoDB, no STS, no Organizations, no Lambda invoke. This is the only
function reachable from the internet, and this list is the point of splitting
it from the worker.

### The webhook worker

| Action | Scoped to | Why |
|---|---|---|
| `secretsmanager:GetSecretValue` | `github-control-hub/secrets*` | The GitHub App key and OAuth secrets. |
| `dynamodb:*Item`, `Scan`, `Query`, `BatchGetItem`, `BatchWriteItem` | `github-control-hub-*` tables | The app's own tables. Not `dynamodb:*`, and not every table in the account. |

### Your own credentials, on the desktop

Invoking the guardrail function for a manual run happens under whichever AWS
credentials you signed in with on the desktop app (see
[AWS credentials](../auth/aws-credentials.md)), the same as every other AWS read
the desktop makes. There is no shared "app" identity for it the way there was
when an instance ran this same Express app; that instance and its role are gone
and nothing replaced them, because nothing needed to.

### The guardrail engine (Lambda role)

Reads — six actions, all `Describe`/`List`/`Get` on **settings**:

```
s3:ListAllMyBuckets      s3:GetBucketLocation
s3:GetBucketPolicy       s3:GetBucketTagging
logs:DescribeLogGroups   logs:ListTagsForResource
```

Writes — **exactly three, always granted.** Whether a rule uses them is decided
per rule, in the app:

```
s3:PutBucketPolicy   logs:PutRetentionPolicy   logs:DeleteRetentionPolicy
```

Plus `sts:GetCallerIdentity` — so a finding can say which account it came from
— and DynamoDB on `github-control-hub-*`. No `sts:AssumeRole`, and no read of
credentials for any other account.

`"*"` appears as a resource only where IAM offers no alternative:
`ListAllMyBuckets` and `DescribeLogGroups` are account-wide operations, and the
`Get*` calls have to reach whichever resources turn out to exist.

---

## 2. One account, and no way to reach another

The engine reads the account it runs in, with the credentials it already has.

It used to do more. An organisation could register other accounts — reached by a
role each one deployed, or by an access key pair kept in Secrets Manager — and
the sweep ran across all of them. That worked, and it cost a permission the app
had to hold permanently: `sts:AssumeRole` on a fixed role name in **any**
account, plus `secretsmanager:CreateSecret`/`PutSecretValue`/`GetSecretValue` on
a prefix holding other accounts' credentials, plus `organizations:ListAccounts`
to discover them.

That is a large standing capability for a tool whose job is to report. The
registry has been removed and those grants with it, so:

- there is **no `sts:AssumeRole`** anywhere in the stack
- there is **no read of stored credentials** for any other account
- **`organizations:` is not read at all**
- there is no role for another account to create, and no template to deploy

`repro-leastprivilege` asserts each of those as an absence, so re-introducing
one fails a test rather than passing quietly.

An organisation that wants several accounts watched deploys the app once per
account. That is more work than a registry, and it buys a property the registry
could not: a compromise of the engine reaches exactly the account it already
runs in.

## 3. What it deliberately cannot do

**It cannot become anything.** There is no `sts:AssumeRole` in the stack at
all, so the roles AWS puts in every organisation member account —
`OrganizationAccountAccessRole` and `AWSControlTowerExecution`, both carrying
`AdministratorAccess` — are unreachable, along with every other role. The engine
runs as itself and nothing else.

**It cannot read your data.** No `s3:GetObject` anywhere in the engine, no
`logs:GetLogEvents`. It can see that a bucket has a policy and how long a log
group keeps data. It cannot see what is in either.

**It cannot grant anyone access to anything.** No `iam:` action of any kind, in
any role, in any account.

**It cannot delete anything.** Not a bucket, not an object, not a log group.

**It changes nothing until a rule says so.** Every rule starts in report mode
and is switched to enforce individually, in the AWS tab. A rule left in report mode
still finds every violation and still records the exact fix it would have made;
nothing is written
the write and the finding says so in those words.

---

## 4. What it can see about you

Everything it reads is a setting, and every call it makes appears in this
account's own CloudTrail under the guardrail function's role. There is no other
account involved and no cross-account session to audit — the engine reads where
it runs.

---

## 5. Hardening past the defaults

- **External ID.** The deployment script generates one. Without it, another
  installation of this app that knew your account numbers could ask to be let
  in. With it, they cannot.
- **Leave `enforce` off.** Report-only is the default and covers the audit use
  case entirely. Turn it on for one account if you want automation there.
- **Permissions boundary.** Not applied by default. If your organization uses
  boundaries, attaching one to both roles caps them regardless of future policy
  changes.
- **Narrow the app's own account.** The `organizations:ListAccounts` grant only
  populates the account picker. Remove it and add accounts by hand; nothing
  else depends on it.
