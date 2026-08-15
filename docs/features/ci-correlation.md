# Correlated CI failures

Thirteen repositories failing at once is almost never thirteen problems. It is
one problem — a runner image that changed, a shared action that published a bad
tag, an expired token, a registry outage — and the cost of not seeing that is
thirteen people each debugging their own repository in isolation.

## Where the data comes from

The `workflow_job` webhook, which was already arriving and being discarded.
That matters: the alternative is polling the Actions API per repository, which
is one request per repository per cycle and would dwarf everything else this app
spends. Here the data is free and already in flight.

`workflow_job` rather than `workflow_run` because the job payload carries the
runner labels and the per-step conclusions. Which step failed, and on what
runner, is the entire basis of correlating one repository's failure with
another's; the run payload has neither.

Only completed failures are stored. A successful job answers no question anyone
asks, and keeping every job would be thousands of rows a day for nothing.
Records expire after 7 days.

## How failures are grouped

Three groupings, most specific first:

1. **same step, same runner** — the signature of a runner image change or a
   shared action
2. **same step, any runner** — a shared action that broke everywhere
3. **same workflow name** — often a shared reusable workflow

A failure joins only the *most specific* cluster it fits. Reporting the same
failure under all three would turn one incident into three findings and put the
reader back where they started.

**A cluster must span at least two repositories.** One repository failing ten
times is that repository's problem and its owner already knows. The whole value
here is noticing that *separate* repositories are failing for the same reason,
which is the thing nobody sees.

The window is **two hours**, not minutes. A shared cause does not hit every
repository at the same instant — repositories are affected as their schedules
and pushes happen to land, so a runner image change shows up over hours.

## What it can and cannot tell you

It can say *"11 failures across 11 repositories, all at step 'Setup Node' on
ubuntu-latest, 14:02–14:39"* — the correlation, which is the part that saves the
time.

It cannot say *"…because the runner image was updated"*. The payload carries the
runner **label**, not the image version, so the cause is an inference you make
from the correlation rather than something GitHub tells us.

## Alarms

Two metrics are available on a **Correlated CI failures** widget:

| Metric | Fires on |
|---|---|
| `Correlated failure clusters` | How many distinct clusters exist |
| `Repositories in the largest cluster` | The size of the biggest correlation |

Nothing fires until you configure it. Both read the app's own table rather than
GitHub, so an alarm on them costs no rate limit at all.
