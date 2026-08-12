# Security checks

Runs named checks over the graph and lists what fails.

## The checks

| Check | Finds |
|---|---|
| `repos-without-protection` | No protected branch at all |
| `repos-with-unprotected-branch` | A named branch is unprotected |
| `repos-missing-branch` | A required branch does not exist |
| `repos-with-branch-rules` | Repos whose branch carries rules |
| `stale-branch-protections` | Protection defined on a branch that is gone |
| `protection-bypasses-ranking` | Who can bypass protection |
| `public-repos` | Public and internal repositories |
| `archived-repos-with-access` | Archived, yet someone still holds access |
| `stale-repos` | No push in N months |
| `unowned-repos` | No owning team |
| `repos-with-outside-admins` | Admins outside the owning team |
| `highly-privileged-users` | Admin across many repositories |
| `dormant-privileged-users` | Privileged and inactive |
| `empty-teams` | Teams with no members |
| `repos-dependent-on` | Repos using a given dependency |

## Two things it is careful about

**Missing data is not a clean result.** Each check declares the edge type it
reads. If the graph has never collected it, the check refuses with "press Sync
data" rather than returning an empty list that looks like success.

**Archived repositories are excluded from staleness.** An archived repository
has not been pushed to *by design*; reporting it as stale is noise. It gets its
own check instead — archived but still reachable — which is the interesting
question.

## What was removed, and why

An inactive-users check and an Enterprise audit-log integration were taken out.
Both produced answers the underlying data could not support: activity on private
repositories was invisible to the check, and the audit log API was not available
on this plan. A check that is confidently wrong is worse than no check.
