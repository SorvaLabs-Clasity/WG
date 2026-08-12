# Testing

Seventeen suites, each a standalone script named `repro-*.ts`, run with `tsx`.
No framework.

```bash
cd github-control-hub/backend
npx tsx repro-accounts.ts
```

## Why this shape

Each file reproduces a specific failure and then asserts it stays fixed. The
names read as claims about behaviour, not as coverage:

> `PASS  a role that cannot be assumed does not end the sweep`
> `PASS  an entry with no id is skipped rather than written under a new one`

A test that needs a mocking framework to express usually means the seam is in
the wrong place.

## The suites

| Suite | Guards |
|---|---|
| `repro-queries` | The graph-backed security checks |
| `repro-engine` | Guardrail engine safety — report never writes |
| `repro-guardrails` | Rule evaluation |
| `repro-accounts` | Multi-account sweeps, credential chain, deploy scoping |
| `repro-leastprivilege` | **What the IAM does not contain** |
| `repro-accessmap` | Access-path derivation |
| `repro-activity` | Activity lookups and indexes |
| `repro-retention` | TTL stamping |
| `repro-undo` | Undo gating; every write route names its guard |
| `repro-authz` | Authorization |
| `repro-membership` | Org membership |
| `repro-token` | GitHub App token refresh |
| `repro-ratelimit` | Rate-limit reporting and countdown |
| `repro-config` | Config export/import semantics |
| `repro-prefs` | Remembered AWS profile |
| `repro-setupauth` | Setup-time auth |
| `repro-repodetails` | Repository detail assembly |

## Two unusual ones

**`repro-leastprivilege`** reads the shipped CDK and CloudFormation and asserts
what they do *not* contain — no `iam:` action, no wildcard `AssumeRole`, no
administrator role, no unconditional write grant. It is the only test whose
failure means "someone widened the blast radius".

**`repro-undo`** greps the route files to check every write route names an
authorization guard. Adding a route without one fails the suite.

## Running everything

```bash
for t in repro-*.ts; do echo "== $t"; npx tsx "$t" | tail -1; done
```

Plus `npx tsc --noEmit` in `backend`, `frontend`, `desktop` and `infra`.
