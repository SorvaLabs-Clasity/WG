# Enterprise audit log

The organization's own record of who did what, streamed from GitHub into the
Activity page's **Audit log** stream.

## Why streaming rather than the API

The audit log REST API is rate limited to 1,750 requests an hour and its
history is capped. Streaming has neither limit: GitHub writes each batch of
events to a bucket as it happens, and the bucket keeps them for as long as the
lifecycle rule says.

It also costs nothing extra. Streaming is included with GitHub Enterprise
Cloud; the AWS side is a few cents a month at any realistic volume.

## Setting it up

In the app: **Activity → Audit log**. With nothing configured the stream says
so and offers a field for your enterprise slug — the name in
`github.com/enterprises/<name>`.

Setting it up creates two things in AWS, using your own credentials:

- an **OIDC provider** for GitHub's audit-log issuer, shared account-wide
- a **role** that issuer may assume, pinned to that one enterprise and allowed
  `s3:PutObject` on one bucket and nothing else

Pinned deliberately. A role trusting the issuer without naming a subject would
accept uploads from any GitHub enterprise, into the bucket whose whole purpose
is being the record nobody can rewrite. The slug is validated before it reaches
the trust policy for the same reason.

The stack does **not** create these. It used to, behind
`-c auditEnterprise=<slug>`, which made the feature reachable only by someone
who knew a flag documented in a code comment — and left everyone else with an
empty bucket and no hint of what it was for. Two owners for one role would also
race, and whichever lost would fail the deploy.

### Turning it off

**Turn off streaming** on the same page deletes the role GitHub assumes. The
next upload has nothing to assume and fails at GitHub's end; no new batches
arrive. Setting it up again restores it.

**The archive is kept.** The bucket and everything already collected stay
exactly as they are, and objects still expire on their own after 400 days. That
record is the point of the feature — it is held under `RemovalPolicy.RETAIN` so
that even destroying the stack cannot take it — and an off switch that erased
history would be a different, much louder button.

Growth is not a reason to reach for one. Gzipped audit batches are small, the
lifecycle rule already caps the archive at 400 days, and objects move to
Infrequent Access after 30 — a few cents a month at any realistic volume. If
you genuinely want the archive gone, delete it deliberately in the S3 console
rather than as a side effect of pausing a stream.

The account-wide OIDC provider is left in place too: another role may trust the
same issuer, and with nothing pointing at it, it grants nobody anything.

### The half no app can do

An enterprise owner switches streaming on, once, in a browser:

**Enterprise settings → Audit log → Log streaming → Amazon S3**, authenticating
with **OpenID Connect** rather than access keys. The app shows the bucket name
and role ARN to paste, with copy buttons.

The step-by-step, including the exact ARN shape, the two other places to read it
from, and what a failed test event usually means, is in
[setup phase 4](../operations/setup.md#phase-4--enterprise-audit-log-streaming-optional).

Until they do, the page says **"AWS is ready — waiting on GitHub"**. That state
is the reason this lives in the app rather than in a deploy: AWS can be
perfectly configured while GitHub is sending nothing, and a deploy cannot tell
you that. It only knows what it created.

## What is kept

GitHub streams everything, including `git.clone` and `git.fetch` — one line per
CI job, thousands a day, and nobody has opened an audit trail to read them.

So the split is:

- **S3 keeps everything.** Complete, gzipped, cheap, searchable by date prefix
  if a question ever needs it.
- **DynamoDB indexes the consequential events only** — the ones that changed
  who can do what, what is exposed, or what protects a repository. Those are
  what the Audit stream shows.

The allow-list lives in `backend/src/audit/events.ts` and covers organization
membership and roles, teams, repository creation and visibility, branch
protection, rulesets, tokens and third-party access, webhooks, and secret
scanning alerts.

Widening it needs no code change: set **`AUDIT_EVENT_ALLOWLIST`** on the
`audit-ingest` function to a comma-separated list. Entries ending in a dot are
prefixes. An empty or whitespace value falls back to the built-in list rather
than indexing nothing.

You cannot know your own volume until streaming has run for a few days, which
is exactly why this is configuration rather than a constant.

## Retention

Thirteen months on both halves, so the trail ends at one moment rather than one
half outliving the other:

- **DynamoDB** — the same `ttl` attribute every activity row carries, stamped
  from the event's own timestamp. A backdated object replayed into the bucket
  expires on its own schedule.
- **S3** — a lifecycle rule expires objects after 400 days, moving them to
  Infrequent Access after 30. Most of the archive is never read twice, which is
  the right way round for that storage class.

The bucket carries `RemovalPolicy.RETAIN`. Destroying the stack must not take
the record of who did what with it.

## Cost

At the filtered tier this is rounding error. Roughly:

| Indexed events/day | DynamoDB writes | Storage at 13 months | Total |
|---|---|---|---|
| 200 | under a cent | ~2¢ | **~2¢/month** |
| 2,000 | ~8¢ | ~20¢ | **~30¢/month** |
| 10,000 | ~38¢ | ~$1 | **~$1.40/month** |

Plus a few cents of S3. The expensive shape would be indexing every event with
full retention — a busy enterprise generates millions a month, and you would
pay to store and write all of them twice.

## How an event becomes a row

`backend/src/audit/ingest.ts` runs on each object created in the bucket.

It gunzips, parses newline-delimited JSON, drops anything not on the allow-list,
and writes the rest as activity rows with `source: "audit"` and
`action: "audit.event"`. The specific GitHub event — `protected_branch.destroy`,
`org.add_member` — goes in `target`, which is what distinguishes rows in the UI.

GitHub also writes a plain-text object called `_check` whenever it verifies the
connection, and periodically while streaming is on. It is skipped by name
before anything tries to parse it — left to fail it counted as an unparseable
line, so every routine check logged what looked like a corrupted batch and the
count stopped meaning anything.

Three more details that matter:

- **One malformed line does not discard the file.** A partial batch is worth
  more than none, and the count of unparseable lines is logged.
- **Row ids are derived from the event**, not generated, so replaying an object
  overwrites rather than duplicates.
- **`BatchWriteItem` returns partial success rather than throwing.** Unprocessed
  items are retried with backoff, and a batch that still will not write throws
  — S3 retries the notification, and the stable ids make that harmless.

## What this is not

It does not replace the Organization stream. That records what this app did and
what its webhook heard about, in near real time, with undo. The audit log is
GitHub's own record, arrives in batches, covers the whole enterprise rather than
one organization, and is read-only.
