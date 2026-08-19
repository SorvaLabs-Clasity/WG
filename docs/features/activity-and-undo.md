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
| **App settings** | Widgets, scanners, imports, undo history, and every sync (`sync.*`) — housekeeping |
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

`ActivityAction` is declared twice — once in the backend service that writes the
rows, once in the frontend types that render them — with nothing linking them.
The same suite compares the two lists, because an action added to one side alone
produces rows the feed cannot label, and the frontend's label map is a total
record over its own union, so the gap shows as an unlabelled badge rather than a
build error.

## Syncs and refreshes

The feed answered *what changed* and could not answer *when did we last look*.
Those are different questions, and the second one is behind most reports of a
page showing zero or stale data: nothing recorded that a collection run had
happened, so "the graph is empty" and "nobody has synced since Tuesday" were the
same observation.

Every refresh now writes a row naming who asked, what came back, and how long it
took:

| Action | Written by |
|---|---|
| `sync.graph` | The access graph walk — six-hourly, and **Sync from GitHub** |
| `sync.compliance` | Compliance scores, all repositories or one |
| `sync.query` | A security check's coverage being re-run |
| `sync.access` | The access map recomputed from stored edges |
| `sync.scanner` | A scanner run |
| `sync.reminders` | A stale-pull-request reminder pass |
| `sync.alarms` | An alarm evaluation that fired, recovered or failed |

A failed run is marked failed and keeps its reason, because a row that reads like
success over a failed sync is worse than no row. Logging never throws: a run that
collected everything and then failed to write its log line has still collected
everything, and losing the result to report the bookkeeping would be the wrong
trade.

**The frequent jobs are logged only when they did something.** The alarm
evaluator runs every five minutes and the great majority of ticks evaluate
nothing, because each alarm carries its own interval — recording those would add
a hundred thousand rows a year saying "nothing was due", and an audit trail
nobody can read is not one. The reminder pass is gated the same way. Full
per-tick detail still goes to CloudWatch, where volume is free and nobody is
reading a history.

The six-hourly graph sync is **not** gated: four rows a day is history rather
than noise, and it is the run people ask about. The guardrail sweep keeps its own
arrangement, writing a row per finding rather than per sweep, which is the same
principle — outcomes, not ticks.

The `sync.access` row is worth reading carefully if you are chasing a change that
is not showing. It says *no GitHub read* because that refresh recomputes from
already-collected data and cannot pick up anything new; `sync.graph` is the one
that goes to GitHub.

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
