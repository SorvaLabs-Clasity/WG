# What's stored in DynamoDB

Twelve tables. This explains what's in each one, who puts it there, who reads it,
and when it disappears.

If you're comparing against AWS, every name below is prefixed with your stack
name — `github-control-hub-activity`, and so on. That prefix comes from
`STACK_NAME`, so a different environment has a different set.

---

## The words first

**Table** — a place to save things, like a spreadsheet in the cloud. Each row is
one saved thing.

**Key** — the label you look a row up by. Like a filing cabinet where each folder
has a name on the tab: if you know the name you get the folder instantly. If you
don't, you have to flip through every folder one at a time. That's called a
**scan**, and it's slower and costs more.

**TTL** — a "throw this away on" date stamped onto a row when it's written. Later,
the database deletes it for you. Nothing has to remember to clean up.

**Webhook** — GitHub phoning the app to say *"something just changed"* — someone
was added to a repo, a pull request opened. The opposite of the app asking.

**"Rebuilt every 6 hours, with webhook corrections in between"** means: the app
rebuilds the whole list from scratch four times a day, and when GitHub phones
about one small change, it fixes just that row instead of rebuilding everything.

---

## The twelve, at a glance

| Table | Holds | Goes away |
| --- | --- | --- |
| `activity` | the audit trail — every action | after 13 months |
| `alarms` | ten different kinds of row (see below) | varies by kind |
| `alerts` | security alerts | when resolved |
| `auth-codes` | sign-in codes | 5–10 minutes |
| `aws-exclusions` | what the guardrails ignore | never |
| `aws-findings` | what the guardrails caught | replaced each sweep |
| `aws-guardrails` | your AWS rules | never |
| `graph-edges` | who has access to what | rebuilt every 6h |
| `org-config` | one row of org-wide settings | never |
| `scanners` | your scanner setups | never |
| `webhook-deliveries` | "already handled that one" notes | 10–15 minutes |
| `widgets` | the cards on your dashboard | never |

They fall into four groups by *how* they get filled, which matters more than the
alphabetical order.

---

## Group 1 — Settings you typed in

`widgets` · `scanners` · `org-config` · `aws-guardrails` · `aws-exclusions`

**Where the information comes from:** a person clicking Save in the app.
**Who reads it:** the page you're looking at, on load.
**When it disappears:** never. If it's gone, somebody deleted it.

| Table | Key | Written by |
| --- | --- | --- |
| `widgets` | `id` | `services/widgetService.ts` |
| `scanners` | `pk="SCANNER"`, `sk=<id>` | `services/scannerService.ts` |
| `org-config` | `org` | `services/orgConfigService.ts`, `aws-guardrails/accounts.ts` |
| `aws-guardrails` | `id` | `aws-guardrails/store.ts` |
| `aws-exclusions` | `id` | `aws-guardrails/store.ts` |

**There is one dashboard, shared by everyone.** The app records who created each
widget but never uses that to hide anything, so your widgets are everyone's
widgets. That's why only admins can edit them — otherwise anyone could delete a
card the whole team relies on.

**`org-config` is a single row** holding the feature flags, the Renovate bot
name, and the record of when the access graph was last rebuilt. That last part
sounds like it belongs beside the graph itself, but it can't be: the rebuild
*wipes* the graph table before refilling it, so a note stored there would be
destroyed by the next run — including a run that then crashed, leaving no record
that anything happened.

---

## Group 2 — `alarms`, the busy one

Keyed by `id` alone, but eleven different *kinds* of row live in it, each tagged
with what it is:

| Tag | What it is | Goes away |
| --- | --- | --- |
| `alarm` | your alarm setups | never |
| `group` | email groups (and their SNS topic) | never |
| `feed` | which emails go out for Dependabot / Renovate | never |
| `security` | one row: the security-alert on/off switch | never |
| `pr-settings` | your PR reminder configuration | never |
| `pr-mutes` | who's muted from reminders | never |
| `pr-state` | per-PR: reminders sent, paused or not | 180 days |
| `pr-snapshot` | the saved copy of your PR tab | 24 hours |
| `pending` | emails waiting to be sent | 24 hours |
| `query-subject` | saved answers for slow checks | 48 hours |
| `widget-snapshot` | the saved rows behind each dashboard card | replaced every 5 min |

**`widget-snapshot` never accumulates.** One row per widget, keyed
`widget-snapshot#<widgetId>` with no timestamp in the key, so each 5-minute pass
overwrites the one before it in place. Eleven widgets means eleven rows today
and eleven rows a year from now; only `computedAt` moves. It carries a 24-hour
TTL, but that is never what removes it — a snapshot is replaced roughly 288
times before it could expire. The TTL is there for rows that *stop* being
rewritten: deleting a widget removes its snapshot immediately, and if that is
ever missed, the TTL clears it within a day instead of leaving it forever.

Nothing reads a previous snapshot, which is why none is kept. A snapshot is a
cache of the current answer, not a record of what was true earlier — history
that is worth keeping is kept deliberately elsewhere, in `activity` (what
changed) and in alarm rows (what fired).

**`query-subject`** is how the expensive widget checks stay affordable. The
dormant-admin check needs one GitHub commit search per privileged account, and
that search allows only **30 requests a minute** — so answers are saved per
account and refreshed 25 at a time. "Checked and active" is saved too, not just
findings: otherwise a clean account would be indistinguishable from one nobody
had got to yet, and the check could never finish.

**`pr-state`'s 180 days is measured from the last write, not from creation.** An
active pull request keeps renewing itself. A *paused* one is the exception —
nothing writes it, because paused pull requests are skipped before any reminder
is posted — so the app explicitly pushes its expiry out. Without that, a pause
left alone for 180 days was deleted and reminders quietly resumed on a pull
request somebody had deliberately silenced.

### The trap worth knowing

Because ten kinds share one table, reading any one kind means reading the whole
table and filtering. And:

> **A read of a whole table returns at most 1MB and then stops.** It doesn't
> fail. It doesn't warn. It hands back a short list and a quiet note saying
> "there's more" that's easy to ignore.

Ignore it and everything downstream works perfectly on incomplete data. Alarms
that seem to have vanished stop firing. Email groups look deleted. Buffered
emails never send. Muted people start getting reminders again. Nothing appears
broken — it's just answering from half the data. `utils/dynamo.ts` has a helper
that always reads to the end, and every caller here uses it.

---

## Group 3 — Copies of GitHub and AWS data

Not settings. Copies the app keeps so it doesn't have to keep asking GitHub,
which limits how often you can ask.

| Table | Key | Filled by | How often |
| --- | --- | --- | --- |
| `graph-edges` | `pk`, `sk` | `jobs/graphAggregator.ts` | every 6h + webhook fixes |
| `aws-findings` | `pk="FINDING"`, `sk` | `aws-guardrails/handler.ts` | every 15 min + on CloudTrail events |

**Neither has a TTL, because being replaced is how they expire.**

**`graph-edges`** holds rows that read like *"alice → api-repo, role: admin."*
This is what most widget checks actually read. "Repos without an owning team"
never calls GitHub at all — it's counting rows here, which is why it's instant.

The rebuild costs roughly **four GitHub requests per repository**, plus two per
team and about a dozen for the organization. Three hundred repositories works out
around 1,300 requests, against an allowance of 15,000 an hour — which is why it
runs every six hours rather than every few minutes.

**`aws-findings`** uses `sk = "<accountId>#<region>#<ruleId>#<resourceId>"`.
Findings are written in batches, and DynamoDB is allowed to decline part of a
batch and hand back what it didn't take. An unread "didn't take" list is a set of
violations the engine found and reported nowhere, so the write retries up to five
times with backoff before giving up loudly.

---

## Group 4 — The record, and the scratch notes

### `activity` — the audit trail

Kept for **13 calendar months** (not 30-day approximations, so "13 months" means
what a person reading a retention policy thinks it means). DynamoDB deletes
expired rows *within about 48 hours* of the date rather than exactly on it, so
treat it as a floor rather than a deadline.

Everything is filed under a single tab labelled `ACTIVITY`, sorted by time. Great
for "show me the newest hundred." Useless for "find the row with *this* ID" or
"everything about *this* repository", because either would mean flipping through
the whole thing. So there are **three extra lookup lists** beside it:

| Lookup list | Answers | Why it exists |
| --- | --- | --- |
| `id-index` | find one row by its id | every row has an id |
| `parentId-index` | find a row's children | only child rows have a parent, so the list holds exactly those |
| `repo-index` | everything about one repository, newest first | keyed on the repository with the timestamp beside it, so this is a direct lookup at any depth |

Without them those lookups fell back to *checking the most recent rows and
hoping*, which answers "is it recent?" rather than "does it exist?" On a small
log those look identical; on a large one it is silently wrong.

**`repo-index` is deliberately sparse.** A row that is not about one repository,
a sync or a settings change, omits the `repo` attribute entirely rather than
storing an empty string. DynamoDB indexes a row only when the attribute is
present, so those rows are not indexed at all. Storing `""` would have put every
one of them under a single empty key: the largest partition in the index and the
one nobody ever queries.

Four things write to it:

| Writer | What it records |
| --- | --- |
| `services/activityService.ts` | actions taken in the app |
| `webhooks/processDelivery.ts` | changes made on github.com, and, behind the detailed-logging toggle, the routine traffic (branches, tags, pushes, pull requests) |
| `aws-guardrails/handler.ts` | AWS guardrail findings |
| `routes/auth.ts` | sign-ins |

### Reading it back

The Activity tab asks the server for one page at a time, with every filter as
part of the query. It used to fetch the newest hundred rows once and do paging
and searching in the browser, which made the pager stop at page two whatever the
table held and made a search blind to anything older than those hundred rows.

Paging is by **cursor**, not page number: DynamoDB pages forward from where it
left off and cannot jump to page seven, so the controls are Newest, Previous and
Older, which is exactly what the store can do.

Free-text search has a **read budget of 3,000 rows per request**, because a
filter is applied after reading and a rare term would otherwise walk thirteen
months in one request. Running out is reported as *unfinished*, with a cursor to
carry on from, rather than as "no results" — those are different answers, and
saying the second when you mean the first is how somebody concludes a change was
never recorded. Filtering by an exact repository name skips the budget entirely
by using `repo-index`.

Rows written under **detailed GitHub logging** carry `detailed: true`, so the
Activity page can hide or show them as a view choice. The toggle (Activity,
Organization tab, admins only) governs collection: turning it off stops new
detailed rows and deletes nothing already stored. Which kinds are collected
lives in `org-config` as `detailedLogging`.

### `alerts`

Security alerts, keyed by `id`. Created by `services/alertService.ts`, almost
always triggered from `webhooks/processDelivery.ts` — a repo made public, an
admin added, a team added or removed. **No expiry**, because an unresolved alert
shouldn't quietly disappear; rows go when somebody resolves them.

### The two that exist only to stop things happening twice

| Table | Key | Holds |
| --- | --- | --- |
| `auth-codes` | `code` | sign-in codes (5 min), the sign-in state token (10 min) |
| `webhook-deliveries` | `deliveryId` | "already handled that one" (10–15 min) |

GitHub does re-send the same webhook, so `webhook-deliveries` is what stops one
event being processed twice.

---

## Where the tables come from

Eleven are created by **`scripts/setup-aws-account.sh`**. Only
`webhook-deliveries` is created by the CDK stack.

That split matters. When the AWS-only setup script tried to write the table
definitions itself instead of delegating, three came out wrong — including
`auth-codes`, which got labelled by the wrong field and broke sign-in entirely.

**A wrong key doesn't produce an error.** It produces a filing cabinet where
nothing is ever found. That's why `setup-aws-only.sh` now hands table creation to
`setup-aws-account.sh` rather than repeating the definitions.

---

## One that used to be here

`compliance-cache` held a compliance score per repository. The scoring ran on
every graph rebuild and on webhooks, costing roughly seven to ten GitHub requests
per repository — often more than the graph rebuild itself — and **no screen in
the app ever displayed it.** The route and the frontend hooks existed; nothing
imported them.

It was removed, along with the sweeps that filled it. If your account still has
the table, nothing reads or writes it and you can delete it:

```bash
aws dynamodb delete-table --table-name "${STACK_NAME:-github-control-hub}-compliance-cache"
```

---

For how each *feature* uses these tables — the triggers, the staleness, what a
screen is actually showing you — see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).
