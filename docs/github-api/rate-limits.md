# Rate limits

Two budgets, and they behave very differently.

| Credential | Budget | Scope |
|---|---|---|
| User OAuth token | 5,000 / hour | per person |
| App installation token | 12,500 / hour | shared across the installation |

## Why that split drives the design

Reads use the App token because bulk work is expensive. A full graph sync across
500 repositories costs roughly 1,500 requests — repos, branches, collaborators,
workflows, Dependabot alerts. Run that on a user's own budget and two syncs lock
that person out of GitHub entirely, not just out of this app.

Writes use the user's token because there are few of them and because
[GitHub must be the one to authorize them](../auth/github-oauth.md).

## Rough costs

| Action | Requests |
|---|---|
| Loading a page | single digits |
| Opening one repository | ~5 |
| Full graph sync (500 repos) | ~1,500 |
| Enabling Dependabot on one repo | 1–2 |

Fifteen admins using the app normally do not come close to 12,500/hour. A few
people syncing repeatedly might.

## What happens when a limit is hit

The throttle plugin is deliberately configured **not** to wait and retry:

```ts
onRateLimit: () => false
onSecondaryRateLimit: () => false
```

Silently sleeping would turn a rate limit into "the app is mysteriously slow".
Instead the error surfaces, the backend responds `429` with the reset time, and
the UI shows a banner counting down to the minute the budget returns.

Secondary rate limits — GitHub's protection against bursts of writes — are
reported separately, because the advice differs: primary means wait, secondary
means slow down.

## The refresh storm that isn't

Toggling Dependabot on a repository used to invalidate every Dependabot query,
re-fetching every repository in the organization. Debouncing bounded a burst but not a slow
sequence of clicks. It now refreshes just the repository that changed.
