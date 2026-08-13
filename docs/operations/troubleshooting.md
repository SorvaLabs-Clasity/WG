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

The deployment is read-only. The finding says so in words. Redeploy with
`-c enforce=true`, and set the target account's stack to `ReadOnly=false`.

## Activity stopped recording changes made in GitHub

The EC2 is down or the webhook is misconfigured. The Activity page shows how
long since GitHub last said anything. Deliveries during downtime are lost, not
queued.

## "An unexpected error occurred"

The sanitiser hides messages it does not recognise. It reads AWS exception
*names* as well as messages, so a missing table or permission gives a specific
answer. If you still get the generic one, the server log has the real error.

## The app opens in a second browser window instead of your real one

Fixed — outbound links go to the system browser, sign-in flows stay inside. The
distinction is fiddly because an OAuth redirect fires `will-redirect` rather
than `will-navigate`.
