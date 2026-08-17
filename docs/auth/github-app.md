# The GitHub App

A GitHub App installed on the organization, used for reads and for anything
that has to happen without a person present.

## What it is used for

- Listing repositories, teams, members, branches (hundreds of calls per sync)
- The webhook worker's own actions, processing a delivery where no user is
  signed in

## Why not use the user's token for reads

A user OAuth token has **5,000 requests/hour, per user**. One graph sync across
500 repositories costs roughly 1,500 calls. Two syncs and a person is locked out
of GitHub — not just this app.

The App's installation token has **12,500/hour shared across the whole
installation**, which is the right budget for bulk reads. See
[rate limits](../github-api/rate-limits.md).

## No fallback

The installation token is the only GitHub credential the app holds. A
`SYSTEM_GITHUB_TOKEN` personal access token used to stand behind it and has been
removed — it was broader than the App, belonged to a person rather than the
installation, and made an App outage survivable enough that nobody noticed one.

If the App stops working, GitHub answers 401 and the app says so. That is the
intended behaviour: it is a thing to fix, not to route around.

## Token lifecycle

Installation tokens last an hour. `GitHubTokenManager` refreshes them five
minutes before expiry, deduplicates concurrent refreshes behind a single
promise, and re-arms a timer. Callers ask for a token and get a valid one; they
never see the refresh.

The private key is read from Secrets Manager. Secrets Manager's key/value editor
strips newlines out of PEM blocks, so the key is normalized on read — a
single-line PEM is reconstructed rather than rejected.

## The trade being made

Reads through the App token show **everything in the organization**, regardless
of what the signed-in person can see. For a security dashboard inside one org
that is the point: you are reporting on the estate, not browsing your own
corner of it.

It is also precisely why writes do **not** work this way. See
[GitHub OAuth](github-oauth.md).
