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

### Two kinds of provider

**Eight services deeply** — SQS, Lambda, S3, DynamoDB, IAM, security groups, log
groups, RDS. These know relationships, configuration and the fields drift
compares. Adding a ninth means adding one provider; nothing else names a service.

**Every taggable service shallowly**, through one call to the Resource Groups
Tagging API. That covers the rest of AWS — API Gateway, EventBridge, Step
Functions, CloudFormation, EC2 instances, VPCs, WAF — so a resource can be
looked up even where nothing here can say what depends on it.

Neither is a superset. Measured on a real account: the specific providers found
96 resources, the tagging API found 41, and each covered things the other
missed. Together, **125 across 16 services**.

The overlap is merged on the ARN, with the specific providers listed first so
their richer description survives. A resource shown twice would be worse than
either: it makes a list look wrong and a count meaningless.

The tagging API's limit is worth stating: it returns resources that **support
tagging and are indexed for it**, in the current region. Most of AWS, not all.

## The rule everything is shaped around

**A service that cannot be read is `unknown`, never zero.**

"Nothing depends on this" produced by an AccessDenied looks identical to the
safe answer, arrives faster than the safe answer, and acting on it causes the
outage the feature exists to prevent. So a read failure is a first-class
outcome from provider to verdict, the report says which read failed and why, and
**nothing is ever called low risk while anything is unread**.

The source search runs as **you**, not as the app — for disclosure rather than
capability. An installation token can see every private repository in the
organization, so searching with it would show somebody the paths of files in
repositories they cannot open. Your own token returns exactly what you could
have found on github.com.

A search that finds nothing is still worth reading twice, because the query is
scoped to the configured `GITHUB_ORG`. A resource named only in a repository
belonging to a *different* organization is correctly, and unhelpfully, reported
as unreferenced.

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

### Searching for what people actually type

A security group is called `default` and nobody refers to it that way — they
have `sg-0d311ce…`, out of a console URL or an error message. So a resource is
findable by its **name**, its **ARN**, any **id** it carries, and the **words
people use for its service**:

| Typed | Finds |
|---|---|
| `sg-0d311ce245b2a84a4` | that group exactly, ranked above anything merely containing it |
| `sg-` | every security group |
| `security group`, `firewall` | the same |
| `queue`, `bucket`, `function`, `table` | that kind of resource |

Searching an id used to return nothing at all, which reads as the resource not
existing.

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

**CloudFormation and CDK names are reduced to their logical id.** CloudFormation
names a resource `{Stack}-{LogicalId}{hash}-{random}`, so a queue declared as
`WebhookQueue` exists in AWS as
`GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh`. Source contains the
logical id and never the physical name, so without this **every CDK-managed
resource in an account reports as referenced by nobody**. Found the same way: a
queue two Lambdas visibly consume, and which this codebase visibly declares,
returned zero source references. With the logical id searched it returns three
files including the CDK stack, and the verdict gains the line that matters —
*deleting it in the console will not stick*.

The pattern is deliberately strict. A loose one would shorten ordinary
hyphenated names, and a wrongly shortened term matches the wrong files, which is
worse than matching none.

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
| A referencing file could not be read | The declaration is incomplete |

"Cannot be compared" is shown as its own answer and deliberately **not** as a
clean bill of health.

Commented-out blocks are stripped before anything reads the file. A rule
somebody deliberately turned off, reported as drift, is exactly backwards.

### A group nothing declares is itself the finding

Silence used to be the answer when no infrastructure code declared a group. On
an account managed as code that is backwards: a security group **no repository
declares** is one somebody made by hand, and its rules were never reviewed by
anybody. That is more worth surfacing than a diff, not less.

Each ingress rule on such a group is reported as **undeclared** — neither
`extra` nor `missing`, because nothing was compared:

```
  Not declared anywhere
  undeclared   tcp 22 from 0.0.0.0/0
  undeclared   tcp 443 from 0.0.0.0/0
```

A rule that allows another security group rather than a CIDR is still reported;
it is a rule nobody wrote down either.

### Values that live in Parameter Store

The commonest reason a rule cannot be compared is that its value is not in the
file: an office CIDR lives in SSM and the Terraform says
`data.aws_ssm_parameter.office_cidr.value`. The value exists and is readable, so
it is fetched and the comparison proceeds, with the parameter's path recorded on
the report.

Three things are refused rather than guessed:

| | |
|---|---|
| A parameter whose **name** is itself a variable | Resolving it moves the problem rather than solving it |
| A **SecureString** | Decrypting a secret to print it in a drift panel would put it on screen and in a response body. `WithDecryption` is never asked for, so even an operator who *could* decrypt it does not through this path |
| A parameter that cannot be read | Gone, denied, wrong account. A missing parameter is not an empty CIDR |

Each of those leaves the rule unresolved, which is where it was before.

### "Has this changed?" is a different question

Drift compares AWS against source. It has **no memory**, so a security group
that no code declares compares identically before and after somebody edits a
rule's address — undeclared either way. That is why editing an inbound rule
appeared to change nothing.

So each read of a security group's ingress is fingerprinted, and the next read
says what is different:

```
  Changed since this app last looked
  Last read 2 days ago. The change happened at some point since then —
  this app cannot say when, or by whom.

  added     tcp 22 from 198.51.100.7/32
  removed   tcp 22 from 203.0.113.1/32
```

An edited address shows as one rule added and one removed, because that is what
it is.

**Only the gap between two reads is knowable.** Not the moment inside it, and
not who made the change — both come from CloudTrail, which this app does not
use. The wording says so rather than implying a precision it lacks.

The **first** read of a resource is a baseline and reports nothing. Inventing a
change on first sight would make every new resource look like an incident, and
the panel says that is what happened rather than showing an empty box.

A reordering is not a change: AWS returns rules in whatever order it likes, and
comparing raw lists would report a change on every read.

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

## What it does not do

**It does not delete anything, or offer to.** Every operation is a read. The
answer is for a person about to act, not a button that acts.

**It does not tell you who changed something.** That comes from CloudTrail and
nowhere else, and this deliberately does not use it.

**It reads one account** — the one you are signed into. Cross-account is the
guardrail mechanism and is not extended here.

**It says nothing about money.** There was a cost panel here, reading Cost
Explorer and attributing spend to repositories; it was removed. Nothing in this
app now calls a billing API, which also means nothing in it can be charged for —
every AWS call the app makes is a `List` or `Describe`, and those are free.
