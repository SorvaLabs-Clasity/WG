# Troubleshooting

Things that have actually gone wrong, and what they turned out to be.

## "OAuth is not configured on this build"

The backend loads GitHub secrets from Secrets Manager **after** it starts
listening, so for the first second `/auth/status` honestly answers "not
configured". The page now re-asks for up to 20 seconds and shows *Loading
credentials…* while it waits. If it persists past that, the secret genuinely
lacks `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

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
