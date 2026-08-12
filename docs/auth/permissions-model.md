# Permissions model

Who is allowed to do what, and who decides.

## Two different authorities

**GitHub decides repository actions.** The call is made with your token, so
GitHub applies your permissions. The app adds no check of its own and needs
none.

**The app decides its own settings.** Templates, exclusion lists, scanners and
AWS guardrails are the app's concepts; GitHub has never heard of them. So the
app gates those on membership of a team.

## The two admin teams

| Team | Controls | Default name |
|---|---|---|
| Control Hub admins | Templates, exclusions, scanners, config import/export | `control-hub-admins` |
| AWS guardrail admins | AWS rules, accounts, sweeps, enforce mode | `aws-guardrail-admins` |

Both are overridable with `CONTROL_HUB_ADMIN_TEAM` and `AWS_ADMIN_TEAM`.

They are deliberately separate. The person who curates branch-protection
templates is not necessarily the person who should be able to let an
application write to production S3 buckets.

Organization owners pass both checks.

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
