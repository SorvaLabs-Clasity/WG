# Widgets, one by one

Every card on the Overview tab, what it actually asks, where the answer comes
from, and how fresh it can be.

A widget is a saved row holding a check id and a title. It stores no data of its
own. There is **one dashboard shared by the organization**, which is why only
admins can add or remove cards.

For the machinery behind all of them — the 5-minute snapshot pass, the refresh
button, the storage — see [HOW-IT-WORKS.md](../HOW-IT-WORKS.md). This file is
about the checks themselves.

---

## How to read the tables below

**Reads** is the edge type in the access graph the check depends on. If the
graph has never collected that type, the check refuses with *"press Sync data"*
rather than returning an empty list that looks like a clean result.

**Freshness** is the worst case:

| | |
| --- | --- |
| **seconds** | a webhook patches the graph as it happens |
| **≤30 min** | the light refresh pass is the only thing that updates it |
| **≤6 hours** | only the full rebuild collects it |
| **live** | read from GitHub on each pass; no graph involved |

### What changed, and why it matters

Six checks used to sit at **≤6 hours** no matter how often the dashboard
recomputed them: `public-repos`, `archived-repos-with-access`, `stale-repos`,
`unowned-repos`, `empty-teams` and `repos-dependent-on`.

They read edge types **nothing but the full rebuild wrote**. So re-running them
every five minutes produced a byte-identical answer roughly seventy-one times out
of seventy-two — the check was fine, the data underneath it simply could not
change.

That was a gap rather than a decision. Every one of those facts arrives on a
webhook the worker was **already receiving and already acting on**: a repository
going public raised a *critical* security alert within seconds, while the widget
counting public repositories showed the old number for hours.

Two changes closed it:

**The worker now patches the graph** on those same deliveries — visibility,
archival, last push, team ownership, team membership, vulnerable dependencies.
Same events, no extra requests; it simply writes the edge as well as raising the
alert. Those six moved from *≤6 hours* to *seconds*.

**A light refresh pass runs every 30 minutes** as a backstop, because a webhook
can be missed, arrive out of order, or not be sent at all — and nothing else
would have corrected it before the next rebuild. It refreshes only the cheap
edges: repository metadata, which arrives free with the repository listing, and
team composition at two calls per team. Under a hundred requests, against an
allowance of fifteen thousand an hour.

The expensive walk — every repository's collaborators, branches, workflows and
alerts, four requests each — stays on six hours. Running *that* every half hour
is what this deliberately is not.

| | **Light** (30 min) | **Full** (6 hours) |
| --- | --- | --- |
| GitHub requests | ~85 | ~1,300 |
| Per repository | 0 extra | 4 |
| Edge types written | 5 | 14 |
| Clears the table | no | yes |
| Covers | repository facts, team composition | everything |

Both are the same Lambda, invoked with a different payload. The full comparison,
including which edge types each writes, is in
[HOW-IT-WORKS.md](../HOW-IT-WORKS.md).

---

# Preset widgets

Four cards that don't read the graph at all.

## Dependabot alerts

**Asks:** how many open Dependabot alerts each repository has, split by severity.

Read **organization-wide in a single API call**, not per repository. Rows carry
counts for critical, high, medium and low.

A repository with scanning switched off is stored as a *different thing* from one
with no alerts, so a repository nobody is scanning never looks clean.

**Freshness:** live, on every 5-minute pass.
**If it cannot read:** reports "could not be read" rather than zero. A degraded
sweep returning an empty list is indistinguishable from a clean organization,
and would let an alarm resolve itself because GitHub answered 403.

## Vulnerable repositories

**Asks:** which repositories have an alert at or above chosen severities.

Same source as above — adding this card alongside the Dependabot one costs **no
extra requests**, because both read the same memoised sweep.

**Freshness:** live.

## Protection bypasses

**Asks:** who can bypass branch protection, ranked.

Runs the `protection-bypasses-ranking` check. Paced like the other
subject-by-subject checks: 50 repositories per pass.

**Freshness:** live, building coverage over several passes.

## Renovate open pull requests

**Asks:** how many update pull requests Renovate has open.

There is no Renovate API. Its pull requests are found by **the bot account's
authorship** — a live GitHub search for `is:pr org:<org> author:<bot>` — which
is why the bot's name is a setting.

**Freshness:** live.
**If no bot is configured:** reports that, rather than zero. An alarm must not
read "no open PRs" off an organization nobody told us how to look at.

---

# Access and ownership

## Repos without an owning team

**Asks:** which repositories have no team granted access at all.

Every person on such a repository is there by a **direct, individual grant**.
That matters because team-based access is revoked automatically when someone
changes teams or leaves; direct grants are not. These are also the repositories
with no obvious reviewer, no CODEOWNERS, and nobody to ask when an alert opens.

Flags a repository with **no `owned_by_team` edge at all**. A team with read-only
permission counts as owned — this is a floor ("somebody claims this"), not a
judgement about whether the permission is right.

| | |
| --- | --- |
| Reads | `owned_by_team` |
| Freshness | **seconds** — `team` added/removed webhook, backed by the 30-minute pass |
| Parameter | none |

## Repos with admins outside the owning team

**Asks:** who holds admin on a repository without being in a team that owns it.

The combination that access reviews are meant to catch: the permission is real,
and the usual revocation path — changing teams — will never remove it.

| | |
| --- | --- |
| Reads | `has_collaborator`, `owned_by_team` |
| Freshness | **seconds** — `member` webhook |

## Highly privileged users

**Asks:** which people hold write or admin on more than N repositories.

Blast radius, per person. Not wrong on its own — a platform engineer legitimately
has broad access — but it is the list to check against your leavers.

| | |
| --- | --- |
| Reads | `collaborates_on` |
| Parameter | minimum repository count, default **5** |
| Freshness | **seconds** — `member` webhook |

## Dormant privileged access

**Asks:** who holds admin or maintain on 2+ repositories and has committed
nothing to the organization in six months.

The single most expensive check in the app, and the one whose pacing is most
visible.

It finds candidates from the graph, then asks GitHub **one commit search per
person**. Commit search allows **30 requests a minute** — not the 15,000 an hour
everything else draws on — so answers are cached per person with the date they
were taken, and each pass refreshes the **25 least-recently-checked**. Coverage
builds over several passes.

Two rules make it trustworthy:

- **"Checked and active" is stored too**, not just findings. Otherwise a clean
  account is indistinguishable from one nobody has reached yet, and coverage
  could never complete.
- **A partial answer is refused.** If any candidate could not be read, the check
  reports incomplete rather than returning a smaller list. "Twenty of forty-five
  admins are dormant" is not a smaller finding, it is an unreliable one — and it
  would read as an improvement.

Organization owners are included deliberately: a dormant account with admin
everywhere is the most serious version of this, not one to leave out.

| | |
| --- | --- |
| Reads | `collaborates_on` + live commit search |
| Freshness | graph in seconds; the search verdict up to **48 hours** |

## Empty teams

**Asks:** which teams have no members.

Usually the residue of a reorganisation. An empty team that still owns
repositories is worse than no team: it looks like ownership and answers nothing.

| | |
| --- | --- |
| Reads | `has_member` |
| Freshness | **seconds** — `membership` webhook (must be subscribed on the App) |

---

# Repository state

## Public repositories

**Asks:** which repositories are public or internal.

Reports the two separately, because "internal" and "public" are different
exposures and conflating them makes the count useless.

| | |
| --- | --- |
| Reads | `repo_meta.visibility` |
| Freshness | **seconds** — `repository` publicized/privatized webhook |

## Archived repos people still have access to

**Asks:** which archived repositories still have collaborators.

Archiving retires the code; it does not remove anybody. Access outlives the
decision to stop using it.

| | |
| --- | --- |
| Reads | `repo_meta.archived`, `has_collaborator` |
| Freshness | **seconds** — `repository` archived webhook |

## Repos with no push in N months

**Asks:** which repositories have not been pushed to for N months.

Two deliberate exclusions:

- **Archived repositories are skipped.** Archiving *is* the act of retiring
  something, so reporting it here says only that somebody did what they meant to.
- **Repositories never pushed to are skipped.** Those are empty, not abandoned,
  and calling them stale is a different claim.

Rows carry an **Owner** column, answered in four tiers, in this order:

| | Shows | Labelled |
| --- | --- | --- |
| 1 | the **owning team** — all of them, if several | `team` |
| 2 | a person holding admin **directly** on that repository | `admin` |
| 3 | the GitHub account with the **most commits** | `top committer` |
| 4 | the **git author name** with the most commits, where that author has no GitHub account | `top committer · no account` |
| — | nothing found at all | *"No owner found"* |

**The order is the meaning.** A team answers "who is responsible" formally; a
direct admin answers it less formally; a committer is only a lead. Presenting a
lead as an assignment would be worse than saying nothing.

**Tier 4 exists because tier 3 is narrower than it looks.** A commit is only
attributed to a GitHub account when the author's email is registered to one.
Commits pushed by CI, by a bot, or from a laptop signing with an unregistered
address come back as *anonymous* contributors with a name and no login. In an
organization whose pushes come from automation that is every contributor there
is, and asking GitHub to exclude them returns an empty list — indistinguishable,
at the call site, from a repository nobody has ever touched. The name is still
the true answer to "who pushes here", so it is shown, and the `· no account`
label is what stops it being read as a GitHub user you could go and message. The
email that came with it is deliberately **not** stored: a column about who to ask
is not a place addresses should leak out of.

**Every answer carries its kind**, because a team slug and a username render
identically — without the label, "who owns this" gets a different answer
depending on which you assumed.

Tier 2 depends on `source`, which the rebuild records on every collaborator edge
as `direct`, `team` or `org_owner`. Only `direct` counts. Organization owners
hold admin on every repository, so counting them would name the same handful of
people on every unowned repository; and a team member with admin is a case where
the *team* is the answer.

Tiers 3 and 4 come from one request, made during the full rebuild and **only for
repositories no team owns** — an owned repository already has an answer, and
asking anyway would be one request per repository for a column that would not
show it. The request includes anonymous authors and the choice between the two
tiers is made locally, so covering tier 4 costs nothing extra. A newly unowned
repository shows tiers 1–2 immediately and gains 3–4 at the next rebuild.

| | |
| --- | --- |
| Reads | `repo_meta.pushedAt`, `owned_by_team`, `has_collaborator`, `top_contributor` |
| Parameter | months, default **6** |
| Freshness | **seconds** for the push time; owner in seconds; contributor **≤6 hours** |
| Requests | one `listContributors` per unowned repository, per full rebuild |

---

# Branch protection

## Repos with no protected branch at all

**Asks:** which repositories have no protected branch anywhere.

The blunt version of the protection question, and the one worth alarming on.

| | |
| --- | --- |
| Reads | `has_branch` |
| Freshness | **seconds** — branch and protection webhooks |

## Repos missing a specific branch

**Asks:** which repositories do not have a named branch. Accepts several.

For conventions — every repository should have `develop`, or a `release` branch.

| | |
| --- | --- |
| Reads | `has_branch` |
| Parameter | branch name(s) |

## Repos with a named branch unprotected

**Asks:** which repositories have that branch, but without protection.

Different from the one above: this one is about a branch that **exists and is
exposed**, which is usually the more urgent finding.

| | |
| --- | --- |
| Reads | `has_branch` |
| Parameter | branch name(s) |

## Repos that have a specific branch

**Asks:** which repositories have the named branch. **Informational** — it makes
no claim that having it is right or wrong, so it is not a finding and does not
colour as one.

| | |
| --- | --- |
| Reads | `has_branch` |
| Parameter | branch name(s) |

## Repos matching specific branch rules

**Asks:** which repositories' branch protection matches a set of conditions —
required reviews, dismiss stale approvals, and so on.

The configurable one. Everything above is a fixed question; this is the one to
reach for when your policy is specific.

| | |
| --- | --- |
| Reads | `has_branch` |
| Parameter | branch name(s), plus rule conditions |

## Stale branch protection

**Asks:** which repositories have protection defined on a branch that **no longer
exists**.

Protection on a deleted branch protects nothing while looking exactly like
protection that works. Paced like the other subject-by-subject checks — 50
repositories per pass on the ordinary rate limit, not the search one.

| | |
| --- | --- |
| Reads | `has_branch` + live repository reads |
| Freshness | graph in seconds; verdicts up to **48 hours** |

---

# Dependencies

## Repos exposed through a vulnerable package

**Asks:** which repositories depend on named package(s).

**Informational** — it reports exposure, not a policy breach. Written for the
morning an advisory lands and the question is "where are we affected".

Accepts several packages, comma-separated.

| | |
| --- | --- |
| Reads | `has_vulnerable_dependency` |
| Parameter | package name(s) |
| Freshness | **seconds** — `dependabot_alert` webhook |

Unlike the other checks, an empty result here is a **legitimate answer** — an
organization with no open advisories genuinely has none — so this one does not
refuse when the edge type is absent.

---

## Two things that apply to all of them

**A failed read is never shown as an empty result.** Each check declares the
edge type it needs. If the graph has never collected it, the widget says so and
points at Sync data, rather than reporting zero.

**Every check is computed on the 5-minute pass and stored**, so the dashboard
opens from stored answers rather than running each one while you wait. The age
is shown under the headline, and **Refresh** re-runs them all live.
