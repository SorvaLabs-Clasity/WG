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

## What it is careful about

**Missing data is not a clean result.** Each check declares the edge type it
reads. If the graph has never collected it, the check refuses with "press Sync
data" rather than returning an empty list that looks like success.

**Archived repositories are excluded from staleness.** An archived repository
has not been pushed to *by design*; reporting it as stale is noise. It gets its
own check instead — archived but still reachable — which is the interesting
question.

**A partial read is refused, not returned.** Three checks call GitHub per
subject: `dormant-privileged-users` runs one commit search per privileged
account, and `stale-branch-protections` and `protection-bypasses-ranking` read
protection and merged pull requests per repository. Each of those calls used to
be wrapped in an empty `catch`, and because a finding is only recorded on a
particular answer, a dropped error removed that subject from the result — so the
check reported *fewer* findings than existed, with no error and no warning. A
smaller number on a security check reads as an improvement, which makes it the
worst possible way to fail.

They now collect what they could not read and refuse the whole answer, naming
how much was covered. The alarm evaluator already handles no reading correctly
— it leaves the alarm's state alone rather than resolving it — so refusing is
also what stops a rate limit from mailing out an all-clear.

A **404 is still an answer.** Asking for branch protection on a branch that has
none returns 404, and that means unprotected. Only that one status is treated as
absence; a 403 or a 502 means the question went unanswered. Keeping those apart
is what makes it possible to ignore the harmless case without ignoring the other.

## What it costs

`dormant-privileged-users` is the one worth knowing about. Membership and roles
come from the cached graph at no API cost; the commits question is **one commit
search per privileged account** — not per repository, so an account with 355
repositories costs the same as one with two. Only accounts privileged on two or
more repositories are asked about at all.

That draws on **search**, which is 30 requests a *minute* — a different and much
smaller budget than the 15,000 an hour everything else uses. The check is
therefore affordable up to roughly thirty privileged accounts per evaluation and
not beyond, which is why exceeding it now refuses rather than under-reports.

### Covered a batch at a time

Three checks cost a request per subject — one commit search per privileged
account for `dormant-privileged-users`, and protection plus merged pull requests
per repository for the two protection checks. That is affordable for two
subjects and impossible for three hundred, so neither running everything nor
capping the list works:

| Approach | What it does on a large org |
|---|---|
| Run everything each pass | Hits the limit partway and returns a short list |
| `.slice(0, 20)` | Looks at twenty and says nothing about the rest |
| **Cache per subject** | Covers everyone a batch at a time, and says when it has |

Each subject's verdict is stored on its own with the time it was taken. A pass
refreshes a batch — never-checked first, then oldest-first — and the answer is
assembled from everything on file.

The batch is sized to the budget the check draws on, not to one number for all
three:

| Check | Budget | Per pass |
|---|---|---|
| Dormant Privileged Access | search — 30 a **minute** | 25 |
| Stale Branch Protection | core — 15,000 an **hour** | 50 |
| Protection Rule Bypasses | core | 50 |

Twenty-five exists only because of commit search. Holding the protection checks
to it would have made an organization with thirty protected repositories wait an
extra pass for an answer the old capped version returned at once — a regression
for the middle-sized case, introduced while fixing the large one.

**Anything at or under one batch is complete on the first pass**, with no
building phase at all. That is most organizations: the subject count is
privileged accounts, or repositories with a protected branch, not headcount or
repository count.

**Nothing is reported until coverage is complete.** While it builds, the check
says so and how far along it is, rather than returning the findings it happens
to have. Both the protection checks' caps are gone: they now take every
protected repository as their subject list.

"Checked and clean" is stored as a verdict, not left out. Otherwise a clean
subject would be indistinguishable from one never reached and coverage could
never complete.

A verdict counts for **24 hours**, enforced when it is read rather than trusted
to the table's own expiry — DynamoDB deletes on its own schedule, often days
after the stamp passes, and a row still sitting there is not the same as an
answer still worth having.

## What was removed, and why

An inactive-users check and an Enterprise audit-log integration were taken out.
Both produced answers the underlying data could not support: activity on private
repositories was invisible to the check, and the audit log API was not available
on this plan. A check that is confidently wrong is worse than no check.
