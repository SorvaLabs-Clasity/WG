# Renovate pull requests

Lives on the **Vulnerabilities** tab, under the Dependabot alerts. Dependabot
says what is vulnerable; Renovate says what has been raised to fix it.

## How the PRs are found

There is no Renovate API to ask. Self-hosted Renovate raises pull requests as a
**GitHub App**, and that authorship is the only marker — so the account name is
configuration, set by an admin on the tab itself:

```
is:pr org:<org> author:<bot> is:open
is:pr org:<org> author:<bot> is:closed closed:>=<three months ago>
```

Two bounded queries rather than a walk over every repository. Unset, the tab
says so instead of showing an empty table that reads like a failure.

**An App's login carries a `[bot]` suffix that the GitHub UI never shows.** Next
to a pull request you see the App's display name with a separate "Bot" label, so
the obvious thing to type is the thing search rejects — verified against live
GitHub, where `author:renovate[bot]` returns results and `author:renovate`
answers 422. Both forms are tried, App form first, and the login that actually
matched is shown back.

**GitHub answers `author:` for an account it cannot find with 422, not with an
empty result.** So an unrecognised name is reported as its own state, naming
both forms that were tried, rather than surfacing as a 500 that reads as the
feature being broken.

## Changing the bot account

The name is stored in org config, not in code or in an environment variable, and
an admin can change it at any time from the panel — the **change** link beside
the account name, or the editor shown when the account is not recognized.

Changing it only changes which pull requests this app looks for and emails
about. Nothing on GitHub is touched, and no history is lost: the list is a live
search, so it re-runs against the new name immediately.

It was settable exactly once. The input rendered only in the unconfigured state,
so after a rename — or a typo — the panel said the account was unrecognized and
offered nothing to correct it with.

## Retention

Open pull requests are always shown, however old. Closed ones drop off three
months after they close.

That is the `closed:>=` bound above rather than a stored expiry — nothing is
written down, so nothing can drift from GitHub. The bound is on **when it
closed**, not when it was last touched; filtering on `updated:` would keep a
PR alive because somebody commented on it.

## Cost

Search is metered in its own bucket — 30 requests a minute — separate from the
core limit the Dependabot sweep and graph sync compete for. A refresh costs
about three requests, so this cannot slow down anything else in the app.

Volume scales with pull request count, not repository count: one more request
per refresh for every additional hundred open PRs. GitHub stops paging search
at 1,000 results, and hitting that is reported rather than shown as a total.

## It cannot merge

By design, and asserted. Every row links out to GitHub; merging happens there,
where GitHub authorizes the person doing it against the repository.

There is no merge route on the backend, and `repro-renovate.ts` fails if any
code anywhere gains the ability to merge a pull request — a button somebody
could add later is a button somebody could add later.

## Widget and alarm

**Open Renovate PRs** is a preset widget, and carries a `renovatePrs.open`
alarm condition: *open Renovate PRs at or above N*. It inherits everything the
alarm machinery already does — firing on crossing rather than every cycle, two
clean checks before an all-clear, and the fifteen-minute cadence.

An unreachable bot account reads as **no value**, not zero. An alarm watching
for a pile-up must not resolve itself because the account name is wrong.

## Email on every new pull request

A toggle under the Renovate table, beside the same kind of control the Security
tab uses. On, it sends one email per pull request the configured bot opens.

Driven by the `pull_request` webhook rather than by the search above, so it
arrives within seconds and costs no GitHub requests. It fires only on `opened`.
Renovate rebases its branches constantly and each rebase is a `synchronize`
delivery, so reacting to those would send another email for the same pull
request every time it updated.

Only the bot's pull requests are emailed. The comparison tolerates the `[bot]`
suffix in either direction, because GitHub's deliveries carry the login as
`name[bot]` while the name shown on the pull request usually has no suffix — so
either form can be typed into the settings box.

An unconfigured bot name matches nothing at all rather than matching everything.
The alternative would email on every pull request anyone in the organization
opened.

## Grouping

Two ways to be told, chosen per feed:

| Setting | What arrives | Delay |
|---|---|---|
| **One email per repository** (default) | One message listing everything that arrived for that repository | Up to 5 minutes |
| **One email per pull request** | One message each | Seconds |

Per-repository exists because the common case is not one event arriving. It is
Dependabot being switched on for a repository and raising every alert it has at
once, or Renovate running against a repository for the first time. One email
each is a blast nobody reads, and a feed people filter is a feed that is off.

The webhook writes the event into a buffer instead of publishing, and the alarm
evaluator — which already ticks every five minutes — drains it, grouping by feed
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
sends nothing — those rows are cleared rather than left to be reconsidered on
every future tick.
