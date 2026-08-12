# Environment variables

Almost nothing needs setting by hand. Secrets come from Secrets Manager, table
names are derived from a prefix, and the desktop app sets its own ports.

## From Secrets Manager

Stored as one JSON document at `<STACK_NAME>/secrets`, loaded at startup.

| Key | Required | What |
|---|---|---|
| `GITHUB_ORG` | yes | The organization login, case-sensitive |
| `GITHUB_CLIENT_ID` | yes | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | yes | OAuth App client secret |
| `GITHUB_APP_ID` | yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | The `.pem`, newlines or literal `\n` both accepted |
| `GITHUB_APP_INSTALLATION_ID` | yes | From the install URL |
| `SYSTEM_GITHUB_TOKEN` | fallback | Used only where no App token is available |
| `GITHUB_WEBHOOK_SECRET` | for webhooks | Signature verification |
| `JWT_SECRET` | no | Generated per start if absent |

## Set in the environment

| Variable | Default | What |
|---|---|---|
| `STACK_NAME` | `github-control-hub` | Prefix for every table and resource name |
| `AWS_REGION` | `us-east-1` | |
| `AWS_PROFILE` | remembered, then `default` | Desktop only; see [AWS credentials](../auth/aws-credentials.md) |
| `PORT` | `4321` desktop, `4000` web | |
| `BACKEND_URL` / `FRONTEND_URL` | set by the desktop app | OAuth redirect construction |
| `CONTROL_HUB_ADMIN_TEAM` | `control-hub-admins` | Team gating templates and config |
| `AWS_ADMIN_TEAM` | `aws-guardrail-admins` | Team gating AWS rules and accounts |
| `ACTIVITY_RETENTION_MONTHS` | `13` | Activity TTL |
| `GUARDRAIL_FUNCTION_NAME` | `<prefix>-guardrail-enforcer` | |
| `GUARDRAIL_ROLE_NAME` | `<prefix>-guardrail-access` | The one role the app may assume |
| `__SERVER_MODE__` | unset | Set on EC2. Disables desktop-only endpoints and profile handling |

## Table names

Derived from `STACK_NAME`, but each is individually overridable —
`ACTIVITY_TABLE`, `TEMPLATES_TABLE`, `GRAPH_EDGES_TABLE`, `ORG_CONFIG_TABLE`
and so on. Setting them by hand is only useful when sharing tables across
installs, which is rarely what you want.

`ACTIVITY_TABLE` doubles as the switch between DynamoDB and the local JSON
fixture: unset, the app reads `data/graph-edges.json` instead. That is what
lets the test suites run with no AWS at all.

## Frontend build-time

Baked in at build, not read at runtime.

| Variable | What |
|---|---|
| `VITE_COMPANY_NAME` | Shown in the app |
| `VITE_API_URL` | Overrides the API base; unset means same origin |
| `VITE_DEMO_MODE` | Skips authentication. Never set this for a real build |
