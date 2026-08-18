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

**Write access and above.** Read is normally the organization default for every
member on every repository — recording it would be one edge per member per
repository, hundreds of thousands of identical rows. The page reads the org's
actual `default_repository_permission` from GitHub and states it, rather than
assuming.

**Outside collaborators are marked**, since they are the first row of any access
review.

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
the header carries the age — *Rebuilt 4 hours ago · 1,200 connections* — and a
**Rebuild now** button for members of `control-hub-admins`. A rebuild that
failed is called out beside the age, because "last built four hours ago, failing
since" is a different situation from "last built four hours ago", and the age
alone cannot tell them apart.

**The Refresh button beside it does something else.** It re-reads the derived map
from the stored edges, which is cheap and picks up nothing new from GitHub.
Rebuild is the one that goes back to GitHub.

A rule rebuilds it every six hours (`GraphAggregationSchedule` in the CDK stack).
Six rather than minutes because the walk covers every repository, team and member
in the organization — expensive in GitHub's rate limit, and describing something
that changes on the scale of days. The manual rebuild covers the case six hours
is too long for, which is almost always somebody wanting to see an access change
they just made.

Until this existed the snapshot was only rebuilt when someone pressed a button,
and nothing on screen said when that last happened — so a graph assembled before
a person joined, left, or was made an owner looked exactly like a current one.
