# Webhooks

GitHub POSTs to the URL in the stack's `WebhookUrl` output, an API Gateway
endpoint, not a machine anyone administers. The path is `/webhooks/github`,
with no `/api` prefix: this API serves one thing, so there is nothing to
disambiguate from.

## Security

- API Gateway's resource policy allows `execute-api:Invoke` only from
  **GitHub's four webhook CIDR ranges**, and denies everyone else. This is
  evaluated *before* the integration runs, a request from outside those
  ranges never reaches any code, so it cannot be let through by a routing
  mistake the way a security group's placement sometimes could be.
- Every delivery's HMAC signature is verified against the shared secret, over
  the raw bytes GitHub sent.
- The receiver responds `202` almost immediately, because verifying and
  enqueueing is all it does, the actual processing happens afterwards, in the
  worker, off a queue.

## Events handled

Twelve. Most do two jobs: they record what happened, and they patch the access
graph so the widgets that read it are current in seconds rather than at the next
rebuild. The two pull-request events do neither — they exist only to deliver a
notification to a person, which is why they are the two that can be missing
without anything on any screen looking wrong.

| Event | Recorded as | Graph edge patched |
|---|---|---|
| `repository` created | repo appeared | all of the repo's edges |
| `repository` publicized / privatized | visibility changed | `repo_meta.visibility` |
| `repository` archived / unarchived |, | `repo_meta.archived` |
| `push` |, | `repo_meta.pushedAt` |
| `create` (branch) | branch created | `has_branch` |
| `delete` (branch) | branch deleted | `has_branch` |
| `branch_protection_rule` created / edited / deleted | protection changed | `has_branch.protected` |
| `repository_ruleset` created / edited / deleted | ruleset changed |, |
| `member` added / removed | access changed | `has_collaborator`, `collaborates_on` |
| `team` added_to / removed_from repository | team access changed | `owned_by_team` |
| `membership` added / removed |, | `has_member` |
| `dependabot_alert` created / fixed / dismissed |, | `has_vulnerable_dependency` |
| `pull_request` review_requested |, |, |
| `pull_request_review` submitted |, |, |

These are the things nobody did through the app. Without them the activity log
would only show the app's own actions, which is the least interesting half of an
audit trail, and six widgets would be as stale as the last six-hourly rebuild.

**Three are newer than the first release** — `membership`, `pull_request` and
`pull_request_review` — so a webhook configured before them will not have them
ticked, and an unticked box is delivered never and errors nowhere.

The two pull-request ones are the ones somebody notices. They carry the instant
notifications in **My work → Notifications**, and nothing else uses them: no
activity row, no graph edge. So when they are missing, every screen looks
correct and three switches a developer turned on simply never fire.

**These are the organization webhook's events.** The GitHub App subscribes to
none, and they are not permissions — `pull_request` delivery has nothing to do
with the App's Pull requests permission, which is already Read & write for the
PR tab. See [setup.md](../operations/setup.md) for the checkbox names, which do
not resemble the API names, and for the two neighbouring boxes
(`pull_request_review_comment`, `pull_request_review_thread`) that look like
they belong and are dropped.

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

The thresholds are wide on purpose, a quiet weekend is not an outage.

## If a delivery fails

Two different failure modes now, with two different outcomes:

- **Rejected at the gateway**, wrong IP range, or the receiver itself is
  unreachable. The delivery is **lost**, as it always has been at this stage.
  GitHub retries for a while and gives up.
- **Reaches the queue and then fails**, the worker throws, times out, or is
  killed. SQS redelivers it. Only after five failed attempts does it land in
  the dead-letter queue, where a CloudWatch alarm fires. Nothing is silently
  dropped, and a DLQ entry can be redriven once the underlying problem is
  fixed.

Nothing else in the app is affected either way.
