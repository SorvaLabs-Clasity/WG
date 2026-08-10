# Repo Knowledge Center — design

**Date:** 2026-08-10
**Replaces:** the risk heat map in the Knowledge Map tab (`KnowledgeGraphPage.tsx`)

## Goal

Turn the Knowledge Map tab into a browsable reference for every repo in the org.
Pick a repo, see everything worth knowing about it. No risk scoring, no security
framing — that material already lives on the Security and Compliance pages.

## What is removed

| Removed | Location |
|---|---|
| `riskColor()` / `riskHex()` helpers | `KnowledgeGraphPage.tsx:8-24` |
| Critical / High / Medium / Low stat cards | `:89-92` |
| "Risk Heat Map" grid, risk-coloured tiles, risk legend | `:114-160` |
| Risk badge and score in the panel header | `:237-238`, `:311-313` |
| Blast radius "if compromised, the following are at risk" | `:374` |
| Vulnerable Dependencies section and the "Vulns" stat tile | `:285-297`, `:337` |

`useBlastRadius` and `useBlastRadiusRanking` are no longer called from this page.
The endpoints stay — the Analytics page still uses them.

## What replaces it

### Left: repo browser

Flat, uncoloured list of all repos. Search by name or description; filter by
language, visibility and archived state; sort by last-pushed, name, or size.
Backed by the existing `GET /api/repos`, widened to return fields GitHub already
sends in `listForOrg` and that `repoService.listRepos` currently discards.

### Right: knowledge panel

Loads on demand for the selected repo only. This is what makes the richer stats
affordable: roughly a dozen API calls for one repo, not for all 348.

- **Header** — description, visibility, primary language, license, size, topics,
  archived/fork/template badges, link to GitHub
- **Stat tiles** — branches, people, open PRs, open issues, teams, workflows
- **Overview** — created / last pushed / last updated, age, default branch,
  homepage, enabled features (issues, wiki, projects, pages)
- **Languages** — full breakdown with percentages
- **Activity** — open PR count and oldest open PR, commits in the last 30 days,
  latest release and total release count, stars / watchers / forks
- **People** — collaborators with roles, teams with permissions, top contributors
  by commit count
- **Branches** — every branch, default and protected flags
- **Workflows** — name, state, path
- **Repo hygiene** — presence of README, LICENSE, CODEOWNERS, description,
  topics. Descriptive only, no score or grade.
- **Merge settings** — squash / merge commit / rebase allowed, auto-merge,
  delete branch on merge
- **Environments** — deployment environment names

## Backend

`GET /api/repos/:repo/details` → new `repoDetailsService.getRepoDetails()`.

Calls, all for a single repo: `repos.get`, `listLanguages`, `listContributors`
(top 5), `pulls.list` (open, oldest first), `listReleases`, `listRepoWorkflows`,
`listBranches`, `getAllEnvironments`, `listCommits` (since 30d), and content
probes for README / LICENSE / CODEOWNERS.

Every call is individually wrapped: one failing section degrades to `null`
rather than failing the whole panel. A repo with Actions disabled or no
environments is normal, not an error.

Commit counts come from `listCommits?since=…&per_page=1` and reading the last
page number off the `Link` header. GitHub's `stats/*` endpoints return `202` and
compute asynchronously on first request, which is unusable for a UI panel.

Teams and collaborators continue to come from the graph edges already
aggregated by `graphAggregator`, at no extra API cost.

## Demo mode

`mock.ts` gains a `mockFetchRepoDetails()` so `VITE_DEMO_MODE=true` still works.

## Testing

A standalone script drives `getRepoDetails` against a fake Octokit, asserting:
per-section failures degrade to `null` instead of throwing; language percentages
sum to 100; the `Link`-header commit count parses correctly, including the
single-page and no-commits cases.
