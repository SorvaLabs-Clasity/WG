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

## Every finding is a link

A blast radius is read by somebody who then has to go and act on it, so each
dependency names the exact thing and links straight to it in the AWS console:

- **which** Lambda, by name, linked to its function page
- **which** environment variable, by key *and* value — `QUEUE_URL = https://…`,
  not "references it by env var"
- whether an event-source mapping is **enabled**, marked `consuming now`
- the resource itself, with **Open in AWS** on the header

Links are built rather than fetched, because AWS returns none. Where one cannot
be built truthfully — an unknown region, a security group with no id — there is
no link rather than a guessed one: a link to the wrong region shows an empty
page, which reads as "this no longer exists".

## Who has worked on it

The same lookup answers a second question, at no extra search cost: **who has
actually edited the files that define and use this resource.**

Not who has permission, and not who is on the team that owns the account. Those
are easy to find and usually the wrong people. This reads the commit history of
exactly the files the blast radius already located, and ranks with the same
decay the [Who knows](who-knows.md) tab uses — recent work counts for more, bots
are excluded.

**Ranked by file, not by repository.** Ranking by repository credits everybody
who has ever committed to the monorepo, which buries the one person who wrote
`terraform/sqs.tf` under fifty who changed a stylesheet.

At most **twelve** files are read, ordered by what the file is before the cut
bites: infrastructure first, then pipelines, then code, and documentation last.
Each person carries the files they touched, so a name can be checked rather than
trusted, and the count of files not read is shown rather than hidden.

A file whose history cannot be read is reported. A shorter list of people looks
exactly like a smaller set of people, and here it would send somebody to the
wrong person.

## Drift — does AWS match the source?

For security groups, the lookup also compares what AWS actually allows against
what the Terraform declares, and says which side has the extra rule:

| Finding | Meaning | Whose problem |
|---|---|---|
| **in AWS only** | Something allows this and no Terraform declares it | A manual change nobody captured |
| **in code only** | Terraform declares this and AWS does not have it | A pipeline that never ran |

Those are different problems for different people, so they are never merged into
one "drift" count.

### It reads the declaration, it does not run a plan

The precise answer is `terraform plan`, which needs the state file, the
providers, credentials for every backend and a working directory — none of which
a read-only app has or should have. Reading the declaration is enough for the
question actually being asked: *is the thing in AWS the thing somebody wrote
down?*

The cost of that choice is stated rather than hidden.

### When it refuses to answer

**Drift detection fails by being noisy, not by crashing.** A report that flags
twenty rules a human knows are fine is read once, disbelieved, and never opened
again. So the comparison is abandoned — and says so — whenever it cannot be
trusted:

| Situation | Why nothing is reported |
|---|---|
| A rule uses `var.x`, a `local`, or an interpolation | Resolving it needs Terraform. Comparing the resolved half against complete AWS state marks every unseen rule "added by hand" |
| A `dynamic "ingress"` block | It generates rules from an expression |
| The file also declares `aws_security_group_rule` | Rules can be added from another file or module, so the inline ones are not the whole set |
| Two declarations share the group's name | Picking the first compares against a coin flip |
| No Terraform names the group at all | There is nothing to compare against |
| A referencing file could not be read | The declaration is incomplete |

"Cannot be compared" is shown as its own answer and deliberately **not** as a
clean bill of health.

Commented-out blocks are stripped before anything reads the file. A rule
somebody deliberately turned off, reported as drift, is exactly backwards.

### What it cannot tell you

**Who changed it, and when.** That comes from CloudTrail and nowhere else, and
this deliberately does not use it. What it can tell you is the more useful half
anyway: *this rule exists in AWS, no Terraform declares it, and here is who has
edited the files that do.*

## The budget

GitHub's code search allows **ten requests a minute** — the smallest allowance
it hands out. One lookup costs one request per identifier, so a resource known
by a name and an ARN costs two.

Answers are cached for ten minutes, including failures. Caching the failures is
deliberate: a rate limit re-tried on every render turns one exhausted budget
into a permanently exhausted one.

The AWS inventory is held for one minute, shared between concurrent requests, so
search-as-you-type costs one listing rather than one per keystroke.

## Cost

**Behind a button, not on the page.** Every other AWS read in this app is free.
Cost Explorer charges **$0.01 per request** — nothing once a day, and $26 a
month for one tab refreshing every thirty seconds. So it is fetched when
somebody asks, held for a day on both sides, and never on a render, a timer or a
window focus.

### Three precisions, and which one you get is on the number

| Mode | Precision | Needs |
|---|---|---|
| **resource** | Exact per resource, so spend attributes through the source index with no tagging | Payer account opt-in for resource-level data. Keeps **14 days** |
| **tag** | Exact for anything tagged | Cost allocation tags activated in Billing. Populates over a day, **not retroactively** |
| **service** | Always available, **cannot be split between projects** | Nothing |

The mode is shown on the total, because a per-service figure and a per-project
figure answer different questions and a reader who cannot tell which they have
will assume the better one. When a more precise mode is unavailable, the panel
says which setting to change rather than apologising.

The 14-day window is checked *before* asking. Requesting a calendar month
returns "start date is too old for hourly, the max supported days for hourly
granularity is 14 days" — a message that does not mention resources, is not
actionable, and costs a cent to receive.

### The link to code, and the line it will not cross

For each service, the panel names the **repositories whose source references
resources of that service**, and counts the resources **nothing references**.
That second number is usually the more interesting one: those are the resources
nobody owns.

It does **not** invent a per-repository dollar figure. Without per-resource data
nothing supports splitting a service's bill between repositories, and a number
made up here is exactly the kind that gets quoted in a meeting and then cannot
be defended.

Only services this app actually inventories are mapped. An unmapped service
shows its cost with no ownership claim — the honest shape for "we did not look".

## What it does not do

**It does not delete anything, or offer to.** Every operation is a read. The
answer is for a person about to act, not a button that acts.

**It does not tell you who changed something.** That comes from CloudTrail and
nowhere else, and this deliberately does not use it.

**It reads one account** — the one you are signed into. Cross-account is the
guardrail mechanism and is not extended here.
