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
