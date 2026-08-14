# Troubleshooting

Things that have actually gone wrong, and what they turned out to be.

## The GitHub card will not let me sign in

It says which of four things is wrong, and they need different answers:

| It says | Meaning |
|---|---|
| *Unlocks once AWS is connected* | AWS is the blocker. The OAuth secrets live in Secrets Manager, so nothing about GitHub can work first |
| *Loading credentials…* | Secrets are still loading. They are read after the server starts listening, so there is a second or so where this is honest |
| *No GitHub credentials stored yet* | The secret does not exist. Run [the setup](setup.md) — this is the ordinary state before it |
| *OAuth is not configured on this build* | The secret exists and has no OAuth keys in it. This one really is a build or configuration fault |

There is also *could not be read*, which means the secret exists but this
account cannot read it — an IAM problem rather than a setup one.

## The sign-in page asks which AWS profile every launch

Fixed — the profile is remembered in `~/.github-control-hub/desktop.json`. If it
still asks, your SSO session has expired; the app cannot renew it.

## A page shows 0 and you expected hundreds

The graph has not been rebuilt since that check existed. Press **Sync data**.
Checks that read an uncollected edge type refuse rather than reporting zero, so
you should see a message saying exactly this.

## The Access tab is empty

Same cause. The person, team and org edges are collected by graph aggregation.

## An AWS account reports nothing

Its role is missing, or does not trust this app. **AWS → Accounts → Check
access** gives the actual reason. The app can assume exactly one role name and
has no fallback to an administrator role, by design.

## A guardrail finds a violation but will not fix it

The rule is in report mode, which is where every rule starts. Switch it to
enforce in the AWS tab. For a finding in another account, that account's role
also needs `ReadOnly=false`.

## Activity stopped recording changes made in GitHub

The webhook is misconfigured, or a delivery is failing somewhere in the path.
The Activity page shows how long since GitHub last said anything. A delivery
rejected at the API Gateway is lost, not queued; one that reached the queue and
failed is retried and, after five attempts, sits in the dead-letter queue
rather than vanishing. See [webhooks](../github-api/webhooks.md).

## GitHub's webhook IP ranges changed

Nothing detects this automatically — it is the same position the security
group held before this moved to Lambda. The symptom is 403s at the API
Gateway and the Activity page reading **Stale** within 72 hours, because every
delivery is being rejected before it reaches the receiver.

The current list comes from `https://api.github.com/meta` → `hooks`, and lives
in `GITHUB_WEBHOOK_CIDRS` in `infra/cdk-stack.ts`. Update it there and
`cdk deploy` the resource policy.

## A delivery that used to work now gets a 401

More likely a rotated webhook secret than a bug in the signature logic. The
receiver caches the secret for fifteen minutes and refetches once per
verification failure, with a sixty-second floor between refetches — so a
single rotated secret costs roughly one lost delivery, not fifteen minutes of
them. Give it a minute before investigating further; if 401s are still
happening after that, the secret in Secrets Manager and the one configured on
the GitHub webhook have genuinely diverged.

## "An unexpected error occurred"

The sanitizer hides messages it does not recognize. It reads AWS exception
*names* as well as messages, so a missing table or permission gives a specific
answer. If you still get the generic one, the server log has the real error.

## The app opens in a second browser window instead of your real one

Fixed — outbound links go to the system browser, sign-in flows stay inside. The
distinction is fiddly because an OAuth redirect fires `will-redirect` rather
than `will-navigate`.
