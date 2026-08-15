# Permissions — design

**Date:** 2026-08-10

## The problem

Access control did not exist. The only gate was at login (`routes/auth.ts:534`):
is the user a member of the org? Past that, every authenticated member could do
everything.

Worse, write routes ran as `getSystemToken() || req.user.accessToken`. With the
App token present, writes executed with org-admin privilege regardless of who
asked — so a member with read-only access to one repository could strip branch
protection from every repository.

## The rule

**The app must not let anyone do something they could not do themselves on
github.com.**

## How it is enforced

Not by checking permissions, but by **acting as the user**. Repo writes are made
with the signed-in user's own OAuth token, so GitHub applies exactly the
permissions it would apply had they used github.com directly.

This is deliberate. A permission model of our own would be a second source of
truth: it could be wrong, it would drift as people change teams, and it would
need its own tests and audits. Delegating to GitHub cannot drift, because it is
not a copy — it is the same authority.

The OAuth app already requests `scope: "repo read:org"` (`github/oauth.ts:20`),
and an OAuth scope never grants permission the user lacks. `repo` means "act on
repos you can reach, at your existing level."

### Three identities

| Action | Runs as | Why |
|---|---|---|
| User-initiated repo writes — apply template, edit/delete protection, create branch, toggle Dependabot | the user's token | GitHub authorizes natively |
| System-initiated writes — auto-apply on repo creation, scheduled scans | App token | No user exists behind a webhook |
| Reads — dashboards, compliance, knowledge center | App token | Full org visibility, and the 12,500/hr limit |

Reads are deliberately unrestricted: anyone who can sign in can see the whole
org. This is an internal transparency tool.

### The one thing GitHub cannot answer

Auto-apply on new repositories is not a GitHub action, so there is nothing to
ask GitHub about — and it is the highest-stakes setting in the app, because
turning it on changes every repository created from that moment.

It is therefore gated on membership of a GitHub team, `control-hub-admins`
(override with `CONTROL_HUB_ADMIN_TEAM`). Org owners always qualify, so a
deleted or empty team cannot lock everyone out of their own settings.

Membership is read with the App token, not the caller's: a user cannot
necessarily see a team they do not belong to, and "cannot see it" would
otherwise be indistinguishable from "is not in it". Answers are cached per user
for 60 seconds.

The gate fires only on an actual *change* to the flag. The edit form
round-trips the whole template, so a non-admin editing an unrelated field
resends the existing value, and that must keep working.

## Errors

GitHub answers 403, or 404 when the user cannot see the resource at all —
distinguishing them would leak whether a private repo exists, so both map to
one message naming the user, the action and the repo.

When every target of a bulk apply is refused, the response is 403 rather than a
partial success, so the UI can say plainly that nothing happened.

## UI

`GET /auth/permissions` reports `isControlHubAdmin` only. Per-repo permissions
are deliberately not mirrored to the client: those are decided by GitHub at
call time, and a mirrored copy would be a second source of truth that could
disagree.

The auto-apply toggle is disabled, with a lock icon and a note naming the team.

## Known consequences

- Bulk apply now runs on the user's token: 5,000 req/hr rather than the App's
  12,500. Applying one template across hundreds of repos in a single action may
  hit that ceiling where previously it did not.
- Members who could previously change any repo will start seeing 403s. That is
  the point, but it is a visible behavior change.

## Testing

`repro-authz.ts` covers: plain member denied; team member allowed; org owner
allowed even with no team; pending invite rejected; missing team denies rather
than throws; API failure fails closed; the org-check failing still allows the
team path; cache keyed per user.
