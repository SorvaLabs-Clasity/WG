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

**The author, always.** They can chase people in person, they can merge once it
is possible, and they are the one person who always has something they could do.

Beyond that there is a single question: **is anything other than missing
approvals stopping this merge?**

| Situation | Who is reminded |
|---|---|
| Reviews are the only thing missing | Author **+** everyone still owing a review |
| Required check failing, conflicts, behind base, changes requested, draft | **Author alone** |
| Approved and mergeable, but people were asked and have not answered | Author **+** those who have not answered |
| Everyone asked has approved, rule wants somebody who was never asked | **Author alone** |

Reviewers are never chased about a failing build. No amount of approving fixes
one, so reminding six people would send six of them to look at a pull request
they cannot help with.

`mergeStateStatus` is what makes this answerable. `BLOCKED` means a rule is
unsatisfied; `UNSTABLE` means a check failed that no rule requires, so the merge
is still possible and reviews are still the thing missing. A failing check only
shields the reviewers when it is actually blocking.

Everyone carrying a review request is included, **whatever their approval counts
for**. A reviewer without write access, or on the wrong team, cannot satisfy the
rule — but they were asked, and they are not answering. Equally, having enough
approvals to merge does not stop the others being chased: the author may be
waiting on them deliberately.

**"Approved" means approved right now.** Re-requesting a review from somebody who
already approved puts them back on the hook, and their previous approval stops
counting the moment it happens. This reads `latestReviews`, which GitHub empties
on a re-request, rather than `latestOpinionatedReviews`, which keeps the stale
approval forever — reading the wrong one meant the person asked to look again
was the one person never reminded.

## What the reminder says

The author and the reviewers are asked for different things, so they are
addressed on separate lines:

> **No commits for 9 days.**
>
> @alice — this is approved and green, so it just needs merging.
> @dave @erin — a review was requested from you and is still outstanding.

A single sentence addressed to everyone tells at least one of them something
they cannot act on — the first version said "it just needs merging" to
reviewers who have no ability to merge.

Where only the author is named, only their line appears.

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

**Shorten the threshold.** `STALE_SECONDS` in `prNudgeService.ts` is the one
number governing both staleness and the interval between reminders, for the
scheduled pass and the manual one alike. Set it to 10, deploy, and a pull
request is stale ten seconds after its last commit and reminded again ten
seconds later. Set it back to `SEVEN_DAYS` and deploy when finished.

It is a constant rather than an environment variable on purpose. The scheduled
pass runs in a Lambda, which never sees a value set on a developer machine — so
an environment variable moved the manual button and nothing else, which is
exactly the confusion it caused when it was one. The page shows a banner while
the threshold is not seven days, and the test suite prints a note, so it cannot
be left turned down unnoticed.

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
