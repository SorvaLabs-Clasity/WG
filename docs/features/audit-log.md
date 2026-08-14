# Enterprise audit log

The organisation's own record of who did what, streamed from GitHub into the
Activity page's **Audit log** stream.

## Why streaming rather than the API

The audit log REST API is rate limited to 1,750 requests an hour and its
history is capped. Streaming has neither limit: GitHub writes each batch of
events to a bucket as it happens, and the bucket keeps them for as long as the
lifecycle rule says.

It also costs nothing extra. Streaming is included with GitHub Enterprise
Cloud; the AWS side is a few cents a month at any realistic volume.

## What you have to do

Nothing in this repository can turn this on. An enterprise owner has to
configure it, in a browser, once.

1. Deploy the stack. `cdk deploy` creates the bucket and prints its name as the
   **`AuditLogBucketName`** output.
2. In GitHub: **Enterprise settings → Audit log → Streaming → Amazon S3**.
3. Point it at that bucket and authenticate. GitHub sends a test event on save
   — if it succeeds, objects start arriving.

Until step 2 happens the bucket sits empty, the Lambda never runs, and the
Audit stream says it is not connected rather than showing a blank table.

## What is kept

GitHub streams everything, including `git.clone` and `git.fetch` — one line per
CI job, thousands a day, and nobody has opened an audit trail to read them.

So the split is:

- **S3 keeps everything.** Complete, gzipped, cheap, searchable by date prefix
  if a question ever needs it.
- **DynamoDB indexes the consequential events only** — the ones that changed
  who can do what, what is exposed, or what protects a repository. Those are
  what the Audit stream shows.

The allow-list lives in `backend/src/audit/events.ts` and covers organisation
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
one organisation, and is read-only.
