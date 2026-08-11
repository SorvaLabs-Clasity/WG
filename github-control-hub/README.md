# GitHub Control Hub

A self-hosted GitHub governance platform for managing repository protections, compliance scoring, security alerting, and audit trails across your organization — with full undo/redo support.

## Features

### Repository & Branch Management
- View all org repositories and branches
- Create, delete, and rename branches
- Apply branch protection rules (classic or modern rulesets)
- Import/export rulesets as JSON

### Protection Templates
- Create reusable protection templates with branch rules, tag rules, and push rules
- Apply templates across multiple repos at once with conflict detection
- Auto-apply templates to newly created repositories via webhooks
- Manage exclusion lists for repos that should be skipped

### Compliance Dashboard
- Configurable compliance rules (branch protection, required files, outside collaborators, etc.)
- Per-repo compliance scoring (0–100) with rule-by-rule breakdowns
- Cached scores with on-demand or webhook-triggered refresh

### Custom Scanners
- Define custom compliance scanners with configurable conditions
- Target all repos, specific repos, or include future repos automatically
- Run manually or triggered by webhook events

### Security Alerts
- Real-time alerts for critical events:
  - Repository made public
  - Branch protection removed or modified (drift detection)
  - Rulesets disabled
  - Admin/team access changes
  - Suspicious activity (user pushing to many repos rapidly)
- Manual and auto-resolution

### Security Graph & Blast Radius Analysis
- Directed graph of org relationships: repos, teams, users, workflows, dependencies
- Blast radius analysis — what's affected if a repo is compromised
- User impact analysis — what repos/workflows can a user reach
- Risk ranking of all repos (based on workflows, vulnerabilities, access patterns)
- Advanced query engine for security investigations

### Dependency Vulnerability Tracking
- Org-wide Dependabot vulnerability overview
- Severity filtering (critical, high, medium, low)
- Enable/disable Dependabot per repo

### Activity Audit Trail
- Full audit log of all actions (branch changes, protection updates, template applications)
- Hierarchical activity trees for bulk operations
- Undo/redo/retry for all destructive actions
- Conflict detection when undoing overlapping changes

### Webhook Integration
- Receives GitHub webhook events with HMAC signature verification and replay protection
- Incrementally updates graph, compliance cache, and scanners on each event
- Auto-applies templates to new repos
- Generates alerts for security-relevant events

## Tech Stack

| Layer          | Technologies                                           |
|----------------|--------------------------------------------------------|
| Frontend       | React, TypeScript, Vite, Material UI, TanStack Query, React Router |
| Backend        | Node.js, TypeScript, Express, Octokit                  |
| Auth           | GitHub App (API access) + GitHub OAuth (user login), JWT |
| Database       | AWS DynamoDB (11 tables)                               |
| Secrets        | AWS Secrets Manager                                    |
| Infrastructure | AWS CDK (EC2, IAM, VPC, Security Groups)               |
| Deployment     | Docker (linux/amd64), deployed via S3 upload to EC2    |
| Desktop        | Electron (optional local mode)                         |

## Deployment Modes

### 1. EC2 Server (Production)

The primary deployment mode. A single Docker container on EC2 serves both the backend API and frontend SPA over HTTPS.

**Infrastructure** is provisioned via AWS CDK (`infra/cdk-stack.ts`):
- EC2 instance (t3.small) with Docker pre-installed
- Security group allowing HTTPS only from GitHub webhook IP ranges
- IAM role scoped to Secrets Manager, DynamoDB, and S3
- Self-signed SSL certificate for HTTPS
- SSM Session Manager access (no SSH needed)

**Deploy:**
```bash
./scripts/deploy.sh <instance-id>
```

This builds the Docker image, uploads it to EC2 via S3, and restarts the container.

### 2. Desktop App (Local Development)

An Electron app (`github-control-hub/desktop/`) that runs the backend locally on port 4321. Includes AWS credential management UI (profiles, SSO login, access keys) and auto-updates.

## GitHub App Setup

The backend authenticates to GitHub using a **GitHub App** (not a personal access token). This provides:
- Scoped permissions (only what the app needs)
- Tokens that auto-expire every hour
- No personal account exposure if compromised
- No user seat consumed

**Required App permissions:**
| Permission | Level | Purpose |
|---|---|---|
| Repository administration | Read & write | Branch protections, rulesets |
| Contents | Read & write | Template auto-apply to empty repos |
| Members | Read | Org member visibility |
| Organization administration | Read | Org config and audit logs |

**Required webhook events:** `push`, `pull_request`, `create`, `delete`, `repository`, `branch_protection_rule`, `repository_ruleset`, `member`, `team`, `issues`

## Environment Variables

Loaded from AWS Secrets Manager at startup (key: `{prefix}/secrets`):

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM) |
| `GITHUB_APP_INSTALLATION_ID` | App installation ID for your org |
| `GITHUB_CLIENT_ID` | OAuth App client ID (for user login) |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification secret |
| `GITHUB_ORG` | Target GitHub organization |
| `JWT_SECRET` | JWT signing key |

## DynamoDB Tables

All tables are prefixed with the stack name (default: `github-control-hub`):

| Table | Content |
|---|---|
| `{prefix}-activity` | Audit log with undo/redo payloads |
| `{prefix}-templates` | Protection templates |
| `{prefix}-scanners` | Scanner configs and results |
| `{prefix}-alerts` | Security alerts |
| `{prefix}-org-config` | Org configuration and feature flags |
| `{prefix}-auth-codes` | One-time OAuth codes (5-min TTL) |
| `{prefix}-graph-edges` | Security graph edges |
| `{prefix}-exclusions` | Template/scanner exclusion lists |
| `{prefix}-widgets` | Dashboard widgets |
| `{prefix}-compliance-cache` | Cached compliance scores |
| `{prefix}-rule-templates` | Reusable rule definitions |

## Local Development

```bash
cd github-control-hub

# Install dependencies
npm install

# Start backend (port 4000) and frontend (port 5173) concurrently
npm run dev
```

Requires a `.env` file in `backend/` with the environment variables listed above.

## Project Structure

```
github-control-hub/
├── frontend/                # React + Vite SPA
│   └── src/
│       ├── api/             # HTTP client utilities
│       ├── components/      # UI components (modals, navbar, diff viewer, etc.)
│       ├── hooks/           # TanStack Query hooks
│       ├── pages/           # Route pages (templates, compliance, security, graph, etc.)
│       └── types/           # TypeScript interfaces
├── backend/                 # Express API server
│   └── src/
│       ├── github/          # Octokit client, App token manager, OAuth
│       ├── middleware/       # JWT auth middleware
│       ├── routes/          # API route handlers
│       ├── services/        # Business logic (templates, scanners, compliance, graph, etc.)
│       ├── jobs/            # Background jobs (graph aggregator, audit log checker)
│       └── utils/           # JWT utilities
├── infra/                   # AWS CDK infrastructure stack
├── scripts/                 # Deploy script
└── Dockerfile               # Production container build
github-control-hub/desktop/  # Electron desktop app
```

## API Overview

| Area | Base Path | Key Operations |
|---|---|---|
| Auth | `/auth` | OAuth flow, token verification, AWS credential management |
| Repos | `/api/repos` | List repos, branches, create/delete/rename branches |
| Protection | `/api/repos/:repo` | Get/apply/remove branch protections and rulesets |
| Templates | `/api/templates` | CRUD + apply templates to repos |
| Scanners | `/api/scanners` | CRUD + run scans |
| Compliance | `/api/compliance` | Dashboard scores, rule config, refresh |
| Alerts | `/api/alerts` | List, resolve, simulate alerts |
| Graph | `/api/graph` | Blast radius, user impact, risk ranking, query engine |
| Dependencies | `/api/security` | Dependabot vulnerabilities, enable/disable |
| Activity | `/api/activity` | Audit log, undo/redo/retry |
| Webhooks | `/api/webhooks/github` | GitHub event receiver |

All `/api/*` endpoints require `Authorization: Bearer <jwt>`.

## License

Private — internal use only.
