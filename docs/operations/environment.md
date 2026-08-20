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

## `GITHUB_ACCOUNT_ID` — confining GitHub to one AWS account

Optional. The AWS account id where the GitHub half of this app belongs.

The desktop app reads its secrets from whichever account the operator signed
into, so by default signing into production and opening the Repos tab is a
request for GitHub credentials in production. Setting this to your development
account's id means every GitHub route refuses anywhere else, naming both the
account it wants and the one you are in.

**The AWS tab is deliberately exempt.** Guardrails are usually the reason to run
this app in production at all, and they carry no GitHub credentials — so the
account keeps exactly the half it is meant to have.

Unset means unrestricted, which is what every existing install is. A gate that
switched itself on would lock people out of an app that worked yesterday, and
this is a deployment decision rather than a default.

Enforced in `middleware/githubGate.ts` at the router level, not in the screens:
a hidden tab is a suggestion, and the routes are reachable by anything that can
talk to the backend. `repro-githubgate.ts` asserts every GitHub router carries
the gate, that the AWS one does not, and that all of them still authenticate.

An account that cannot be read is refused rather than allowed — asking for
GitHub to be confined means "unsure" is not good enough.

## Frontend build-time

Baked in at build, not read at runtime.

| Variable | What |
|---|---|
| `VITE_COMPANY_NAME` | Shown in the app |
| `VITE_API_URL` | Overrides the API base; unset means same origin |
| `VITE_DEMO_MODE` | Skips authentication. Never set this for a real build |
