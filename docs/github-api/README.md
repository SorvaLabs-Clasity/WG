# How GitHub is called

Every GitHub interaction goes through **Octokit**, GitHub's official JavaScript
SDK, against the REST API. Fourteen backend files import it; roughly forty
distinct endpoints are in use.

```ts
const octokit = createOctokit(token);
await octokit.rest.repos.updateBranchProtection({ owner, repo, branch, ... });
```

## What Octokit gives us

**Typed endpoints.** `octokit.rest.repos.updateBranchProtection` is a real
function with a real parameter type. A misspelled field or a missing required
parameter is a compile error, not a 422 discovered by a user. Across ~40
endpoints and a codebase this size, that is the single biggest thing it buys.

**Authentication as a strategy, not a header.** The same client shape works with
a user OAuth token or a GitHub App installation token. `@octokit/auth-app`
handles JWT signing and installation-token exchange, which is fiddly to get
right by hand and easy to get subtly wrong.

**Pagination that terminates.** GitHub's `Link`-header pagination is easy to
implement almost correctly. Octokit's helpers handle the last page and the
empty page consistently.

**Retry and throttle plugins.** Configured explicitly in `createOctokit`:

```ts
retry:    { enabled: true, retries: 1 },
throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false }
```

One retry for transient failures. Both throttle handlers return `false`, which
means **do not silently wait and retry** — surface the rate limit so the UI can
show a countdown. See [rate limits](rate-limits.md) for why that choice matters.

**Error shape.** Failures arrive as objects with `.status`, so the code can
distinguish "404, this repo has no rulesets" from "403, you may not look" and
respond differently. Several handlers depend on that distinction.

## What we chose not to use

**GraphQL.** Fewer round trips for some queries, but a second API surface to
learn and a different rate-limit model (points, not requests). The REST calls
here are mostly bulk listings where the win would be small.

**Raw `fetch`.** Would mean writing pagination, auth refresh, retry and error
normalisation ourselves — four things that are boring to write and unpleasant to
debug.

## Why not Terraform

A fair question, and the answer is not "Terraform is worse". They do different
jobs.

| | This app | Terraform |
|---|---|---|
| Authority | Your token; GitHub decides | One service credential |
| Drift | Reports it, names who caused it | Corrects it on next apply |
| Reversal | Records an undo per action | Change the config, apply again |
| Partial adoption | Reads whatever is there | Needs every repo imported first |
| Audience | Someone clicking a button | Someone reading a plan diff |

Terraform is genuinely better at enforcing one standard everywhere and at
putting changes through review. This app is better at *observing* an estate
nobody has declared yet, and at letting a person act with their own
permissions and leave a trail. Most organizations sensibly run both.

## Read next

- [Rate limits](rate-limits.md)
- [Webhooks](webhooks.md)
