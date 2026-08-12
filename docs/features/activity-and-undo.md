# Activity and undo

Everything that changed, who changed it, and — where it is safe — a way back.

## Two sources

| Source | Comes from |
|---|---|
| `app` | Something done through this app |
| `github` | A [webhook](../github-api/webhooks.md) — someone acting in GitHub directly |

The second is the half that makes it an audit trail rather than a command log.

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
finds a complete record. See [retention](../data/retention.md).

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
