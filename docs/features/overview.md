# Overview

A grid of cards, each running one check you chose, on data already collected.

## Where the numbers come from

The **graph** — a table of edges rebuilt when someone presses Sync data. No card
calls GitHub. That is why the page is fast and why it can be stale; the header
says when the graph was last built.

## Widgets

A widget is a saved check with settings. Kinds available:

| Kind | Example question |
|---|---|
| Preset check | Repos with no protected branch at all |
| Vulnerability count | Repos with critical **or high** open alerts |
| Branch-specific | Repos where `main` is unprotected |
| Staleness | Repos with no push in N months |
| Visibility | Public and internal repositories |
| Access | Repos an archived repo still grants access to |

Severity is a **set**, not a threshold — "critical and high" is expressible, and
distinct from "everything low and above".

## Reading a card

- A **ring** appears only where a denominator is meaningful. A check counting
  users or teams shows a count, not a fraction of nothing.
- The **verdict** reflects matches as failures, not passes. 347 of 356
  repositories unprotected is not "good".
- Clicking a card opens the full list, with the reason each entry matched.

## What it will not do

**Report zero for data it never collected.** A check reading an edge type the
graph does not contain refuses and says "press Sync data" instead of showing 0.
Reporting zero findings you have not looked for is the worst thing a security
dashboard can do, and this is guarded explicitly.

**Guess at deploy targets.** Checks that would require knowing which repository
deploys to production were removed — the data does not exist, so the answer was
invented.
