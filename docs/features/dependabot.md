# Dependabot

Known vulnerabilities in dependencies, and which repositories are watching for
them.

## The distinction the page is built around

Two very different states look identical if you only count alerts:

- a repository with Dependabot **on** and no alerts — genuinely clean
- a repository with Dependabot **off** — nothing is known either way

The header refuses to call the second one "all clear". With a handful of hundreds
scanned it reads *Mostly unscanned*, not *Nothing outstanding*, and says in
words how many are unwatched.

## What you can do here

- Turn Dependabot on or off per repository
- Filter by severity
- See which repositories share a vulnerable dependency

## Toggling

Enabling Dependabot on a repository refreshes **that repository**, not every one.
An earlier version invalidated every Dependabot query on each toggle, which
turned a few clicks into thousands of API calls.

The change is made with your token, so GitHub decides whether you may enable it.

## Where the alert data comes from

Graph aggregation collects `has_vulnerable_dependency` edges per repository from
GitHub's Dependabot alerts API. Repositories with Dependabot disabled return
nothing — correctly, and indistinguishably from "no vulnerabilities", which is
why the unwatched count is shown so prominently.

## No alerts is a legitimate answer

Unlike most checks, an empty result here is **not** treated as missing data. An
organization with no open advisories genuinely has none, and claiming otherwise
would be its own kind of wrong.


## Why the tab is cheap now

Listing which repositories have alerts switched on used to cost one REST call
per repository — 351 of them on a 355-repo organization, every time the tab was
opened, against the same rate-limit budget the graph sync and compliance sweep
draw on. Forty page loads in an hour would have exhausted it.

GraphQL carries the same flag 100 repositories at a time. Measured on the live
organization: **4 requests instead of 347**, and GraphQL is metered separately
from REST, so the cost moved off the shared budget rather than merely shrinking.

The flag was checked against the REST endpoint it replaced before the swap, in
both directions — on repositories with alerts on and off. A field that is
always false would agree with a mostly-off organization and still be wrong.

That same query returns the repository names, so the REST repository listing is
not called here either — four more pages fetching names GraphQL had already
handed over.

A full load of the tab is now **5 requests** (1 REST + 4 GraphQL), against
roughly 355 before.

If the query fails, repositories are listed **without** the on/off marker
rather than falling back to hundreds of calls. A page missing one column beats
a slow page, and the fallback is the thing being removed.
