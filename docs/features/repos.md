# Repos

The repository browser and the entry point for graph sync.

## What it shows

Every repository, with its compliance score, visibility, owning team and
protection state. Opening one shows branches, workflows, collaborators,
rulesets and dependency alerts.

## Sync data

The button that rebuilds the graph. It walks the organization through the
GitHub App token and writes edges to DynamoDB:

| Edge | Records |
|---|---|
| `repo_meta` | visibility, archived, pushedAt, default branch, secret scanning |
| `has_branch` | branches and whether each is protected |
| `has_collaborator` / `collaborates_on` | who can write, and how they got it |
| `member_of` / `has_member` | team membership |
| `owns_repo` / `owned_by_team` | team → repository |
| `uses_workflow` | Actions workflows |
| `has_vulnerable_dependency` | open Dependabot alerts |
| `user_meta` | org members, their role, outside collaborators |
| `team_meta` | team names |
| `org_meta` | default repository permission, member count |

Roughly 1,500 API calls for 350 repositories. It is **not scheduled** — it runs
when pressed. See [the graph model](../data/graph-model.md).

## Why sync is manual

An automatic rebuild every few hours would spend the shared rate-limit budget
whether or not anyone was looking, and the data it feeds is used for reporting
rather than enforcement. Making it a button also makes staleness visible: the
pages that read the graph say when it was last built.

## After adding a feature

New edge types do not exist in an old graph. Pages that need them say so and ask
for a sync, rather than rendering an empty state that reads as good news.
