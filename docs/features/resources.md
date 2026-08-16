# Resources — what breaks if I delete this?

Look up any AWS resource by name, ARN or fragment, and see everything that
depends on it: inside AWS, and across every repository in the organization.

The second half is the point. AWS knows a Lambda consumes a queue. Only your
source knows which Terraform module declares it, which pipeline deploys it, and
therefore which pull request has to change before it can safely go.

## What it reads, and as whom

**Your own AWS credentials**, on demand, in the desktop process. Not the
guardrail role, not a Lambda, no assume-role, no cross-account hop. Somebody
signed in with permission to see a queue is exactly the person asking whether
deleting it is safe, so this needed **no new IAM grant and nobody's approval**.

Every AWS call is a `List` or `Describe`, which AWS does not charge for. The
feature's marginal AWS bill is **zero**.

Eight services today — SQS, Lambda, S3, DynamoDB, IAM, security groups, log
groups, RDS. Adding a ninth means adding one provider; nothing else in the
feature names a service.

## The rule everything is shaped around

**A service that cannot be read is `unknown`, never zero.**

"Nothing depends on this" produced by an AccessDenied looks identical to the
safe answer, arrives faster than the safe answer, and acting on it causes the
outage the feature exists to prevent. So a read failure is a first-class
outcome from provider to verdict, the report says which read failed and why, and
**nothing is ever called low risk while anything is unread**.

The same rule is why the source search must run as **you**, not as the app.
GitHub's code search returns **zero hits** for a GitHub App installation token —
no error, just nothing. Measured: a file that plainly exists in this repository
came back with nothing through the app token and everything through a user
token. A blast radius built on that would confidently report no source
references at the worst possible moment, so a test asserts the route never
reaches for the system token.

## What counts as a dependency

| Inside AWS | Meaning |
|---|---|
| **Event source** | A Lambda is consuming from this **right now**. Breaks in seconds, not on the next deploy |
| Environment variable | How nearly every function names the table, queue or bucket it uses |
| Execution role | The function runs as this role |
| Security group | Network access to a database is governed by this group |

| In your source | Meaning |
|---|---|
| **Terraform / CloudFormation / CDK** | Declares it. Deleting it in the console **will not stick** |
| Pipeline | A delete breaks a deploy, not just a runtime |
| Kubernetes | A manifest names it |
| Code, config | Something reads it |
| Docs | A runbook will send somebody to a resource that no longer exists |

Relationships are **directional**, because losing the direction loses the
difference between "this will break" and "this will be orphaned".

Matching is by **whole token**. `orders` does not match `orders-archive-dlq`,
because a report that over-reports is a report nobody believes.

## What it searches for

A resource is named three different ways in three different places, and
searching only one finds a third of the references. The lookup searches the
name, the ARN, and the name with any **generated suffix** removed.

That last one matters more than it sounds. A bucket called
`acme-audit-log-<account-id>` appears in Terraform as
`"acme-audit-log-${data.aws_caller_identity.current.id}"` and never as the
literal — so searching the literal finds nothing and reports nothing. Found by
running this against a real account, where the app's **own** audit bucket came
back with zero references for exactly that reason. Account ids, regions and
environment suffixes are all stripped.

## The budget

GitHub's code search allows **ten requests a minute** — the smallest allowance
it hands out. One lookup costs one request per identifier, so a resource known
by a name and an ARN costs two.

Answers are cached for ten minutes, including failures. Caching the failures is
deliberate: a rate limit re-tried on every render turns one exhausted budget
into a permanently exhausted one.

The AWS inventory is held for one minute, shared between concurrent requests, so
search-as-you-type costs one listing rather than one per keystroke.

## What it does not do

**It does not delete anything, or offer to.** Every operation is a read. The
answer is for a person about to act, not a button that acts.

**It does not tell you who changed something.** That comes from CloudTrail and
nowhere else, and this deliberately does not use it.

**It reads one account** — the one you are signed into. Cross-account is the
guardrail mechanism and is not extended here.
