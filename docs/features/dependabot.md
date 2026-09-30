# Dependabot

Known vulnerabilities in dependencies, and which repositories are watching for
them.

## The distinction the page is built around

Two very different states look identical if you only count alerts:

- a repository with Dependabot **on** and no alerts, genuinely clean
- a repository with Dependabot **off**. Nothing is known either way

The header refuses to call the second one "all clear". With a handful of hundreds
scanned it reads *Mostly unscanned*, not *Nothing outstanding*, and says in
words how many are unwatched.

## What you can do here

- Turn Dependabot on or off per repository
- Hold security fixes back and release them once a month
- Filter by severity
- See which repositories share a vulnerable dependency

## Toggling

Enabling Dependabot on a repository refreshes **that repository**, not every one.
An earlier version invalidated every Dependabot query on each toggle, which
turned a few clicks into thousands of API calls.

The change is made with your token, so GitHub decides whether you may enable it.

## Monthly security fixes

In **Manage**, under *Monthly security fixes*. Tick repositories and put them in
the monthly batch.

GitHub raises a security-fix pull request as soon as an alert appears, and the
`schedule` in `dependabot.yml` does not change that: it governs version updates
only. So the batch works by holding the switch:

- Adding a repository switches its security fixes **off** now, so nothing arrives
  mid-month.
- On the 1st (New York time) the monthly job in AWS switches them **on** for 24
  hours, which is when GitHub raises the month's pull requests, then **off**
  again.
- **Run now** opens that window immediately, without using up the 1st's own.
- Taking a repository out, or **Turn monthly off**, switches its fixes back
  **on**. A repository that could not be switched back on stays in the batch, so
  the next window releases it.

The trade-off: a new vulnerability can wait up to a month for its fix.

GitHub does not document that switching fixes on makes it raise pull requests for
existing alerts. The same caveat applies to **Re-trigger**. Try the batch with
one repository and **Run now** first, and check the pull request appears.

**Permissions.** Changes on the tab are made with your own token, like the other
switches here. The monthly job runs as the GitHub App, which needs
**Administration: write** ([setup](../operations/setup.md#2-a-github-app)). If
the App lacks it, the job's results say so, and the tab lists which repositories
missed their fixes. Reading the schedule needs `deps.dependabot.read`, and
changing it needs `deps.dependabot.bulk`.

## Where the alert data comes from

Graph aggregation collects `has_vulnerable_dependency` edges per repository from
GitHub's Dependabot alerts API. Repositories with Dependabot disabled return
nothing, correctly, and indistinguishably from "no vulnerabilities", which is
why the unwatched count is shown so prominently.

## No alerts is a legitimate answer

Unlike most checks, an empty result here is **not** treated as missing data. An
organization with no open advisories genuinely has none, and claiming otherwise
would be its own kind of wrong.


## Why the tab is cheap now

Listing which repositories have alerts switched on used to cost one REST call
per repository, 351 of them on a 355-repo organization, every time the tab was
opened, against the same rate-limit budget the graph sync and compliance sweep
draw on. Forty page loads in an hour would have exhausted it.

GraphQL carries the same flag 100 repositories at a time. Measured on the live
organization: **4 requests instead of 347**, and GraphQL is metered separately
from REST, so the cost moved off the shared budget rather than merely shrinking.

The flag was checked against the REST endpoint it replaced before the swap, in
both directions, on repositories with alerts on and off. A field that is
always false would agree with a mostly-off organization and still be wrong.

That same query returns the repository names, so the REST repository listing is
not called here either, four more pages fetching names GraphQL had already
handed over.

A full load of the tab is now **5 requests** (1 REST + 4 GraphQL), against
roughly 355 before.

If the query fails, repositories are listed **without** the on/off marker
rather than falling back to hundreds of calls. A page missing one column beats
a slow page, and the fallback is the thing being removed.

## Email on every new alert

A toggle under the alert list, with a severity floor. On, it sends one email per
new alert at or above the severity chosen; the default floor is high, because
every new moderate alert on a large dependency tree is a lot of mail and a feed
people filter is a feed that is off.

Driven by the `dependabot_alert` webhook, so it arrives within seconds and costs
no GitHub requests. Only alerts raised from that point on, switching it on does
not send the backlog already in the table.

**It needs one setup step this app cannot do.** The organization webhook has to
send the `dependabot_alert` event: Organization → Settings → Webhooks → the
Control Hub webhook → Edit → "Let me select individual events" → tick
**Dependabot alerts**. Until it is ticked the toggle can be switched on and
nothing will ever arrive, because GitHub never sends the event and there is no
error to report.

It is the organization webhook, not the GitHub App's own event list. The App
subscribes to nothing, every delivery comes from that webhook, so an empty
`events` list on the App is expected. The panel says where to go, and
[setup.md](../operations/setup.md) lists the full event set.

GitHub calls the middle severity "moderate" and this app calls it "medium". The
translation happens once, where the webhook is read, so a floor of medium
catches GitHub's moderate alerts rather than silently dropping them.

## Grouping

Two ways to be told, chosen per feed:

| Setting | What arrives | Delay |
|---|---|---|
| **One email per repository** (default) | One message listing everything that arrived for that repository | Up to 5 minutes |
| **One email per alert** | One message each | Seconds |

Per-repository exists because the common case is not one event arriving. It is
Dependabot being switched on for a repository and raising every alert it has at
once, or Renovate running against a repository for the first time. One email
each is a blast nobody reads, and a feed people filter is a feed that is off.

The webhook writes the event into a buffer instead of publishing, and the alarm
evaluator, which already ticks every five minutes, drains it, grouping by feed
and repository. Buffered rows are marked sent rather than deleted and expire on
their own after 24 hours.

A group whose publish fails is left unmarked, so the next tick retries it. That
risks a repeated digest if SNS accepted the message and the failure came later,
which is the right way round: a repeat is noticed and ignored, a silent loss is
not noticed at all.

The digest keeps your templates. The subject counts the items and names the
repository; the body lists them worst-severity first, so a critical is not
buried at position fourteen, and your rendered single-item body follows. A
buffer holding one item is sent exactly as the template rendered it, not as a
digest of one.

Turning a feed off, or switching it back to per-event, while events are buffered
sends nothing. Those rows are cleared rather than left to be reconsidered on
every future tick.
