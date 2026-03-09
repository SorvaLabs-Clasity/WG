# GitHub Control Hub

An internal web dashboard for managing GitHub organization repositories, branches, and branch protections.

## Features

- GitHub OAuth login (organization-gated)
- View all repositories in your organization
- Browse branches per repository
- Create new branches
- Delete branches
- Apply branch protection rules (require PRs, prevent force pushes/deletions)
- Designed for future bulk operations, compliance scanning, and audit logging

## Tech Stack

| Layer          | Technologies                                           |
|----------------|--------------------------------------------------------|
| Frontend       | React, TypeScript, Vite, Material UI, TanStack Query, React Router |
| Backend        | Node.js, TypeScript, Express, Octokit                  |
| Auth           | GitHub OAuth, JWT                                      |
| Infrastructure | AWS Lambda, API Gateway, Secrets Manager, DynamoDB (optional) |
| IaC            | AWS SAM                                                |

## Prerequisites

- Node.js >= 18
- A GitHub OAuth App ([create one here](https://github.com/settings/developers))
  - **Homepage URL**: `http://localhost:5173`
  - **Authorization callback URL**: `http://localhost:4000/auth/github/callback`
- Membership in the target GitHub organization

## Setup

```bash
# Clone and enter the project
cd github-control-hub

# Copy env files and fill in your values
cp .env.example backend/.env
# Edit backend/.env with your GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_ORG, JWT_SECRET
```

## Local Development

### Backend (port 4000)

```bash
cd backend
npm install
npm run dev
```

### Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173 and click **Sign in with GitHub**.

## API Endpoints

| Method   | Path                                | Description               |
|----------|-------------------------------------|---------------------------|
| `GET`    | `/auth/github`                      | Redirect to GitHub OAuth  |
| `GET`    | `/auth/github/callback`             | OAuth callback → JWT      |
| `GET`    | `/api/repos`                        | List org repositories     |
| `GET`    | `/api/repos/:repo/branches`         | List branches             |
| `POST`   | `/api/repos/:repo/branches`         | Create a branch           |
| `DELETE` | `/api/repos/:repo/branches/:branch` | Delete a branch           |
| `GET`    | `/api/repos/:repo/protection/:branch` | Get branch protection   |
| `PUT`    | `/api/repos/:repo/protection/:branch` | Apply branch protection |

All `/api/*` endpoints require `Authorization: Bearer <jwt>`.

## AWS Deployment

The `infra/template.yaml` SAM template deploys the backend as a Lambda behind API Gateway.

```bash
cd backend && npm run build
cd ../infra
sam build
sam deploy --guided
```

Store your secrets (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, JWT_SECRET) in AWS Secrets Manager and pass the ARN as the `SecretsArn` parameter.

## Project Structure

```
github-control-hub/
├── frontend/           # React + Vite SPA
│   └── src/
│       ├── api/        # HTTP client utilities
│       ├── components/ # Reusable UI components
│       ├── hooks/      # TanStack Query hooks
│       ├── pages/      # Route pages
│       └── types/      # TypeScript interfaces
├── backend/            # Express API server
│   └── src/
│       ├── github/     # Octokit client & OAuth helpers
│       ├── middleware/  # JWT auth middleware
│       ├── routes/     # Express route handlers
│       ├── services/   # Business logic
│       └── utils/      # JWT utilities
└── infra/              # AWS SAM template
```

## License

Private — internal use only.
