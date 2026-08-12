# AWS guardrails

Rules evaluated against live AWS state, in one or many accounts. The only part
of this app that touches AWS resources rather than GitHub.

## How it runs

A Lambda, invoked three ways — a 15-minute schedule, a CloudTrail event on a
covered resource, or a manual sweep from the app. All three run the same
function, so a manual run cannot behave differently from an automatic one.

## Shape of a rule

```
kind        what to check          (s3_https_only, log_retention_min)
mode        report | enforce       (enforce may also fix)
params      thresholds, names
accounts    which accounts         (empty = all, including future ones)
exclusions  what to skip
```

`evaluate()` for each kind is a **pure function** of resource state and params.
No AWS calls live in it, which is what makes the whole catalog testable without
AWS.

## Report and enforce

| Mode | Behaviour |
|---|---|
| `report` | Finds the violation, records the fix it *would* make, changes nothing |
| `enforce` | Also applies the fix, and records an undo payload |

Enforce needs two independent things: the rule set to enforce, **and** the
deployment granted write permissions. A read-only deployment still finds every
violation and still records the exact fix — AWS refuses the write, and the
finding says so in those words rather than surfacing a raw `AccessDenied`.

## Pages

- [Rules](rules.md) — the catalog, and what each one checks
- [Accounts](accounts.md) — running across dev / uat / prod
- [Exclusions](exclusions.md) — skipping resources deliberately left alone
- [Permissions](permissions.md) — the complete IAM inventory

## What it cannot do

It cannot read the contents of any bucket or any log line, cannot delete
anything, cannot grant anyone access to anything, and cannot become an
administrator of any account. Those are properties of IAM, not promises made by
this code — see [permissions](permissions.md).
