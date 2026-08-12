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

## Requires a sync

The person, team and org edges are collected by graph aggregation. Before the
first sync the page says it is stale rather than showing an empty organization.
