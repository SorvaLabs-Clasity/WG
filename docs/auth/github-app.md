# The GitHub App

A GitHub App installed on the organization, used for reads and for anything
that has to happen without a person present.

## What it is used for

- Listing repositories, teams, members, branches (hundreds of calls per sync)
- The webhook receiver's own actions on EC2, where no user is signed in
- Auto-applying templates to newly created repositories

## Why not use the user's token for reads

A user OAuth token has **5,000 requests/hour, per user**. One graph sync across
350 repositories costs roughly 1,500 calls. Two syncs and a person is locked out
of GitHub — not just this app.

The App's installation token has **12,500/hour shared across the whole
installation**, which is the right budget for bulk reads. See
[rate limits](../github-api/rate-limits.md).

## Token lifecycle

Installation tokens last an hour. `GitHubTokenManager` refreshes them five
minutes before expiry, deduplicates concurrent refreshes behind a single
promise, and re-arms a timer. Callers ask for a token and get a valid one; they
never see the refresh.

The private key is read from Secrets Manager. Secrets Manager's key/value editor
strips newlines out of PEM blocks, so the key is normalised on read — a
single-line PEM is reconstructed rather than rejected.

## The trade being made

Reads through the App token show **everything in the organization**, regardless
of what the signed-in person can see. For a security dashboard inside one org
that is the point: you are reporting on the estate, not browsing your own
corner of it.

It is also precisely why writes do **not** work this way. See
[GitHub OAuth](github-oauth.md).
