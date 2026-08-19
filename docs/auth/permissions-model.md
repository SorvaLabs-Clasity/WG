# Permissions model

Who is allowed to do what, and who decides.

## Two different authorities

**GitHub decides repository actions.** The call is made with your token, so
GitHub applies your permissions. The app adds no check of its own and needs
none.

**The app decides its own settings.** Scanners, widgets, alarms, compliance
rules and AWS guardrails are the app's concepts; GitHub has never heard of them.
So the app gates those on membership of a team.

## The two admin teams

| Team | Controls | Default name |
|---|---|---|
| Control Hub admins | Scanners, widgets, alarms and email groups, security alerts, compliance rules, the Renovate bot name, pull request reminders, graph rebuilds, config import/export | `control-hub-admins` |
| AWS guardrail admins | AWS rules, exclusions, sweeps, enforce mode, audit-log streaming | `aws-guardrail-admins` |

Both are overridable with `CONTROL_HUB_ADMIN_TEAM` and `AWS_ADMIN_TEAM`.

They are deliberately separate. The person who curates branch-protection
settings is not necessarily the person who should be able to let an
application write to production S3 buckets.

**A config import cannot cross between them.** An export bundle carries scanners
and widgets *and* AWS guardrails in one file, so importing it is a write to both
sides. The AWS sections need the AWS team; a Control Hub admin importing a
bundle that contains them is refused and told which sections to remove. Without
that, the import route was a way to create an enforcing AWS guardrail while only
ever proving membership of the GitHub team.

Organization owners pass both checks.

## What "the app's own settings" covers

Anything with no GitHub equivalent, which is broader than it first looks. The
test that keeps this honest is `repro-undo.ts`: it reads every route file and
fails if a `post`, `put` or `delete` does not name an authorization guard, and
separately fails if a route file with writes is neither guarded nor listed as
deliberately exempt with a reason.

The compliance rule set was the last thing to be caught by it. Its router was
exempted as "read models over the graph" — true of everything in it except
`PUT /api/compliance/config`, which replaces the definition every repository in
the organization is scored against. `{"rules": []}` scores everything 100.

## Reading is open

Anyone signed in can see rules, findings, the access map and the activity log.
Knowing who can write to which repository is not privileged information inside
an organization — it is the thing people most often get wrong because nobody
could see it.

## Undo is gated as hard as the original action

Undoing something is doing something. Every undo is re-checked against what the
person could do *now*, per repository — being on the admin team says nothing
about whether you may touch a particular repo. Actions with no safe reversal
are refused rather than faked. See
[activity and undo](../features/activity-and-undo.md).
