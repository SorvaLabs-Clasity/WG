# Open pull requests and stale reminders

Every open pull request in the organization, most idle first, with a reminder
posted on the ones that have gone quiet.

Closed pull requests never appear. The search is `is:pr is:open`, asserted in
the tests, because a list that accumulates closed work is an archive rather than
a queue.

## What "stale" means

**Seven days with no commit** — not seven days since it was opened. That
distinction is the whole feature: a branch opened two hundred days ago and
pushed to this morning is alive, and a nine-day-old one nobody has touched is
not. Measuring from the opening date flags the first and misses the second.

A push resets the clock. Nothing special implements that: the commit date moves,
idleness drops below the threshold, and nothing is due until seven fresh days
pass.

A pull request with no readable commit date falls back to its opening date
rather than counting as fresh, so the ones that cannot be read are not the ones
never chased.

## Who gets reminded

| What is blocking it | Who is named |
|---|---|
| Waiting on review | The requested reviewers who have **not** reviewed |
| Ready to merge | The author |
| Conflicts, failing checks, changes requested, draft | The author |

Reviewers who have already approved are never named. Neither is the author when
the block is missing approvals — they cannot approve their own pull request.

A `COMMENTED` review is not a verdict. Treating "looks good!" as one would
silence a pull request that is genuinely still waiting.

Teams requested as reviewers are ignored. There is no person behind the handle
to hold responsible, and naming it would notify people who were never asked.

Everything is re-evaluated on every pass. Somebody approving between cycles
changes who is named, with no stored state to update.

## One comment, not fifty-two

The reminder is a single sticky comment that **replaces itself**. Fifty-two
weekly cycles leave one comment, not fifty-two — asserted directly in the tests,
along with the human comments in the thread being untouched.

It is deleted and reposted rather than edited, because editing notifies nobody
and the notification is the point. An edit would leave a tidy thread that
reaches no one.

The previous reminder is found by a marker in its body **and** by our own
authorship. The marker alone is not enough: GitHub's quote-reply copies the
whole body, so somebody replying to the reminder would have their own comment
deleted.

## Pausing

Members of the admin team can pause reminders for a pull request, or mute
specific people on it — the reviewer who has said they will not be reviewing
this one, while the others are still chased.

A paused pull request is **not** recorded as nudged. Recording one would restart
the seven-day clock, so lifting the pause would be followed by a week of silence
instead of the next reminder.

Where every remaining person is muted, nothing is posted at all rather than a
reminder addressed to nobody — and the list says so, so a silent pull request is
explained rather than looking like the feature failing.

## Cost

One GraphQL query for the whole organization, including reviews, commits,
mergeability and check state. The REST equivalent is a list call plus three
requests per pull request: at fifty open, over a hundred and fifty requests for
one screen.

The pass runs on the alarm evaluator's existing five-minute tick and is gated by
its own seven-day interval, so one clock exists rather than two.

## Testing it

Waiting seven days to find out whether this works is not a test. Two things
make it immediate:

**Shorten the threshold.** `PR_STALE_SECONDS=10` treats a pull request as stale
ten seconds after its last commit, and reminds again ten seconds after that.
Anything absent, zero, negative or unparseable falls back to seven days, so a
typo cannot silently disable staleness or turn it into a reminder every pass.
The page shows a banner whenever the threshold is not the real one, because an
override left on by accident would otherwise remind everyone every few minutes
with nothing on screen explaining why.

**Send reminders now.** An admin button on the page runs the pass immediately
rather than waiting for the next five-minute tick. It posts as the app, not as
whoever pressed it — the reminder has to come from the same account every cycle
or the next one cannot recognise its own comment to replace it.

A full run-through: set `PR_STALE_SECONDS=10`, open a pull request, wait ten
seconds, press **Send reminders now**, and the reminder appears on the pull
request. Press it again and the previous comment is replaced rather than
added to.

## Requirements

`pull_requests: write` on the GitHub App, for posting and deleting the reminder.
The list works without it; reminders do not.
