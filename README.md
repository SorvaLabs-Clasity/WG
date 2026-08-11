# GitHub Control Hub

A desktop application for managing GitHub organization security — branch protection templates, compliance scanning, dependency monitoring, security alerts, and analytics.

Built with Electron + React + Express + AWS DynamoDB.

---

## Prerequisites

- **Node.js 20+** and npm
- **AWS CLI** configured with credentials (`aws configure`)
- **GitHub account** with an organization
- **Git**

---

## 1. GitHub Setup

### Create an Organization

If you don't have one, create a GitHub org at https://github.com/organizations/plan.

### Create an OAuth App

1. Go to https://github.com/settings/developers (or your org's settings > Developer settings > OAuth Apps)
2. Click **New OAuth App**
3. Fill in:
   - **Application name**: `GitHub Control Hub`
   - **Homepage URL**: `http://localhost:4321`
   - **Authorization callback URL**: `http://localhost:4321/auth/callback`
4. Click **Register application**
5. Copy the **Client ID**
6. Generate and copy the **Client Secret**

### Create a Personal Access Token (System Token)

This token is used for org-level API operations (dependabot alerts, branch protection, etc.).

1. Go to https://github.com/settings/tokens (Fine-grained or Classic)
2. For a **Classic token**, select these scopes:
   - `repo` (full control of private repositories)
   - `admin:org` (read and write org and team membership)
   - `read:user`
3. Copy the token — this becomes your `SYSTEM_GITHUB_TOKEN`

### Create a Webhook (Optional)

For real-time security alerts when branch protections change:

1. Go to your org settings > Webhooks > Add webhook
2. **Payload URL**: Your backend URL + `/webhooks/github` (e.g., `https://your-domain/webhooks/github`)
3. **Content type**: `application/json`
4. **Secret**: Generate a random string — this becomes your `GITHUB_WEBHOOK_SECRET`
5. **Events**: Select "Branch protection rules", "Repositories", "Organization", "Members"

---

## 2. AWS Setup

### Configure AWS Credentials

```bash
aws configure
# Enter your Access Key ID, Secret Access Key, and region (default: us-east-1)
```

Or use AWS SSO:
```bash
aws sso login --profile your-profile
```

### Create DynamoDB Tables

The app needs these DynamoDB tables. All use `id` (String) as the partition key unless noted:

| Table Name | Partition Key | Sort Key |
|---|---|---|
| `github-control-hub-activity` | `id` (S) | — |
| `github-control-hub-templates` | `id` (S) | — |
| `github-control-hub-rule-templates` | `id` (S) | — |
| `github-control-hub-scanners` | `id` (S) | — |
| `github-control-hub-alerts` | `id` (S) | — |
| `github-control-hub-org-config` | `id` (S) | — |
| `github-control-hub-auth-codes` | `code` (S) | — |
| `github-control-hub-graph-edges` | `pk` (S) | `sk` (S) |
| `github-control-hub-exclusions` | `id` (S) | — |
| `github-control-hub-widgets` | `id` (S) | — |
| `github-control-hub-compliance-cache` | `id` (S) | — |

You can create these via the AWS Console or CLI:

```bash
# Example for one table:
aws dynamodb create-table \
  --table-name github-control-hub-activity \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# For graph-edges (has a sort key):
aws dynamodb create-table \
  --table-name github-control-hub-graph-edges \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

Enable TTL on the `auth-codes` table (field: `ttl`):
```bash
aws dynamodb update-time-to-live \
  --table-name github-control-hub-auth-codes \
  --time-to-live-specification Enabled=true,AttributeName=ttl
```

### Create a Secret in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name "github-control-hub/secrets" \
  --secret-string '{
    "GITHUB_CLIENT_ID": "your-oauth-client-id",
    "GITHUB_CLIENT_SECRET": "your-oauth-client-secret",
    "SYSTEM_GITHUB_TOKEN": "ghp_your-personal-access-token",
    "GITHUB_WEBHOOK_SECRET": "your-webhook-secret"
  }'
```

---

## 3. Install Dependencies

```bash
# Backend
cd github-control-hub/backend
npm install

# Frontend
cd ../frontend
npm install

# Desktop App
cd ../../github-control-hub/desktop
npm install
```

---

## 4. Running in Dev Mode

### Option A: Desktop App (recommended)

This starts the backend, serves the frontend, and opens the Electron window — all in one:

```bash
cd github-control-hub/desktop
npm run dev
```

The app will:
1. Build the backend and frontend
2. Start an Express server on port 4321
3. Open the Electron window at `http://localhost:4321/login`

### Option B: Web Mode (backend + frontend separately)

**Terminal 1 — Backend:**
```bash
cd github-control-hub/backend
npm run dev
```
Starts on `http://localhost:4000`

**Terminal 2 — Frontend:**
```bash
cd github-control-hub/frontend
npm run dev
```
Starts on `http://localhost:5173`

For web mode, the backend still loads secrets (including `GITHUB_ORG`) from AWS Secrets Manager — same as the desktop app.

---

## 5. Building the Desktop App

### Build for your platform

```bash
cd github-control-hub/desktop

# macOS
npm run dist:mac

# Windows
npm run dist:win

# Both
npm run dist
```

The installer will be in the `release/` folder.

### Update the publish target

In `github-control-hub/desktop/package.json`, update the `publish` section to point to your repo:

```json
"publish": {
  "provider": "github",
  "owner": "your-github-username-or-org",
  "repo": "your-repo-name",
  "private": true
}
```

---

## 6. Auto-Updates & Releases

### GitHub Actions Workflow

The `.github/workflows/release.yml` workflow automatically builds and publishes the desktop app when you push to `main`.

It:
1. Builds the backend and frontend
2. Packages the Electron app for macOS and Windows
3. Publishes installers to GitHub Releases

Make sure your repo has the `GITHUB_TOKEN` secret available (it's automatic for GitHub Actions).

### How auto-updates work

When the desktop app starts:
1. It waits for AWS auth to be ready (needs `SYSTEM_GITHUB_TOKEN` from Secrets Manager)
2. Sets `GH_TOKEN` for `electron-updater`
3. Checks GitHub Releases for a newer version
4. Downloads and installs the update automatically

### Bumping the version

Before pushing a release:
```bash
cd github-control-hub/desktop
npm version patch  # or minor, or major
```

Then push to `main` — the workflow handles the rest.

---

## 7. Environment Variables Reference

| Variable | Required | Source | Description |
|---|---|---|---|
| `GITHUB_ORG` | Yes | AWS Secrets Manager | Target GitHub organization name |
| `GITHUB_CLIENT_ID` | Yes | AWS Secrets Manager | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | AWS Secrets Manager | OAuth App client secret |
| `SYSTEM_GITHUB_TOKEN` | Yes | AWS Secrets Manager | PAT with org admin permissions |
| `GITHUB_WEBHOOK_SECRET` | Optional | AWS Secrets Manager | Webhook signature verification |
| `JWT_SECRET` | Auto | Auto-generated | Session signing key (random per app start) |
| `AWS_REGION` | No | Defaults to `us-east-1` | AWS region |
| `PORT` | No | Set by desktop app | Server port (default: `4321` desktop, `4000` web) |
| `BACKEND_URL` | No | Set by desktop app | Backend URL for OAuth redirects |
| `FRONTEND_URL` | No | Set by desktop app | Frontend URL for OAuth redirects |
| `STACK_NAME` | No | Defaults to `github-control-hub` | DynamoDB table name prefix |

---

## Project Structure

```
WG/
├── github-control-hub/
│   ├── backend/           # Express API server
│   │   ├── src/
│   │   │   ├── routes/    # API endpoints (auth, templates, alerts, etc.)
│   │   │   ├── services/  # Business logic
│   │   │   ├── github/    # GitHub API client & OAuth
│   │   │   ├── middleware/ # Auth middleware
│   │   │   ├── utils/     # JWT, DynamoDB, token store
│   │   │   └── jobs/      # Graph aggregator, audit log checker
│   │   └── package.json
│   └── frontend/          # React SPA (Vite + Tailwind)
│       ├── src/
│       │   ├── pages/     # TemplatesPage, SecurityPage, AnalyticsPage, etc.
│       │   ├── components/ # Shared UI components
│       │   ├── hooks/     # React Query hooks
│       │   ├── api/       # API client functions
│       │   └── types/     # TypeScript types
│       └── package.json
├── github-control-hub/desktop/  # Electron wrapper
│   ├── src/
│   │   ├── main.ts        # Electron main process
│   │   ├── preload.ts     # Context bridge
│   │   ├── bootstrap.ts   # AWS config resolution
│   │   └── server.ts      # Express server loader
│   └── package.json       # electron-builder config
└── .github/workflows/
    └── release.yml        # CI/CD for releases
```
