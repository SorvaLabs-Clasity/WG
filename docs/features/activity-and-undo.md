# Activity and undo

Everything that changed, who changed it, and — where it is safe — a way back.

## Four streams

One list held a widget being renamed beside branch protection being removed.
Those are not the same kind of event and nobody reads them for the same reason,
so the page is split by what changed:

| Stream | Holds |
|---|---|
| **Organization** | Branches, protection, rulesets, repositories, Dependabot — anything that changed GitHub |
| **AWS** | The guardrail engine's findings and remediations (`aws.guardrail`) |
| **App settings** | Widgets, scanners, imports, and undo history — housekeeping |
| **Audit log** | The [enterprise audit log](audit-log.md), streamed from GitHub |

A fifth tab, **Everything**, sits first and merges all four. It is for when you
know roughly when something happened but not which stream recorded it — a
repository going public appears in Organization *and* again in the audit log,
and checking one stream at a time is how you miss it. Rows there carry a badge
naming their stream, and clicking the badge narrows to it.

It opens on Organization rather than Everything, so the security-relevant feed
is what you land on and dashboard housekeeping is one click away rather than
mixed in.

**What decides the stream is what the action changed, not where it came from.**
That is the part that reads as arbitrary until it is said out loud: removing
branch protection is an Organization row whether somebody did it here or on
github.com, because the same thing changed either way. Where it came from is the
*source*, below, and the two are independent.

Classification lives in `frontend/src/lib/activityCategories.ts` as data rather
than a switch, and `repro-activitycategories.ts` asserts every action the
backend can write lands somewhere deliberate. An unrecognized action falls back
to Organization on purpose: hiding something new in a tab nobody watches is the
failure worth avoiding.

## Two sources

Independently of the stream, every row records where it came from:

| Source | Comes from |
|---|---|
| `app` | Something done through this app |
| `github` | A [webhook](../github-api/webhooks.md) — someone acting in GitHub directly |
| `audit` | The enterprise audit log |

The second is the half that makes it an audit trail rather than a command log.

Only the Organization stream is written from more than one direction, so it is
the only one where filtering by source can change what you see. The filter is
therefore offered there and in Everything, and hidden in the other three — it
used to appear in all four while listing only `app` and `github`, which meant
that in the audit stream, where every row is `audit`, either choice emptied the
table and nothing explained why.

## Structure

Rows are stored in one partition ordered by timestamp, so the feed is a single
query. Two sparse indexes support lookups that would otherwise scan:

- `id-index` — fetch one entry
- `parentId-index` — fetch an entry's children

Sparse matters: only rows that *have* a `parentId` appear in that index, so the
index stays small. The earlier version applied a `Limit` before a filter, which
silently returned nothing once the feed grew past the limit.

## Retention

Thirteen months, via a DynamoDB TTL stamped from each row's own timestamp — a
year of history plus a month of slack, so an auditor looking back twelve months
finds a complete record.

**The same for all four streams**, because they are rows in one table and the
TTL is stamped as each row is written. There is no per-stream setting.
`ACTIVITY_RETENTION_MONTHS` changes it for everything at once, and only for rows
written after the change: TTL is a stored attribute, so existing rows keep the
expiry they were given.

Two things nearby expire on their own schedule and are not this:

- the raw audit-log objects in S3, which a lifecycle rule expires after 400 days
  — the archive outlives the indexed rows on purpose
- closed Renovate pull requests, which are not stored at all; they are filtered
  out of a live search three months after closing

See [retention](../data/retention.md).

## Undo

Each action records a payload describing how to reverse it. Undo is not a
generic inverse:

- **Re-checked at the time you press it**, per repository, against what you can
  do *now*
- **Refused where no honest reversal exists.** AWS guardrail actions record a
  payload but are not in the allowed set — the app will not pretend to reverse
  something it cannot verify
- **Reads live state first.** Undoing a branch operation asks GitHub for the
  branch's current state, so commits and merges made since are respected rather
  than clobbered

An undo is itself an activity row, so undoing is as visible as doing.

## Webhook pulse

The top of the page shows how long since GitHub last told the app anything. See
[webhooks](../github-api/webhooks.md#health).
