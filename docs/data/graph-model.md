# The graph

One table, `graph-edges`, holding the organization as a set of edges. Rebuilt
whole when someone presses Sync data.

## Shape

```
pk        REPO#api           the thing
sk        USER#alice         the other thing
type      has_collaborator   the relationship
metadata  { role, source }   what makes it interesting
```

Most relationships are stored **both ways**, so a question can be asked from
either end without a scan.

## Edge types

| Type | pk → sk | Metadata |
|---|---|---|
| `repo_meta` | `REPO#x` → `META#repo` | visibility, archived, pushedAt, defaultBranch, secretScanning |
| `has_branch` | `REPO#x` → `BRANCH#main` | protected, default |
| `has_collaborator` | `REPO#x` → `USER#y` | role, source |
| `collaborates_on` | `USER#y` → `REPO#x` | role, source |
| `member_of` | `USER#y` → `TEAM#t` | — |
| `has_member` | `TEAM#t` → `USER#y` | — |
| `owns_repo` | `TEAM#t` → `REPO#x` | permission |
| `owned_by_team` | `REPO#x` → `TEAM#t` | permission |
| `uses_workflow` | `REPO#x` → `WORKFLOW#n` | path, state |
| `has_vulnerable_dependency` | `REPO#x` → `DEPENDENCY#n` | severity |
| `user_meta` | `USER#y` → `META#user` | orgRole, avatarUrl |
| `team_meta` | `TEAM#t` → `META#team` | name, description |
| `org_meta` | `ORG#o` → `META#org` | defaultRepositoryPermission, memberCount |

## Two deliberate narrowings

**Only admin, write and maintain are recorded as collaborators.** Read is what
the org default grants everyone on everything — recording it would be one edge
per member per repository, hundreds of thousands of rows saying the same thing,
and no query asks about it.

**Every collaborator edge carries `source`** — `org_owner`, `team` or `direct`.
Without it, an organization owner is admin on every repository and floods
every result. With it, a query can ask the useful question: who has admin that
ownership and team membership do not already explain.

## Rebuilding

The whole table is cleared and rewritten. Simple, and correct for a dataset this
size; a diffing rebuild would be faster and much easier to get subtly wrong.

The cost is that the graph is only as fresh as the last sync, which every page
reading it says out loud.
