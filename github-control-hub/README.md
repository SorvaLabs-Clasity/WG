# GitHub Control Hub

A self-hosted GitHub governance platform for managing repository protections, compliance scoring, security alerting, and audit trails across your organization — with full undo/redo support.

## Features

### Repository & Branch Management
- View all org repositories and branches
- Create, delete, and rename branches
- Apply branch protection rules (classic or modern rulesets)
- Import/export rulesets as JSON

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
- Full audit log of all actions (branch changes, protection updates, scanner runs)
- Hierarchical activity trees for bulk operations
- Undo/redo/retry for all destructive actions
- Conflict detection when undoing overlapping changes

### Webhook Integration
- Receives GitHub webhook events via API Gateway, with HMAC signature verification and replay protection
- Incrementally updates graph, compliance cache, and scanners on each event
- Generates alerts for security-relevant events

### Alarms & Email Notifications
- Thresholds on any dashboard widget, with conditions specific to what that widget measures
- Security alerts emailed within seconds of the event, above a severity floor you choose
- Email groups are SNS topics managed in the app, with confirmation status shown per recipient
- Fires on crossing into breach, not every cycle; two clean checks required before an all-clear

### Enterprise Audit Log
- GitHub Enterprise audit events streamed to S3 and indexed into the Activity page
- Raw events kept complete in S3; only consequential events indexed, to keep the feed readable

## Tech Stack

| Layer          | Technologies                                           |
|----------------|--------------------------------------------------------|
| Frontend       | React, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router |
| Backend        | Node.js, TypeScript, Express, Octokit                  |
| Auth           | GitHub App (API access) + GitHub OAuth (user login), JWT |
| Database       | AWS DynamoDB (13 tables)                               |
| Secrets        | AWS Secrets Manager                                    |
| Infrastructure | AWS CDK (API Gateway, Lambda, SQS, SNS, EventBridge, S3, IAM) |
| Deployment     | `cdk deploy` — bundles and deploys the Lambdas directly from source |
| Desktop        | Electron (runs the backend locally, talking to AWS directly) |

## Deployment Modes

### 1. Webhook Pipeline (AWS, always on)

GitHub webhook events are the only part of the backend that runs continuously in AWS. There is no long-lived server: API Gateway terminates HTTPS with a valid ACM certificate, a receiver Lambda verifies the HMAC signature and enqueues the event to SQS, and a worker Lambda drains the queue — writing activity rows, generating alerts, and updating the compliance cache and security graph. Failed deliveries land in a dead-letter queue after five attempts. A separate scheduled Lambda sweeps AWS accounts for the guardrails feature.

**Infrastructure** is provisioned via AWS CDK (`infra/cdk-stack.ts`):
- API Gateway REST API, restricted by resource policy to GitHub's published webhook IP ranges
- Receiver and worker Lambdas, connected by an SQS queue (with a DLQ)
- A scheduled Lambda for AWS guardrail enforcement, with its own DLQ
- A scheduled Lambda evaluating widget alarms, publishing to SNS when one crosses its threshold
- An S3-triggered Lambda ingesting the enterprise audit log stream
- SNS topics (`{prefix}-notify-*`) for alarm and security-alert email; the Lambdas may publish to
  them and nothing else — no Subscribe, no CreateTopic
- IAM role scoped to Secrets Manager, DynamoDB, and (for guardrails) read-only AWS config APIs
- No inbound network surface beyond API Gateway — there is no EC2 instance, no security group, no SSH

**Deploy:**
```bash
cd infra && npx cdk deploy -c enforce=true
```
`-c enforce=true` is not optional if you want guardrails to remediate. Without it the engine still
finds violations and reports the fix it would make, but is not granted the three write actions, so
nothing is ever changed. This is the entire deployment step. There is no separate build-and-upload — CDK bundles the Lambdas straight from `backend/src` and deploys them along with the rest of the stack.

### 2. Desktop App (REST API + UI, local or production use)

The REST API (repos, compliance, scanners, graph, activity, etc.) and the frontend SPA are not deployed anywhere in AWS — they run inside an Electron app (`github-control-hub/desktop/`), which starts the same Express backend locally on port 4321 and talks to DynamoDB and Secrets Manager directly using the operator's AWS credentials. This is true both for local development and for day-to-day production use: everyone who needs to use the app runs the desktop client with credentials for the target AWS account. Includes AWS credential management UI (profiles, SSO login, access keys) and auto-updates.

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
| Contents | Read & write | Branch creation; required-file compliance checks |
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
| `GITHUB_ORG` | Target GitHub organization |
| `JWT_SECRET` | JWT signing key |

The webhook signing secret is deliberately **not** in that bundle. It lives by
itself at `{prefix}/webhook-secret`, read only by the internet-facing receiver
Lambda, so a bug in the one component that must touch unauthenticated bytes
cannot reach the GitHub App private key. See
[environment.md](../docs/operations/environment.md).

## DynamoDB Tables

All tables are prefixed with the stack name (default: `github-control-hub`):

| Table | Content |
|---|---|
| `{prefix}-activity` | Audit log with undo/redo payloads |
| `{prefix}-scanners` | Custom compliance scanner configs and results |
| `{prefix}-alerts` | Security alerts |
| `{prefix}-org-config` | Org feature flags, compliance rule config, monitored AWS accounts |
| `{prefix}-auth-codes` | One-time OAuth codes (5-min TTL) |
| `{prefix}-graph-edges` | Security graph edges |
| `{prefix}-widgets` | Dashboard widgets |
| `{prefix}-compliance-cache` | Cached compliance scores |
| `{prefix}-aws-guardrails` | AWS guardrail rule definitions |
| `{prefix}-aws-exclusions` | AWS guardrail exclusion lists |
| `{prefix}-aws-findings` | AWS guardrail scan findings |
| `{prefix}-alarms` | Widget alarms, their state, email groups, notification settings |
| `{prefix}-webhook-deliveries` | Webhook replay-protection markers (created by the CDK stack, not `setup-aws-account.sh`) |

An account set up before the Templates feature was removed may still hold `{prefix}-templates`,
`{prefix}-rule-templates` and `{prefix}-exclusions`. Nothing reads them. They are left in place
rather than dropped — an unread table costs nothing at `PAY_PER_REQUEST`, and a deletion cannot be
undone.

## Local Development

```bash
cd github-control-hub

# Install dependencies
npm install

# Start backend (port 4000) and frontend (port 5173) concurrently
npm run dev
```

No `.env` file is needed. The backend reads its configuration from AWS Secrets Manager at startup
using whatever AWS credentials are active, which is the same path the desktop app and the Lambdas
take — so there is one place credentials live and one way they are loaded.

## Project Structure

```
github-control-hub/
├── frontend/                # React + Vite SPA
│   └── src/
│       ├── api/             # HTTP client utilities
│       ├── components/      # UI components (modals, navbar, diff viewer, etc.)
│       ├── hooks/           # TanStack Query hooks
│       ├── pages/           # Route pages (compliance, security, graph, etc.)
│       └── types/           # TypeScript interfaces
├── backend/                 # Express API server (runs inside the desktop app, not deployed to AWS)
│   └── src/
│       ├── github/          # Octokit client, App token manager, OAuth
│       ├── middleware/      # JWT auth middleware
│       ├── routes/          # API route handlers
│       ├── services/        # Business logic (scanners, compliance, graph, etc.)
│       ├── webhooks/        # Receiver/worker Lambda handlers (API Gateway → SQS → worker)
│       ├── alarms/          # Widget alarm evaluation, email templating, SNS delivery
│       ├── audit/           # Enterprise audit log ingestion (S3 → activity rows)
│       ├── aws-guardrails/  # Scheduled Lambda handler for AWS guardrail enforcement
│       ├── jobs/            # Background jobs (graph aggregator)
│       └── utils/           # Shared utilities
└── infra/                   # AWS CDK stack (API Gateway, Lambda, SQS, DynamoDB, IAM)
github-control-hub/desktop/   # Electron app — runs the backend locally against AWS
scripts/                      # Account setup and migration scripts (repo root, not github-control-hub/)
```

## API Overview

| Area | Base Path | Key Operations |
|---|---|---|
| Auth | `/auth` | OAuth flow, token verification, AWS credential management |
| Repos | `/api/repos` | List repos, branches, create/delete/rename branches |
| Protection | `/api/repos/:repo` | Get/apply/remove branch protections and rulesets |
| Scanners | `/api/scanners` | CRUD + run scans |
| Compliance | `/api/compliance` | Dashboard scores, rule config, refresh |
| Alerts | `/api/alerts` | List, resolve, simulate alerts |
| Graph | `/api/graph` | Blast radius, user impact, risk ranking, query engine |
| Access | `/api/access` | Access map summary, per-user/per-repo access, refresh |
| Dependencies | `/api/security` | Dependabot vulnerabilities, enable/disable |
| Activity | `/api/activity` | Audit log, undo/redo/retry |
| Org | `/api/org` | Webhook pipeline health, org feature flags, actor list |
| Widgets | `/api/widgets` | Dashboard widget CRUD |
| Config | `/api/config` | Export/import org configuration |
| AWS Guardrails | `/api/aws` | Guardrail rules, findings, exclusions, monitored accounts |
| Alarms | `/api/alarms` | Widget alarms, email groups and members, security-alert settings (admin only) |

All `/api/*` endpoints require `Authorization: Bearer <jwt>`.

GitHub webhook deliveries do not go through this Express API at all — they land on the API Gateway URL from the CDK stack's `WebhookUrl` output, handled entirely by the receiver/worker Lambdas described above.

## License

Private — internal use only.
