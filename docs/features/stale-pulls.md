# Open pull requests and stale reminders

Every open pull request in the organization, most idle first, with a reminder
posted on the ones that have gone quiet.

Closed pull requests never appear. The search is `is:pr is:open`, asserted in
the tests, because a list that accumulates closed work is an archive rather than
a queue.

## Two switches

| Switch | Default | Off means |
|---|---|---|
| **Monitor pull requests** | On | Nothing is fetched, listed or posted, and the scheduled pass does no work on its behalf |
| **Post reminders** | **Off** | The list works — the scheduled pass still walks and stores it — and nothing is posted |

Admin only, and both stop the work rather than hiding its result. The list route
refuses before it queries GitHub, the scheduled pass checks before fetching, and
the page stops polling — otherwise "off" would still spend a sweep every time
somebody opened the tab. Tests assert the guard sits before the fetch in both
places.

Reminders default to off. Seeing the queue is inert; commenting on somebody's
pull request is not, and a feature that starts posting the moment it deploys is
a surprise nobody asked for.

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

**The message and the mentions come from one decision.** They used to be two
functions computing the same thing, and seventeen combinations of merge state,
review decision and check state made them disagree — the comment announcing
"waiting on review" while deliberately naming no reviewer, because a pending
check had shielded them. `blockReason` now decides, and who to chase is derived
from it, so the two cannot drift. A test walks all 160 combinations.

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

## Pausing and muting

Admin only, and asked at four sizes because the reasons come at four sizes.

| Scope | Set from | For |
|---|---|---|
| **Pause this pull request** | **Manage** on the pull request | Silences everyone on it, the author included |
| **This PR** | **Manage** on the pull request | The reviewer who has said they are not reviewing this one, while the others are still chased |
**Manage is on every open pull request, not only the stale ones.** Muting
somebody is decided when you notice it, which is usually while the pull request
is still fresh; a panel that appeared only after seven days of silence meant the
mute could not be set until the first reminder had already gone out. Anything not
yet stale reads in the future tense — *would remind* — with how long is left.

**A mute outlives the pull request being closed.** The list is built from what
GitHub reports as open, so closing one removes it from view — but the row is
keyed by repository and number, which GitHub never reissues, and nothing about
closing touches it. Reopening comes back with the same mutes, the same pause and
the same count of reminders already sent. The row expires after 180 days
untouched, pushed out again on every write, so a pull request being worked on
cannot lapse mid-review.

| **This repo** | **Manage**, or the **Reminder mutes** window | Somebody asked to review a repository they do not work on |
| **Everywhere** | **Manage**, or the **Reminder mutes** window | Somebody on leave, or who has left |

The two wide scopes open in a window rather than unfolding on the page, because
setting one is a detour from reading the queue — the list should still be where
it was on the way back.

Its repository side lists **every repository in the organization**, not only the
ones with a pull request open today. Muting somebody on a quiet repository is
the case worth supporting: it is set once, before the first pull request ever
lands there. Repositories carrying a mute sort to the top with a count, and one
that has since been renamed, archived or removed from the installation is still
listed — otherwise the only way to lift its mute would be to edit the record by
hand.

The widest scope in effect is the one named, so a person muted both in a
repository and everywhere reads as muted everywhere — the narrower rule would be
misleading, since removing it would change nothing.

**People are chosen from the organization, never typed.** A free-text login box
accepts any string, and a great many strings are real GitHub accounts belonging
to strangers — so a typo does not fail, it names somebody outside the
organization, renders their photograph beside it, and stores a mute that can
never match anybody. Nothing looks wrong, and the person it was meant for keeps
being reminded. The picker offers only members, and the route refuses a
non-member on the way in, so the rule holds whether or not the request came from
this UI. Removal skips that check: a login that has since left is exactly the
one that most needs clearing out.

Avatars come from the member list rather than being guessed from the login.
`github.com/<login>.png` resolves for *any* GitHub account, which is how a
stranger's face appeared next to a name nobody recognised.

Matching ignores case and surrounding spaces. GitHub logins are not
case-sensitive, and a mute that fails because somebody typed a capital letter is
a mute that appears to have been set.

A paused pull request is **not** recorded as nudged. Recording one would restart
the seven-day clock, so lifting the pause would be followed by a week of silence
instead of the next reminder.

Where every remaining person is muted, nothing is posted at all rather than a
reminder addressed to nobody — and the list says so, naming who is muted and at
which scope, so a silent pull request is explained rather than looking like the
feature failing.

## Cost

Measured against the live organization, not estimated.

**GitHub API.** One GraphQL sweep costs **2 points**, and the allowance is
**12,500 points an hour**. At a five-minute tick that is 24 points an hour —
**0.19%** of the budget. The REST allowance (15,000/hour) is touched only when a
reminder is actually posted: one list, one delete, one create.

The REST equivalent of that sweep would be a list call plus three requests per
pull request — reviews, commits and mergeability are separate endpoints — so
fifty open pull requests would cost over a hundred and fifty requests per tick
rather than one query worth two points.

**No Actions minutes are used at all.** This makes API calls; it never runs a
workflow, so nothing is billed against the Actions allowance.

**AWS.** The evaluator averages **2.7 seconds** at 512 MB, using 150 MB. At a
five-minute tick that is 8,640 invocations a month, roughly **$0.20**. The pass
shares an existing Lambda and schedule, so it adds no new AWS resource — the
only marginal cost is the extra seconds those invocations run for.

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

A full run-through: set `STALE_SECONDS` to 10, deploy, open a pull request, wait
ten seconds, press **Send reminders now**, and the reminder appears on the pull
request. Press it again and the previous comment is replaced rather than added
to. Mute yourself on it and press again: nothing is posted, and the row explains
why.

## Requirements

`pull_requests: write` on the GitHub App, for posting and deleting the reminder.
The list works without it; reminders do not.
