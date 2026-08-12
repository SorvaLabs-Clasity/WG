# How GitHub is called

Every GitHub interaction goes through **Octokit**, GitHub's official JavaScript
SDK, against the REST API. Fourteen backend files import it; roughly forty
distinct endpoints are in use.

## Octokit is not the API

They are often said in the same breath, which makes them sound like
alternatives. They are two different layers.

**The GitHub API** is the thing that exists on GitHub's servers: a set of HTTPS
URLs that accept and return JSON. It is language-agnostic. `curl` can call it.

**Octokit** is a client library that runs in *this* codebase and makes those
HTTP calls for you. It is GitHub's own, so it stays in step with the API, but
it has no authority of its own — it is a convenience over the same requests.

The same operation, both ways:

```bash
# The API, directly
curl -X PUT https://api.github.com/repos/acme/api/branches/main/protection \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"required_status_checks":null,"enforce_admins":true,...}'
```

```ts
// The same call, through Octokit
await octokit.rest.repos.updateBranchProtection({
  owner: "acme", repo: "api", branch: "main", enforce_admins: true, ...
});
```

Identical HTTP request on the wire. What differs is everything around it:
whether a typo is caught at compile time, who assembles the auth header, what
happens on page two of the results, and what a 403 looks like when it arrives.

Removing Octokit would not remove a dependency on GitHub — it would mean
writing the parts below by hand.

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
debug, and that fail in ways nobody notices until a page is quietly missing its
second hundred results.

## Read next

- [Rate limits](rate-limits.md)
- [Webhooks](webhooks.md)
