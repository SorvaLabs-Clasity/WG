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

Two identities. The EC2 instance running the app, and the Lambda that evaluates
guardrails.

### The app (EC2 instance role)

| Action | Scoped to | Why |
|---|---|---|
| `s3:GetObject` | `github-control-hub-deploy-<account>/*` | The deploy script ships the Docker image through this bucket. One bucket, created by this stack. |
| `secretsmanager:GetSecretValue` | `github-control-hub/secrets*` | The GitHub App key and OAuth secrets. |
| `secretsmanager:CreateSecret`, `PutSecretValue`, `GetSecretValue` | `github-control-hub/aws-account/*` | Access keys for AWS accounts outside your organization, if you use that option. Cannot reach the secret above. |
| `dynamodb:*Item`, `Scan`, `Query` | `github-control-hub-*` tables | The app's own tables. Not `dynamodb:*`, and not every table in the account. |
| `organizations:ListAccounts`, `DescribeOrganization` | — | Reads your account list so nobody has to type twelve-digit ids. Read-only; neither call supports resource scoping. |
| `sts:AssumeRole` | `arn:aws:iam::*:role/github-control-hub-guardrail-access` | Verifies an account is reachable before storing it. **One role name.** |
| `lambda:GetFunctionConfiguration` | the guardrail function | Reads the engine's role ARN, so the Accounts screen can show both principals a watched account must trust. |
| `lambda:InvokeFunction` | the guardrail function | Manual sweeps from the UI. |
| `AmazonSSMManagedInstanceCore` | AWS managed policy | Session Manager, so the instance has no SSH port open. |

### The guardrail engine (Lambda role)

Reads — six actions, all `Describe`/`List`/`Get` on **settings**:

```
s3:ListAllMyBuckets      s3:GetBucketLocation
s3:GetBucketPolicy       s3:GetBucketTagging
logs:DescribeLogGroups   logs:ListTagsForResource
```

Writes — **none by default.** Deploying with `-c enforce=true` adds exactly:

```
s3:PutBucketPolicy   logs:PutRetentionPolicy   logs:DeleteRetentionPolicy
```

Plus `sts:AssumeRole` on the one role name, `sts:GetCallerIdentity`,
`secretsmanager:GetSecretValue` on `github-control-hub/aws-account/*`, and
DynamoDB on `github-control-hub-*`.

`"*"` appears as a resource only where IAM offers no alternative:
`ListAllMyBuckets` and `DescribeLogGroups` are account-wide operations, and the
`Get*` calls have to reach whichever resources turn out to exist.

---

## 2. Other accounts

Reached by assuming a role that account grants — never a stored key, unless you
choose that option for an account outside your organization.

**The role is `github-control-hub-guardrail-access`, and it is the only role
this app is permitted to assume anywhere.** Its policy is the six reads above,
with the same three writes available only if that account's stack sets
`ReadOnly=false`.

It also carries explicit `Deny` statements, which no `Allow` from any policy
can override:

- **Never read data** — `s3:GetObject`, `s3:GetObjectVersion`, `s3:GetObjectAcl`,
  `logs:GetLogEvents`, `logs:FilterLogEvents`, `logs:StartQuery`
- **Never destroy** — `s3:DeleteBucket`, `s3:DeleteBucketPolicy`,
  `s3:DeleteObject`, `s3:DeleteObjectVersion`, `logs:DeleteLogGroup`,
  `logs:DeleteLogStream`
- **Never widen access** — `iam:*`, `sts:AssumeRole` (blocks role chaining),
  `s3:PutBucketAcl`, `s3:PutObjectAcl`, `s3:PutBucketPublicAccessBlock`,
  `s3:DeletePublicAccessBlock`, `s3:PutAccountPublicAccessBlock`,
  `s3:PutBucketWebsite`

Those denies are redundant against today's allow-list. They exist so that a
broader policy attached to this role later — by anyone, for any reason — still
cannot be used to expose your data.

Its trust policy names **two** principals: the app and the guardrail engine.
The app assumes the role to verify an account before storing it; the engine
assumes it to sweep. Both ARNs are shown in the Accounts screen.

### Deploying it

**From the app.** AWS → Accounts → *How do I add an account?* gives you the
template, every parameter filled in, a generated external ID, and a link to the
right console page. Nothing to run.

**From a checkout.** `scripts/deploy-guardrail-role-org-wide.sh` does the same
thing as a StackSet with auto-deployment, so accounts created later get the role
without anyone remembering.

### Why the app does not create the role itself

Creating an IAM role across an organisation requires
`cloudformation:CreateStackSet` with `CAPABILITY_NAMED_IAM`. Anything holding
that permission can deploy an **administrator** role into every account in the
organisation — strictly worse than the administrator access this app was built
without. It would trade a bounded permission for an unbounded one to save a few
clicks.

So the app does every part that costs nothing: it works out the ARNs, generates
the external ID, carries the template, and builds the commands and links. A
human presses Create, signed in as themselves. `repro-leastprivilege.ts` asserts
that no `cloudformation:Create*`, no `iam:CreateRole`, and no `iam:PassRole`
appears anywhere in the stack.

---

## 3. What it deliberately cannot do

**It cannot become an administrator.** AWS puts
`OrganizationAccountAccessRole` — which carries `AdministratorAccess` — in every
account opened through Organizations, and using it would mean no setup work at
all. This app's IAM does not permit assuming it, or
`AWSControlTowerExecution`, or any role but the one named above. That is the
reason there is a setup script; the convenience was not worth the permission.

**It cannot read your data.** No `s3:GetObject` anywhere in the engine, no
`logs:GetLogEvents`. It can see that a bucket has a policy and how long a log
group keeps data. It cannot see what is in either.

**It cannot grant anyone access to anything.** No `iam:` action of any kind, in
any role, in any account.

**It cannot delete anything.** Not a bucket, not an object, not a log group.

**It cannot change anything unless you deploy it twice on purpose** — once for
the app's own account (`cdk deploy -c enforce=true`), and once per account you
want it to fix things in (`ReadOnly=false`). A read-only deployment still finds
every violation and still records the exact fix it would have made; AWS refuses
the write and the finding says so in those words.

---

## 4. What it can see about you

Everything it reads is a setting, and every call it makes into another account
appears in **that account's own CloudTrail**, under the session name
`control-hub-guardrails`. The account being watched can audit exactly what was
looked at, and revoke it by deleting one stack.

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
