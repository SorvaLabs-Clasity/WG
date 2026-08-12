# Security

What this application can do, what it deliberately cannot, and how those
properties are held in place.

| | |
|---|---|
| [AWS permissions](../aws-guardrails/permissions.md) | Every IAM grant, and what is absent |
| [Permissions model](../auth/permissions-model.md) | Who is allowed to do what |
| [Review findings](review-2026-08.md) | The last full review, and what it changed |

## Held by tests, not by habit

Two suites assert the absence of things, because absence is what nobody
notices going missing.

**`repro-leastprivilege.ts`** reads the shipped CDK and CloudFormation and
fails if an `iam:` action, a wildcard `AssumeRole`, an administrator role, or
an unconditional write grant appears.

**`repro-appsec.ts`** fails if `index.html` regains a remote origin, the
content-security policy is weakened, a process is spawned through a shell, the
Electron renderer is given node access, the webhook stops failing closed, or a
credential shape appears in source.

Both are cheap to run and are the reason a regression here shows up as a red
test rather than as an incident.

## The properties

**No remote code.** Fonts and icons are bundled. Nothing in the page references
another origin, and the policy forbids script from anywhere but this one.

**No shell.** One process is ever spawned — `aws sso login` — with an
argument list, no shell, and an allow-listed profile name.

**No credential in the repository.** Everything comes from Secrets Manager at
runtime.

**No administrator anywhere.** The app can assume exactly one role name, and
that role reads configuration. See
[AWS permissions](../aws-guardrails/permissions.md).

**Writes are the caller's.** Repository changes use the signed-in person's
token, so GitHub decides. The app holds no authority of its own.

**Webhooks fail closed.** HMAC, compared in constant time, against the raw
body, with replay rejection. No secret means no delivery is accepted.
