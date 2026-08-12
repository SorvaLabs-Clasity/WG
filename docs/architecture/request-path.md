# Request path

One click, traced end to end. Example: enabling Dependabot on a repository.

```
1. Browser (Electron window)
   POST http://localhost:4321/api/security/dependabot/:repo
   Authorization: Bearer <app JWT>

2. authMiddleware
   Verifies the JWT, attaches req.user = { login, accessToken }

3. Route handler (routes/dependencies.ts)
   Builds an Octokit client with req.user.accessToken — YOUR token

4. GitHub
   Accepts or refuses based on YOUR permissions on that repository

5. activityService.logActivity(...)
   Writes a row to DynamoDB with an undo payload

6. Response → the UI updates that one repository's row
```

## The two things worth noticing

**Step 3 uses your token, not the app's.** The app never decides whether you
may write to a repository; GitHub does. See
[the permissions model](../auth/permissions-model.md).

**Step 5 records an undo payload**, not just a log line. What that payload is
allowed to do is a separate decision — see
[activity and undo](../features/activity-and-undo.md).

## Reads are different

Most read paths use the **system token** from the GitHub App rather than
yours — listing hundreds of repositories with every user's token would burn through
per-user rate limits immediately. The system token has a shared 12,500/hour
budget. See [rate limits](../github-api/rate-limits.md).

The consequence is worth stating plainly: **reads show you everything in the
org, whether or not you personally can see it.** That is a deliberate choice
for a reporting tool inside one organization, and it is why writes work the
opposite way.
