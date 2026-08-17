# Environment variables

Almost nothing needs setting by hand. Secrets come from Secrets Manager, table
names are derived from a prefix, and the desktop app sets its own ports.

## From Secrets Manager

Stored as one JSON document at `<STACK_NAME>/secrets`, loaded at startup.

| Key | Required | What |
|---|---|---|
| `GITHUB_ORG` | yes | The name as it appears in `github.com/orgs/<name>` |
| `GITHUB_CLIENT_ID` | yes | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | yes | OAuth App client secret |
| `GITHUB_APP_ID` | yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | The `.pem`, newlines or literal `\n` both accepted |
| `GITHUB_APP_INSTALLATION_ID` | yes | From the install URL |
| `SYSTEM_GITHUB_TOKEN` | fallback | Used only where no App token is available |
| `JWT_SECRET` | no | Generated per start if absent |

## The webhook secret, on its own

`GITHUB_WEBHOOK_SECRET` is **not** in the bundle above. It is stored by itself,
as a bare value rather than JSON, at `<STACK_NAME>/webhook-secret`.

Only the receiver Lambda reads it, and its IAM grants that secret and nothing
else. The receiver is the one component reachable from the internet, and it
has to handle bytes nobody has authenticated yet in order to authenticate
them; sharing the bundle meant a bug on that path surrendered
`GITHUB_APP_PRIVATE_KEY` rather than the ability to check signatures.

Rotating it means changing it in GitHub and here. Nowhere else — nothing in
the desktop app or the worker reads it, because webhooks are authenticated at
the edge before anything reaches the queue.

## Set in the environment

| Variable | Default | What |
|---|---|---|
| `STACK_NAME` | `github-control-hub` | Prefix for every table and resource name |
| `AWS_REGION` | `us-east-1` | |
| `AWS_PROFILE` | remembered, then `default` | Desktop only; see [AWS credentials](../auth/aws-credentials.md) |
| `PORT` | `4321` desktop, `4000` web | |
| `BACKEND_URL` / `FRONTEND_URL` | set by the desktop app | OAuth redirect construction |
| `CONTROL_HUB_ADMIN_TEAM` | `control-hub-admins` | Team gating scanners, widgets, alerts and config import |
| `AWS_ADMIN_TEAM` | `aws-guardrail-admins` | Team gating AWS rules and accounts |
| `ACTIVITY_RETENTION_MONTHS` | `13` | Activity TTL |
| `GUARDRAIL_FUNCTION_NAME` | `<prefix>-guardrail-enforcer` | |
| `WEBHOOK_QUEUE_URL` | set by CDK | Read by the receiver; where a verified delivery is sent |
| `WEBHOOK_DELIVERIES_TABLE` | set by CDK | Read by the worker; the dedup lock table |

## Table names

Derived from `STACK_NAME`, but each is individually overridable —
`ACTIVITY_TABLE`, `GRAPH_EDGES_TABLE`, `ORG_CONFIG_TABLE`
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
