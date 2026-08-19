# Access map

Who can reach what, and by which route. Read-only.

## Why routes and not totals

GitHub reports one *effective* permission per person per repository and says
nothing about where it came from. That makes the obvious answer useless:
revoking a direct grant changes nothing if the person is also in a team that
owns the repository, and removing them from that team changes nothing if they
are an organization owner.

So every row carries every route:

> **payments-api** — Platform team (write) · Payments Squad team (admin) — **admin**

Where the effective permission exceeds what teams and roles explain, it is
flagged in amber as **granted to them directly** — the thing an access review is
actually hunting for.

## Both directions

- **By person** — everything they touch, their teams, counts of admin and
  personal grants
- **By repository** — everyone who can reach it, plus the teams that own it

## What it shows and does not

**Every explicit grant**, at whatever level: admin, maintain, write and triage,
and custom repository roles under whatever name the organization gave them. A
fixed list of role names used to decide this, which silently dropped triage and
made anyone holding a custom role invisible — the list could not contain names it
did not know.

**One exclusion, and it depends on your organization.** A *member's* plain read
is skipped where the org already grants read or better to everyone: GitHub
reports one of those per member per repository, and it says nothing the default
has not already said once. The page reads the actual
`default_repository_permission` and states it rather than assuming. Where the
default is `none` — or could not be read — a member's read is an explicit grant
and appears like any other.

**Outside collaborators are marked, and always shown — including at read.** No
organization default covers them, so their read is a real grant, and the person
who is not in the organization and can nevertheless see the code is the row an
access review exists to find.

**Members with no write anywhere still appear.** A map that omits them is a map
of the people you already suspected.

## Deliberately read-only

There is no remove button. Removing someone's access is a decision with
consequences and belongs where those consequences are visible, not behind a
button on a map.

## It is a snapshot, and it says how old it is

The person, team and org edges are collected by graph aggregation. Before the
first sync the page says it is stale rather than showing an empty organization.

Everything on this page is that snapshot rather than a live read of GitHub, so
the header carries the age — *Synced 4 hours ago · 1,200 connections · updates
itself every 6 hours* — and a **Sync from GitHub** button for members of
`control-hub-admins`. A sync that failed is called out beside the age, because
"last synced four hours ago, failing since" is a different situation from "last
synced four hours ago", and the age alone cannot tell them apart.

It is not a quick operation, and the button says so while it runs. GitHub
charges nothing for any of it, but it is the most rate-limit-expensive thing this
app does, and that is the budget worth watching.

One pass costs roughly **four requests per repository** for the walk itself —
collaborators, workflows, Dependabot alerts, branches — plus about **six more per
repository** for the compliance scores, plus two per team and a handful for the
organization. So:

| repositories | requests per sync | share of one hour's limit |
|---|---|---|
| 50 | ~520 | ~10% |
| 150 | ~1,500 | ~15% |
| 350 | ~3,600 | ~29% |
| 800 | ~8,100 | ~65% |

A GitHub App installation gets 5,000 requests an hour, rising by 50 per
repository and 50 per user to a ceiling of 12,500. Four scheduled syncs a day
spread across 24 hours leave the budget almost entirely free for everything else;
what to avoid is pressing **Sync from GitHub** repeatedly on a large organization,
where each press is a quarter of that hour gone and the rest of the app starts
seeing rate-limit errors.

GraphQL has its own separate budget, so the pull request list is unaffected by
any of this.

**It writes only what changed.** The sync used to delete every stored row and
write every row back, whether or not anything had moved — and what this records
barely moves between one sync and the next, so nearly every write replaced a row
with an identical row. On-demand DynamoDB bills per write, so a graph of thirty
thousand edges rewritten four times a day came to millions of write units a
month to record almost nothing.

It now reads the stored edges — a scan it was already doing, to find rows to
delete — and writes only the rows that are new or different, deleting only the
ones that have gone. A sync where nothing changed writes nothing at all. Reads
are roughly a fifth the price of writes per unit and cover four kilobytes each
rather than one, so the running cost is now dominated by Lambda time rather than
storage, and a manual sync costs approximately nothing. `repro-graphfreshness`
asserts the no-op case, so a return to blind rewriting fails a test rather than
appearing on a bill.

**One button, not two.** Whoever can sync sees **Sync from GitHub**, which goes
back to GitHub and takes a few minutes. Whoever cannot sees **Refresh**, which
re-reads the derived map from the stored snapshot — all it could ever have done
for them. Showing both to the same person was worse than showing either: the
cheap one looks like it should pick up a change and never can.

The schedule is `GraphAggregationSchedule` in the CDK stack. Manual syncing
covers the case six hours is too long for, which is almost always somebody
wanting to see an access change they just made.

Until this existed the snapshot was only rebuilt when someone pressed a button,
and nothing on screen said when that last happened — so a graph assembled before
a person joined, left, or was made an owner looked exactly like a current one.
