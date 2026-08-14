# Alarms and email

Two ways to be told something happened, deliberately built differently.

| | Security alerts | Widget alarms |
|---|---|---|
| Trigger | the webhook, as it arrives | a schedule |
| Latency | seconds | up to one interval |
| Answers | "this just happened" | "this has been true for a while" |
| Set up in | Security → Notifications | any widget → Add alarm |
| Managed in | Security tab | **Alarms tab** |

Everything here is admin-only, including reads. These calls run with the app's
AWS credentials rather than the caller's GitHub token, and subscribing an
address to a topic means the app can send mail to anyone — so it is gated to
the same team that can change guardrails. A group's member list is also a list
of people's email addresses.

## Security alerts

A toggle, an email group, and a severity floor.

It hooks into `createAlert`, which the webhook worker already calls when it
sees a repository go public, branch protection disappear, a team's permissions
change. So the email goes out at the moment the alert is recorded — typically
five to thirty seconds after the event itself, most of which is GitHub's
webhook delivery and your mail provider.

Alerts below the floor are still recorded in the Security tab. They are just
not emailed, because a low-severity alert on a busy organization is a daily
occurrence and the floor is what keeps the mailbox worth reading.

A notification failure never fails the alert. The alert is already written by
then, and letting SNS take the delivery down with it would make the worker
retry and duplicate every activity row and alert it had just created.

## Widget alarms

Each widget offers only the conditions it can actually answer:

| Widget | Conditions |
|---|---|
| Dependabot | critical ≥ n · high ≥ n · total ≥ n · affected repos ≥ n |
| Vulnerable repos | matching repos ≥ n · total ≥ n · worst severity reaches _s_ |
| Protection bypasses | total bypasses ≥ n · repos with a bypass ≥ n |
| Any query widget | rows ≥ n · rows ≤ n |

The catalogue lives in `backend/src/alarms/conditions.ts` and is both what the
form is built from and what the API validates against. A condition its widget
cannot produce is refused, because it would evaluate to nothing on every pass
and never fire — which is indistinguishable from an alarm that simply is not
triggering.

### How often they run

One schedule, every fifteen minutes. Each alarm is due on its own interval:

- **Dependabot-backed widgets: hourly.** GitHub only rescans on push and when
  advisories are published, which happens in batches a few times a day.
  Checking four times an hour spends rate limit to receive the same answer.
- **Everything else: fifteen minutes.** Configuration state, read from the
  graph tables, changed by people.

There is no interval setting. The system knows what kind of data each widget
reads and picks accordingly, and the tiering is a constant in the code rather
than a deploy.

The due check carries two minutes of slack, because EventBridge fires within
about a minute either side of the scheduled time. Without it a tick arriving at
59m50s reads as "not yet an hour" and defers, so an hourly alarm quietly
becomes a 75-minute one and the drift compounds.

### Firing and recovering

An alarm fires when it *crosses* into breach, not on every cycle it stays
there. Recovery is deliberately asymmetric: firing waits for nothing, but two
consecutive clean checks are required before an all-clear. A value resting
exactly on its threshold would otherwise flip OK-ALARM-OK-ALARM and mail you
every cycle, which teaches people to filter the alarm that mattered.

**A failed read is not a clean check.** If the Dependabot sweep returns 403, or
the widget was deleted, the state machine is left exactly as it was and only
the error is recorded. Letting it count would mean two consecutive GitHub
failures sending an all-clear about a value nobody looked at.

## Email groups

Created and managed on the **Alarms** tab, and only there. The Security tab
chooses among existing groups; it does not make them. Two screens producing SNS
topics is how you end up with two half-remembered sets of recipients.

A group is an SNS topic named `<prefix>-notify-<slug>`. The prefix is a
permission boundary, not a convention: the Lambdas' IAM grants
`sns:Publish` on `<prefix>-notify-*` and nothing else, so they cannot reach
another topic in the account and cannot subscribe anyone to anything. Adding
members happens in the desktop app under the operator's own credentials.

Membership is read back from SNS rather than from our table, so **pending**
means pending. AWS sends a one-time confirmation link and delivers nothing
until it is clicked; showing an unconfirmed address as a member would make a
silently undelivered alert look delivered.

"Send test" publishes a real message, so a group can be proven before it is
relied on.

## Customising the email

Subject and body are templates using `{{widget}} {{metric}} {{value}}
{{threshold}} {{state}} {{severity}} {{repo}} {{message}} {{org}} {{time}}`.

`{{time}}` is rendered as `2026-08-14 09:15 EDT` — readable, and explicit about
the clock. The zone is set on the Security tab and applies to both alarm and
security emails; it defaults to UTC, which is the safe answer when recipients
are spread out, and every email names its zone either way. An unknown zone
falls back to UTC rather than throwing, because a formatter that throws takes
the whole email with it.

For security alerts the time is **when the receiver took the delivery from
GitHub**, not when the worker got round to processing it. Those are seconds
apart normally, minutes after a retry, and arbitrarily far apart for a
redelivery of an old event — which used to produce an alert dated today for
something that happened last week. A redelivery still reads as the moment it
was redelivered, because the payload carries no original timestamp to recover.

A name that is not a real variable is rejected when you save, and left
literally in the output if it ever reaches rendering — blanking it would make
the email look broken rather than the template look wrong.

Subjects are flattened to one line, stripped to printable ASCII and cut to 99
characters before sending. SNS rejects a subject that breaks any of those rules
rather than trimming it, and a rejected publish is an alarm that fires into
silence — where silence already means "all clear".

This is SNS, so mail is plain text and AWS appends its own unsubscribe footer.
HTML would mean SES, which cannot send to unverified addresses until AWS grants
production access.

## Cost

Effectively nothing. SNS email is $2 per 100,000; the evaluator runs about a
second every fifteen minutes; the table is on-demand and holds a handful of
rows. Under 10¢/month at any realistic volume.

## What it is not

Not monitoring. Nothing here watches a metric continuously — the widget alarms
sample on a schedule, and a value that breaches and recovers between two checks
is never seen. For "tell me the instant this happens", the security-alert path
is the one that is event-driven.
