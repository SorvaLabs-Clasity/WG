# Webhooks

GitHub POSTs to `https://<ec2>/api/webhooks/github`. This is the only reason the
EC2 instance exists.

## Security

- The security group allows 443 from **GitHub's four webhook CIDR ranges only**
- Every delivery's HMAC signature is verified against the shared secret
- The handler responds `202` *before* doing slow work, so GitHub does not time
  out and retry

## Events handled

| Event | Recorded as |
|---|---|
| `repository` created / unarchived | repo appeared |
| `repository` publicized / privatized | visibility changed |
| `branch_protection_rule` created / edited / deleted | protection changed |
| `repository_ruleset` created / edited / deleted | ruleset changed |
| `delete` (branch) | branch deleted |
| `member` added / removed | org membership changed |
| `team` added_to / removed_from repository | team access changed |

These are the things nobody did through the app. Without them the activity log
would only show the app's own actions, which is the least interesting half of an
audit trail.

## Side effect: auto-apply templates

On `repository.created`, any template marked *auto-apply on new repo* is applied
— after a five-second pause, because GitHub needs a moment to finish
provisioning a repository before its API accepts branch and protection calls.
Exclusion lists are checked first.

## Health

The endpoint failing is invisible: the app keeps serving whatever it last heard
and looks exactly as it does when nothing has happened. The Activity page
therefore shows how long since GitHub last said anything:

| Status | Meaning |
|---|---|
| Receiving events | under 24 hours |
| Quiet | 24–72 hours |
| Stale | over 72 hours |
| Unknown | never heard anything |

The thresholds are wide on purpose — a quiet weekend is not an outage.

## If the EC2 is down

Deliveries are **lost**, not queued. GitHub retries for a while and gives up.
Nothing else in the app is affected.
