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
