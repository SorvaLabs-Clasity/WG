# GitHub Control Hub — Detailed Architecture & File Reference

This document explains how the application works end-to-end, then breaks down every file in the project.

---

## Table of Contents

- [What This App Is](#what-this-app-is)
- [How It Runs (Three Deployment Modes)](#how-it-runs-three-deployment-modes)
- [Authentication Flow](#authentication-flow)
- [Data Flow](#data-flow)
- [Templates & Exclusion Lists](#templates--exclusion-lists)
- [Webhook Automation](#webhook-automation)
- [Compliance & Security](#compliance--security)
- [Knowledge Graph](#knowledge-graph)
- [Background Jobs](#background-jobs)
- [AWS Infrastructure](#aws-infrastructure)
- [File-by-File Breakdown](#file-by-file-breakdown)

---

## What This App Is

GitHub Control Hub is a governance platform for GitHub organizations. It lets you:

- **Define protection templates** — reusable branch protection configs (classic protections, branch rulesets, tag rulesets, push rulesets) that you apply to repos in bulk.
- **Auto-apply templates** — when a new repo is created in your org, webhooks trigger and automatically apply the right templates.
- **Detect drift** — when someone manually changes a branch protection or disables a ruleset, the app detects it, creates a security alert, and can auto-resolve it back to the template config.
- **Track everything** — every action (branch created, protection applied, alert resolved) is logged with full undo/redo support.
- **Monitor compliance** — score each repo against configurable rules (does it have branch protection? rulesets? CODEOWNERS? no outside collaborators?).
- **Scan for violations** — custom scanners check repos for specific conditions and report violations.
- **Manage dependencies** — view Dependabot vulnerability alerts across all repos, enable/disable Dependabot per repo.
- **Visualize risk** — a knowledge graph maps repos → branches → teams → users → workflows → dependencies to calculate blast radius scores.
- **Exclude repos** — exclusion lists let you skip repos by name or by dynamic patterns (starts with, contains, created by a specific user, has a CODEOWNERS entry).

---

## How It Runs (Three Deployment Modes)

### 1. Desktop App (Electron)
The recommended mode for individual use. An Electron app wraps the Express backend and serves the React frontend. On launch:
1. `bootstrap.ts` resolves DynamoDB table names and loads secrets from AWS Secrets Manager.
2. `server.ts` (desktop) requires the compiled Express backend and serves the frontend as static files.
3. `main.ts` (Electron) creates a BrowserWindow pointing to `http://localhost:4321/login`.
4. After AWS auth completes, the auto-updater checks GitHub Releases for new versions.

### 2. Web Dev Mode
For development. You run the backend and frontend separately:
- Backend: `npm run dev` in `github-control-hub/backend/` → Express on port 4000 (via tsx watch).
- Frontend: `npm run dev` in `github-control-hub/frontend/` → Vite dev server on port 5173, proxying API calls to port 4000.

### 3. Docker / EC2
For production deployment. A multi-stage Dockerfile builds the backend TypeScript and frontend Vite bundle into a single image. The `deploy.sh` script builds the image, uploads it to S3, SSHs into EC2 via SSM Session Manager, and loads the container. The container exposes port 4321, mapped to port 443 (HTTPS with a self-signed cert) on the host.

---

## Authentication Flow

1. **User clicks Login** → frontend redirects to `/auth/github` → backend builds a GitHub OAuth URL with `repo` + `read:org` scopes → browser goes to GitHub.
2. **GitHub callback** → GitHub redirects to `/auth/callback` with an auth code → backend exchanges it for a GitHub access token.
3. **JWT creation** → backend fetches the user's GitHub profile (id, login, avatar), stores the access token in an in-memory token store (keyed by GitHub ID), signs a JWT with the user's info, and returns it.
4. **Frontend stores JWT** → saved in sessionStorage. Every API call includes `Authorization: Bearer <jwt>`.
5. **Auth middleware** → on each request, the middleware verifies the JWT, looks up the GitHub access token from the token store, and attaches both to `req.user`.

The GitHub App (used for server-to-GitHub API calls like applying templates) is separate from user auth. It uses a private key to generate short-lived installation tokens, managed by `GitHubTokenManager` in `client.ts`.

---

## Data Flow

```
User → React Frontend → React Query hooks → API layer (fetch calls) → Express Backend → Service layer → DynamoDB (or in-memory fallback)
                                                                                          ↕
                                                                                    GitHub API (via Octokit)
```

- **Frontend**: React 19 + React Router 7 + TanStack React Query 5 + Tailwind CSS + Material UI.
- **State management**: React Query handles all server state. Mutations invalidate related query keys to keep the UI fresh.
- **Backend**: Express with typed routes. Each route delegates to a service. Services handle business logic + persistence.
- **Persistence**: DynamoDB in production (11 tables), in-memory Maps for local dev (no AWS needed).
- **GitHub API**: All GitHub calls go through Octokit instances. The system token (from GitHub App) is used for server-initiated actions; the user's OAuth token is used for user-initiated actions.

---

## Templates & Exclusion Lists

**Templates** are the core feature. A template defines:
- Branch rules (classic protection: require PRs, status checks, dismiss stale reviews, etc.)
- Branch rulesets (modern GitHub rulesets with bypass actors, deployment requirements)
- Tag rulesets (tag creation/update/deletion restrictions)
- Push rulesets (file path restrictions, size limits, extension blocks)
- Target branches (which branches to protect)
- Auto-apply flag (apply to new repos automatically)
- Exclusion lists (which repos to skip)

**Applying a template** means: for each target repo (minus excluded repos), create the branch if it doesn't exist, then apply the protection rules via GitHub API. Each repo result (success, failure, skipped, conflict) is logged as an activity entry with undo payloads.

**Exclusion lists** filter repos two ways:
1. **Explicit repos** — manually listed repo names.
2. **Patterns** — dynamic rules resolved at apply-time against the live org:
   - `starts_with` — repo name starts with a string
   - `contains` — repo name contains a string
   - `created_by` — repo was created by a specific GitHub user (checked via Audit Log API)
   - `has_codeowners_entry` — repo's CODEOWNERS file contains a specific string
3. **Whitelist** — repos that match patterns but should NOT be excluded.

The effective excluded set = explicit repos + pattern matches - whitelisted repos.

---

## Webhook Automation

GitHub sends webhook events to the `/webhooks` endpoint. The handler:

1. **Verifies** the webhook signature (HMAC-SHA256) and rejects replays (5-min delivery ID cache).
2. **Processes** 20+ event types:
   - **New repo created** → waits 5 seconds (for GitHub to provision), then auto-applies all templates flagged for auto-apply (checking exclusion lists with the webhook creator context).
   - **Branch protection changed/deleted** → detects drift from templates, creates alerts, optionally auto-resolves.
   - **Ruleset edited/disabled** → same drift detection.
   - **Repo visibility changed** (made public) → creates security alert.
   - **Member/collaborator added with admin** → creates alert.
   - **All events** → logged as activity entries, compliance cache refreshed, graph edges updated.

---

## Compliance & Security

**Compliance scoring** rates each repo 0-100 based on configurable rules:
- Branch protection (35 pts default) — does the default branch have protection?
- Rulesets (25 pts) — does it have active rulesets?
- Required files (25 pts) — does it have README, CODEOWNERS, etc.?
- Outside collaborators (15 pts) — no outside collaborators with write+ access?

Scores are cached in DynamoDB and refreshed on webhook events or manual trigger.

**Security alerts** are created for: protection removed, ruleset disabled, repo made public, admin added, protection drift, user promoted, etc. Alerts can be resolved/unresolved and are auto-resolved when the underlying issue is fixed.

**Custom scanners** let you define conditions (branch protection patterns, query-based checks) and run them against all repos or specific repos to find violations.

---

## Knowledge Graph

The graph maps relationships between entities:
- `team → repo` (owns)
- `user → team` (member_of)
- `repo → branch` (has_branch)
- `repo → user` (has_collaborator)
- `repo → workflow` (uses_workflow)
- `repo → dependency` (has_vulnerable_dependency)

This powers:
- **Blast radius analysis** — if repo X is compromised, which downstream deps, workflows, and teams are affected?
- **User impact analysis** — if user Y's account is compromised, which repos/teams are at risk?
- **Risk ranking** — repos scored by number of workflows + vulnerable deps + access vectors.
- **Security queries** — custom queries like "repos deploying to prod" or "repos with outside admins".

The graph is built by the `graphAggregator` job and stored as edges in DynamoDB.

---

## Background Jobs

Two scheduled jobs run periodically:

1. **Graph Aggregator** (`graphAggregator.ts`) — fetches all repos, teams, members, collaborators, workflows, and Dependabot alerts from GitHub API. Builds edges and writes them to the GRAPH_EDGES_TABLE in DynamoDB.
2. **Audit Log Checker** (`auditLogChecker.ts`) — checks if the org has GitHub Enterprise Audit Log access. Updates org config features accordingly.

---

## AWS Infrastructure

Provisioned via AWS CDK (`github-control-hub/infra/`):

- **EC2 instance** (t3.small default) on the default VPC.
- **Security group**: HTTPS (443) open only to GitHub webhook IP ranges (192.30.252.0/22, 185.199.108.0/22, 140.82.112.0/20, 143.55.64.0/20). No SSH — access is via SSM Session Manager.
- **IAM role** with permissions for: SSM, S3 (deploy artifact), Secrets Manager (app secrets), DynamoDB (all 11 tables).
- **Secrets Manager** stores: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_WEBHOOK_SECRET, GITHUB_ORG, JWT_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID.
- **11 DynamoDB tables**: activity, templates, scanners, alerts, org-config, auth-codes, graph-edges, exclusions, widgets, compliance-cache, rule-templates.
- **Self-signed SSL cert** generated on EC2 via user-data script.

---

## File-by-File Breakdown

### Root Level

#### `Dockerfile`
Multi-stage Docker build. Stage 1 installs dependencies and compiles both backend (TypeScript → JavaScript) and frontend (Vite build). Stage 2 copies only production artifacts and runs as a non-root `node` user. Entry point: `node backend/dist/standalone.js`. Exposes port 4321.

#### `docker-compose.yml`
Single-service compose file. Builds from the Dockerfile, maps port 4321, injects AWS credentials from the host environment, and sets restart policy to `unless-stopped`.

#### `.dockerignore`
Excludes node_modules, build artifacts, git history, the desktop app folder, release builds, and .claude workspace files from the Docker build context.

#### `scripts/deploy.sh`
Deployment script for EC2. Builds the Docker image locally with `docker buildx` (linux/amd64), uploads it to S3 as a tar archive, connects to EC2 via SSM Session Manager, downloads and loads the image, then runs the container mapping host port 443 to container port 4321. Also generates a self-signed SSL certificate on the instance. Outputs the webhook URL and SSM connection command.

#### `README.md`
Setup guide covering GitHub OAuth app creation, AWS DynamoDB table setup, environment variable configuration, and instructions for all three deployment modes (desktop, web, Docker).

---

### Backend — Entry Points

#### `backend/src/server.ts`
**The Express application.** Initializes the app with CORS, JSON parsing, security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection), and rate limiting (100 requests/15 min on auth endpoints). Loads secrets from AWS Secrets Manager on startup and initializes the GitHub App token manager. Mounts all 16 route modules under `/api` or root paths. Applies `authMiddleware` to all routes except `/auth/*`, `/webhooks`, and `/health`. Applies `awsHealthMiddleware` to all routes except `/auth/*` and `/health`. Exports the Express app.

**Depends on:** All route files, authMiddleware, awsHealthMiddleware, dynamo utils, github client.

#### `backend/src/standalone.ts`
**EC2/Docker entry point.** Resolves DynamoDB table names from `STACK_NAME` environment variable prefix. Loads secrets from AWS Secrets Manager (same secret keys as bootstrap.ts). Checks for SSL certificates at `/etc/ssl/github-control-hub/`. If found, creates an HTTPS server; otherwise HTTP. Serves the frontend build as static files with SPA fallback (non-API routes return `index.html`). Initializes the GitHub App token manager if App credentials are present. Starts periodic jobs (graph aggregation, audit log checks). Listens on port 4321.

**Depends on:** server.ts (the Express app), github client (initTokenManager), jobs (graphAggregator, auditLogChecker).

---

### Backend — Routes

#### `backend/src/routes/auth.ts`
**Authentication and AWS management.** Handles the GitHub OAuth flow (authorization URL, token exchange, callback). Issues JWTs after successful auth. Manages AWS credentials in desktop mode (SSO login, profile switching, explicit access keys). Provides endpoints for token verification, session revocation, auth status checking, and system token retrieval. Implements a `serverModeGuard` middleware that blocks desktop-only endpoints (like AWS management) when running on EC2. Stores auth codes in DynamoDB or in-memory with TTL-based cleanup.

**Key endpoints:** `GET /auth/github`, `GET /auth/callback`, `POST /auth/verify`, `POST /auth/revoke`, `GET /auth/status`, `GET /auth/system-token`, `POST /auth/aws/sso-login`, `POST /auth/aws/profile`.
**Depends on:** oauth.ts, jwt.ts, tokenStore.ts, dynamo.ts, awsHealthMiddleware.ts, client.ts.

#### `backend/src/routes/repos.ts`
**Repository listing.** Single endpoint that lists all repositories in the GitHub organization. Fetches repos via `repoService.listRepos()` and returns them as JSON.

**Key endpoints:** `GET /repos`.
**Depends on:** repoService.ts, client.ts.

#### `backend/src/routes/branches.ts`
**Branch management.** CRUD operations for branches: list branches for a repo, create a new branch (from default branch HEAD), delete a branch, rename a branch. Every action logs an activity entry with undo/redo payloads so actions can be reversed. Validates repo and branch names using validation middleware.

**Key endpoints:** `GET /repos/:repo/branches`, `POST /repos/:repo/branches`, `DELETE /repos/:repo/branches/:branch`, `PATCH /repos/:repo/branches/:branch/rename`.
**Depends on:** branchService.ts, activityService.ts, validation.ts, errorSanitizer.ts, client.ts.

#### `backend/src/routes/protection.ts`
**Branch protection management.** Gets current protection for a branch, applies classic protection or rulesets, deletes protections, imports rulesets from JSON, deletes rulesets. All changes are logged with undo payloads that capture the previous protection state for rollback. Compares configs to detect whether the protection actually changed before logging.

**Key endpoints:** `GET /repos/:repo/branches/:branch/protection`, `PUT /repos/:repo/branches/:branch/protection`, `DELETE /repos/:repo/branches/:branch/protection`, `POST /repos/:repo/rulesets/import`, `DELETE /repos/:repo/rulesets/:rulesetId`.
**Depends on:** branchService.ts, activityService.ts, validation.ts, errorSanitizer.ts, client.ts.

#### `backend/src/routes/activity.ts`
**Activity log and undo/redo.** Lists activity entries with pagination and filtering (by repo, action type, actor, date range). Implements undo (reverts an action using its stored undo payload), redo (re-applies after undo), and retry (retries a failed action). Handles conflict resolution when an undo/redo would conflict with changes made since the original action. Each undo/redo operation creates its own activity entry.

**Key endpoints:** `GET /activity`, `POST /activity/:id/undo`, `POST /activity/:id/redo`, `POST /activity/:id/retry`, `POST /activity/:id/resolve-conflict`.
**Depends on:** activityService.ts, branchService.ts, templateService.ts, exclusionService.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/templates.ts`
**Protection templates.** CRUD for reusable branch protection templates. The `POST /:id/apply` endpoint applies a template to all target repos: fetches the template, resolves excluded repos (via `resolveExcludedReposFromIds` which handles both explicit repos and pattern matching), then for each non-excluded repo applies the configured protections. Returns per-repo results (success, failure, skipped, conflict). Logs all actions with undo payloads.

**Key endpoints:** `GET /templates`, `GET /templates/:id`, `POST /templates`, `PUT /templates/:id`, `DELETE /templates/:id`, `POST /templates/:id/apply`.
**Depends on:** templateService.ts, exclusionService.ts (resolveExcludedReposFromIds), activityService.ts, branchService.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/ruleTemplates.ts`
**Rule templates.** CRUD for atomic, reusable rule configs. Each rule template has a `ruleType` (classic, branch_ruleset, tag_ruleset, push_ruleset) and a `config` object with the specific settings. These can be composed into protection templates. Validates that `ruleType` is one of the allowed values.

**Key endpoints:** `GET /rule-templates`, `POST /rule-templates`, `PUT /rule-templates/:id`, `DELETE /rule-templates/:id`.
**Depends on:** ruleTemplateService.ts, errorSanitizer.ts.

#### `backend/src/routes/exclusions.ts`
**Exclusion lists.** CRUD for exclusion lists that filter repos from template application. The `GET /:id/resolved-repos` endpoint resolves patterns against live org repos and returns the breakdown: explicit repos, per-pattern matches, whitelisted repos, and the effective excluded set. POST/PUT accept `patterns` (array of `{id, type, value}`) and `patternWhitelist` (array of repo names). Supports `forceTemplateIds` and `forceOnNewTemplates` to auto-attach the exclusion list to templates.

**Key endpoints:** `GET /exclusions`, `GET /exclusions/:id`, `GET /exclusions/:id/resolved-repos`, `POST /exclusions`, `PUT /exclusions/:id`, `DELETE /exclusions/:id`.
**Depends on:** exclusionService.ts, client.ts (createOctokit, getSystemToken).

#### `backend/src/routes/scanners.ts`
**Custom compliance scanners.** CRUD for scanners that check repos against custom conditions. Scanners target "all" repos or a specific list. Conditions can be branch-protection-based (check specific branch patterns for required protection rules) or query-based (evaluate security graph queries). The `POST /:id/run` endpoint executes a scan and stores results. `GET /:id/results/:resultId` retrieves scan results.

**Key endpoints:** `GET /scanners`, `POST /scanners`, `PUT /scanners/:id`, `DELETE /scanners/:id`, `POST /scanners/:id/run`, `GET /scanners/:id/results/:resultId`.
**Depends on:** scannerService.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/webhooks.ts`
**GitHub webhook handler.** The most connected route file. Verifies webhook signatures (HMAC-SHA256 with the webhook secret) and rejects replayed deliveries (5-min TTL cache of delivery IDs). Processes 20+ GitHub event types:

- `repository.created` → auto-applies templates (with 5-second delay for provisioning) using pattern-aware exclusion checking with the webhook sender as creator context.
- `branch_protection_rule.edited/deleted` → drift detection, creates alerts, optional auto-resolve.
- `repository_ruleset.edited` → detects ruleset disabling, creates alerts.
- `member.added` / `team.added_to_repository` → alerts on admin access grants.
- `repository.publicized` → alert for repo made public.
- `organization.member_added/member_removed` → activity logging.
- All events → refresh compliance cache, run scanners, update graph edges.

**Key endpoints:** `POST /webhooks`.
**Depends on:** client.ts, scannerService.ts, alertService.ts, activityService.ts, templateService.ts, exclusionService.ts (resolveExcludedReposFromIds), complianceCacheService.ts, graphEdgeService.ts.

#### `backend/src/routes/alerts.ts`
**Security alerts.** Lists all alerts, resolves/unresolves alerts by ID. Test endpoints for simulating alert scenarios in demo mode. An inactive user detection endpoint finds org members who haven't pushed code in 180 days.

**Key endpoints:** `GET /alerts`, `PATCH /alerts/:id/resolve`, `PATCH /alerts/:id/unresolve`, `POST /alerts/test/:scenario`, `GET /alerts/inactive-users`.
**Depends on:** alertService.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/compliance.ts`
**Compliance dashboard.** Get or update the compliance config (rules and weights). Get cached compliance scores for all repos or trigger a full refresh. Refresh a single repo's score. Handles GitHub rate limit errors gracefully (returns partial results with a warning).

**Key endpoints:** `GET /compliance/config`, `PUT /compliance/config`, `GET /compliance/dashboard`, `POST /compliance/refresh`, `POST /compliance/refresh/:repo`.
**Depends on:** complianceConfigService.ts, complianceCacheService.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/dependencies.ts`
**Dependabot vulnerability management.** Lists open Dependabot alerts org-wide (paginated, maps to a standard format with repo, package, severity, CVE, ecosystem). Lists alerts per repo. Enables or disables Dependabot for a specific repo. Summary endpoint returns counts of repos with critical/high/medium/low vulnerabilities.

**Key endpoints:** `GET /dependencies`, `GET /dependencies/:repo`, `POST /dependencies/:repo/enable`, `POST /dependencies/:repo/disable`, `GET /dependencies/summary`.
**Depends on:** client.ts, repoService.ts, activityService.ts, errorSanitizer.ts.

#### `backend/src/routes/org.ts`
**Organization metadata.** Returns org features and config (whether audit logs are available, rulesets are supported, advanced security is enabled). Lists "actors" (roles, teams, GitHub Apps) that can be assigned as bypass actors in rulesets.

**Key endpoints:** `GET /org/config`, `GET /org/actors`.
**Depends on:** orgConfigService.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/graph.ts`
**Security graph analysis.** The most complex query endpoint. Supports:
- Node expansion (get all edges for a repo or user)
- Blast radius (downstream deps, workflows, teams affected if a repo is compromised)
- User impact (all teams/repos accessible to a compromised user account)
- Risk ranking (all repos scored by workflows + vulnerable deps + access vectors)
- Security query engine (evaluate custom queries like "repos-dependent-on" or "repos-with-outside-admins")
- Graph aggregation trigger (kicks off the graphAggregator job)

Falls back to local JSON file (`data/graph-edges.json`) if DynamoDB is unavailable.

**Key endpoints:** `GET /graph/meta`, `GET /graph/node/:type/:id`, `GET /graph/blast-radius/:repo`, `GET /graph/user-impact/:user`, `GET /graph/risk-ranking`, `POST /graph/query`, `POST /graph/aggregate`.
**Depends on:** graphService.ts, dynamo.ts, client.ts, errorSanitizer.ts.

#### `backend/src/routes/widgets.ts`
**Dashboard widgets.** CRUD for customizable analytics widgets. Widgets reference either a preset query or a custom security query. Support metric (single number) or table (rows) display types.

**Key endpoints:** `GET /widgets`, `POST /widgets`, `PUT /widgets/:id`, `DELETE /widgets/:id`.
**Depends on:** widgetService.ts.

---

### Backend — Services

#### `backend/src/services/repoService.ts`
**Repository fetching.** Lists all repos in the org via paginated GitHub API calls (100 per page). Returns a summary for each repo: name, full_name, private, default_branch, description, language, updated_at.

**Key exports:** `listRepos(octokit)`.

#### `backend/src/services/branchService.ts`
**Branch and protection operations.** The workhorse service. Handles: listing branches, creating/deleting/renaming branches, getting/applying/deleting classic branch protections, listing/creating/deleting rulesets. Builds ruleset JSON from template configs (branch rulesets, tag rulesets, push rulesets). Includes comparison functions (`compareRulesetConfigs`, `compareClassicConfigs`) used for drift detection — compares the current GitHub state against the template config to determine if protection has drifted.

**Key exports:** `listBranches`, `createBranch`, `deleteBranch`, `renameBranch`, `protectBranch`, `getProtection`, `getAllProtections`, `listRulesets`, `deleteProtection`, `deleteRuleset`, `createRulesetWithFallback`, `buildRulesetRules`, `buildTagRulesetRules`, `buildPushRulesetRules`, `compareRulesetConfigs`, `compareClassicConfigs`.

#### `backend/src/services/activityService.ts`
**Central audit log.** Every significant action in the app goes through `logActivity()`. Stores entries in DynamoDB or in-memory. Each entry records: action type, actor, repo, target name, description, diff (old vs new values), source (app, webhook, undo), and optional undo/redo/retry payloads. Supports parent-child relationships for grouped actions (e.g., a template apply creates a parent entry and per-repo children). Activity entries are used by the undo/redo system to reverse or replay actions.

**Key exports:** `logActivity`, `getActivities`, `getActivity`, `updateActivity`.
**Types:** `ActivityAction` (enum of all action types), `ActivityEntry`, `UndoPayload`, `RetryPayload`.

#### `backend/src/services/templateService.ts`
**Protection templates.** CRUD operations for templates. The `applyTemplate` function is the core: for each target repo, it creates the branch if needed, applies the configured protections (classic, branch ruleset, tag ruleset, push ruleset), handles conflicts (existing protection differs from template), and logs per-repo results. Templates store: name, branch rules, tag rules, push rules, target branches, auto-apply flag, exclusion list IDs.

**Key exports:** `listTemplates`, `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `applyTemplate`, `putTemplateRaw`.

#### `backend/src/services/alertService.ts`
**Security alert management.** Creates, lists, resolves, and unresolves security alerts. Alert types include: protection_removed, ruleset_disabled, repo_made_public, admin_added, protection_drift, user_promoted, inactive_user. Each alert has a severity (critical, high, medium, low), type, and resolution state. Auto-resolve function marks matching open alerts as resolved when the underlying issue is fixed.

**Key exports:** `createAlert`, `getAlerts`, `getAlert`, `resolveAlert`, `unresolveAlert`, `autoResolveAlerts`.

#### `backend/src/services/exclusionService.ts`
**Exclusion list management and pattern resolution.** CRUD for exclusion lists. The pattern resolution engine is the core:

- `resolveExcludedRepos()` takes an exclusion list and an Octokit instance, resolves all patterns against live org repos, applies the whitelist, and returns the effective excluded set.
- `resolveExcludedReposFromIds()` resolves multiple exclusion list IDs and unions the results.
- `resolvePatternMatches()` handles each pattern type:
  - `starts_with` / `contains` — string matching against repo names (cached repo list, 2-min TTL).
  - `created_by` — queries the GitHub Audit Log API for `repo.create` events by the specified actor. In webhook context, also matches the webhook sender directly.
  - `has_codeowners_entry` — fetches CODEOWNERS files (checks 3 paths: root, .github/, docs/) and searches for the pattern value (cached, 5-min TTL).
- `cascadeForceToTemplates()` — when an exclusion list has `forceTemplateIds` or `forceOnNewTemplates`, automatically attaches itself to the specified templates.

**Key exports:** `listExclusions`, `getExclusion`, `createExclusion`, `updateExclusion`, `deleteExclusion`, `resolveExcludedRepos`, `resolveExcludedReposFromIds`, `normalizeExclusion`, `putExclusionRaw`, `deleteExclusionRaw`.

#### `backend/src/services/scannerService.ts`
**Custom compliance scanners.** CRUD for scanners. Scanners define conditions (branch protection requirements on specific branch patterns, or query-based conditions evaluated against the security graph). The `runScan` function executes a scanner against its target repos, checks each condition, and produces a `ScanResult` with violations per repo. Results are stored and can be retrieved later.

**Key exports:** `listScanners`, `getScanner`, `createScanner`, `updateScanner`, `deleteScanner`, `runScan`, `getScanResult`.

#### `backend/src/services/complianceService.ts`
**Compliance evaluation engine.** Calculates a compliance score (0-100) for a single repo against the configured rules. Each rule has a weight (points). Rules check for: branch protection on default branch, active rulesets, required files (README, CODEOWNERS, LICENSE), no outside collaborators with write+ access, and custom security graph queries. Returns per-rule pass/fail details and the aggregate score.

**Key exports:** `calculateRepoCompliance`, `evaluateRule`.

#### `backend/src/services/complianceCacheService.ts`
**Compliance score caching.** Caches compliance scores in DynamoDB or memory so the dashboard doesn't re-evaluate every repo on every page load. `refreshAll` re-evaluates all repos (3 concurrent) and updates the cache. `refreshRepo` re-evaluates a single repo (triggered by webhook events). Falls back to a -1 score on evaluation errors.

**Key exports:** `getCachedScores`, `cacheScore`, `refreshRepo`, `refreshAll`.

#### `backend/src/services/graphEdgeService.ts`
**Security graph edge management.** Manages edges in the knowledge graph (stored in GRAPH_EDGES_TABLE). Batch write/delete operations. Specialized functions for adding/removing branch edges, collaborator edges, and protection status updates. `addRepoEdges` syncs all edges for a newly created repo (branches, collaborators, workflows, Dependabot alerts) — called by the webhook handler when a new repo is created.

**Key exports:** `addBranchEdge`, `removeBranchEdge`, `updateBranchProtection`, `addCollaboratorEdge`, `removeCollaboratorEdge`, `addRepoEdges`, `batchWriteEdges`, `batchDeleteEdges`.

#### `backend/src/services/widgetService.ts`
**Dashboard widget management.** CRUD for analytics widgets. Widgets have a `preset` (predefined query like "repos-with-critical-vulns") or a custom `query`. Display type is `metric` (single number) or `table` (rows). All widget changes are logged via `activityService`.

**Key exports:** `listWidgets`, `getWidget`, `createWidget`, `updateWidget`, `deleteWidget`.

#### `backend/src/services/ruleTemplateService.ts`
**Rule template management.** CRUD for atomic, reusable rule configs. Each rule template has a `ruleType` (classic, branch_ruleset, tag_ruleset, push_ruleset) and a `config` object. These are building blocks that can be composed into full protection templates. All changes logged via `activityService`.

**Key exports:** `listRuleTemplates`, `getRuleTemplate`, `createRuleTemplate`, `updateRuleTemplate`, `deleteRuleTemplate`.

#### `backend/src/services/orgConfigService.ts`
**Organization configuration.** Stores org-level feature flags: `auditLogs` (is Enterprise audit log accessible?), `rulesetsSupported` (does the org plan support rulesets?), `advancedSecurity` (is GHAS enabled?). Lazy-initializes with defaults on first access. Updated by the audit log checker job.

**Key exports:** `getOrgConfig`, `updateOrgFeatures`.

#### `backend/src/services/graphService.ts`
**Security graph query engine.** Evaluates security queries against the graph edges. Queries like `repos-dependent-on`, `repos-deploying-to-prod`, `repos-with-outside-admins`, `repos-with-critical-vulnerabilities` scan all edges and filter/aggregate results. Supports local JSON fallback for development. Used by the graph route endpoints and by compliance rules that reference graph queries.

**Key exports:** `evaluateSecurityQuery`.

#### `backend/src/services/complianceConfigService.ts`
**Compliance rule configuration.** Stores the set of compliance rules and their weights. Default rules: branch protection (35 pts), rulesets (25 pts), required files (25 pts), outside collaborators (15 pts). Supports enabling/disabling individual rules and adjusting weights. All changes logged.

**Key exports:** `getComplianceConfig`, `updateComplianceConfig`.

---

### Backend — Middleware

#### `backend/src/middleware/authMiddleware.ts`
**JWT authentication.** Express middleware that runs on every protected request. Extracts the JWT from the `Authorization: Bearer` header, verifies it using the JWT_SECRET, looks up the user's GitHub access token from the in-memory token store, and attaches `{ githubId, login, avatarUrl, accessToken }` to `req.user`. Returns 401 if the token is missing/invalid, 503 if JWT_SECRET hasn't been loaded yet.

**Key exports:** `authMiddleware`.

#### `backend/src/middleware/awsHealthMiddleware.ts`
**AWS connectivity check.** Express middleware that verifies DynamoDB is reachable before processing requests. Performs a health check every 30 seconds (cached). If AWS is unreachable or manually locked (via `lockAws()`), returns 503. The lock/unlock mechanism is used during AWS credential changes to prevent requests from hitting a temporarily unavailable database.

**Key exports:** `awsHealthMiddleware`, `lockAws`, `unlockAws`, `isAwsLocked`.

---

### Backend — Utilities

#### `backend/src/utils/dynamo.ts`
**DynamoDB client wrapper.** Creates and exports the DynamoDB document client (`docClient`) from `@aws-sdk/lib-dynamodb`. Provides `tableName(envKey)` to look up table names from environment variables. `usesDynamo()` returns whether a DynamoDB connection is available (based on whether any table env vars are set). `resetDynamoClient()` recreates the client (used after AWS credential changes). Re-exports all DynamoDB commands (GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, UpdateCommand, BatchWriteCommand) for convenience.

**Key exports:** `docClient`, `resetDynamoClient`, `tableName`, `usesDynamo`, plus all command re-exports.

#### `backend/src/utils/tokenStore.ts`
**In-memory token store.** A simple `Map<string, string>` keyed by GitHub user ID, storing GitHub access tokens. Tokens are stored here after OAuth exchange and looked up by the auth middleware on each request. Tokens are never serialized to the JWT — the JWT only contains the user ID, and the access token lives only in server memory.

**Key exports:** `storeToken`, `getToken`, `removeToken`.

#### `backend/src/utils/jwt.ts`
**JWT signing and verification.** Signs JWTs with a payload of `{ githubId, login, avatarUrl }` and 8-hour expiry using the `JWT_SECRET` environment variable. Verifies and decodes JWTs on incoming requests.

**Key exports:** `signToken`, `verifyToken`, `JwtPayload` interface.

#### `backend/src/utils/errorSanitizer.ts`
**Error response sanitization.** Wraps error messages before sending them to clients. Detects specific error types (rate limits, DB errors, auth errors, network errors) and returns appropriate generic messages. In production, never exposes internal error details. In development, returns truncated error messages. Always logs the full error server-side.

**Key exports:** `sanitizeError(err, context)`.

#### `backend/src/utils/validation.ts`
**Request parameter validation.** Regex-based validation for repo names (alphanumeric, hyphens, dots, underscores; max 100 chars) and branch names (max 255 chars, no control characters). Provides `validateParams(...names)` — an Express middleware factory that validates named route parameters.

**Key exports:** `isValidRepoName`, `isValidBranchName`, `validateParams`.

---

### Backend — Jobs

#### `backend/src/jobs/graphAggregator.ts`
**Security graph builder.** Scheduled job that fetches all repos, teams, team memberships, outside collaborators, GitHub Actions workflows, and Dependabot alerts from the GitHub API. Builds graph edges for each relationship type (team→repo, user→team, repo→branch, repo→user, repo→workflow, repo→dependency). Writes all edges as a batch to the GRAPH_EDGES_TABLE in DynamoDB. Also triggers a compliance cache refresh for all repos after aggregation.

**Key exports:** `aggregateGraphData(fallbackToken?)`.

#### `backend/src/jobs/auditLogChecker.ts`
**Audit log feature detection.** Scheduled job that tests whether the organization has GitHub Enterprise Audit Log API access by making a test request. Updates the org config's `auditLogs` feature flag based on the result. This determines whether `created_by` exclusion patterns can use the audit log for resolution.

**Key exports:** `runAuditLogCheckJob()`.

---

### Backend — GitHub Integration

#### `backend/src/github/client.ts`
**GitHub API client and token management.** Creates Octokit instances with `createOctokit(token)`. Manages the GitHub App token lifecycle via `GitHubTokenManager`: normalizes the PEM private key, uses `@octokit/auth-app` to generate installation tokens, caches them, and auto-refreshes before expiry (5-minute buffer). Deduplicates concurrent refresh calls. Provides sync `getSystemToken()` (returns cached token, falls back to `SYSTEM_GITHUB_TOKEN` env var) and async `getSystemTokenAsync()` (refreshes if needed). Also exports `getOrg()` (from `GITHUB_ORG` env var), `fetchOrgAuditLog()`, and `checkAuditLogAccess()`.

**Key exports:** `initTokenManager`, `getSystemToken`, `getSystemTokenAsync`, `createOctokit`, `getOrg`, `fetchOrgAuditLog`, `checkAuditLogAccess`.

#### `backend/src/github/oauth.ts`
**GitHub OAuth 2.0 helpers.** Builds the GitHub authorization URL with `repo` + `read:org` scopes. Exchanges an authorization code for an access token via GitHub's token endpoint. Reads client ID and secret from environment variables. Redirect URI points to `BACKEND_URL/auth/callback`.

**Key exports:** `buildAuthorizationUrl`, `exchangeCodeForToken`, `getClientId`, `getClientSecret`.

---

### Frontend — Core

#### `frontend/src/App.tsx`
**Root component.** Sets up the application structure with React Query provider, Auth context, and Theme context. Manages authentication state (current user, JWT token). Handles periodic auth status checks (pings `/auth/verify` to ensure the session is still valid). Provides `useAuth()` hook for child components to access login state, user info, and logout function. Renders the router outlet with the Navbar.

**Key exports:** `useAuth()` hook, `AuthContext`.

#### `frontend/src/main.tsx`
**React entry point.** Renders the app into the DOM. Handles the OAuth callback flow: if the URL contains auth query params (token, login, avatar), extracts them, stores the JWT in sessionStorage, and redirects to the login page to complete the flow.

#### `frontend/src/router.tsx`
**Route definitions.** Uses React Router with a `RequireAuth` wrapper that redirects unauthenticated users to `/login`. Routes:
- `/login` → LoginPage
- `/auth/callback` → AuthCallback
- `/` → AnalyticsPage (default)
- `/activity` → ActivityPage
- `/templates` → TemplatesPage
- `/security` → SecurityPage
- `/compliance` → ComplianceDashboardPage
- `/dependencies` → DependencyDashboardPage
- `/graph` → KnowledgeGraphPage

---

### Frontend — API Layer

#### `frontend/src/api/client.ts`
**HTTP client.** Utility functions for all REST methods (`apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete`). Manages the auth token in sessionStorage. Automatically attaches `Authorization: Bearer` headers. Handles 401 responses (redirects to login), 503 responses (retries with backoff). Supports a `DEMO_MODE` flag that routes all calls to mock data instead of the backend.

**Key exports:** `apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete`, `DEMO_MODE`.

#### `frontend/src/api/auth.ts`
**Auth API calls.** Functions for: getting the GitHub OAuth login URL, verifying tokens, revoking sessions, checking auth status, managing AWS profiles (SSO login, profile switching, explicit credentials), and disconnecting AWS.

#### `frontend/src/api/activity.ts`
**Activity API calls.** Fetches paginated activity logs, performs undo/redo/retry actions, resolves conflicts. Each function has a demo mode fallback using mock data.

#### `frontend/src/api/repos.ts`
**Repo API calls.** Fetches the list of all org repos. Returns `Repo[]`.

#### `frontend/src/api/branches.ts`
**Branch API calls.** Fetches branches for a repo, creates/deletes/renames branches, gets/applies/deletes protections, imports/deletes rulesets. Includes a `fetchBranchProtection` mock for demo mode that returns synthetic protection data.

#### `frontend/src/api/alerts.ts`
**Alert API calls.** Fetches alerts, resolves/unresolves alerts, simulates test alerts, fetches inactive users.

#### `frontend/src/api/compliance.ts`
**Compliance API calls.** Fetches compliance scores, refreshes dashboard, saves/loads compliance config.

#### `frontend/src/api/dependencies.ts`
**Dependency API calls.** Fetches Dependabot alerts (org-wide and per-repo), enables/disables Dependabot, gets dependency summary.

#### `frontend/src/api/graph.ts`
**Graph API calls.** Fetches graph metadata, node edges, blast radius analysis, user impact analysis, risk ranking. Executes security queries and triggers graph aggregation.

#### `frontend/src/api/org.ts`
**Org API calls.** Fetches org config/features and actors (roles, teams, apps for bypass assignment).

#### `frontend/src/api/templates.ts`
**Template API calls.** CRUD for templates, applies templates to repos. Includes `buildConflictComparison()` utility that formats a diff between existing and template protection configs for display.

#### `frontend/src/api/exclusions.ts`
**Exclusion API calls.** CRUD for exclusion lists. `fetchResolvedRepos()` gets the pattern resolution breakdown (explicit repos, pattern matches, whitelisted repos, effective repos) for an exclusion list.

#### `frontend/src/api/ruleTemplates.ts`
**Rule template API calls.** CRUD for atomic rule templates.

#### `frontend/src/api/scanners.ts`
**Scanner API calls.** CRUD for scanners, runs scans, fetches scan results.

#### `frontend/src/api/widgets.ts`
**Widget API calls.** CRUD for dashboard widgets.

#### `frontend/src/api/mock.ts`
**Mock data provider.** Returns synthetic data for all API endpoints when `DEMO_MODE` is enabled. Includes mock repos, branches, activities, templates, alerts, compliance scores, dependencies, scanners, widgets, and exclusion lists. Simulates delays and realistic data structures.

---

### Frontend — Hooks

Each hook wraps React Query's `useQuery` or `useMutation` with the appropriate API function, query key, stale time, and cache invalidation logic.

#### `frontend/src/hooks/useActivity.ts`
Activity list query (auto-refetch every 15s). Mutations for undo, redo, retry, and conflict resolution. On success, invalidates activity, templates, branches, exclusions, and alert caches.

#### `frontend/src/hooks/useRepos.ts`
Repo list query with 30-second stale time.

#### `frontend/src/hooks/useBranches.ts`
Branch list, ruleset list, and branch protection queries. Mutations for create/delete/rename branches and manage protections. Invalidates branch and activity caches on success.

#### `frontend/src/hooks/useAlerts.ts`
Alert list query with 10-second refetch interval. Mutations for resolve/unresolve/simulate. Invalidates alert and activity caches.

#### `frontend/src/hooks/useTemplates.ts`
Template list and detail queries. Mutations for create/update/delete/apply. Invalidates template and activity caches.

#### `frontend/src/hooks/useExclusions.ts`
Exclusion list query. Resolved repos query (enabled only when an exclusion ID is provided). Mutations for create/update/delete. Invalidates exclusion, template, and activity caches.

#### `frontend/src/hooks/useCompliance.ts`
Compliance dashboard and config queries. Mutations for refresh and config update. Invalidates compliance caches.

#### `frontend/src/hooks/useDependencies.ts`
Dependency alert and summary queries. Mutations for enabling/disabling Dependabot. Invalidates dependency caches.

#### `frontend/src/hooks/useGraph.ts`
Graph metadata, node, blast radius, user impact, and security query hooks. Various stale times (5 min for metadata, 2 min for nodes).

#### `frontend/src/hooks/useOrgConfig.ts`
Org config and actors queries with 5-minute stale time.

#### `frontend/src/hooks/useRuleTemplates.ts`
Rule template list query. Mutations for create/update/delete with cache invalidation.

#### `frontend/src/hooks/useScanners.ts`
Scanner list, detail, and result queries. Mutations for create/update/delete/run. Invalidates scanner and activity caches.

#### `frontend/src/hooks/useWidgets.ts`
Widget list query. Mutations for create/update/delete with cache invalidation.

#### `frontend/src/hooks/useTheme.ts`
Theme context and hook. Manages light/dark mode with localStorage persistence. Detects system preference on first load.

---

### Frontend — Types

#### `frontend/src/types/Activity.ts`
`ActivityAction` enum covering all system operations (branch.create, template.apply, exclusion.update, webhook events, etc.). `ActivityEntry` interface with full audit fields including undo/retry payloads and conflict resolution state.

#### `frontend/src/types/Alert.ts`
`SecurityAlert` interface with severity levels (critical, high, medium, low), alert types (protection_removed, ruleset_disabled, repo_made_public, etc.), and resolution tracking (resolved, resolvedBy, resolvedAt).

#### `frontend/src/types/Branch.ts`
Simple `Branch` interface: name, protected flag, commit SHA.

#### `frontend/src/types/Repo.ts`
`Repo` interface: name, full_name, private, default_branch, description, language, updated_at.

#### `frontend/src/types/Compliance.ts`
`RepoComplianceScore` (repo name, score 0-100, per-rule details). `ComplianceRule` (id, name, description, weight, type, enabled). `ComplianceConfig` (array of rules, last updated timestamp).

#### `frontend/src/types/Dependabot.ts`
`DependencyAlert` (repo, package name, severity, CVE, ecosystem, version range, fix available). `DependencySummary` (counts by severity, total vulnerable repos).

#### `frontend/src/types/Org.ts`
`OrgFeatures` (auditLogs, rulesetsSupported, advancedSecurity flags). `OrgConfig` (features + last updated).

#### `frontend/src/types/RuleTemplate.ts`
`RuleTemplate` interface and `RuleTemplateType` enum (classic, branch_ruleset, tag_ruleset, push_ruleset).

#### `frontend/src/types/Scanner.ts`
`Scanner` (name, conditions, target repos, include future repos flag). `ScannerCondition` (branch patterns, required protection rules). `ComplianceViolation` and `ScanResult`.

#### `frontend/src/types/Template.ts`
The most complex type file. `BranchRule` (classic protection: require PRs, approvals, status checks, dismiss stale reviews, etc.). `TagRule` (tag creation/update/deletion restrictions). `PushRule` (file path restrictions, size limits, extension blocks). `RepoTemplate` combines all rule types with target branches, auto-apply flag, and exclusion list IDs. `ExclusionPattern` (id, type, value) and `ExclusionList` (repos, patterns, whitelist, force flags).

---

### Frontend — Pages

#### `frontend/src/pages/LoginPage.tsx`
Login page with GitHub authentication button. Displays app branding and directs users to the OAuth flow. In desktop mode, also shows AWS connection status.

#### `frontend/src/pages/AuthCallback.tsx`
OAuth callback handler. Extracts the auth token from URL query parameters, stores it, and redirects to the home page. Handles error cases by redirecting to login.

#### `frontend/src/pages/ActivityPage.tsx`
Activity log viewer. Displays a filterable, paginated list of all system actions. Each entry shows: action type (color-coded badge), actor, target, timestamp, and description. Expandable entries show diffs (via DiffViewer component). Action buttons for undo, redo, retry, and conflict resolution. Filters by repo, action type, actor, and date range.

#### `frontend/src/pages/TemplatesPage.tsx`
Template management hub. Two tabs: Protection Templates and Rule Templates. For protection templates: create/edit modal with branch rules, tag rules, push rules, target branches, auto-apply toggle, and exclusion list management. Exclusion list modal with explicit repo selection, pattern rule builder (dropdown for type + input for value), and whitelist management. Apply modal shows target repos, excluded repos (with async pattern resolution + loading indicator), and per-repo results. Cards display template name, rule counts, exclusion list summaries with pattern pills.

#### `frontend/src/pages/SecurityPage.tsx`
Security alerts dashboard. Displays alerts in a filterable list with severity-based color coding. Resolve/unresolve buttons. Alert details show the affected repo, event description, and timestamp. Inactive user detection section.

#### `frontend/src/pages/ComplianceDashboardPage.tsx`
Compliance scoring dashboard. Shows each repo's score as a gauge visualization (0-100). Per-rule breakdown shows which rules pass/fail. Config panel for editing rules, weights, and enabled state. Refresh button triggers full re-evaluation.

#### `frontend/src/pages/DependencyDashboardPage.tsx`
Dependabot alerts dashboard. Groups alerts by repo. Severity filtering (critical, high, medium, low). Each alert shows package name, CVE, ecosystem, and fix availability. Toggle buttons to enable/disable Dependabot per repo.

#### `frontend/src/pages/KnowledgeGraphPage.tsx`
Risk ranking visualization. Displays repos ranked by blast radius score. Each card shows the repo name, score breakdown (workflows, deps, access vectors), and a visual indicator.

#### `frontend/src/pages/AnalyticsPage.tsx`
Main dashboard with customizable widgets. Create/edit widgets that display security metrics or table data. Supports preset queries (e.g., "repos with critical vulns") or custom security graph queries. Includes a button to trigger graph aggregation.

---

### Frontend — Components

#### `frontend/src/components/Navbar.tsx`
Top navigation bar. Logo, page links (Analytics, Activity, Templates, Security, Compliance, Dependencies, Graph), mobile hamburger menu, theme toggle (light/dark), and logout button. Highlights the active page based on the current route.

#### `frontend/src/components/LoginButton.tsx`
GitHub login button using Material UI styling. Clicking it redirects to the OAuth authorization endpoint.

#### `frontend/src/components/UserAvatar.tsx`
User avatar display. Shows the GitHub avatar image with fallback to initials (first letter of username) if the image fails to load. Generates a deterministic background color from the username.

#### `frontend/src/components/UpdateOverlay.tsx`
Electron-only component. Shows an overlay notification when an app update is available. Displays download progress and installation status. Provides an "Install & Restart" button.

#### `frontend/src/components/DiffViewer.tsx`
JSON diff visualizer. Takes old and new objects, computes a line-by-line diff, and renders added lines (green), removed lines (red), and unchanged lines (gray) with line numbers. Used in the activity page to show what changed in each action.

#### `frontend/src/components/BranchRow.tsx`
Table row for branch display. Shows branch name, protection status badge, default branch indicator, and action buttons (delete, rename). Conditionally disables delete for the default branch.

#### `frontend/src/components/TagInput.tsx`
Reusable tag input field. Type a value and press Enter to add a tag. Click the X on a tag to remove it. Backspace on empty input removes the last tag. Used for entering target branches, repo names, etc.

#### `frontend/src/components/ProtectBranchModal.tsx`
Large form modal for configuring branch protection rules. Sections for: require pull request reviews (approvals count, dismiss stale, require code owner reviews), require status checks, require signed commits, enforce admins, restrict pushes, allow force pushes, allow deletions, require linear history, lock branch. Also configures branch rulesets with bypass actors, deployment requirements, and merge strategies.

#### `frontend/src/components/ProtectTagModal.tsx`
Form modal for tag ruleset configuration. Configure restrictions on tag creation, updates, and deletion. Signature requirements. Bypass actor assignment.

#### `frontend/src/components/ProtectPushModal.tsx`
Form modal for push ruleset configuration. File path restrictions (require/deny specific paths), maximum file size limits, blocked file extension list.

#### `frontend/src/components/RulesetShared.tsx`
Shared UI components used by all ruleset modals. Bypass actor selector (search and select from org roles, teams, and GitHub Apps). Rule toggle switches with labels and descriptions.

#### `frontend/src/components/ScannerModal.tsx`
Large form modal for creating/editing compliance scanners. Target selection (all repos or specific list, include future repos toggle). Condition builder with branch pattern matching and required protection rule specifications. Query-based condition support.

---

### Frontend — Utilities

#### `frontend/src/utils/queryOptions.ts`
`QUERY_OPTIONS` array defining available security query templates for the graph query engine. Each option has: id, label, description, parameter requirements (e.g., library name, team name), and UI metadata. Examples: "repos-dependent-on", "repos-deploying-to-prod", "repos-with-critical-vulnerabilities", "repos-with-outside-admins", "users-with-access-to".

---

### Frontend — Config

#### `frontend/vite.config.ts`
Vite configuration. React plugin. Dev server proxy: all `/api/*` and `/auth/*` requests forwarded to `http://localhost:4000` (the backend in dev mode).

#### `frontend/tailwind.config.js`
Tailwind CSS configuration. Custom `gh` color namespace with GitHub-themed colors. Custom shadows, animations (fade-in, slide-up, shine, gradient, pulse-once), and extended theme values.

#### `frontend/postcss.config.js`
PostCSS configuration loading Tailwind CSS and Autoprefixer plugins.

#### `frontend/tsconfig.json`
TypeScript config for the frontend. Strict mode, React JSX, ES2020 target.

#### `frontend/package.json`
Frontend dependencies: React 19, React Router 7, TanStack React Query 5, Tailwind CSS, Material UI, and dev tools (TypeScript, Vite, ESLint).

---

### Infrastructure — AWS CDK

#### `infra/cdk-stack.ts`
The main CDK stack (`GitHubControlHubStack`). Provisions:
- EC2 instance (configurable instance type, default t3.small) on the default VPC.
- Security group: HTTPS (443) open only to GitHub webhook IP ranges. No SSH access.
- IAM role: SSM Session Manager access, S3 read (for deploy artifact), Secrets Manager read (for app secrets), DynamoDB full CRUD on all 11 tables.
- User data script: installs Docker, enables it, generates a self-signed SSL certificate.
- Stack outputs: instance ID, public IP, webhook URL, SSM connection command.

#### `infra/cdk-app.ts`
CDK app entry point. Auto-detects the AWS account ID from `aws sts get-caller-identity`. Instantiates the stack with the detected account and region. Supports context variables for customization (e.g., `-c instanceType=t3.medium`).

#### `infra/package.json`
CDK project dependencies. Scripts for deploy, destroy, diff, and synth commands.

#### `infra/cdk.json`
CDK configuration. Points to `cdk-app.ts` as the app entry point (via `npx ts-node`).

---

### Desktop Electron App

#### `desktop-app/src/main.ts`
**Electron main process.** Creates the BrowserWindow (1440x900, min 1024x700) pointing to localhost:4321. Handles the OAuth flow by opening a fresh OAuth window with an isolated session (no cached cookies). IPC handlers for clearing GitHub sessions and triggering update installation. Auto-updater integration: waits for AWS auth to complete (polls `/auth/status` every 5 seconds for up to 5 minutes), fetches the system token from `/auth/system-token`, sets `GH_TOKEN` environment variable, then checks GitHub Releases for updates. Navigation guard: allows localhost and github.com, opens all other URLs in the system browser.

#### `desktop-app/src/preload.ts`
**Context bridge.** Exposes `electronAPI` to the renderer process (sandboxed). Available methods: platform info, app version, deep link handler, update status listener, install update trigger, and clear GitHub session. All communication goes through IPC — the renderer has no direct Node.js access.

#### `desktop-app/src/server.ts`
**Backend loader.** Requires the compiled Express server from `backend/dist/server.js`. Serves the frontend build from `frontend/dist/` as static files. SPA fallback: non-API routes (not starting with `/api`, `/auth`, `/health`) return `index.html` for client-side routing. Sets NODE_ENV=production and __STANDALONE__=1.

#### `desktop-app/src/bootstrap.ts`
**Startup initialization.** Resolves DynamoDB table names from the `STACK_NAME` environment variable (default prefix: `github-control-hub`). Loads secrets from AWS Secrets Manager: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SYSTEM_GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, GITHUB_ORG, JWT_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID. Auto-generates a random JWT secret if not provided. Warns but doesn't fail if secrets are unavailable (allows offline operation).

#### `desktop-app/afterPack.js`
**macOS code signing hook.** Runs after electron-builder packages the app. Performs ad-hoc code signing (no certificate) so that electron-updater recognizes builds from different CI runs as the same app. Two-step process: deep sign the entire bundle, then sign with a permissive designated requirement (bundle ID only). Skips on non-macOS platforms.

#### `desktop-app/package.json`
**Electron build configuration.** Version tracking (1.0.38). Build scripts: prebuild (compile backend + frontend + bundle deps), build:electron (compile Electron TypeScript), dev (full build + run), dist:mac/dist:win (build installers). electron-builder config: app ID, resource bundling (backend/dist, frontend/dist, backend node_modules), macOS DMG/ZIP targets, Windows NSIS/ZIP targets, GitHub Releases auto-update (owner and repo derived from the CI checkout).
