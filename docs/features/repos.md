# Repos

The repository browser and the entry point for graph sync.

## What it shows

Every repository, with its compliance score, visibility, owning team and
protection state. Opening one shows branches, workflows, **people with access**,
rulesets and dependency alerts.

### Access is not authorship

**"People with access" answers who can reach the repository, not who has worked
on it.** The two lists sit in the same panel and are easy to confuse:

| Section | Answers | Source |
| --- | --- | --- |
| **People with access** | who *can* open it | `has_collaborator` edges — GitHub's collaborator list |
| **Top contributors** | who *has committed* | commit counts, from the repository detail call |

They routinely disagree, and the usual reason is that **an organization owner
holds admin on every repository in the organization** whether or not they have
ever opened it. Someone who has never made a commit legitimately appears under
access; that is GitHub's answer, not a mistake in the data.

Each person therefore carries **how** they got in:

| Label | Meaning |
| --- | --- |
| `direct` | granted on this repository specifically |
| `via team` | inherited from a team that owns it |
| `org owner` | blanket admin from running the organization |

Blanket access sorts **last** whatever its role — an owner outranks everyone on
paper and tells you the least about this repository — and the **With access**
count on the tile row excludes it, so the number reflects people given access to
*this* repository rather than repeating the owner count on every one.

For "who actually knows this code", use the [Who knows](who-knows.md) tab, which
scores commits, review comments and issue comments and never reads access at
all.

## Syncing the graph

The graph rebuilds itself every six hours. **Sync from GitHub**, on the Access
tab, does it on demand for members of `control-hub-admins`, for when six hours is
too long to wait — usually right after somebody's access has changed.

Either way it walks the organization through the GitHub App token and writes
edges to DynamoDB:

| Edge | Records |
|---|---|
| `repo_meta` | visibility, archived, pushedAt, default branch, secret scanning |
| `has_branch` | branches and whether each is protected |
| `has_collaborator` / `collaborates_on` | who can reach it, at what level, and how they got it |
| `member_of` / `has_member` | team membership |
| `owns_repo` / `owned_by_team` | team → repository |
| `uses_workflow` | Actions workflows |
| `has_vulnerable_dependency` | open Dependabot alerts |
| `user_meta` | org members, their role, outside collaborators |
| `team_meta` | team names |
| `org_meta` | default repository permission, member count |

Roughly 1,500 API calls for 500 repositories. It **is** scheduled — every six
hours, with a lighter pass every thirty minutes; the button is for when six
hours is too long to wait. See [the graph model](../data/graph-model.md) and
[HOW-IT-WORKS](../HOW-IT-WORKS.md) for what each pass writes.

## Why sync is manual

An automatic rebuild every few hours would spend the shared rate-limit budget
whether or not anyone was looking, and the data it feeds is used for reporting
rather than enforcement. Making it a button also makes staleness visible: the
pages that read the graph say when it was last built.

## After adding a feature

New edge types do not exist in an old graph. Pages that need them say so and ask
for a sync, rather than rendering an empty state that reads as good news.
