# How every feature actually works

What each feature *does* is in [`docs/features/`](features/). This file is about
the mechanism: where the data lives, what puts it there, how often, and how
stale it can be before somebody notices.

It exists because those are the questions asked when something looks wrong. "The
page says zero" has three completely different answers depending on whether that
page reads GitHub live, reads a stored snapshot, or reads a snapshot nobody has
rebuilt since Tuesday.

Every feature below is written twice, on purpose:

- **The path**, what actually happens, in plain English, as a diagram plus a
  table saying what each box in it really is. Read this. Most questions are
  answered by working out which step you are on the wrong side of.
- **The infrastructure**, table names, row shapes and which file does what.
  This is for whoever is about to change the code. Skip it otherwise; nothing in
  the path depends on reading it.

> **Keep this current.** A feature whose storage or refresh path changes and is
> not updated here is worse than one that was never listed, because this file is
> where people will look first. When you change what writes a table, what
> triggers a refresh, or how long something is cached, change the row here too.

---

## The three ways anything gets its data

Almost every screen falls into one of these, and knowing which is most of
diagnosing it.

| Shape | What it means | How stale |
|---|---|---|
| **Live** | The route calls GitHub or AWS while you wait | Never stale, always slow |
| **Stored** | Something wrote it earlier; the route reads storage | As old as the last write |
| **Stored, refreshing** | Reads storage, paints, then refreshes behind you | Bounded, and shown on screen |

Nothing is cached in the browser beyond React Query's own short lifetimes, and
nothing survives a relaunch except what is in DynamoDB.

---

## Words this file uses

Three terms come up throughout, so they are defined once here rather than
assumed.

**A tick.** An EventBridge rule in AWS invoking a Lambda function on a timer.
Nobody presses anything; AWS calls the function on a schedule you set when the
stack was deployed. Four of these exist: at 5 minutes, 30 minutes and 1 hour, plus one
that runs at a fixed time each night rather than on an interval.

**A sweep.** One complete run of the guardrail engine: list the resources in the
account, check each against each rule, write down what it found. Described in
full under [AWS guardrails](#aws-guardrails).

**A walk.** One complete read of the open pull requests from GitHub. It is called
a walk because GitHub will not hand over the whole list at once. You ask for a
page, get a cursor, ask for the next, and keep going. Described in full under
[Pull requests](#pull-requests).

**An expiry (TTL).** A time stamped on a row, after which DynamoDB deletes it
for you. Nothing has to run to clean up, but it is also not punctual: DynamoDB
often deletes hours or days after the stamp passes, which is why anything that
must be *ignored* on time is checked when it is read rather than trusted to
disappear.

**A connection.** One row in the access graph, saying *this person can reach
this repository, at this level, by this route*. Bob is in the platform team, the
platform team can write to payments-api, so Bob has a connection to payments-api
at write level, by way of that team. Your organization has 1,849 of them.

The app says "connections" and so does this file. The code and the table call
them **edges**, which is the usual word for a link between two things in a
graph, and is why the table is named `github-control-hub-graph-edges`, worth
knowing only when you are looking at the table itself.

### How to read the diagrams

Each feature has a **path**, a diagram written in plain English, followed by a
table saying what each box in it really is. Read the diagram to understand what
happens; read the table only if you are about to change something.

The things the tables name:

| Term | What it means |
|---|---|
| **Lambda** | Code AWS runs for you when something triggers it. No server, nothing running between triggers, billed by the millisecond. Each one has a memory size and a time limit |
| **EventBridge rule** | AWS's timer. "Every 5 minutes, run that Lambda." It can also watch for a specific thing happening rather than a clock |
| **DynamoDB table** | The database. Every table here is a pile of rows looked up by a key. There are no joins and no queries across tables |
| **SQS queue** | A waiting line for work. Something puts a job in, something else takes it out later. The point is that the taker can be slow or broken without the putter caring |
| **SNS topic** | AWS's mailing list. The app publishes one message; AWS delivers it to everyone subscribed |
| **S3 bucket** | File storage |
| **API Gateway** | The public front door. The only address anything outside your account can reach |
| **Secrets Manager** | Where the GitHub credentials are kept |
| **app code** | Ordinary code with no infrastructure of its own. When you click something, this runs on **your own machine**, the desktop app contains the whole backend |

Where a box names a file, it is `like/this.ts`, and it is there for whoever
edits the code. You can ignore it otherwise.

---

## How a failure is shown

A screen has three states, not two, and the third is easy to lose: **loading**,
**there is nothing**, and **we could not find out**. The last two render
identically unless something makes them differ, and the empty one is
*reassuring*, "Nothing outstanding", "No alarms yet", "Nobody matches". A
person whose token had expired was being told, in a calm voice, that there was
nothing to see. On a security or compliance screen that is the worst available
answer: it under-reports, and it looks deliberate.

| Kind of failure | Where it is announced |
| --- | --- |
| a **read** (query) that failed | `LoadFailed` from `design/index.tsx`, on the screen, naming what could not be read and offering a retry |
| a **write** (mutation) that was refused | `components/MutationErrors.tsx`, one subscription to the mutation cache, so every mutation is covered including ones added later |
| a **sign-in** action on the login screen | inline, above the tabs, because it happens before any of the above is mounted |

The write side is the one that keeps coming back. These endpoints answer `200`
with `{ reachable: false, error }` when they reached the server but not AWS, so
a caller that ignores the result gets no exception and shows nothing, and the
button looks dead rather than refused. Four handlers on the sign-in screen had
exactly that. `repro-failedreads` pins all of them, plus the read side.

On the login screen `MutationErrors` is not mounted yet, which is why that
screen reports its own failures inline rather than relying on it.

## What runs on a schedule

Seven things happen without anybody pressing anything. Everything else happens
because a person clicked, or GitHub sent a webhook.

| What | Runs | Which Lambda |
|---|---|---|
| Guardrail sweep | every 10 minutes, plus within seconds of a CloudTrail event | `github-control-hub-guardrail-enforcer` |
| Guardrail run for one resource | seconds after a covered resource changes, via CloudTrail | the same function |
| Alarm evaluation, then the PR walk | every 5 minutes, whenever **Monitor pull requests** is on | `github-control-hub-alarm-evaluator` |
| Light graph refresh | every 30 minutes | `github-control-hub-graph-aggregator` (`mode: light`) |
| Access graph rebuild | nightly, 22:00 America/New_York | `github-control-hub-graph-aggregator` (`mode: full`) |
| Developer Teams digests | checked every 5 minutes, sent once per person per day at their own hour | `github-control-hub-alarm-evaluator` |

The schedules are EventBridge rules created by the CDK stack. Changing one means
editing `infra/cdk-stack.ts` and redeploying. They are not settings in the app.

---

## Pull requests

**Shape: stored, refreshing.** The tab reads a stored copy and refreshes behind
you.

### The path

Two of them, and they write the same DynamoDB row.

```
  KEEPING THE LIST FRESH

  every 5 minutes ──▶ the ticker ──▶ ask GitHub for every open PR ──▶ save the
                      (a Lambda)     (slow: a page at a time)         whole list
                                                                      as one row

  OPENING THE TAB

  you open it ──▶ read that saved row ──▶ less than 15 minutes old?
                                              │                    │
                                             yes                   no
                                              │                    │
                                              ▼                    ▼
                                    show it instantly,      go ask GitHub now,
                                    say how old it is,      and you wait ~25 s
                                    refresh behind you      (then save it too)
                                              │
                                    the page re-checks every 30 s,
                                    so the fresh answer appears
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| every 5 minutes | An EventBridge rule, `github-control-hub-alarm-schedule` |
| the ticker | A Lambda: `github-control-hub-alarm-evaluator`, 512 MB, 5-minute limit. The same one that checks alarms. This rides along rather than having a timer of its own |
| ask GitHub | GitHub's search, a page at a time, following a cursor (`services/prNudgeService.ts`) |
| the saved row | **One** row in the `github-control-hub-alarms` table, holding the entire list as text, under the name `pr-snapshot` |
| you open it | The Pull requests tab's backend (`routes/pulls.ts`), running on your machine |
| re-checks every 30 s | The page itself polling, and it stops polling entirely if you switch the feature off |

1. **One Lambda does three jobs on the same timer**, checks alarms, sends
   buffered notifications, and this. Adding a second timer would mean two clocks
   to keep in step, so the pull request walk rides on the existing one. It fires
   288 times a day whether or not anybody is signed in.
2. **The first thing it does is check whether the feature is on**, which is a
   single row read. Switched off, the walk never starts, the check sits
   deliberately *before* the fetch, so "off" costs nothing rather than fetching
   the world and then declining to use it.
3. **Asking GitHub is the slow part, and it comes back a page at a time.** You
   ask for a page, GitHub gives you the page and a bookmark, you ask for the
   next. Each pull request also needs its last commit, its requested reviewers
   and its existing reviews resolved, which is why a *page* is the expensive
   unit here, not a request.
4. **How many fit in a page is learned, not configured.** GitHub gives up on a
   page it finds too expensive and returns an error after about eleven seconds.
   So the walk starts at 30 per page and, on that error, steps down, 24, 18,
   12, 6, retrying **from the same bookmark** so nothing is skipped, and
   remembers the size that worked for next time. Every twentieth walk it tries
   one size bigger, so a bad afternoon does not pin you to the smallest page for
   ever.
5. **The whole list is saved as one row, not a row per pull request**, the list
   as a block of text, plus when the walk finished. If that block exceeds
   300 KB it drops the last fifth and tries again, and flags the result as
   trimmed. The reason for the cap: a row over 400 KB is rejected outright, and
   a rejected save looks exactly like a cache that is quietly working and merely
   old.
6. **Opening the tab reads that one row and looks at its age.** Fresh enough, it
   paints immediately and starts a walk behind you, one walk however many tabs
   are open, because a flag in memory stops a second one starting. Too old, it
   walks in front of you and saves the result on the way past, so the *next*
   open is instant even if the timer has never run.
7. **The 30-second re-check is the page itself**, and it switches off completely
   when the feature is off, rather than politely asking a route that will keep
   saying no.

The 5 and the 15 do different jobs: five minutes is how often the row is
rewritten, fifteen is how old it may get before the tab stops trusting it. The
gap is three ticks of tolerance for a missed one.

### Why there is a stored copy at all

Reading open pull requests from GitHub is the slowest thing this app does. There
is no single call that returns them. You ask GitHub's search API for a page, it
returns some results and a cursor, you ask for the next page, and so on until
there are none left. That is the **walk**.

Each pull request in a page also needs its last commit, its requested reviewers
and its standing reviews resolved, and GitHub does that work per pull request. So
a page is not cheap: several seconds on a large organization, and a walk is
several pages.

Doing that when somebody opened the tab meant a twenty-to-thirty second wait,
every launch. So the result is stored, and the tab reads the stored copy.

### The two things that write it

**1. The 5-minute tick.** The alarm evaluator Lambda walks the pull requests
every five minutes and saves the result. This is what keeps the stored copy
fresh without anybody opening the app.

It walks whenever **Monitor pull requests** is on, whether or not reminders are.
The walk feeds two things, the stored copy, and the decision about who to
remind, and only the second one is what the reminders switch governs. That
distinction was wrong in the code until 2026-08-20: the tick returned early when
reminders were off, which is the default, so in the shipped configuration
nothing kept the stored copy warm and the first open of the day always paid for
a live walk. Switching monitoring off still stops the walk entirely, and that is
the switch to use if you want the tick to stop looking.

**2. Any walk the app itself does.** If the tab is opened and there is no stored
copy, first ever launch, or the stored one has expired, the app walks GitHub
itself, shows the result, *and saves it on the way past*. That is what "on its
way past" meant: it was already fetching, so it writes it down before returning,
and the next open is instant.

### What happens when you open the tab

1. The route reads the stored copy from the `alarms` table (`id: "pr-snapshot"`).
2. **If it exists and is under 15 minutes old**, the page paints from it
   immediately, showing *"As of 3 minutes ago"*, and a fresh walk starts in the
   background. The page polls every 30 seconds, so the new result appears
   shortly.
3. **If it is missing or older than 15 minutes**, the route walks GitHub and you
   wait, but that walk is then stored, so the next open is fast.

The **refresh button** requests `/api/pulls?refresh=1`, which skips step 2
entirely and walks GitHub. Without that parameter it would re-read the same
stored copy: the button would spin, finish, and change nothing.

### Where it is stored

| | |
|---|---|
| Table | `alarms`, one row, `id: "pr-snapshot"` |
| Contents | the list as JSON, plus when the walk finished |
| Size guard | trimmed to stay under 300KB, and marked truncated if it had to be |
| Expires | 24 hours (DynamoDB TTL) |

The size guard matters because a DynamoDB item stops at 400KB. Exceeding it is
not a graceful failure, the write is rejected and the stored copy silently stops
updating, which looks exactly like a cache that works and is merely old.

### The infrastructure

**The list itself** is one row in the `alarms` table:

```
id        "pr-snapshot"
kind      "pr-snapshot"
payload   '{"prs":[...],"truncated":false}'   the list, as JSON text
cachedAt  "2026-08-20T09:14:03Z"              when the walk finished
count     137                                 how many it holds
ttl       <epoch seconds, +24h>
```

Stored as one JSON string rather than as separate attributes, because the shape
is exactly the route's response, pinning it as columns would create a second
definition of the same rows, free to drift from the first.

**Which code touches it:**

| File | Role |
|---|---|
| `services/prNudgeService.ts` | `fetchOpenPrs`, the walk itself, the page-size ladder, the reminder logic |
| `services/alarmService.ts` | `savePrSnapshot` / `readPrSnapshot`, **the only reader and writer of the row** |
| `routes/pulls.ts` | the tab: serve the snapshot, refresh behind it, honour `?refresh=1` |
| `alarms/handler.ts` | the 5-minute tick that walks and saves |
| `services/orgConfigService.ts` | `savePrPageSize`, the learned page size, in a different table |

**Two tables, not one.** The list lives in `alarms`; the learned page size lives
in `org-config` alongside the graph's freshness. They are separated because the
list expires after a day and the page size should not, an organization's
workable page size is a property of the organization, not of the last walk.

### The page size is learned, not configured

GitHub gives up on a page it finds too expensive, returning an HTML 502 after
about eleven seconds. How many pull requests fit in one page depends on the
organization, so the walk discovers it: ask for 30, and on failure step down
through 24, 18, 12, 6.

That discovery costs a timeout per step, so the answer is written to
`org-config.prPageSize` and read back on the next launch. It is paid once per
organization rather than once per process. Every twenty walks it tries one size
larger, so an organization that had one bad afternoon is not pinned to the
smallest page for ever.

### Reminders are a separate switch from monitoring

- **Monitoring on**, the walk happens and the list is stored. This is what the
  tab shows.
- **Reminders on**, additionally, people are messaged about what the walk found.

They used to be one condition, which meant turning reminders off also stopped the
stored copy being refreshed, and the tab went back to being slow.

A reminder is one sticky comment per pull request: the previous one is deleted
and a fresh one posted, so a year of weekly reminders is one comment rather than
fifty-two. When each pull request was last reminded, and whether it is paused,
lives in the `alarms` table as `kind: "pr-state"`, keyed `pr-state#repo#number`,
expiring after 180 days.

## Access map

**Shape: stored.** Nothing on this page is read live from GitHub. Everything it
shows was collected earlier and written to DynamoDB.

### The path

Three writers and one reader, and only the first of them is a Lambda.

```
  THREE THINGS WRITE THE CONNECTIONS

  nightly at 10pm ────▶ the rebuilder ──▶ ask GitHub for everything ──┐
                        (a Lambda)        teams, members, who can     │
                                          reach what                  │
                                                                      ▼
                                                          compare against what
                                                          is already stored, and
                                                          write ONLY what changed
                                                                      │
  GitHub tells us one thing changed ──▶ update just those             │
  (a branch, a collaborator, protection)  few connections ────────────┤
                                                                      │
  you press "Sync from GitHub" ──▶ the same rebuild, but running      │
                                    on your machine, as you ──────────┤
                                                                      ▼
                                                         the connections table
                                                                      │
  ONE THING READS THEM                                                │
                                                                      ▼
  you open the Access tab ──▶ work out every route each person has ──▶ the page
                              (kept for 60 seconds so clicking
                               around does not redo it)
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| nightly at 10pm Eastern | An EventBridge **Scheduler** schedule, `github-control-hub-graph-aggregation`. A Scheduler schedule rather than an EventBridge rule because only Scheduler understands a named timezone: a rule's cron is UTC, which would be 10pm in winter and 11pm after the clocks change. |
| the rebuilder | A Lambda: `github-control-hub-graph-aggregator`, 1024 MB, 15-minute limit (`jobs/graphAggregator.ts`) |
| ask GitHub | Ordinary GitHub API calls with the app's own credentials, about four per repository |
| the connections table | A DynamoDB table, `github-control-hub-graph-edges` |
| GitHub tells us | A webhook arriving, handled by `github-control-hub-webhook-worker` (`services/graphEdgeService.ts` does the updating) |
| press "Sync from GitHub" | The same rebuild code, run inside the desktop app on your machine, using **your** GitHub login rather than the app's |
| work out every route | `services/accessMapService.ts`, holding its answer in memory for 60 seconds |

One more thing the rebuild writes on its way past: a note of when it finished,
which is what the Access page header reads to tell you how old the picture is.

It used to also score every repository for compliance, at roughly seven to ten
GitHub requests each, often costing more than the rebuild itself. No screen ever
displayed those scores; the route and the hooks existed and nothing imported
them. That sweep has been removed.

1. **Nothing runs the rebuild except that timer and that button.** The Lambda
   is allowed to *read* every table in the stack but to *write* only two: the
   connections and the freshness note. Something that
   clears and rewrites a whole table is deliberately kept away from the activity
   log, which is the record you would use to reconstruct what happened.
2. **The walk is ordinary GitHub API calls**, using the app's own credentials:
   list the repositories, the teams, the members and the outside collaborators;
   then for each team its repositories and its members; then for each repository
   who can reach it and at what level, plus its branches, workflows and open
   Dependabot alerts. Roughly four requests per repository.
3. **"Compare and write only what changed" means this, concretely.** It is done
   in the Lambda's own memory, DynamoDB has no such feature:
   - It reads every connection already stored, the whole row, not just its
     identifier, because it needs the contents to compare them.
   - It gives each one a short summary of its contents, a **fingerprint**,
     and files it under its identifier.
   - It does the same for the connections it has just built from GitHub. This
     also removes duplicates across the whole run rather than just within each
     batch of 25, which is a mistake the old version made.
   - Now the comparison is three simple cases. Same identifier, same
     fingerprint → **leave it alone**. New identifier, or the fingerprint
     differs → **write it**. Stored identifier that GitHub no longer reports →
     **delete it**.
   - The identifier joins the two halves of the key with an invisible NUL
     character, which is the one character DynamoDB will not allow inside a
     name, so it cannot collide with the data. It used to join them with `::`,
     and a workflow genuinely named `Build :: Test` split into three parts, the
     delete then went out against a name that matched nothing, and the dead row
     stayed for ever.
   - The writes go out in batches that **retry whatever DynamoDB refuses**. The
     older code sent batches and ignored the reply, so a database that was
     briefly too busy silently dropped an unknown number of connections and
     reported success.
4. **Writes go out before deletes, on purpose.** Both orders leave a window: put
   first and a renamed connection briefly exists under both keys, which reads as one
   stale row; delete first and it briefly exists under neither, which reads as
   access nobody has. A security report should never be wrong in the second
   direction.
5. **If the scan fails, nothing is written at all.** Without the stored set there
   is no way to know what has gone, and writing anyway would leave orphan rows
   that every security check reads as current. A failed sync leaves the previous
   one in place, which is merely old. A failed *write* is rethrown so the
   freshness stamp is never reached, a snapshot dated now is worse than one
   dated last night, because only one of them looks wrong.
6. **Sync from GitHub calls the same function in-process**, not the Lambda:
   `routes/graph.ts` imports `aggregateGraphData` and runs it in the desktop
   backend with your token. (Guardrails do the opposite and invoke their Lambda.
   The difference is that a sweep holds write permissions on your AWS account
   worth confining to one place; a graph walk only reads GitHub.)
7. **The read path never touches GitHub.** `accessMapService.load()` scans
   `graph-edges` once, derives every route by which each person reaches each
   repository into a set of `Map`s, and keeps that derived object in a
   module-level variable for **60 seconds**, a plain `let cache` in the
   process, not DynamoDB and not Redis. The aggregator calls
   `invalidateAccessMap()` when it finishes, so a completed sync is visible
   immediately rather than up to a minute later.

### Two schedules, not one

The full walk runs once a night. A **light pass runs every 30 minutes** and
refreshes only the edges that walk is otherwise the sole writer of.

The split exists because the cost is wildly uneven. The expensive part is
per-repository, collaborators, branches, workflows, alerts, four requests each,
about 1,200 for 300 repositories. The parts six checks depend on cost almost
nothing:

| Edge type | Where it comes from | Cost |
| --- | --- | --- |
| `repo_meta` | already returned by the repository listing | **no extra request** |
| `owned_by_team` | the team's repository list | 1 per team |
| `has_member` | the team's member list | 1 per team |

So a light pass over 300 repositories and 40 teams is **under 100 requests**,
against an allowance of 15,000 an hour. Both schedules invoke the *same* Lambda
with `{ mode: "light" }` or `{ mode: "full" }`, a second function would have
meant a second bundle, bootstrap and permission set for a job reading the same
API with the same token.

### Light against full, side by side

| | **Light** | **Full** |
| --- | --- | --- |
| Runs | every **30 minutes** | **nightly at 22:00 America/New_York** |
| EventBridge rule | `graph-light-refresh` | `graph-aggregation` |
| Payload | `{ mode: "light" }` | `{ mode: "full" }` |
| Lambda | `graph-aggregator` | **the same function** |
| GitHub requests | **~85** | **~1,300** |
| Per repository | **0 extra**, metadata arrives with the listing | **4**, collaborators, branches, workflows, alerts |
| Per team | 2 | 2 |
| Edge types written | **5** | **14** |
| Clears the table first | **no** | **yes** |
| How it removes stale edges | prunes only inside a team it just read | wholesale, by clearing |
| Updates "last synced" | **no** | yes |
| Activity row | only if it changed something or failed | every run |

**What each one writes:**

| | Edge types |
| --- | --- |
| Light | `repo_meta` · `owns_repo` / `owned_by_team` · `has_member` / `member_of` |
| Full adds | `has_branch` · `has_collaborator` / `collaborates_on` · `has_vulnerable_dependency` · `uses_workflow` · `top_contributor` · `org_meta` / `team_meta` / `user_meta` |

### Exactly what the light pass stores

Five edge types, from three kinds of GitHub call. Every field below is written
on every light pass; nothing else in the row is touched.

**`repo_meta`**: one row per repository, `pk: REPO#<name>`, `sk: META#repo`.
Built entirely from the organization repository listing
(`GET /orgs/{org}/repos`, 100 per page), which is why the whole set costs three
or four requests rather than one per repository.

| Field | Type | From | Notes |
| --- | --- | --- | --- |
| `visibility` | `"public"` · `"private"` · `"internal"` | `repo.visibility` | falls back to `private ? "private" : "public"` on older payloads |
| `archived` | boolean | `repo.archived` | coerced, never null |
| `fork` | boolean | `repo.fork` | coerced, never null |
| `pushedAt` | ISO timestamp or `null` | `repo.pushed_at` | what the dormant-repository check reads; `null` means no commit has ever landed |
| `createdAt` | ISO timestamp or `null` | `repo.created_at` | so a repository with no pushes can still be judged against an age |
| `defaultBranch` | string | `repo.default_branch` | defaults to `"main"` when absent |
| `secretScanning` | `"enabled"` · `"disabled"` · `"unknown"` | `repo.security_and_analysis.secret_scanning.status` | `"unknown"` when the field is absent, which is not the same as disabled |
| `pushProtection` | `"enabled"` · `"disabled"` · `"unknown"` | `repo.security_and_analysis.secret_scanning_push_protection.status` | same |

**`owns_repo`** and **`owned_by_team`**, the same fact stored from both ends so
either can be looked up without a scan. From `GET /orgs/{org}/teams/{slug}/repos`,
one call per team per page.

| Edge | `pk` | `sk` | Metadata |
| --- | --- | --- | --- |
| `owns_repo` | `TEAM#<slug>` | `REPO#<name>` | `{ permission }` |
| `owned_by_team` | `REPO#<name>` | `TEAM#<slug>` | `{ permission }` |

`permission` is GitHub's `role_name`, `admin`, `maintain`, `push`, `triage`,
`pull`, and falls back to `"read"` when the listing does not carry one.

**`has_member`** and **`member_of`**, again both directions, from
`GET /orgs/{org}/teams/{slug}/members`, one call per team per page.

| Edge | `pk` | `sk` | Metadata |
| --- | --- | --- | --- |
| `has_member` | `TEAM#<slug>` | `USER#<login>` | **none** |
| `member_of` | `USER#<login>` | `TEAM#<slug>` | **none** |

These two carry **no metadata at all**. Membership is the whole fact; the team's
own role for that person is not read on the light pass, and a member with no
`login` is skipped rather than stored as a blank.

**What the light pass does not store:** anything needing a per-repository call.
No collaborators, no branch protection, no workflows, no vulnerability edges,
and no `top_contributor`, so the dormant-repository Owner column does not move
between full rebuilds. Nor does it write `org_meta`, `team_meta` or `user_meta`.

**Pruning is per team and conditional.** Rows under a team are removed only when
*both* that team's repository list and its member list were read without error.
A half-read team is indistinguishable from a team that lost everything, and
deleting on that basis would turn a failed read into a confident wrong answer.
A repository that disappears entirely is not pruned here, that waits for the
full rebuild, which clears the table.

`top_contributor` carries one of two shapes: a GitHub `login` where the top
author's email is registered to an account, or a bare git author `name` marked
`unlinked: true` where it is not. Both answer "who pushes here"; only the first
is somebody who can be messaged, and the dormant-repository Owner column labels
them apart. See [features/widgets.md](features/widgets.md) for the full tier
order.

So the light pass covers **repository facts and team composition**, precisely
what the six otherwise-stale checks read, and touches nothing else. Branch
protection, collaborators, workflows and dependency edges are all patched by
webhooks as they change and otherwise wait for the full walk.

**One consequence worth knowing.** The light pass deliberately does **not** update
the "last synced" marker the Access page reads. That timestamp means *"when was
the complete picture last rebuilt"*, and a light pass has not rebuilt it. So team
membership and repository visibility can be fresher than the timestamp claims.
Overstating it would be worse: a marker that moves every half hour while
collaborators and branches are still from last night is a marker that lies.

Two rules the light pass follows, both of which would be silent if broken:

- **It never clears the table.** The full rebuild does; doing that often would
  be the expensive thing wearing a cheap hat. The light pass upserts what it
  reads and prunes only within a team it just walked.
- **It never prunes from a partial read.** A team whose members could not be
  listed looks identical to a team that lost all of them, and deleting on that
  basis would turn a failed read into a confident wrong answer.

### The six checks that needed it

`public-repos`, `archived-repos-with-access`, `stale-repos`, `unowned-repos`,
`empty-teams` and `repos-dependent-on` read edge types **no webhook wrote**, so
their answers could only ever be as fresh as last night's rebuild.

That was a gap rather than a decision: every one of them arrives on an event the
worker was already receiving and already acting on. A repository going public
raised a *critical* important event within seconds, while the widget counting
public repositories showed the old number for hours.

The worker now patches the graph on those same deliveries:

| Check | Event | What is written |
| --- | --- | --- |
| `public-repos` | `repository` publicized / privatized | `repo_meta.visibility` |
| `archived-repos-with-access` | `repository` archived / unarchived | `repo_meta.archived` |
| `stale-repos` | `push` | `repo_meta.pushedAt` |
| `unowned-repos` | `team` added / removed from repository | `owned_by_team` |
| `empty-teams` | `membership` added / removed | `has_member` |
| `repos-dependent-on` | `dependabot_alert` | `has_vulnerable_dependency` |

`repo_meta` is **merged, not replaced**, that edge carries a dozen fields the
rebuild collected and a webhook knows about one. A repository the rebuild has
never seen is skipped rather than created from a single field, because a partial
`repo_meta` reads as "collected and empty" where the checks need "not collected".

A resolved advisory has its edge **removed** rather than marked, matching the
rebuild, which lists alerts with `state=open` and so would never have written it.

### What the rebuild does

The rebuild, the nightly tick, or **Full GitHub recrawl** on the Access tab, walks
the whole organization and turns it into *connections*: small rows saying "this
person reaches this repository, at this level, by this route".

1. **List every repository**, every team, every member, and every outside
   collaborator.
2. **Read the organization's default permission**, because the map's biggest
   claim, "everyone can already read everything", is only true if the default
   says so.
3. **For each team**, list its repositories and its members. That is where "Bob
   can write to payments-api because he is in platform-eng" comes from.
4. **For each repository**, list its collaborators with the level each has, plus
   its branches, workflows and open Dependabot alerts.
5. **Turn all of that into connections**, roughly `USER#bob → REPO#payments-api`,
   carrying the level and how it was obtained.
6. **Compare against what is already stored**, and write only the difference.

Step 6 is why this is cheap to run often. A rebuild where nobody joined, left or
changed team writes **nothing at all**. It reads the stored connections, finds
them identical, and stops. Before that comparison existed it deleted and rewrote every
row every time, which was the single most expensive thing in the app.

### What it costs

Roughly **four GitHub requests per repository**, plus two per team and about a
dozen for the organization overall. Three hundred repositories works out at
around 1,300 requests, under a tenth of one hour's allowance of 15,000. Cost is not
why it runs nightly rather than every few minutes: webhooks and the 30-minute light
pass already keep the graph current, so all this walk still does is reconcile. See
"Why nightly, and why 10pm" below.

It was about three times that until the compliance sweep was removed from it.

### Why nightly, and why 10pm

Almost nothing in the graph is collected *only* by this walk any more. Webhooks
patch access as it changes, and the 30-minute light pass carries repository
facts and team composition. What is left is **reconciliation**: webhook delivery
is best-effort, and a delivery that never arrives leaves the graph holding
something that is no longer true, with nothing else in the system able to
notice. The walk re-reads everything and deletes what GitHub no longer has, so a
missed delivery is wrong for a day rather than forever.

Running it four times a day bought a worst case of six hours instead of
twenty-four on a failure that is already rare, at four times the GitHub traffic.
**Full GitHub recrawl** covers anyone who needs it sooner.

The hour is chosen rather than inherited. An interval schedule
(`rate(1 day)`) fires 24 hours after the rule was last written, so the hour it
lands on is whenever the stack happened to be deployed, and it moves every time
the rule is touched. This is the heaviest GitHub traffic the app produces, so it
runs at 22:00 in `America/New_York`, named as a zone so it stays 10pm on both
sides of a daylight-saving change.

**At most one manual recrawl an hour, across the organization.** The button on
Access and on Overview is one component reading one answer from the server, so
it behaves the same in both places and for everybody.

| State | What every screen shows |
|---|---|
| a walk running, anybody's | "Recrawling, this takes a few minutes…", naming who started it |
| within an hour of the last walk | "Recrawl available in N min", with how long ago the last one was |
| otherwise | "Full GitHub recrawl" |

Both answers come from `graphAggregation` in the org config, which the desktop
app and the nightly Lambda both write. That is what makes the state shared: it
was `mutation.isPending` in one component on one machine, so it vanished on a
tab switch and nobody else ever saw it.

- **The nightly walk counts toward the hour.** It is a full recrawl like any
  other and writes the same `lastAttemptAt`, so a manual attempt at 10:40pm,
  forty minutes after the 10pm walk, waits twenty minutes.
- **The nightly walk is never itself blocked.** The gate is in the route, which
  the Lambda does not call. Skipping the pass that catches missed webhooks to
  save one crawl would delay reconciliation by a day.
- **Counted from when the last walk started**, not when it finished, so the
  number somebody is shown matches the clock they watched.
- **A run that never says it finished is assumed dead after 20 minutes**, past
  the Lambda's own 15-minute timeout. `runningSince` is cleared however a walk
  ends, including on a throw, but it cannot survive the process disappearing:
  the Lambda being killed, or somebody closing the desktop app mid-walk.
- **A refusal is a 409, not a 429.** The client turns any 429 into a
  `RateLimitError` and raises a banner saying GitHub's rate limit was reached,
  which is a different thing and untrue here.

There is deliberately **exactly one** trigger for the full walk. Adding a new
schedule and leaving an old one in place would run the rebuild twice a night
with no visible symptom, because the walk is idempotent: the only effect is
double the GitHub traffic at an hour nobody is watching. A test asserts that
only one thing in the stack asks for `mode: "full"`.

### What is recorded, and the one thing that is not

Every explicit grant: admin, maintain, write, triage, and custom repository roles
under whatever name your organization gave them. Outside collaborators always,
including at read, the person who is not in your organization and can still see
the code is the row an access review exists to find.

The one exclusion is a **member's plain read, where the organization already
grants read to everyone**. GitHub reports one of those per member per repository,
so recording them would mean hundreds of thousands of rows saying what the
organization default already says once, on screen, at the top of the page. Where
the default is `none`, a member's read is a real grant and is recorded like any
other.

### The infrastructure

**Table:** `github-control-hub-graph-edges`, keyed `pk` (HASH) + `sk` (RANGE).

**A row is one connection**, and every row has the same four attributes:

```
pk       "USER#alice"          the thing the connection starts at
sk       "REPO#payments-api"   the thing it points to
type     "collaborates_on"     what kind of relationship
metadata { role, source }      whatever that kind needs
```

Thirteen connection types are written: `user_meta`, `team_meta`, `org_meta`,
`repo_meta`, `member_of` / `has_member`, `owns_repo` / `owned_by_team`,
`collaborates_on` / `has_collaborator`, `has_branch`, `uses_workflow`,
`has_vulnerable_dependency`.

Most are written in both directions, `USER#alice → REPO#api` *and*
`REPO#api → USER#alice`, because DynamoDB can only query by partition key. One
direction answers "what can Alice reach", the other answers "who can reach this
repository", and without both one of those questions would need a full scan.

**Four files touch this table, and they do different jobs:**

| File | What it does |
|---|---|
| `jobs/graphAggregator.ts` | **the only full writer.** Rebuilds everything: reads all edges, diffs, writes the difference |
| `services/graphEdgeService.ts` | **patches single edges** between rebuilds, `addBranchEdge`, `removeBranchEdge`, `addCollaboratorEdge`, `removeCollaboratorEdge`, `addRepoEdges`, `updateBranchProtection` |
| `services/graphService.ts` | reads for the security checks, `scanGraphEdges`, `evaluateSecurityQuery` |
| `services/accessMapService.ts` | reads and derives the access map, `accessSummary`, `accessForUser`, `accessForRepo`, `accessForTeam` |

### Webhooks patch it between rebuilds

The nightly rebuild is not the only writer. When GitHub sends a webhook saying a
branch was created, a collaborator was added, or protection changed,
`webhooks/processDelivery.ts` calls the matching function in `graphEdgeService`
and updates **just those rows**.

So the graph is usually more current than "rebuilt last night" suggests: the rebuild is
the floor, and webhooks keep the fast-moving parts up to date in between. What a
rebuild catches that webhooks cannot is anything that happened while the webhook
was misconfigured, plus connection types no webhook reports.

`routes/activity.ts` calls the same functions when you undo something, so undoing
a branch deletion puts its connection back rather than waiting for a rebuild.

### Reading it back

The Access tab does not read connections directly. `accessMapService` derives the
answer, for each person, every route by which they reach each repository, and
holds that derivation for **60 seconds** in a module-level variable, because
deriving it walks every connection. `invalidateAccessMap()` drops it, and the
aggregator calls that at the end of every sync.

### Two buttons that are not the same

- **Sync from GitHub** re-runs everything above. Minutes, and admin-only.
- **Refresh** drops that 60-second derivation so it is recomputed from the
  stored connections. Instant, and **cannot pick up anything new from GitHub**.

Whoever can sync sees the first; whoever cannot sees the second. Showing both to
one person is worse than either, because the cheap one looks like it should have
helped.

The header shows when the last rebuild finished, read from
`org-config.graphAggregation`, along with whether the last attempt failed.

## AWS guardrails

**Shape: rules are stored and read live; findings are stored by each sweep.**

### The path

Three different things can start a sweep. All three run **the same code**, the
app has no checking logic of its own, which is what makes a sweep you started
identical to one the clock started.

```
  every 10 minutes ─────────────┐
                                │
  something in your AWS         │        ┌──────────────────────────────────┐
  account just changed ─────────┼───────▶│          the sweeper             │
                                │        │                                  │
  you press "Run" in the app ───┘        │  1. read your rules              │
                                         │  2. list what is really in the   │
                                         │     account, buckets, log       │
                                         │     groups, and so on            │
                                         │  3. judge each thing against     │
                                         │     each rule                    │
                                         │  4. write down every verdict     │
                                         │  5. fix it, only if that rule   │
                                         │     is set to "enforce"          │
                                         └──────────────────────────────────┘
                                                   │              │
                                                   ▼              ▼
                                        the list the AWS     a note in the
                                        tab shows you        activity feed, only
                                                             if something changed
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| every 10 minutes | An EventBridge rule, an AWS timer pointed at the sweeper (`rate(10 minutes)` in the stack) |
| something just changed | CloudTrail (AWS's own record of who did what) noticing one of six specific API calls, creating a bucket, changing a bucket policy, changing log retention, and firing the sweeper within seconds, for just that one thing |
| you press "Run" | The AWS tab's backend asking AWS to run the sweeper and waiting for the answer (`routes/awsGuardrails.ts`) |
| the sweeper | A Lambda: `github-control-hub-guardrail-enforcer`, 512 MB, 10-minute limit (`aws-guardrails/engine.ts` is the judging part) |
| your rules | A DynamoDB table, `github-control-hub-aws-guardrails`, one row per rule |
| every verdict | A DynamoDB table, `github-control-hub-aws-findings`, one row per rule-and-resource pair |
| the activity feed | A DynamoDB table, `github-control-hub-activity` |

1. **What differs between the three triggers is how much they look at, not what
   they do.** The timer sweeps everything. The change-event sweeps the single
   resource that changed. The button sweeps whatever you asked it to. All three
   hand the same function a list of what to cover, and an empty list means
   everything.
2. **Pressing Run does not check anything on your machine.** The app asks AWS to
   run the sweeper and waits for its answer. There is no second copy of the
   rules logic in the desktop app, so a manual sweep cannot quietly behave
   differently from an automatic one.
3. **Your rules are just rows, filtered in memory.** The sweeper reads them all,
   then drops the ones that are switched off, the ones this run was told to
   skip, and the ones that do not apply to this AWS account.
4. **It looks at each kind of resource once, not once per rule.** If you have
   eight rules about S3 buckets, it lists your buckets **once** and all eight
   rules read that one list, the ninth rule costs nothing extra. The list is
   kept per account *and* per region, because buckets in one region tell you
   nothing about another.
5. **Each resource is then judged twice.** First: is it on one of this rule's
   exclusion lists, by name or by tag? If so it is recorded as *not applicable*
   and skipped. Otherwise: does it pass the rule? The answer comes back as a
   verdict, a one-line summary, and, where a fix exists, a description of
   exactly what would be changed.
6. **Everything that passed is written down too, not just the failures.** Each
   verdict is stored under a key built from account, region, rule and resource,
   so the next sweep **overwrites** the same row rather than adding a second
   one. The table is the current state of your account, not a history: a bucket
   that was broken and is now fine has one row, saying fine.
7. **Report mode does everything except the fix.** It lists, excludes, judges,
   and writes down the fix it *would* have made. It just never makes it. Across
   your entire AWS account the sweeper can perform exactly three write
   operations, set a bucket policy, set a log retention, delete a log retention
   and no IAM action of any kind.
8. **Old verdicts are cleaned up only after a sweep of everything.** A run
   scoped to one resource has not refreshed the rows it would be comparing
   against, so cleaning up there would delete real findings and put nothing in
   their place.
9. **A run that fails to start at all is not lost.** It goes to a dead-letter
   queue attached to the trigger, so a sweep that never began is still
   recoverable rather than silently missing.

### What a sweep actually does

A sweep is one run of the guardrail engine. It happens on the 15-minute tick, and
also within seconds of a covered resource changing. Step by step:

1. **Read the rules** from the `aws-guardrails` table, and drop any that are
   disabled or that this run was told to skip.
2. **List the resources**, once per resource *type* rather than once per rule.
   Eight S3 rules do not mean eight passes over every bucket, the buckets are
   listed once and all eight rules read that one list. This is a `ListBuckets`
   or `DescribeLogGroups` call and the `Get*` calls needed to see each one's
   configuration. Nothing reads the contents of anything.
3. **For each rule, for each resource, decide one of four verdicts:**
   - *excluded*, the resource is on one of the rule's exclusion lists, so it is
     recorded as not applicable and skipped
   - *compliant*. Nothing to do
   - *violation, rule in report mode*, recorded, including the exact fix it
     would have made, and **nothing is changed**
   - *violation, rule in enforce mode*, the fix is applied
4. **Write every verdict**, compliant ones too, to the `aws-findings` table as
   one row per rule-and-resource pair. This is what the AWS tab reads.
5. **After a full sweep only**, delete findings whose rule or resource no longer
   exists, so the tab does not show results about things that are gone.

### The infrastructure

**Three tables, all in the account being watched.**

| Table | Key | Holds |
|---|---|---|
| `github-control-hub-aws-guardrails` | `id` | one row per rule: kind, mode, params, which exclusion lists it uses |
| `github-control-hub-aws-exclusions` | `id` | one row per exclusion list: names or tags a rule should ignore |
| `github-control-hub-aws-findings` | `pk` + `sk` | one row per verdict from the last sweep |

**A finding's key is what makes the table self-cleaning:**

```
pk   "FINDING"                                    every finding, one partition
sk   "123456789012#us-east-2#rule-abc#my-bucket"  account # region # rule # resource
```

That `sk` is deterministic, so the next sweep writing the same rule-and-resource
pair **overwrites** the previous verdict rather than adding a second one. The
table holds the current state of the account, not a history, a bucket that was
in violation and is now compliant has one row, saying compliant.

History is the activity feed's job, and only real changes go there.

**Which code touches what:**

| File | Role |
|---|---|
| `aws-guardrails/handler.ts` | the Lambda. Loads rules, runs the engine, persists the result |
| `aws-guardrails/engine.ts` | the sweep itself, collect, evaluate, remediate |
| `aws-guardrails/store.ts` | **the only file that reads or writes the three tables** |
| `routes/awsGuardrails.ts` | the AWS tab: create, edit, delete rules; run or preview a sweep |

`store.ts` being the only reader and writer is deliberate: the Lambda and the app
both reach these tables, and one file owning the key format is what stops the two
disagreeing about what a finding's `sk` looks like.

**After a full sweep**, `store.ts` also deletes findings whose rule or resource no
longer exists. That runs only after a *full* sweep, a run scoped to one resource
has not rewritten the rows it would be deleting, so doing it there would erase
findings and replace them with nothing.

### Report and enforce

**Fixing one resource, without enforcing the rule.** Every failing resource a
fix exists for carries a **Fix** button, whatever mode its rule is in. Deciding
to correct *this* bucket is a different decision from deciding that every future
violation should be corrected automatically, and the rule's `mode` is what
carries the second one.

So the button does not touch the mode. A setting changed back afterwards is
**reported again, not silently re-corrected**: unless the rule is in `enforce`,
where re-correcting is the whole point.

It works on a `report` rule because such a rule already carries the parameters a
fix needs: the catalog defines them in `defaultParams`, and the rule form shows
every field regardless of mode. What `report` withholds is *doing it
automatically*, not the knowledge of how.

Under the hood this is `forceRemediate` on the engine, and it is **refused
unless `resourceIds` names what to act on**, one absent field would otherwise
turn a button beside a single row into enforcing an entire rule.


Every rule starts in report mode and is switched to enforce individually. A
report-mode rule is not a dry run of a switched-off feature. It does the full
check, records the violation, and writes down the fix it would have made. The
only thing it does not do is make it.

The engine holds exactly three write permissions across the whole account:

```
s3:PutBucketPolicy   logs:PutRetentionPolicy   logs:DeleteRetentionPolicy
```

No `iam:` action of any kind, no `s3:GetObject`, no `logs:GetLogEvents`. It can
see that a bucket has a policy and how long a log group keeps data. It cannot
see what is in either, and cannot grant anyone access to anything.

### Why CloudTrail is involved

Without it, the only trigger is the 15-minute tick. With it, an EventBridge rule
watches for six specific API calls, `CreateBucket`, `PutBucketPolicy`,
`DeleteBucketPolicy`, `CreateLogGroup`, `PutRetentionPolicy`,
`DeleteRetentionPolicy`, and invokes the same function within seconds, scoped to
just the resource that changed.

Those events only exist if CloudTrail is recording. No trail means no fast path;
the sweep still catches everything, up to ten minutes later. Setup only
offers to create a trail if the account has none, because a second trail is
billed per event and the first one's management events are free.

## Alarms and email

**Shape: stored, evaluated on a tick.**

An alarm watches one dashboard widget and emails a group when its value crosses a
threshold. Three separate things have to happen for that, and they live in
different places.

### The path

From the timer to somebody's inbox, with the state machine in between.

```
  every 5 minutes ──▶ the ticker ──▶ read all the alarms
                      (a Lambda)              │
                                              ▼
                                    for each one: is it due yet?
                                     │                        │
                                     no                      yes
                                     │                        │
                                     ▼                        ▼
                                  nothing            work out what its number
                                                     is right now
                                                              │
                                                              ▼
                                                     is it over the line?
                                                              │
                                                              ▼
                                                     has that ANSWER changed
                                                     since last time?
                                                      │              │
                                                      no            yes
                                                      │              │
                                                      ▼              ▼
                                                   say nothing    send the email
                                                              │
                                                              ▼
                                                     write down where it now
                                                     stands, on the alarm itself
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| every 5 minutes | An EventBridge rule, `github-control-hub-alarm-schedule` |
| the ticker | A Lambda: `github-control-hub-alarm-evaluator`, 512 MB, 5-minute limit |
| all the alarms | Rows in the `github-control-hub-alarms` table. One alarm is one row, and its current state lives on that same row |
| what its number is | Depends on the widget: usually a read of the stored connections; for the Dependabot and Renovate ones, a live GitHub call |
| send the email | The app publishes one message to an **SNS topic**, AWS's mailing list, one per email group, and AWS delivers it to everyone who confirmed their address |

1. **Five minutes is how often it *looks*, not how often each alarm is
   checked.** Every alarm carries its own interval, 10 minutes for the
   Dependabot-backed ones, 15 for everything else, and is checked on the first
   look after it comes due. One timer therefore serves every alarm, and changing
   those intervals is a code change rather than a redeploy of AWS. An alarm that
   is not due costs one row read.
2. **A value that could not be read is not the same as zero.** If GitHub refuses
   or rate-limits, the answer comes back as *no reading* rather than an empty
   list, and the alarm is left exactly as it was. This is the difference between
   an alarm staying quiet and an alarm cheerfully emailing you an all-clear
   because GitHub said 403.
3. **Whatever a pass fetches is fetched once.** Three alarms watching the same
   number cost one lookup between them, and if they ask at the same moment they
   share the one request rather than starting three.
4. **What decides whether mail goes out is the *change*, not the value.**
   Crossing the line when it was fine → email. Still over the line → nothing, it
   already told you. Coming back under the line → it waits for **two** clean
   checks before saying so, because a number resting exactly on its threshold
   would otherwise flip back and forth and email you every cycle, which teaches
   people to ignore the one that mattered.
5. **Email delivery is AWS's, not the app's.** Each email group is an SNS topic;
   the app publishes one message to it and AWS sends it on. Somebody who never
   clicked the confirmation link in their first email is not subscribed and gets
   nothing, which is why the page asks AWS who is really on the list rather than
   trusting its own records.
6. **Where an alarm stands is stored on the alarm itself**, in the same write,
   its state, how many clean checks in a row, when it was last checked, what the
   value was. There is no separate state table, so there is no way for an alarm
   and its state to disagree.

### Setting one up

1. **You create an email group.** The app calls SNS to create a *topic*, AWS's
   fan-out mechanism, and writes a row to the `alarms` table with
   `kind: "group"` holding the group's name and the topic's ARN.
2. **You add addresses to it.** Each is subscribed to that SNS topic, and AWS
   emails the person a confirmation link. **Until they click it they receive
   nothing.** The app reads the member list back from SNS rather than from its
   own table, so an unconfirmed address shows as unconfirmed instead of looking
   like a working recipient.
3. **You create the alarm.** A row in the same table with `kind: "alarm"`,
   holding the widget it watches, the condition, the group to notify, the email
   templates, and its starting state, always `OK`, so creating an alarm never
   emails everyone the first time it runs.

### What the 5-minute tick does

The evaluator Lambda wakes every five minutes and, for each enabled alarm:

1. **Decides whether it is due.** Five minutes is the *tick*, not the interval,
   each alarm carries its own (10 minutes for Dependabot-backed widgets, 15 for
   everything else) and is evaluated on the first tick after it comes due. One
   rule serves every tiering, and a not-due alarm costs one row read.
2. **Computes the widget's current value**, which may mean a GitHub call or a
   read of the stored graph, depending on the widget.
3. **Compares it to the condition**, breaching, or not.
4. **Steps the state machine** and writes the result back:

   | Now | Was | Result |
   |---|---|---|
   | breaching | `OK` | → `ALARM`, **send the email** |
   | breaching | `ALARM` | stays `ALARM`, sends nothing. It already told you |
   | not breaching | `ALARM` | clean streak +1; at **2** clean checks → `OK`, send the recovery email |
   | not breaching | `OK` | nothing |

   Recovery waits for two clean checks while firing waits for none. That
   asymmetry is deliberate: a value resting exactly on its threshold would
   otherwise flip OK-ALARM-OK-ALARM and email every cycle, which teaches people
   to filter the alarm that mattered.
5. **Publishes to the group's SNS topic** if the state changed, and SNS delivers
   to every confirmed address on it.
6. **Writes the runtime back**, state, clean streak, last checked time, last
   value, onto the same alarm row. There is no separate state table: an alarm
   and its state are read and written together on every evaluation, and splitting
   them would buy a second round trip and a chance for the two to disagree.

### Editing an alarm

Changing **what** an alarm watches resets its state to `OK`. Otherwise an alarm
firing on "critical ≥ 1" that becomes "total ≥ 500" would stay in `ALARM` and
never email again, because the first breach under the new condition is not a
transition.

That comparison is structural, not string equality. DynamoDB returns a map's keys
in its own order, so comparing the stored condition as JSON text made *every*
save look like a condition change, renaming an alarm was enough to reset a
firing one and re-email everybody.

Only seven fields can be edited through the API. The table is shared by alarms,
groups, PR state and the security toggle, all keyed on `id`, so a request body
passed through wholesale could overwrite a *different kind of row*, an email
group's `topicArn`, or the organization's security settings.

### The infrastructure

**One table, four kinds of row.** `github-control-hub-alarms`, keyed on `id`:

| `kind` | `id` | Holds |
|---|---|---|
| `alarm` | a UUID | the widget watched, condition, group, templates, **and its live state** |
| `group` | a UUID | name and SNS topic ARN |
| `pr-state` | `pr-state#owner/repo#42` | when that pull request was last reminded, whether paused |
| `pr-snapshot` | `pr-snapshot` | the stored pull request list |
| `security` | `security-settings` | the security-alert toggle |
| `query-subject` | per check and subject | cached verdicts for the slow security checks |

Six kinds sharing one table is why an alarm update is restricted to seven named
fields. Every row is keyed on `id` alone, so a request body passed through
wholesale could write `id: "security-settings"` and overwrite the organization's
security configuration from the alarm endpoint.

**Where an alarm's state lives:** on the alarm row itself, not beside it.
`state`, `cleanStreak`, `lastCheckedAt`, `lastValue` and `lastError` are
attributes of the same item. An alarm and its state are read and written together
on every evaluation, so splitting them would cost a second round trip and create
a way for the two to disagree.

**Which code touches it:**

| File | Role |
|---|---|
| `services/alarmService.ts` | reads and writes five of the six kinds, alarms, groups, PR state, the snapshot, security settings |
| `services/queryCacheService.ts` | owns the sixth, `query-subject`, and nothing else touches those rows |
| `alarms/handler.ts` | the Lambda: the 5-minute tick |
| `alarms/evaluate.ts` | decides due, breaching, and what state to move to |
| `alarms/conditions.ts` | the state machine and the intervals |
| `services/notifyService.ts` | SNS: create topic, subscribe, publish |
| `routes/alarms.ts` | the Alarms tab |

**What is not in DynamoDB:** who receives an email. That is SNS subscription
state, read back from SNS every time the page loads, so an address that never
confirmed shows as unconfirmed rather than as a working recipient this app
believes in.

---

## Repository list, vulnerabilities, org settings, "who knows"

**Shape: live.** These call GitHub while you wait and store nothing at all.

They are fast for one reason: they ask narrow questions with direct answers.
"List the repositories in this org" is one paginated call. "Who is in this team"
is one call. There is nothing to precompute because there is no walk, GitHub
answers in one round trip, and storing it would only create a copy that can be
wrong.

### The path

```
  you open the page ──▶ the app on your machine ──▶ GitHub ──▶ straight back
                                                                to the screen

  nothing is saved. no table, no timer, nothing to go stale.
```

1. **There is no server hop.** The desktop app runs the backend in-process on
   `localhost:4321`, so "live" here means exactly one network call, your
   machine to GitHub and back.
2. **Which token depends on the verb, not the route.** Reads use the GitHub
   App's installation token so everyone sees the same organization-wide picture;
   writes, enabling Dependabot, changing protection, creating a branch, use
   *your* OAuth token, so GitHub authorizes precisely what it would have
   authorized on github.com. The app never decides you may change a repository.
3. **Nothing is written down**, so there is no table, no expiry, and no staleness
   to reason about. The failure mode here is a slow page, never a wrong one.
4. **Vulnerabilities is the one with a trick in it.** Dependabot alerts are read
   **org-wide in a single paginated call** rather than per repository, one
   request instead of 350. Two consequences: a repository with no alerts is
   recorded as *alerts off* or *on and clean*, never collapsed into one number;
   and a sweep that could only read part of the organization returns `degraded`
   rather than a partial list, which any alarm reading it treats as no reading
   at all.

### The infrastructure

There isn't any, and that is the point, no table, no cache, no scheduled job.
The route builds an Octokit client from a token and returns what GitHub says.

| Page | Route | Reads |
|---|---|---|
| Repos | `routes/repos.ts` | `repos.listForOrg`, then per-repo detail on demand |
| Vulnerabilities | `routes/dependencies.ts` | `dependabot.listAlertsForOrg` |
| Org settings | `routes/org.ts` | `orgs.get`, `orgs.listCustomRepoRoles` |
| Who knows | `routes/expertise.ts` | commit and comment history |

**Which token** depends on what is being done. Reading uses the GitHub App's
token, so everyone sees the same organization-wide picture. **Writing**, enabling
Dependabot, changing protection, creating a branch, uses *your* token, so GitHub
authorizes exactly what it would have authorized had you done it on github.com.
The app never decides you may change a repository; it asks GitHub, as you.

**Vulnerabilities** is the one worth understanding. Dependabot alerts are read
**org-wide in a single call** rather than per repository, which is the difference
between one request and 350. Two details follow from that:

- A repository with no alerts is ambiguous, alerts might be switched off, or on
  and clean. Those are recorded as different things, so a clean repository never
  looks like a vanished one.
- If the sweep can only read part of the organization, it reports `degraded`
  rather than returning what it managed. An alarm reading a degraded sweep treats
  it as *no reading*, so an alarm cannot resolve itself because half the answer
  was missing.

### Three budgets, not one

"I keep getting the slow-down message even though the requests tab says I have
used 8 requests." Both were true. GitHub keeps three separate allowances in
different units:

| Budget | Allowance | Unit |
| --- | --- | --- |
| core | 15,000 | per hour |
| GraphQL | 5,000 points | per hour |
| search | 30 | **per minute** |

Thirty a minute is small enough to spend twice over inside a minute of an hour
whose total reads 8, and the usage screen reports hourly totals, so it can
never explain a search limit.

The refusal says which budget it was, in `x-ratelimit-resource`, and the
classifier was discarding that header and then describing every limit as "the
hourly request budget for this organization is spent". For a search limit that
is wrong twice over, wrong budget and wrong unit, and it points somebody at a
screen that cannot account for it. The banner now names the budget and says
minutes where the unit is minutes.

An unnamed budget stays unnamed. Some responses omit the header, and defaulting
to core there would be a confident wrong answer in place of a vague right one.
`repro-ratelimit` pins it.

### Findings without fixes

A repository can show a hundred findings, a switch reading "auto-fix on", and
still have nothing open. Both halves are true and the screen used to show only
one of them, which sent people clicking through repositories one at a time.

Two numbers now sit beside each other, findings and open Dependabot pull
requests, and where the second is zero the repository says why. There are five
states and they want different responses:

| State | What it means |
| --- | --- |
| `archived` | No pull request can be opened at all. Pressing the switch is a write that changes nothing. |
| `fixes-off` | The switch is off. Turn it on. |
| `config-target-branch` | Its `dependabot.yml` sets `target-branch`, which GitHub takes as putting the configuration out of scope for security updates. |
| `no-patch` | Not one alert has a patched version, so zero is arithmetic rather than failure. |
| `transitive` | A patch exists but sits under a parent dependency. GitHub: "Dependabot is unable to update an indirect or transitive dependency if it would also require an update to the parent dependency." npm is the documented exception, where the lockfile can be bumped directly, so transitive findings there are still Dependabot's to fix. |
| `null` | Everything is configured correctly and GitHub never scheduled the work. |

That last one is the interesting answer, not the boring one: it is the
population a re-trigger can help, and it was invisible while it sat mixed in
with the four above.

Three rules hold this together, all of them the same rule:

- **Archived outranks everything**, because nothing else about the repository
  can be acted on.
- **One patchable alert is enough to make a repository stuck.** Ninety-nine
  findings with no fix and one with a fix is a repository owed a pull request,
  and calling the whole repository unpatchable would hide it.
- **A non-answer is never read as a reason.** The alert relationship has four
  values, and two of them, `unknown` and `inconclusive`, are GitHub declining to
  say. Only `transitive` counts as transitive.
- **Unreadable is never reported as a finding.** `fixesEnabled` is undefined for
  a repository the token cannot administer, the facts are null when the query
  failed, and the pull request counts are null when the search failed. Each of
  those produces no answer rather than a wrong one: a zero nobody measured reads
  as a repository to act on, and sends somebody to a settings page they cannot
  open for a problem they may not have.

One place this is worth knowing from the outside: the "Recent update jobs" log
under Insights, Dependency graph, Dependabot is per manifest and comes from a
`dependabot.yml`. A repository without one shows an empty page whatever its
security updates did, so its emptiness is not evidence of anything. Security
update failures are posted on the individual alert instead, and the REST API
does not carry them, which is why the relationship field does the work here.

The repository facts, archived and the Dependabot configuration, ride the
GraphQL query that was already reading the alert flag a hundred repositories at
a time, so they cost no extra request. Reading `dependabot.yml` over REST would
have been another 351 per open, which is the exact cost that query was written
to avoid. The pull request counts are one org-wide search rather than a query
per repository, because search allows thirty requests a minute where the core
budget allows fifteen thousand an hour. `repro-fixblockers` pins all of it.

### Making the fixes actually happen

The organization this was built against had 7,047 open alerts, 6,973 of them
with a patch GitHub itself had identified, and 85 open pull requests. Opening
any single alert and pressing "create security update" produced one on the
spot, so the fixes were never impossible. GitHub had simply not scheduled them,
and no API asks it to try again.

There is one documented trigger: "when grouped security updates are first
enabled, Dependabot will immediately try to create grouped pull requests." That
requires a `.github/dependabot.yml`, so the Vulnerabilities tab writes one, per
repository, either as a pull request or as a commit to the default branch.

What the generated file says, and why each part of it:

- **Every entry comes from an alert that repository actually raised.** The
  ecosystem and the manifest's directory both come from the alert, because that
  is the one source that has already proved a manifest is there and that GitHub
  can read it. An entry guessed from the repository's shape fails in the worst
  available way: Dependabot reads the file, finds no manifest, opens nothing,
  and looks exactly like the bug being fixed.
- **The alert's ecosystem name is not the config's ecosystem name.** The alerts
  API says `rubygems`, `go`, `rust`, `erlang`, `actions`; the file wants
  `bundler`, `gomod`, `cargo`, `hex`, `github-actions`. A wrong value is not a
  partial failure, it rejects the whole file, so an unmapped ecosystem is
  dropped rather than guessed at.
- **The JVM is one ecosystem in the alerts and three in the config.** The
  alerts API reports every JVM dependency as `maven`, its whole list being
  "composer, go, maven, npm, nuget, pip, pub, rubygems, rust". The config file
  has `maven`, `gradle` and `sbt`. So `maven` was being written onto Gradle
  repositories, where Dependabot looks for a pom.xml, finds a build.gradle, and
  opens nothing: a file that reads correctly and does nothing, reported by
  nobody. The manifest **filename** settles it, and the alert carries it, so
  `pom.xml` is maven, `build.gradle`, `build.gradle.kts`, `settings.gradle` and
  `libs.versions.toml` are gradle, and `build.sbt` is sbt. A version catalog at
  `gradle/libs.versions.toml` points at that directory's *parent*, because the
  build it belongs to is there. A JVM alert with no readable filename is
  **skipped rather than guessed**: either answer is a coin flip that fails
  silently when it loses, and a repository reported as having no configurable
  ecosystem is at least visible. It costs only that entry; the rest of the file
  still stands.
- **`github-actions` is configured at the root**, not at `.github/workflows`
  where its manifests live.
- **`open-pull-requests-limit: 0`.** Adding the file switches version updates
  on, which across 66 repositories is thousands of pull requests nobody asked
  for. Security updates are documented as not subject to that limit, so the
  fixes still arrive.
- **One group per manifest, so ecosystems are already separate.** Each
  ecosystem and directory is its own `updates` entry, and a Dependabot group
  only ever spans its own entry, so npm and pip have always produced separate
  pull requests. What they did not do is *say* so: every group was named
  `security-fixes`, and the group name is the only part of the title this file
  controls, GitHub rendering it as "Bump the *name* group with N updates". Sixty
  identically titled pull requests across an organization gave no way to tell
  which was which. Groups are now named for their entry, `npm-security`,
  `bundler-security`, and `npm-web-security` where two directories share an
  ecosystem, restricted to lowercase letters, digits and dashes because the name
  ends up inside a branch.
- **Below that there is nothing left to split on.** GitHub's group options are
  `patterns`, `exclude-patterns`, `dependency-type`, `update-types` and
  `group-by`; advisory severity is not among them, and per-package would have
  been 6,973 pull requests.

### Pull requests are counted per package, not per finding

The first thing the re-trigger produced was a number that looked like a
failure: a repository with over a hundred findings opened four pull requests.
It was working. Dependabot raises one pull request per vulnerable package it
can bump, and one bump closes every alert against that package, whether that is
the same package in three manifests or one package carrying four advisories.

Comparing pull requests against findings compares two different units, and it
misleads in both directions: a working rollout reads as stalled, and a stalled
one reads as fine. So each repository shows the ceiling those pull requests are
climbing towards, `4/18` rather than `4`, and says in words that a hundred
findings from eighteen packages is about eighteen pull requests.

The care is all in what the ceiling excludes, because an inflated one is the
worse error: it makes a finished repository read as abandoned and sends
somebody to re-trigger work that is already done.

- Alerts with **no patched version** cannot become a pull request.
- **Transitive dependencies outside npm** usually need the parent changed by a
  person. npm is the documented exception, where the lockfile can be bumped.
- An **unstated relationship is counted**, not assumed away. `unknown` and
  `inconclusive` are GitHub declining to say, and dropping them would understate
  the ceiling and make a stalled rollout look finished.
- The repository markers, clean, disabled and scanning, are not findings.

A grouped repository has a different ceiling entirely. Once its dependabot.yml
groups security updates, Dependabot stops opening one pull request per package
and opens one per manifest carrying every bump in it, so the ceiling becomes the
manifest count. Keeping the per-package number there would show a finished
repository as "2/40" forever, which is the same misreading as "4/120", pointing
the other way. The flag comes from the configuration the facts query already
fetched, and ungrouped is the default, because that is what a repository is
until somebody rolls one out to it.

Worth recording, because it is what settled the approach: ungrouped, on a
repository with 120 findings, Dependabot opened four pull requests covering
about twenty alerts and stopped, while every remaining alert could still be
fixed by hand from the alert page. There is no REST endpoint behind that
button, and the whole Dependabot API surface is alerts, secrets, repository
access and dismissal requests. Grouping is what makes the remainder reachable:
one pull request per manifest carrying everything, so a cap on the number of
pull requests stops mattering.

`repro-fixexpectations` pins it.

### Closing them all again

The Manage Dependabot panel can close every open Dependabot pull request on the
selected repositories. It is the most destructive control in the app, and not
for the reason it looks: **closing is not deferring.** GitHub treats a manual
close exactly as it treats `@dependabot close` and will not raise that pull
request again, so a bulk close is a bulk suppression of fixes, per pull request
rather than per repository, undone only by commenting `@dependabot reopen` on
each one.

So the guard is the feature. It sits below a rule of its own, in its own
colour, and takes a **typed confirmation** rather than a click: every other
control on that panel is recoverable by pressing the opposite one, and a dialog
somebody can dismiss by reflex is no guard against one that is not. The prompt
names the number of pull requests, not just the number of repositories, because
the repository count is the half that looks harmless.

Three ways this could destroy something nobody asked it to, and what stops
each:

| Risk | What stops it |
| --- | --- |
| Closing on a repository nobody selected | The search is organization-wide, so the repository filter is ours. Pinned in both directions. |
| An empty selection read as "everything" | Refused explicitly, at the route and again in the service. It is the one input whose blast radius is unbounded. |
| Closing something Dependabot did not open | GitHub does the authorship filtering, `author:app/dependabot`. The config pull requests this app raises are authored by the person who pressed the button, so they are not in the set. |

The held pull request search is dropped afterwards, or the tab reports the pull
requests it has just closed as still open, which reads as the close having
silently failed. Writes are paced, and failures are named individually rather
than counted, since reopening is per pull request and a count cannot be chased.
`repro-dependabotclose` covers all of it.

### Re-triggering without writing anything

Under branch protection the configuration cannot reach the default branch
without a pull request and an approval, per repository, before a single fix
arrives. So the tab offers a cheaper thing to try first: switch security
updates off and straight back on. Two calls, no file, no review.

GitHub does not document this as a re-trigger and it may do nothing. That is
worth trying precisely because it is free, and the button says so rather than
implying a promise GitHub has not made.

What matters is the failure mode, because the first step of this switches a
security feature **off**:

- **Putting it back is retried harder than anything else here**, six attempts
  against the usual four, and on every kind of refusal rather than only the ones
  GitHub asks us to wait out. The alternative to trying again is a repository
  that quietly stops receiving security fixes.
- **The restore is not left to the outer retry loop.** That loop restarts the
  action from the top, which would switch the repository off a second time.
- **A repository left off is counted and named separately**, and the screen says
  it in those words: those repositories are less protected than before anybody
  pressed anything. A count alone cannot be acted on.

`repro-retrigger` pins all of that, including that a transient refusal on the
way back is retried until it sticks.

**The file does not replace the switches.** GitHub lists Dependabot alerts and
Dependabot security updates as *prerequisites* for a `dependabot.yml`, not
alternatives to it: "you must first enable the following features: Dependabot
security updates". The file decides how fixes are grouped; the settings decide
whether there are any. Writing one to a repository whose switch is off is a
silent no-op, so the rollout reports it, on success rather than as a failure,
because that is the outcome somebody would otherwise walk away from believing
had worked. Only where the switch was actually read as off: `fixesEnabled` is
undefined for a repository nobody can administer, and warning about one of
those is a claim nobody established.

**Pressing the button twice does the obvious thing.** Closing a pull request
does not delete its branch, so a second run arrives to find
`control-hub/dependabot-security-updates` already there with the file on it.
Three things in a row can fail from that state, and the first is what people
actually hit:

| State | Without handling | Now |
| --- | --- | --- |
| File exists on our branch | `Invalid request. "sha" wasn't supplied` | Read its sha and update |
| File is byte-identical | A commit containing no change, every run | Nothing written |
| A pull request exists for that head | GitHub refuses the create | That pull request is the answer, with its link |

Newlines are normalised before comparing, because a branch that has been
through a client which rewrites them would otherwise never compare equal and
would take a commit on every single run.

The invariant underneath all of it: **a sha is only ever supplied for our own
branch.** A sha is what turns a write into an overwrite, and on the default
branch the file it would overwrite is somebody else's, so committing there
still passes none and still fails rather than replacing anything.
`repro-rolloutrerun` exercises the decision against every state a rerun can
find, which is the part no test that talks to GitHub could reach.

And the rules about writing to somebody's repository:

- **A repository that already has a `dependabot.yml` is skipped**, never merged
  into and never replaced. Somebody wrote that file, possibly to exclude a
  dependency deliberately.
- **A read that fails counts as "already configured".** Skipping wrongly leaves
  a repository without the file, which is visible and can be rerun. The other
  direction overwrites a file nobody could read.
- **It runs as the person who pressed it**, not the app, so the pull requests
  carry their name and GitHub applies their permissions.
- **Fifty repositories a run**, paced harder than the settings bulk. Six
  requests per repository for a pull request, and creating branches and pull
  requests in quick succession is precisely what the secondary rate limit
  refuses.

`repro-dependabotconfig` pins the generated file.

### "Only when the review is mine to do", in three places

The review-request notification had a cap on how many reviewers a pull request
could have before it stopped being worth interrupting for. The daily summary
and the queue did not, so the same person could be told "not yours, eight
people are on it" at the moment of the request, then handed that same pull
request in the morning summary and again in their queue.

All three now ask it, and the counting rule lives once, in
`services/reviewerLimit.ts`. That matters more than it looks, because the two
shapes it counts differ in a way that invites an off-by-one:

| Source | What it lists | Total |
| --- | --- | --- |
| webhook payload | the **other** reviewers, the reader removed | `1 + others + teams` |
| pull request row | **everybody** still pending, reader included | `pending + teams` |

Adding one to both, or to neither, is wrong in opposite directions and neither
shows up as an error. `repro-reviewerscope` runs the same three-person review
through both shapes at every limit and requires the same answer.

The rest of the rule, unchanged from where it started: a team counts as one,
because it is one more group who might pick it up; the limit is inclusive, so
"at most three of us" keeps a review with exactly three; and **an unreadable
list never withholds**, because silently dropping a review on the strength of a
number nobody could see leaves somebody waiting on a review they were never
told about.

Where each cap lives is a deliberate split. The notification and summary caps
are rules about **when to interrupt somebody**, so they belong to the account
and travel with it. The queue's cap is about **what to look at right now**, so
it stays in that browser: somebody narrowing their screen for an afternoon
should not thereby stop being told about reviews. It also never shows a bare
"nothing to do" when a filter is the reason, since an empty queue and a
narrowed one are the same picture and opposite facts.

### Widget filters: a short list is not a closed one

Owner rendered as a row of tick boxes with no text field at all, because the
filter editor read "few distinct values in these rows" as "a fixed set to pick
from". The two are not the same thing.

Status has a **closed** vocabulary: the app defines it, and fail and pass are
all there will ever be. Owner has an **open** one that merely happens to be
short in today's rows, and one new team makes the boxes wrong. A filter is also
something people save and reuse, so a control built from the values present on
the day it was made quietly stops offering the right answer later.

The failure was total rather than partial: with no text field, a team that
happened to be absent from the rows on screen could not be filtered for at all.

So the guess is gone. The closed vocabularies are named, `status`,
`visibility`, `worst`, `ownerKind`, counts stay ranges, and everything else is
typed into. The new rule's worst case is a column that could have offered a
list and instead lets somebody type, which is an inconvenience. The old rule's
worst case was not being able to express the filter at all.

Typing keeps the help that made the list attractive: the field says what the
column actually holds, "things like platform, finance", because the commonest
way to get nothing back is to filter the wrong column, and a username typed
into a column of repository names matches nothing and looks like a broken
filter.

### The login screen that required a login

Leave the desktop app open long enough for the session token to expire, come
back to the login screen, and the AWS profile list was empty with "Missing or
invalid Authorization header". The screen whose entire job is getting a session
could not draw itself without one.

`setupOrAuthMiddleware` opened the connection endpoints in two cases: nothing
configured yet, and AWS unusable. Both are about AWS. Neither covers the
ordinary way to reach that screen, which is AWS being perfectly healthy while
the *GitHub session* expired. So the endpoints that exist to establish a
connection demanded the thing a connection produces.

The rest of the file already assumed otherwise: `sameOriginOnly`, guarding the
same routes, documents them as "reachable without a session by design, since
reconnecting AWS is how you get a session back". This aligns the two. What
keeps them safe is where they can run, not who is calling: `serverModeGuard`
refuses them outright on a server deployment, so the only caller is the desktop
app reading the `~/.aws/config` of the machine it is installed on, which any
local process able to reach that port can already read directly.

`repro-loginlockout` pins that, and pins `serverModeGuard` and `sameOriginOnly`
on every one of the eight routes. Writing it found three the first list had
missed, which is why the set is asserted in both directions rather than spot
checked.

### Opening the tab used to start a sweep. Every time.

The rule was: if the stored sweep is over ten minutes old, serve it and start a
fresh organization-wide walk behind the reader. Nothing keeps that sweep warm
unless a Dependabot-backed alarm happens to run, so on an account without one it
was **always** over ten minutes old, and every open began a walk of seventy-odd
pages. Opening the app twice in a morning did it twice. Clicking between tabs
did it concurrently, because there was no guard of any kind.

Serving the stored copy instantly was never the problem. Deciding to recompute
*because somebody looked* was.

A refresh is now started only if none is running and none has run in the last
half hour, matching what the alarm pass already uses to warm the same row so the
two cannot fight. The clock is set when a sweep **finishes**, not when it
starts, so a four-minute walk does not immediately permit another, and it is set
on failure too, since retrying a broken sweep on every open is the behaviour
this exists to stop.

**The first version of that throttle only held within a session**, which missed
the case people actually hit. `lastRefreshAt` was module state, and closing the
desktop app kills the backend process, so the guard was empty on every launch:
open the app, open the tab, sweep; close it, reopen, open the tab, sweep again.
Within one session it worked perfectly, which is why it looked fixed.

The decision has to come from something that outlives the process, and one was
already stored. `computedAt` is the time of the last successful refresh and it
lives in DynamoDB, so `isDueForRefresh` reads that and a process that has just
started reaches the same answer as one running for hours. The two in-memory
guards stay, because they cover a different thing: a second request in the same
session while a sweep is in flight.

Two windows, doing two jobs, and conflating them was the original fault:
**freshness is ten minutes and drives what the tab says**; **due is half an hour
and drives what it does.** Nothing stored is deliberately not "due", since that
is a first open, which computes live rather than serving a stale answer and
refreshing behind it.

The label was lying in the same way. "(refreshing)" was shown for anything over
ten minutes old, which was also the condition that started a sweep, so the tab
announced a rescan on every open and then performed one. It now reports whether
one is genuinely running, which most opens will not start at all.

### Why that tab was still slow, and how it now says so

The summary was reading from storage and the tab was still slow on every
launch, which meant the stored sweep was not there to read. A save that fails
is invisible from outside: every opening recomputes the whole organization,
forever, and nothing on screen says why.

So the snapshot now records why its last save did not happen, `/dependencies/age`
reports it, and the tab shows **"not being stored"** with the reason on hover.
Three ways it can fail, each with its own wording: no storage table configured
for the account, a sweep too large for a single row, and a write that was
refused. This is the same failure shape the rest of this document keeps
returning to, an absence rendered as an answer, and a sentence is what it costs
to say instead.

One real cost was found while measuring. The Vulnerabilities page reads the
Renovate endpoint on **every** open, whichever view is showing, purely to put a
count on a tab. Enriching every open Renovate pull request with its checks and
conflicts to do that spent a GraphQL batch on a screen nobody had open, on the
slowest tab in the app. Those details are now asked for only by the panel that
shows them, and the search behind both is held for a minute so the second call
reuses it.

### Drawers, and why the tab stopped being a stack of bands

Every feature added to the Vulnerabilities tab had become another horizontal
band above the findings: a staleness line, an amber summary of repositories
without fixes, and the repository management panel. Each was reasonable on its
own. By the third, the thing somebody opened the tab for had been pushed below
the fold by controls they were not using.

The missing piece was a pattern, not a tidy-up. `Drawer` in the design system
is the answer to it: **a task with a beginning and an end gets its own surface
over the page, rather than a band inside it.** Bulk-editing three hundred
repositories is such a task, and the page it was launched from is not part of
it.

So the three bands became one row and one drawer:

- The **summary and the panel share the drawer**, because they are two halves
  of one question, why fixes are not happening and what to do about it. The
  breakdown opens the drawer, where it says which repositories are worth
  selecting and which cannot be helped by anything on the panel.
- The **staleness became four words** on the switcher row that already existed:
  "swept 2:14 PM", with "(refreshing)" when a sweep is running.
- What is left above the findings is the heading and one row.

Three things the drawer has to get right, since it covers the page:

- **Escape and the backdrop both close it.** A panel covering the page must be
  dismissible without hunting for the control that does it, and the button that
  opens it never toggles: "Hide" rendered underneath the thing it hides is a
  control nobody can reach.
- **The page behind is frozen while it is open**, so a scroll over the backdrop
  does not silently move content the reader cannot see. Its previous overflow
  is *restored* rather than cleared, because something else may have set it.
- **The panel inside gave up its own chrome.** Its card border, heading and
  padding all belonged to the drawer once it moved in. Two titles and two
  borders is what "just put it in a modal" looks like when nothing is taken
  away.

`repro-drawer` holds the structure down, because it is the part that quietly
regresses: the next feature is always easiest to add as one more band.

### The open fix pull requests, in the card that owns them

The card said "4/18 fix PRs" and stopped, so learning *which* four meant going
to GitHub. They now live behind that number: click the count and they unfold
inside the repository's own card, above the findings they close, because that
is where somebody already is when the question occurs to them. Not a band at
the top of the page, which would be a second list to reconcile against the
first.

Each row carries what decides whether it can be merged: readiness as a coloured
left edge, the check rollup, the review, conflicts, the size of the change, the
age, and the package it bumps. Ready first, then oldest, which is the order
somebody would clear them in.

The package comes from the **branch**, not the title, because the title is
prose and prose changes between GitHub releases. `dependabot/npm_and_yarn/
lodash-4.17.21` is lodash.

The test for that is deliberately inverted, and the first version had it the
wrong way round. It recognised Dependabot's default `multi-` grouping and read
every other branch as a package, so a real grouped branch from the
configuration this app writes, `dependabot/npm_and_yarn/security-fixes-450e0d57a0`,
had its hash stripped as though it were a version and displayed as the package
**"security-fixes"**. A group is named by whatever the `dependabot.yml` calls
it, so group names cannot be enumerated and no list of them would be complete.
Versions can be recognised; group names cannot. So a package is claimed only
where the last component starts with a digit and carries a dot, and everything
else shows the title, which for a grouped pull request already reads correctly.
That costs the rare bump to a version with no dot, which claims nothing rather
than claiming wrongly.

One genuine ambiguity is documented rather than hidden, since `babel/core-7.24.0`
(a scoped package) and `frontend/lodash-4.17.21` (a directory) have the same
shape.

### When Dependabot actually runs

Worth knowing before waiting on it. Security updates are **event-driven, not
scheduled**: "when a Dependabot alert is raised for a vulnerable dependency in
the dependency graph of your repository, Dependabot automatically tries to fix
it." The `schedule.interval` in the generated configuration drives *version*
updates only, and those are switched off there by `open-pull-requests-limit: 0`,
so it governs nothing this app cares about.

Which leaves three moments when pull requests appear: a new advisory affecting
a repository, a push that changes a manifest, and the one this app uses,
grouped security updates being switched on for the first time, which GitHub
documents as an immediate attempt at every open alert that has a patch. There
is no fourth. Nothing re-runs nightly to pick up what the backfill missed, and
no REST endpoint asks it to try again, which is why the configuration file is
the trigger.

One irreversible action, surfaced in the panel where somebody is about to take
it: **closing a Dependabot pull request without merging stops it being raised
again**, exactly as the `@dependabot close` command does. On a backlog this
size that is easy to do to a hundred of them before noticing.
`@dependabot reopen` undoes it.

The check state comes from `services/pullRequestDetails.ts`, which the Renovate
view already used. Same question, same objects, so the same code answers it:
two copies would be two places for "unknown" to quietly become "passing". The
readiness wording is shared on the frontend too, in `lib/prReadiness.ts`, for
the same reason. One GraphQL batch per fifty pull requests, on a budget the
search does not touch.

`repro-dependabotprs` covers the search and the branch parsing;
`repro-fixprpanel` pins that the panel renders inside the card and above the
findings, and that nothing on the page can merge anything.

### Why the tab was still slow on the first open

The list was served from storage the moment somebody opened the tab, and the
tab still took an organization-wide walk to appear, but only on the first open
after launching the app. Two facts explained it together:

- the spinner is `depsLoading || sumLoading`, so it waits for the severity
  counts as well as the list, and
- `/summary` swept the organization **live on every call**, ignoring the stored
  answer entirely. On 7,047 alerts that is seventy-one sequential pages.

Later opens in the same session were fast because the sweep is held briefly in
memory. That is exactly why this only ever appeared on the first open after a
launch, and why it read as a cold-start mystery rather than a missing cache
read: serving the list instantly bought nothing while the thing beside it still
walked the whole organization.

The counts are arithmetic over the rows already stored, so the summary now
reads storage first and sweeps only when nothing is stored, which is the first
open for an organization that has never had one.

One trap in doing that, and the reason the counting is a single shared
function: **the stored rows are not the swept rows.** Storage also holds a
marker for every repository that produced no findings, so a clean repository
can be told from an unwatched one. Those rows carry a severity, and counting
them would report findings against every quiet repository in the organization.
A degraded stored answer is refused exactly as a degraded sweep is.
`repro-summarysource` pins it.

While measuring this: nothing in the backend compressed anything, on any
route. The tab's own body is 2.76MB of JSON and 64KB gzipped, a 43x reduction,
so responses over 4KB are now gzipped by a twenty-line middleware. Written
rather than installed, because every runtime dependency has to be declared and
bundled or the packaged desktop build breaks in a way `npm run dev` never
shows, and an app whose subject is dependency risk should be slow to add
dependencies. `repro-compression` covers what must *not* be compressed: a
client that did not offer gzip, a body too small to be worth the headers, and
anything already encoded, since double-encoding reads as corruption rather than
as this middleware.

### Where the answer comes from

The sweep is stored, and the tab reads storage. On an organization with
Dependabot on everywhere the walk takes a while, and paying for it on every open
made the tab slow every time rather than once.

- **Stored, gzipped**, in the same snapshot table as the widgets. Two thousand
  alerts are 434KB raw, past DynamoDB's 400KB item limit, and 15KB packed. A
  payload too large even packed is refused rather than truncated: a partial
  answer here reads as repositories that are clean.
- **Under ten minutes old, it is served as it stands.** Older, it is still served
  immediately and a refresh runs behind it, so nobody waits for a walk to look at
  findings that are minutes old.
- **The alarm pass keeps it warm.** When a Dependabot-backed alarm made the pass
  sweep the organization anyway, the pass hands what it swept to the same builder
  the tab uses and stores the result, at most once every half hour. Nothing is
  ever swept for the cache's sake: a pass with no such alarm starts no walk. So
  most opens find something recent already stored, without adding a request to
  the five-minute pass.
- **A degraded sweep is never stored**, for the same reason an alarm will not
  read one.
- **The tab says how old the picture is**, under the heading, because a sweep
  from twenty minutes ago and one from just now look identical otherwise.

One builder, `services/dependencyView.ts`, serves the tab, the background
refresh and the alarm pass. Two copies would be two places for the "off" and
"clean" markers to drift, and the drift shows as a repository reading clean on
one path and unwatched on the other. `repro-depsnapshot` pins this.

### Two windows, and getting their order right

The tab kept sweeping on every launch even after the throttle was made durable,
and the reason was a relationship rather than a bug in either half.

**The cloud warm-up was conditional.** It ran only where a Dependabot-backed
alarm had already made the pass sweep, so that nothing was ever swept for the
cache's sake. That was a deliberate decision and it was wrong: on an account
with no such alarm the row was never filled by the pass at all, so `computedAt`
only advanced when somebody opened the tab, and opening the tab is exactly what
the row exists to make cheap. It now warms hourly regardless, reusing a sweep
the pass already made where there was one.

**And the windows were the wrong way round.** The pass warms hourly; the tab
refreshed anything over half an hour old. So the tab always won, and swept on
every open. A foreground refresh is a *fallback for when the background one has
stopped*, which means its window has to be longer than the background cadence,
not shorter. Three hours against the pass's one.

Three windows now, doing three different jobs, and conflating any two of them
produces exactly one of the bugs above:

| Window | Length | Governs |
| --- | --- | --- |
| Fresh | 10 minutes | What the tab **says** about its data |
| Warm | 1 hour | How often the **cloud pass** refills the row |
| Due | 3 hours | When the **tab itself** falls back to sweeping |

The last live GitHub call that tab made is stored too. The Dependabot pull
request counts were a search on the thirty-a-minute budget plus a GraphQL batch
per fifty pull requests, on every open, and they are now filled by the same
hourly pass. Opening the Vulnerabilities tab should now make no request to
GitHub at all.

### Renovate, read from storage rather than computed on open

Both halves of the Renovate view cost a search against the smallest budget
GitHub gives, thirty requests a minute, and the dashboard half then parses an
issue body per repository. All of that happened while somebody waited, on every
open, and spent that budget every time.

Both are stored now, in the same table as the Dependabot sweep and under the
same rules: compressed, refused rather than truncated when oversized, served
immediately with a refresh behind the reader, and a failed save reported rather
than silent. Two rows rather than one, because the pull requests and the
dashboards are read by different views and a single row would make the cheaper
view carry the more expensive one's payload.

**Filled hourly by the alarm pass**, which is the only thing that runs whether
or not the app is open. Unlike the Dependabot warm-up beside it, this one starts
the work rather than piggybacking: nothing else in the pass reads Renovate, so
there is nothing to piggyback on, and an hourly search is the price of the tab
being instant instead of taking a minute. It is skipped entirely where no bot is
configured, skipped where the stored answer is still fresh, and a failure there
cannot cost the pass its alarms.

One builder each, shared by the pass and the route, so the stored answer and a
freshly computed one cannot differ in what they carry.

### The bot's login is resolved, not assumed

The dashboard view shipped saying "Could not read the Renovate dashboards" on an
organization whose dashboards were all present.

`author:` wants a GitHub App's **exact** login, which is `<name>[bot]`, and that
suffix is invisible in GitHub's own pages: it shows the display name with a
separate "Bot" label. So the obvious thing to configure is the thing search
rejects, and GitHub answers an unknown author with 422 rather than an empty
result. That 422 became a 500, and the 500 became "could not read".

The pull request search had solved this long before, in `botCandidates`, trying
both spellings and reporting an unknown name as its own state because the fix is
to correct the name and no message about a failed search says that. **Not
reusing it was the whole bug.** The dashboard sweep now shares it, reports
`unknownBot` the same way, and the panel says which name failed and why the
suffix is easy to miss. Any status other than 422 is still raised rather than
retried under a different name, which would only obscure it.

### The dashboard, organised by what is wrong

The first version of that panel listed repositories and put the states inside
them, which is the shape of the underlying data and the wrong shape for the
question. Nobody opens it asking "what is happening in payments-api". They open
it asking "what is broken", and then want every repository it is broken in
together, to act on in one pass.

So the outline is inverted: one foldable section per state, repositories nested
inside them, items inside those, and the dependency inventory as its own section
at the bottom. Everything folds, and it is an outline rather than a grid of
cards, because the useful shape here is a tree somebody collapses down to the
part they care about.

Three rules make it usable at organization scale:

- **Worst first, and only the worst open.** Errored, blocked and rate-limited
  are open by default; the six states below them are Renovate working as
  intended. Opening all ten would put two thousand lines in front of somebody
  who came to look at fourteen.
- **Searching opens everything.** A shut section hiding the only match is a
  search that reports nothing found. The filter reaches repository names, update
  titles, branches, and the package inventory inside each repository.
- **Open is stored as "flipped from default", not as "open".** Sections have
  different defaults and repositories default to open inside an open section, so
  one rule reads both rather than two sets that can disagree.

### The Renovate dependency dashboard

A self-hosted Renovate has no API and no web dashboard: it runs and exits. The
hosted Mend app has one; a self-hosted bot does not. What it does have is the
**Dependency Dashboard issue** it keeps in each repository, and everything worth
knowing is in there and in nothing else. Read only the pull request list, as
this app did, and a repository where Renovate errors on every run looks exactly
like one with nothing to do.

So the Renovate view has two lenses now, inside the one view rather than as a
fourth tab: the pull requests it has raised, and the dashboard saying what it
would raise and has not. Errored, blocked, rate-limited, awaiting approval,
awaiting schedule, pending checks, and the full dependency inventory.

**Keyed on the HTML comment markers, not the section headings.** This is the
whole design decision. Renovate writes markers like
`<!-- unlimit-branch=renovate/axios-1.x -->` and then reads them back to learn
which box somebody ticked, which makes them a machine contract it cannot
casually change. The headings above them are prose: seventeen of them, worded
for people and reworded between releases. Keying on a heading would break this
on a Renovate upgrade, and break *quietly*, in the direction that reads as a
repository with nothing pending. The marker carries the action too, so an item
under a heading this parser has never seen still lands in the right bucket.

The ten per-branch markers map to ten states, and the three approval markers
stay apart: `approve-branch`, `approvePr-branch` and `approveGroup-branch` are
three different situations, and collapsing them sends somebody to tick a box
that is not in that section.

Buttons **tick the checkbox**, which is how a self-hosted bot is instructed.
That makes the write a Markdown edit to an issue that also holds the inventory
and every other pending update, so it is surgical: exactly one line changes,
keeping its own indentation and bullet, and a marker that is absent or already
ticked writes nothing at all. The body is re-read at the moment of writing
rather than taken from the sweep, because Renovate rewrites this issue on every
run and a stale body written back would revert what it changed.

Three things sized deliberately:

- **One search finds every dashboard**, carrying the bodies, so the view costs
  one request rather than an issue read per repository. Found by author rather
  than by title, since `dependencyDashboardTitle` is configurable and an
  organization that renamed it would appear to have none.
- **The inventory is a separate read per repository, on expansion.** Across an
  organization it is megabytes and almost nobody opens it.
- **Bot issues that do not parse are counted and reported**, not silently
  dropped. It is how somebody notices the parse has stopped recognising
  dashboards after an upgrade, which would otherwise look like every repository
  having nothing pending.

`repro-renovatedashboard` pins the parse and the tick, including that ticking
one box leaves every other line byte-identical.

### What a Renovate pull request patches

The row said "Update all non-major dependencies" and stopped, so deciding
whether to merge meant opening GitHub, which is what this screen exists to
save. Expanding a row now lists the packages and the versions either side.

Renovate has no API to ask, and the changed files name manifests rather than
packages, so the body's markdown table is the only statement of what is moving.
That is prose, and the table has changed shape between Renovate versions and
between presets: different columns, in different orders, with and without the
age and confidence badges. So nothing in the parse counts columns. It keys on
the two things every version of that table has carried, a linked package name
and a version transition in backticks, and skips any row without both. The
header and separator rows fall out on their own, having no link.

Fetched per pull request on expansion rather than for all of them up front: a
grouped update's body is large and most rows are never opened, so the cost is
proportional to what somebody actually looks at.

A body that yields nothing returns **null, never an empty list**, because "this
updates nothing" and "nobody could read what this updates" are opposite claims.
The panel falls back to the changed files there, which is less than the
packages but is read rather than guessed. `repro-renovatechanges` pins it.

The counts above the list stopped being five large metric tiles in a card of
their own. They read as the most important thing on the screen when they are
really a way to narrow the list below, so they are chips on the search row now:
same numbers, one line instead of a band, and they look like what they do.

### What a Renovate pull request needs before it can merge

The Renovate view listed a repository, a number, a title and an age, which is
enough to know a pull request exists and not enough to decide anything about
one. The question in front of that screen is which of them can be merged now,
so the screen leads with that: a row of counts over every open pull request,
ready, failing, conflicting, waiting, unknown, each clickable as a filter, and
then per row the check rollup, the review decision, whether it still merges
cleanly, the size of the change, the branch (which names the package better
than the title does) and its labels.

Three constraints shaped how those details are fetched:

- **Over GraphQL, fifty pull requests to a request.** REST would be two calls
  per pull request, the pull request and its check runs, so a hundred open ones
  is two hundred requests.
- **Off the search budget.** Search found them, and search is thirty requests a
  minute, the smallest allowance the app touches. GraphQL is a separate budget.
- **Open ones only.** Nobody is deciding anything about a closed pull request,
  and on an organization keeping months of them that is most of the list.

Discovery still goes through the REST search, unchanged, because the bot-name
resolution depends on its behaviour: search answers an unknown author with 422
rather than an empty result, which is how a mistyped bot name is told apart
from a bot with nothing open.

The rule the details turn on: **an unknown check is not a passing one.** A batch
that fails, a repository with no checks configured, a mergeability GitHub has
not finished computing, all stay "unknown", and none of them count as ready.
The value of the label is that it can be trusted without opening the pull
request, and one wrong "ready" costs more than ten cautious "check this one".
Responses are matched back by the repository and number inside them rather than
by alias order, so a null in the middle of a batch cannot shift every later
pull request onto another one's check status.

`repro-renovatedetails` pins all of it.

### The three views

The tab answers three questions, and they are three views rather than one
column: **Dependabot** (what is vulnerable), **Renovate** (what has been raised
to fix it), and **Notifications** (who gets told). The view is a URL parameter,
so it survives a refresh and can be linked to, the ids behind them are still
`alerts` and `updates`, which is why a link made before the tabs were renamed
still works.

They were stacked before, every vulnerable repository, then the Dependabot
email settings, then Renovate, then the Renovate email settings. Reaching
Renovate meant scrolling past a page of repository cards, which put the two
halves of one question at opposite ends of a scroll bar.

Two consequences worth keeping:

- **No view waits for another view's data.** The Dependabot fetch used to be an
  early return for the whole page, so opening Renovate waited for an alert list
  it does not use, the same fault as the scroll, wearing a different hat. The
  spinner belongs to the Dependabot view now.
- **Refresh refreshes the view you are on.** Refetching all three would spend
  GitHub's rate limit on two views nobody has open.

The Updates tab's count comes from the page issuing the *same* `["renovate"]`
query the panel does, so React Query serves both from one request rather than
fetching twice. `repro-vulnviews` pins all of this.

---

## Security checks (the widget queries)

**Shape: two kinds, some answer instantly, some are built up over time.**

A widget on the Overview page runs a *check*: "repositories with no branch
protection", "people with admin nobody explains", and so on.

**Most read the stored graph** and answer immediately. The graph is already in
DynamoDB, so this is one scan and some filtering, no GitHub call, and no waiting.

**Some cannot be answered in one go.** A check like "which accounts have committed
in the last 90 days" needs one GitHub search *per subject*, and GitHub allows
thirty searches a minute. Two hundred and fifty accounts cannot be checked in one
request no matter how patient you are.

Those work differently:

1. Each pass checks as many subjects as the rate limit allows.
2. Each answer is stored as its own row in the `alarms` table
   (`kind: "query-subject"`), expiring after 24 hours.
3. The check reports its coverage, *"checked 25 of 250"*, rather than a number
   that is only partly true.
4. Later passes fill in the rest, and the card completes over several minutes.

### The path

Two, and the card tells you which one it is on.

```
  MOST CHECKS, answered immediately

  the widget ──▶ read the stored connections ──▶ filter them ──▶ the answer
                 (no GitHub call at all)

  THREE CHECKS, built up over several minutes

  the widget ──▶ show what has been answered so far, and say how far along
                     │
                     └──▶ meanwhile: take the next batch of people (or repos)
                          nobody has asked about yet, ask GitHub about each
                          one, and file each answer separately
                                       │
                                       ▼
                          when every subject has an answer on file,
                          the card stops saying "checked 25 of 250"
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| the stored connections | The `github-control-hub-graph-edges` table |
| ask GitHub about each one | One search per person for "who has not committed lately"; one read per repository for the two branch-protection checks |
| file each answer | A row per subject in the `github-control-hub-alarms` table, thrown away after 24 hours |
| a batch | 25 subjects for the search-based check, 50 for the others, sized to GitHub's limits, which are 30 searches a **minute** but 15,000 ordinary calls an **hour** |

1. **Most checks never leave your own database.** The connections are already
   stored, so the check is one read of them and some filtering, no GitHub call
   and nothing to wait for.
2. **Three checks cost one GitHub call per subject**, which is what makes them
   different: `dormant-privileged-users` runs a commit search per privileged
   account; `stale-branch-protections` and `protection-bypasses-ranking` read
   protection and merged pull requests per repository.
3. **The batch size is the rate-limit budget, declared per check.**
   `dormant-privileged-users` is `{ budget: "search", gapMs: 61_000, perPass: 25 }`
   search allows thirty requests a *minute*, so twenty-five is one batch and a
   second inside the same minute would be over the line, hence the 61-second
   gap. The two protection checks spend the core allowance (15,000 an hour) and
   run 50 a pass, seconds apart.
4. **Subjects are picked never-checked first, then oldest-first**, so coverage
   completes rather than re-asking about the same accounts.
5. **"Checked and clean" is stored as a verdict**, not left out. Without it a
   clean subject would be indistinguishable from one never reached and coverage
   could never reach 100%.
6. **Nothing is reported until coverage is complete.** While it builds, the card
   says *"checked 25 of 250"* rather than a number that is only partly true,
   the only place in the app that deliberately shows an incomplete answer, and
   it says so.
7. **An answer counts for 24 hours, and that is checked when it is read** rather
   than trusted to the expiry. DynamoDB deletes late, often days late, and a
   row still sitting there is not the same as an answer still worth having.

### The dashboard opens from stored answers

Every widget's rows are computed by the **5-minute alarm pass** and stored, one
row per widget in the `alarms` table (`kind: "widget-snapshot"`, 24-hour TTL).
The Overview reads those and renders immediately.

**Each pass overwrites the last. No history is kept.** The row's key is
`widget-snapshot#<widgetId>`, derived from the widget alone, with no timestamp
in it, so writing the new snapshot replaces the old one in place. There is
exactly one row per widget at any moment, however long the app has been running:
eleven widgets means eleven rows, this month and next. What changes is
`computedAt`, not the number of rows.

This is deliberate. A snapshot is a cache of *the current answer*, not a record
of what was true at 3pm; nothing in the app reads yesterday's snapshot, and
keeping them would grow the table by 288 rows per widget per day to store
answers nobody asks for. History that is worth keeping is kept elsewhere and on
purpose, the `activity` table records what changed, and alarm rows record what
fired.

The 24-hour TTL is therefore not a retention policy, a snapshot is replaced
long before it can expire. It is a cleanup for rows that stop being rewritten:
delete a widget and its snapshot is removed immediately, but if that delete is
missed, the TTL removes it within a day rather than leaving it forever.

Before this, each card ran its check inside the request that drew it: a full
scan of the graph table, live GitHub calls for the dependency cards, and, for
the three subject-by-subject checks, up to twenty-five commit searches against
a budget of thirty a minute, on a cold process, right after launching the app.

| | |
| --- | --- |
| Written by | `alarms/handler.ts`, after the alarm evaluation |
| Cost | Reuses the memoised sources the alarms already built, so a widget an alarm watches is not computed twice |
| Order | Sequential, because running them at once would fire every live GitHub call in the same instant |
| Read by | `GET /api/widgets/snapshots`, one request for the whole dashboard |

Four rules make it safe to serve a stored answer:

- **The live sources are switched off when a snapshot is used**, not fetched and
  ignored. `useDependencies(!fromSnapshot)` and the `isQuery` / `isBypass` flags
  do that. Fetching anyway would leave the cost exactly where it was.
- **A stored error is not an answer.** A snapshot carrying one falls through to
  a live read, so the card shows the real failure rather than a stale number.
- **A trimmed snapshot is enough for a card, not for the table.** Results are
  trimmed to 300KB to fit the item limit, and `total` still reports the true
  count, so the card is right. The detail view asks with `needAllRows`, which
  rejects a trimmed snapshot and reads live.
- **The age is on screen.** "Checked 4 minutes ago · refresh to run them now",
  under the headline. A figure shown as current when it is twenty minutes old is
  the failure this feature could otherwise introduce.

**Refresh** puts the page into a live window for 90 seconds: every card drops its
stored answer and runs its own check, which is what the page used to do on every
open. Long enough to finish and be read, short enough that a tab left open does
not quietly return to running every check on every render.

A widget added since the last pass has no snapshot and computes live, so it
works immediately rather than showing nothing until the next tick.

### The infrastructure

Verdicts share the `alarms` table, one row per subject:

```
id        "<queryId>#<subject>"        e.g. "dormant-privileged-users#alice"
kind      "query-subject"
verdict   whatever the check concluded about that one subject
ttl       <epoch seconds, +24h>
```

Two things follow from putting them there rather than in their own table. A
verdict expires by itself after 24 hours, so a check that stops running fades out
rather than reporting last week's answer for ever. And because `alarmService`
reads that table for alarms and groups, its scan **filters these out
server-side**, on a large organization there are hundreds of them, and every
alarm pass would otherwise page through a cache it never reads.

**Which code touches it:**

| File | Role |
|---|---|
| `services/queryCacheService.ts` | verdict storage, the per-check budgets, the throttle |
| `services/graphService.ts` | `evaluateSecurityQuery`, runs a check, cached or direct |
| `routes/graph.ts` | the card, and `POST /query/:q/refresh-all` |

Each slow check declares its own budget in `queryCacheService`: whether it spends
GitHub's **search** allowance or the **core** one, how long to wait between
passes, and how many subjects to attempt per pass. A search-budget check waits 61
seconds between passes because GitHub allows thirty searches a minute.

**Re-check** on the card spends a budget of time working through as many subjects
as it can, then stops and says how far it got. This is the only place in the app
where a screen deliberately shows an incomplete answer, and it says so plainly
rather than rounding up.

---

### The detail table's columns

Clicking a widget opens a table whose columns are **draggable**, and the widths
are the one piece of this app's state that lives in the browser rather than in
DynamoDB, `localStorage`, under `columnWidths:widget:<id>:<column ids>`. It is
per-machine preference, not organization data; there is nothing to reconcile
across accounts and nothing worth a round trip.

Three details are load-bearing:

- **Only the differences are stored.** A column left alone keeps following its
  default, so changing a default still reaches somebody who opened the table
  once. Storing every width would freeze today's defaults into every saved
  layout for ever.
- **The column ids are part of the key.** A widget edited from a preset into a
  query has different columns, and a layout saved for the old set describes a
  table that no longer exists.
- **The last column has no fixed width**, so it absorbs whatever is left and the
  table keeps a clean right edge. Before this, that column carried `w-full`,
  which in a table means `width: 100%`, so it claimed everything and every other
  column collapsed to its narrowest renderable size. The repository name, the
  column people were actually reading, was the one that got nothing while the
  mostly-empty column beside it took half the screen.

`lib/columnWidths.ts` holds the arithmetic and `lib/widgetColumns.ts` the column
sets; both are pure and covered by `repro-columnwidths`, which also asserts that
the number of columns matches the number of cells the body renders for each
widget type, a `<colgroup>` of the wrong length does not throw, it silently
shifts every width one column across.

## Important events

**Shape: push.** Nothing here is computed or scanned. Every row on the Security
tab's alert list exists because GitHub sent a webhook saying something changed.

This is a different mechanism from the checks above, on the same page. The
checks answer *what is true now*, by querying the stored graph. The alerts
answer *what changed, and when*, and they can only know what GitHub told them.

### The path

Taking "a team was added to a repository" as the example:

```
  somebody clicks "Add team" in GitHub
        │
        ▼
  GitHub sends a message to your AWS account, within about a second
        │
        ▼
  the front door ──▶ is this really from GitHub? ──no──▶ rejected, nothing runs
  (API Gateway)      (checked two ways: the sender's
        │             address, and a signature)
        ▼
  the doorman ──▶ drops it in a waiting line ──▶ the handler picks it up
  (a Lambda)       (an SQS queue)                (a Lambda)
                                                       │
                                        "have I already handled this one?"
                                                       │
                                                       ▼
                                        match it: event "team",
                                        action "added_to_repository"
                                                       │
                        ┌──────────────────────────────┼──────────────────┐
                        ▼                              ▼                  ▼
                 write an alert              note it in the        email it, if
                        │                    activity feed         you turned that on
                        ▼
            Activity, Important events
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| the front door | API Gateway, the only address anything outside your AWS account can reach. It only accepts requests from GitHub's four published address ranges, and that check happens before any code runs |
| the signature | GitHub signs each message with a shared secret. The doorman recomputes the signature and compares |
| the doorman | A Lambda: `github-control-hub-webhook-receiver`, 256 MB, 8-second limit. It can reach exactly two things, the secret it needs, and the waiting line |
| the waiting line | An SQS queue. Five failed attempts and the message moves to a dead-letter queue instead of being lost |
| the handler | A Lambda: `github-control-hub-webhook-worker`, 512 MB, 10-minute limit (`webhooks/processDelivery.ts` is the matching part) |
| "already handled this one?" | A row written in the `github-control-hub-webhook-deliveries` table, written only if it is not already there, so a message delivered twice is handled once |
| an alert | A row in the `github-control-hub-alerts` table |

**How the tab reads them.** `GET /alerts` returns one page, newest first,
bounded to the twelve weeks the charts draw, through a `feed-index` GSI keyed
on `feed="ALERT"` with the timestamp as its sort key. One partition for the
whole feed, the same shape the activity table uses.

The index is not an optimisation, it is what makes the read possible. A
DynamoDB Scan returns items in hash order, so a Scan with a `Limit` hands back
an *arbitrary* subset, and calling those "the newest three hundred" would be
untrue. Before this the tab fetched the entire table on every poll, and polled
every ten seconds.

- Under `PAGE_LIMIT` (3,000) in the window, the response is `complete: true`
  and the page behaves exactly as it always has: search and the charts run in
  the browser over everything.
- Over it, the response carries a cursor, and the page **says so**: the chart
  heading changes from "12 weeks" to "since \<date\>", the list heading from
  "Everything recorded" to "Everything loaded", and a band under the list
  offers **Load older**. A truncated chart under a full heading is the exact
  shape of lie this tab keeps being rebuilt to remove.
- The client polls once a minute, not every ten seconds. An alert is emailed
  within seconds of the webhook, so the tab does not need to be a live ticker.

`getAlerts()`, which scans, is kept for the nightly drift check: it has to know
everything already on the record before it raises anything, and a paged read
would let it duplicate something it could not see.

**Rows written before the index have no `feed` and are not in it.** They are
untouched and still readable by anything that scans, but the tab cannot see
them until `scripts/backfill-alert-feed.sh --apply` runs. It writes only where
the attribute is absent, so it is safe to run twice.

1. **The only reason this works is that the app asked GitHub to tell it.** The
   GitHub App is subscribed to team events. Nothing scans for this, so if that
   subscription is off, nothing is ever flagged and nothing looks wrong.
2. **There is no rules engine and no inference.** The handler compares two
   strings, the event is `team`, the action is `added_to_repository`, and
   writes the alert. That is the whole of "how it knows":

   ```js
   if (event === "team" && payload.action === "added_to_repository") {
     await createAlert(repoName, "team_added", …, "medium", …);
   }
   ```

3. **Everything GitHub sends is scrubbed before it is stored**, because these
   strings end up rendered on a page. Characters that could turn text into
   markup are stripped and long values are cut short.
4. **The time on the alert is when GitHub handed it over**, not when the handler
   got round to it. Otherwise a backlog, a retry, or GitHub resending a week-old
   event would all be dated "now".
5. **A failed email does not undo the alert.** Sending is attempted after the
   alert is already stored, and a failure there is logged and dropped,
   otherwise the whole message would be reprocessed and you would get a second
   copy of everything else it did.

### What is flagged, and how hard

| GitHub sends | Alert | Severity |
|---|---|---|
| `repository` publicized | `repo_made_public` | critical |
| `branch_protection_rule` deleted | `protection_removed` | critical |
| `repository_ruleset` deleted | `ruleset_disabled` | critical |
| `branch_protection_rule` / `repository_ruleset` edited | `protection_drift` | high |
| `team` edited, permissions changed | `team_permission_changed` | high |
| `member` added | `admin_added` | medium |
| `team` added to / removed from a repository | `team_added` / `team_removed` | medium |

### Three things worth knowing

**No alert is ever cleared by hand.** There is no Resolve button and no route
behind one. An alert is a record of something that happened, not a task: it is
written, counted, and expires on the same 13-month schedule as the activity log.

The reason is that nearly every alert reports a change somebody made on purpose.
Asking a person to clear each one recorded only that a button had been pressed,
in a row nobody opened again, and a queue that is right almost every time is a
queue nobody reads. So **Activity, Important events** shows a **last 7 days**
window that empties itself, a 12-week chart, and per-kind trends against each
kind's own baseline. What deserves attention is the kind running *above* its usual rate,
which the page computes rather than asking somebody to notice.

**`resolved` now means one thing: the change was undone.** The webhook worker
still sets it when a repository is made private again, when branch protection
is recreated, when a ruleset comes back, or when a member is removed, and the
page shows those as "undone since". `team_added` has no such partner: removing
the team writes a *second* alert rather than marking the first. Rows carrying a
person's login in `resolvedBy` are from before this change and mean only that
somebody pressed the old button.

**A reversal closes only what it reversed.** Each alert records a `subject`:
the member's login, the branch pattern, the ruleset's name. `autoResolveAlerts`
used to match on repository and type alone, so removing **one** of two people
added to a repository marked *both* alerts undone, and restoring protection on
one branch marked every branch in that repository. Harmless while `resolved`
only meant "off the queue"; not harmless once the page states it as a fact.

Two details worth keeping:

- The ruleset subject is its **name**, not its id. A deleted-and-recreated
  ruleset comes back with a new id, so an id could never match its own
  reversal.
- **A row with no `subject` is never closed by a subject-bearing reversal.**
  Those are rows written before this existed and there is no way to tell what
  they were about. Closing them would be the original bug; they age out
  instead.

**Who made the change is recorded.** The webhook's `sender.login` is stored on
the alert as `actor`. It used to be computed for the activity log and dropped,
so a record of a privilege change knew who *received* it and not who *granted*
it.

**There is no Security tab.** It was deleted, and everything it held lives in
**Activity, under Important events**: the twelve-week chart, the per-kind
trends, the repositories involved, the grouped rows that open to the events
inside them, and the notification settings that decide who is emailed about
them.

The events are the same material as the activity streams, read as a shape
rather than as a table, so they belong beside them. And "security alert" was
the wrong name for them: almost every row is a legitimate action, a repository
made public on purpose or somebody given the access they were hired to have.
The word promised a vulnerability and delivered a changelog, which is what made
the tab read as a queue.

`/security` still resolves, as a redirect to `/activity`. The desktop app
restores the route it was last on, so removing it outright would reopen to a
blank screen for anyone who quit while it was open.

**The name changed; the stored keys did not.** Everything a person reads says
"important event": the panel heading, the words in the emails, the activity row
written when the settings change, the details column in the feed.

What is keyed on has been left exactly as it was, deliberately:

| Stays | Why |
|---|---|
| `security-settings` row id | renaming it orphans the settings somebody saved |
| `kind: "security"` | the discriminator every stored notification row carries |
| `"security.alert"` action | rows have already been backfilled *to* this value |
| `"security"` feed key | the pending-notification buffer is keyed on it |
| `/alarms/security` | an API path, not a sentence |

The words people read and the strings the data is keyed on are not the same
thing, and a rename that treats them as one is a rename that loses data. One
consequence to know about: the feed's details column says "Important event
\[CRITICAL\]: …" on new rows and "Security Alert \[CRITICAL\]: …" on rows
written before the rename, so `backfill-security-alert-action.sh` matches
either prefix.

**A lost webhook is caught by the nightly walk.** Every alert is created by the
webhook worker and nothing re-derives them, so a delivery lost past GitHub's
retry window used to be an event that silently never became an alert. The
nightly rebuild now compares the state it just read against the state it stored
on the previous walk, and raises an alert for anything that changed with no
webhook to explain it. It costs nothing extra: the rebuild already loads the
whole stored graph to work out what to delete, so both sides are in memory.

Only two things are compared, and both are critical:

| Was | Is | Alert |
|---|---|---|
| repository not public | public | `repo_made_public` |
| branch protected | not protected | `protection_removed`, named for the branch |

Everything else in the graph churns for ordinary reasons and would bury the real
ones. Four rules keep it quiet:

- **No prior record, no drift.** A repository this walk is seeing for the first
  time is a repository, not a change. This is what stops a first run alerting on
  the whole organization at once.
- **A deleted branch is not a protection removal.** There is no longer a branch
  to protect.
- **An alert already on the record silences it.** On a healthy installation
  every change has arrived as a webhook already, so this writes nothing at all.
  A *reverted* alert does not silence it: a repository that went public, was
  made private, and went public again is a second event.
- **More than `MAX_BELIEVABLE_DRIFT` (20) raises none of it.** Twenty
  repositories quietly going public between two nightly walks is a bug, a
  restored backup, or a graph written by another version. The run logs loudly
  and writes nothing.

These alerts carry `source: "reconciliation"` and **no actor**, and the Security
tab labels them. All the walk knows is that the value changed between two runs,
so the timestamp is when it was *noticed*, and nobody knows who did it. A login
and an exact time would both be invented.

**An alert does not touch the access graph.** The worker updates connections for
branches, collaborators and protection, but not for teams, so the alert appears
in seconds while the Access map still shows the team's old connections until the nightly
rebuild.

**A lost delivery is lost.** Rejected at the gateway, GitHub retries for a while
and gives up, and nothing back-fills it. The team's access will surface on the
Access map at the next rebuild, but no alert is ever created for it. The Activity
page's *Receiving events / Quiet / Stale* indicator is the only sign the feed has
gone silent.

## Activity feed

**Shape: stored, append-only.** Nothing here is ever recomputed, each row is
written once, when the thing happened, and read back later.

### What writes a row

| Writer | When |
|---|---|
| Any route that changes something | as it changes it, branch protection, a widget, a scanner, a ruleset |
| The guardrail Lambda | when a rule **actually fixed** something, or failed trying |
| The webhook worker | when GitHub reports a change somebody made on github.com |
| Any sync | when a refresh, sweep or re-check runs |

### The path

Four things write to it. Nothing ever rewrites a row: each one is written once,
when the thing happened, and read back later.

```
  anything in the app that changes something ─┐
  the webhook handler, when GitHub reports    │
    a change somebody made on github.com ─────┤
  the AWS sweeper, when a rule actually       ├──▶ one long list, newest first
    fixed something ──────────────────────────┤    every row expires after
  any refresh, sweep or re-check ─────────────┘              │
                                                             ▼
                                                     the Activity tab
                                                             │
                                            some rows carry the opposite of
                                            what was done, that is Undo
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| one long list | The `github-control-hub-activity` table. Every row is filed under the same single key so the whole feed can be read newest-first in one go, without searching |
| newest first | The row's sort key starts with the time, so the database is already holding them in the order the page wants |
| Undo | The row stores what would reverse the action. Pressing Undo replays that **using your own GitHub login**, so GitHub decides whether you may, the app does not |

1. **Every row is filed under the same single key**, which is what lets the whole
   feed be read newest-first in one go. The part that orders them starts with
   the time, so the database is already holding them in the order the page
   wants. It never has to search through everything to build the list.
2. **The AWS sweeper writes its rows itself**, rather than going through the
   shared code every other writer uses, the one exception, and deliberate. It
   is packaged on its own, and reusing that code would drag the entire app into
   that function. The catch is that it has to stamp the 13-month expiry itself,
   and a row written without one would sit there for ever.
3. **`id-index` exists because undo needs a row by its id.** Without it,
   `getActivityById` falls back to reading the newest rows and filtering, which
   answers "is it recent?" rather than "does it exist?", correct on a small
   log, silently wrong on a large one.
4. **`parentId-index` is sparse**: only child rows carry `parentId`, so the
   index holds exactly those and nothing else pays for it.
5. **Undo replays the stored inverse using your own GitHub token**, so GitHub
   authorizes the reversal on exactly the terms it authorized the original
   action. The app is not deciding you may reverse something.
6. **Scheduled work logs only when it did something.** 288 ticks a day recording
   "nothing was due" would be a hundred thousand rows a year of nothing; the
   per-tick detail goes to CloudWatch, where volume is free and nobody is trying
   to read a history.

### The infrastructure

**Table:** `github-control-hub-activity`, keyed `pk` (HASH) + `sk` (RANGE), with
two secondary indexes.

```
pk    "ACTIVITY"                              every row, one partition
sk    "2026-08-20T09:14:03Z#a3f2-…"           timestamp # id
id    "a3f2-…"                                also its own attribute
ttl   <epoch seconds, +13 months>
…plus action, actor, repo, target, details, and sometimes undoPayload
```

**One partition on purpose.** Every row shares `pk = "ACTIVITY"`, which makes the
feed a time series readable newest-first in a single query, with no scan. The
sort key starts with the timestamp, so DynamoDB is already holding it in the
order the page wants.

**Two secondary indexes**, because that choice costs something:

| Index | Why it exists |
|---|---|
| `id-index` | Undo needs to find one row *by its id*. Without this, `getActivityById` falls back to reading the newest rows and filtering, which answers "is it recent?" rather than "does it exist?" Correct on a small log, silently wrong on a large one |
| `parentId-index` | Finding a row's children. Sparse: only child rows carry `parentId`, so the index holds exactly those |

**Which code touches it:**

| File | Role |
|---|---|
| `services/activityService.ts` | `logActivity`, `logSync`, and every read, **the app's only writer** |
| `aws-guardrails/handler.ts` | writes rows **directly**, bypassing the service |
| `routes/activity.ts` | the tab, plus undo, redo and retry |

The guardrail Lambda writing directly is the one exception, and deliberate: it is
bundled on its own and importing the service would pull the whole app into that
function. It inlines the retention stamp instead, with a comment saying it must
match, a row without a TTL is a row that never expires.

### Reading it back

One page at a time, filtered on the server. Paging is by cursor rather than page
number, because that is what a single-partition time series supports; filtering
by an exact repository uses `repo-index` and is complete at any depth; free-text
search is bounded at 3,000 rows per request and says when it stopped early. See
[DYNAMO-TABLES](DYNAMO-TABLES.md#activity--the-audit-trail) for the indexes.

### The three streams

Rows are sorted into Organization, AWS and App settings by the prefix
of their action name, `branch.` and `repository.` are organization changes,
`aws.` is the guardrails, `widget.` and `sync.` are housekeeping. The mapping is
data, in `frontend/src/lib/activityCategories.ts`, and an unrecognized action
falls back to Organization on purpose: hiding something new in a tab nobody
watches is the failure worth avoiding.

### Syncs are logged too, but not every tick

Every refresh, sweep and re-check writes a `sync.*` row naming who asked and what
came back.

- **A manual press is always logged**, even when nothing changed. "I refreshed
  and nothing was different" is frequently the fact somebody is trying to
  establish.
- **The 5-minute jobs log only when they did something.** 288 ticks a day saying
  "nothing was due" is not an audit trail, and the full detail still goes to
  CloudWatch where volume is free.

### Undo

A row can carry an *undo payload*, the inverse of what was done. Undo replays it
**using the caller's own GitHub token**, so GitHub authorizes it exactly as it
would have authorized the original action. The app is not deciding you may
reverse something; GitHub is, on the same terms as when you did it.

## Detailed GitHub logging

**Shape: a toggle over what the webhook worker records.** No extra
infrastructure, no schedule, no bucket. It reuses deliveries the worker already
receives.

The Activity feed's Organization stream always records changes to **structure
and access**: repositories created, deleted or made public; branch protection
and rulesets changing. Those are why the feed exists and no switch governs them.

Detailed logging adds the **routine traffic of people working**, which is
sometimes exactly what an admin wants to see and sometimes pure noise:

| Kind | From webhook |
| --- | --- |
| Branch created / deleted | `create` / `delete` |
| Tag created / deleted | `create` / `delete` |
| Commits pushed | `push` |
| Pull request opened / merged / closed | `pull_request` |

Every kind comes from an event the app already subscribes to, so turning this on
never means ticking a new box on the GitHub App.

### Turning it on and off

**Activity, Organization tab.** Admins only (`aws-guardrail-admins`); everyone
else sees the rows and the view filter, never a control they cannot use. Each
kind can be unchecked individually while the toggle stays on.

**The toggle governs collection, never display.** Turning it off stops new
detailed rows from being written and deletes nothing: everything collected while
it was on stays in the feed for its full 13 months. Unchecked kinds are
remembered, so turning the toggle back on restores the same selection.

Flipping it is itself an activity row, so the feed records who changed it.

### How a row is marked

Rows written under the toggle carry `detailed: true` **on the row**, rather than
being identified by their action name. That is what keeps the view filter
truthful if the set of detailed kinds ever changes: a row still reports what it
*was* collected as. The Activity page shows a small `detailed` label on those
rows and offers a **Detailed rows: Shown / Hidden** filter, whose choice is
remembered per browser.

### Where the settings live

`org-config`, under `detailedLogging` (`enabled`, `disabledKinds`, and who
changed it when). The webhook worker reads it through a 30-second cache, because
one push fans out to several deliveries and the answer changes a few times a
year.

Two deliberate failure choices:

- **A settings read that fails skips the detailed row**, and logs why. Wrongly
  skipping loses a line of routine history; wrongly writing ignores an admin's
  explicit off switch.
- **Detailed logging failing never fails the delivery.** A throw would make the
  worker release its claim and re-run every other effect of that event.

### What replaced

This took the place of **enterprise audit-log streaming**: an S3 bucket GitHub
streamed into, and a Lambda that indexed the consequential events into the
activity feed. It was removed because GitHub's own enterprise settings already
show that log, and the per-object cost of the pipeline (a PUT and a Lambda
invocation per event) bought little the enterprise UI did not already give.

The rows it wrote have been deleted along with it.

On a stack that had it deployed, the bucket carried `RemovalPolicy.RETAIN`, so
it is **orphaned rather than deleted**. Empty and delete it by hand when its
contents are no longer wanted.


## Webhooks

**Shape: push.** GitHub tells the app when something changes, rather than the app
asking.

### The path

This is the path every pushed event takes; the feature sections above join it at
the last hop.

```
  GitHub ──▶ the front door ──▶ the doorman ──▶ the waiting line ──▶ the handler
             is it from GitHub  verify the      (a queue, so a       decide what
             at all?           signature,       slow handler is      it means, and
                               then hand it     nobody's problem)    write it down
                               off in under
                               8 seconds
                                                                          │
                    ┌──────────────┬──────────────┬──────────────┬────────┘
                    ▼              ▼              ▼              ▼
              activity feed   connections   important event  rescore that
                                                             repository
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| the front door | API Gateway. Only GitHub's four published address ranges are allowed, enforced before any code runs, with a firewall in front of that |
| the doorman | A Lambda: `github-control-hub-webhook-receiver`, 256 MB, 8-second limit, deliberately under GitHub's 10-second cutoff, because past that nobody is listening for the answer |
| the waiting line | An SQS queue. Five failed attempts and the message goes to a dead-letter queue, kept 14 days |
| the handler | A Lambda: `github-control-hub-webhook-worker`, 512 MB, 10-minute limit. One message at a time, at most five at once, to stay inside GitHub's rate limit |

1. **The address check happens before anything else, and cannot be bypassed by
   a mistake elsewhere.** It is a policy on the front door itself rather than a
   check inside the code, so a request from the wrong place never reaches
   anything that could be buggy.
2. **The doorman can reach exactly two things**: the secret it needs to verify
   signatures, and the waiting line. It holds no GitHub credentials and cannot
   write to any table. If it were ever broken into, what it yields is the
   ability to check signatures.
3. **If a rotation changes the secret, it retries once with a fresh copy**,
   otherwise every delivery would be rejected until a cache happened to expire.
4. **A message too large for the queue fails loudly rather than quietly.**
   Accepting it and dropping it would lose the event with no record anywhere;
   failing means GitHub records the failure and can resend.
5. **The queue is what makes a slow or broken handler harmless.** GitHub has
   already been told "received"; everything real happens on our side. Five
   failed attempts and the message is set aside rather than lost.
6. **The handler claims each message before working on it**, so the same message
   arriving twice is only acted on once. The claim expires on its own, so a
   handler that dies halfway does not block that message for ever.
7. **One message can write to four different places**, the activity feed, the
   access connections, an alert, a rescore. All of it is finished *inside* the
   handler rather than left running afterwards, because AWS freezes the function
   the moment it returns and unfinished work would simply never happen.

### Why the split

The receiver is the only thing in this app reachable from the internet. It holds
a key to the webhook secret **and nothing else**, no GitHub App key, no database
write access beyond the queue. If it were compromised, what it could reach is one
HMAC secret.

The worker holds the real credentials but is reachable only from the queue.

### The infrastructure

**One table of its own**, plus the tables the worker writes to.

`github-control-hub-webhook-deliveries`, keyed on `deliveryId`, exists for one
job: making sure a delivery is processed **once**, even though SQS guarantees
at-least-once and will happily hand the same message to two workers.

```
deliveryId  "a1b2c3-…"     GitHub's own id for this delivery
state       "processing"
expiresAt   <epoch+lease>   when the claim goes stale
ttl         <epoch+lease>
```

The worker calls `claimDelivery` before doing anything, which is a conditional
write: *create this row, but only if it does not exist or its lease has expired*.
Two workers holding the same message race, one wins, the other stops. The lease
matters because a worker that dies mid-delivery would otherwise hold the claim
for ever and that delivery would never be retried.

| File | Role |
|---|---|
| `webhooks/receiver.ts` | the internet-facing Lambda: verify the signature, enqueue |
| `webhooks/secret.ts` | fetches and caches the webhook secret |
| `webhooks/deliveryLock.ts` | **the only file touching the deliveries table**, `claimDelivery`, `completeDelivery`, `releaseDelivery` |
| `webhooks/worker.ts` | the queue-driven Lambda |
| `webhooks/processDelivery.ts` | decides what each event means, and writes the consequences |

**What the worker writes** is not one table but several: rows in `activity`,
updated connections in `graph-edges`, and buffered notifications
in `alarms` via `alarms/feedNotify.ts`, for the evaluator to flush on its next tick. A single push
event can touch all three.

### When something goes wrong

A delivery rejected at the API Gateway is **lost**, GitHub sees the failure, and
the Activity page will show as stale within 72 hours. A delivery that reached the
queue and then failed is **retried**, and after five attempts lands in a
dead-letter queue rather than vanishing.

### Which events

Twelve are subscribed: pushes, repositories, branch or tag creation and deletion,
branch protection rules, repository rulesets, collaborator changes, teams, **team
membership**, pull requests, **pull request reviews**, and Dependabot alerts.

`pull_request_review` is used by one thing only: the "changes requested"
notification a developer can switch on for themselves. An installation without it
loses that notification and nothing else, so it is worth ticking but not worth a
migration.

`membership` is the newest, and the only one that has to be ticked by hand on an
existing installation. Without it `empty-teams` can only ever be as fresh as the
last nightly rebuild, because nothing else reports somebody joining or leaving
a team.

`organization` and `issues` are deliberately **not** among them. Nothing in the
worker handles either, so ticking them means GitHub sends a delivery, API Gateway
accepts it, the receiver verifies it, the queue holds it, and the worker drops
it, the whole path, for nothing.

## Developer notifications

The first thing in the app somebody configures for their own benefit rather than
the organization's. Set from **My work → Notifications**, it posts to a Microsoft
Teams webhook that person supplies.

### The two halves

| | Arrives | Where it runs |
|---|---|---|
| Review requested of you | seconds | the webhook worker, off `pull_request` |
| Changes requested on yours | seconds | the webhook worker, off `pull_request_review` |
| Daily summary | at the hour and timezone they chose | the 5-minute alarm tick |

`pull_request_review` is subscribed for this and nothing else. An installation
that has not ticked it loses the changes-requested notification and nothing more.

Only two events are immediate, and the limit is what a webhook can actually
deliver. "Became mergeable" and "checks went red" are conclusions drawn from
several events rather than events themselves, so they appear in the summary,
where they are read off the pull request snapshot that already exists. Offering
them as switches that quietly never fired would be worse than not offering them.

### How far back each section reaches

Each of the three sections carries its own limit, and the limit **keeps
anything touched within it and leaves out the rest**. Age is time since the last
commit, so a pull request opened a year ago and committed to this morning is
never old.

The control says "skip if quiet over 30 days", phrased as what it drops. It used
to say "quiet under 30 days", which is the same rule described from the other
side, and that reads as its own opposite: the reason anybody opens the menu is
to cut a long list, so the survivors are not what they are thinking about.

No limit is the default, because a summary that silently drops things nobody
asked it to drop is worse than a long one.

### When it is considered sent

`lastDigestAt` is the only thing between one summary a day and one every five
minutes: the pass ticks twelve times inside the hour a summary is due, and each
tick asks the same question. It is written whether the send succeeded, failed or
had nothing to say, because all three are decisions made for today.

Saving new settings re-decides it, and only the timing counts. Changing the
hour, the minute, **the timezone**, or switching the summary on is a reschedule;
changing what goes in it is not, so toggling a section in the evening does not
produce a second summary.

The timezone belongs in that list because it moves the schedule as surely as the
clock does: 2:10pm is a different moment in a different zone. Leaving it out lost
a day's summary in the order people actually work. The time is saved first and
judged against the old zone, where it has already gone by, so the day is marked
done. Correcting the zone a moment later did not count as a reschedule, the
record stood, and the moment it named came and went with nothing sent.

A reschedule then depends on whether the new time has already gone by **in that
person's timezone**:

| The chosen time is | `lastDigestAt` becomes | so |
| --- | --- | --- |
| still ahead today | cleared | it can arrive today, and a schedule set this morning is testable the same day |
| already past today | now | it waits for tomorrow |

The second row is the one that had to be learned. Clearing it unconditionally
meant setting 12:45 at 12:48 re-opened a window that had already passed, and the
next tick sent a summary three minutes later. Because the settings form saved on
every change, adjusting the time asked that question once per keystroke, and a
run of summaries followed. The form now saves once, after the changes stop.

An unrecognised timezone is refused when the settings are saved rather than
further down, where it is not an error at all: it falls back to UTC, and the
only symptom is a summary arriving at the wrong hour with nothing saying why.

### Where it is stored

In the org-config table, keyed `devalerts#<login>`. That table is read only by
exact key, so per-person rows sit beside the organization's own without either
seeing the other, and it needs no new table, which would have meant a stack
deployment before anybody could try the feature.

The webhook URL never leaves the server. The settings screen is told whether one
is set, never what it is: anybody holding it could post into that channel for as
long as it exists.

### Staleness

The digest reads the stored pull request snapshot rather than walking GitHub, so
turning it on costs no additional requests however many people do. That also
means it is only as fresh as the last walk, with **Monitor pull requests** off,
there is nothing keeping the snapshot current and the digest would summarise an
old one.

A failed delivery is recorded against that person and shown on their settings
screen. It is not retried: a webhook deleted in Teams fails identically twelve
times an hour, and the point is that somebody finds out rather than that the app
keeps trying.

---

## How quickly an alarm notices

Two clocks, and they used to disagree badly.

**The data** is refreshed three ways: a CloudTrail event rewrites one resource's
findings within seconds of it changing, the sweep re-reads everything every ten
minutes, and Run does it now.

**The alarm** is evaluated on the five-minute tick, subject to its own interval:

**Every alarm, every tick.** There is no tiering, and there used to be two
different ones, both wrong.

The first split on "guardrail or GitHub", which was wrong in both directions: a
guardrail alarm reads a table and was on the slowest interval of all, while most
GitHub alarms read the graph, which webhooks keep current, and waited three
ticks to re-read something already in DynamoDB.

The second split on whether a reading was bought from GitHub, which was better
and still bought nothing. **The same pass recomputes every widget afterwards**,
to store the snapshot the dashboard reads, so the Dependabot sweep, the Renovate
search and every per-repository walk already happen once per tick regardless.
The sources are memoised for the pass, so an alarm reading one is served from a
call already made. Waiting a second tick added five minutes and saved no
requests.

`GITHUB_BACKED_QUERIES` in `conditions.ts` still records which readings are
bought, because that stops being true the moment the snapshot pass stops
recomputing everything, and the tiering would have to come back.
`repro-alarms.ts` keeps the list honest by deriving it from the cases that
actually construct an Octokit, which is how `dormant-privileged-users` was found
missing from it: a commit search per privileged account, against the
thirty-per-minute limit that is the smallest budget in the app.

Guardrail alarms were hourly, on the reasoning that the sweep behind them was
hourly too, so checking more often was twelve reads of one answer. **The premise
was wrong**: the sweep is not the only writer, and a CloudTrail event moves the
table between sweeps. The visible symptom was the tab and the alarm disagreeing,
a bucket going red on screen at once and the alarm about it arriving up to an
hour later, from the same data.

The cost argument did not apply either. Every other reading is bought from
GitHub or from an estate-wide AWS sweep; this one is a scan of a table that has
already been written.

### Guardrail alarms are also checked when the data moves

The five-minute tick is the backstop, not the mechanism. **Whatever rewrites the
findings evaluates the alarms that read them, in the same invocation**, so an
alarm is never older than the data behind it. That covers all four writers at
once, because the trigger sits beside the write rather than at any call site: a
scheduled sweep, a CloudTrail event, somebody pressing Run, and an exclusion
list being edited.

A pass triggered this way ignores each alarm's interval. The interval answers
"how often is this worth looking at", and something has just answered it.

**Only guardrail alarms.** Their reading is a scan of the table the invocation
just wrote. Every other alarm buys its reading from GitHub or an estate-wide AWS
sweep, so triggering those on every data change would multiply that cost by how
often the data changes, which is exactly what their intervals exist to bound.

### Going wrong is instant; coming right waits

A breach fires on the first check. A recovery waits for **two consecutive clean
checks**, so a value resting on its threshold does not send an all-clear every
time it wobbles, which is what teaches people to filter the alarm that mattered.

So a guardrail fixed at 2:50 clears at 3:00, not at 2:50: one clean check on the
CloudTrail event, one on the next tick. That asymmetry is stated on the setting
itself, because an all-clear that is late without explanation reads as one that
is lost.

Whether the all-clear is sent at all is per alarm, `notifyOnRecovery`, and it
covers email and Teams alike.

### One message per transition, not per evaluation

Two evaluators are only safe because firing is **claimed before anything is
sent**. `claimTransition` is a conditional write: whoever moves an alarm from
`OK` to `ALARM` owns that transition and sends, and anybody else is told no and
stays quiet. Checked afterwards, the most a claim could do is report a duplicate
that had already gone out.

That guarantee was needed before any of this. The evaluator publishes and *then*
records the new state, and the alarm pass has a five-minute timeout on a
five-minute schedule, so an overrunning pass already overlapped the next one and
could send twice. A run that stands down is counted as `duplicatesAvoided`,
which is normally zero: anything else means two passes overlapped, and that is
worth seeing rather than inferring from duplicate emails nobody noticed.

## Alarms on the AWS guardrails

A guardrail alarm is an ordinary alarm. It is not a second alarm system, and
that is the whole design: the state machine, the recovery streak, the message
templates and the delivery are the ones already in use.

What differs is the subject. A widget alarm names a widget it can look up; a
guardrail alarm carries a synthesised id, `guardrail:*` for every rule, or
`guardrail:<ruleId>` for one, because "the S3 rules" is not a record anybody
created, it is a view over the findings table. The evaluator resolves a subject
and then knows nothing about what kind it was.

| Metric | Counts |
|---|---|
| Failing resources | Resources currently breaking the rule, excluding the ones deliberately skipped |
| Rules with a failure | How many separate rules have at least one failure |
| Resources being skipped | Deliberately excluded, worth watching, because an exclusion list that quietly grows is how a rule stops covering anything while still reporting green |

Checked on every five-minute tick. It reads a table rather than an estate, so a
check is one DynamoDB read, and the findings behind it can change at any moment:
a CloudTrail event rewrites one resource's within seconds. See **How quickly an
alarm notices**.

It reads the findings table and evaluates nothing. A sweep started by an alarm
would make the reading a consequence of the check.

An alarm on a rule that has since been deleted is refused at creation rather
than watched. It would read zero forever, which looks exactly like compliance.

---

## What time a notification says it is

`{{time}}` renders as `Aug 30, 2026 at 10:30 AM EDT`: a named month, a
twelve-hour clock, and the abbreviation people use rather than the IANA name.

**Daylight saving needs no handling.** What is stored is an IANA zone name,
never an offset, and both the offset and the abbreviation are resolved at the
moment of formatting. So `America/New_York` prints `EST` in January and `EDT`
in July, changing on the day the clocks do, and the hour moves with it. A
summary set for nine in the morning stays at nine in the morning, which is a
different instant in UTC either side of the change: the schedule is compared in
local time rather than against an offset captured when it was set. Storing
`GMT-5` would have been correct for four months a year.

**The locale is load-bearing.** The formatter asks in `en-US`, because `en-GB`
and `en-CA` render American zones as `GMT-4`, which is correct and is not what
anybody there calls it. A zone with no letter code, which is most of the world,
gives its offset instead (`GMT+5:30`).

**Everybody on a group has their own timezone**, set on their row in the Groups
tab, in either column. What that does then depends on the channel, and the
difference is physics rather than effort:

| Channel | What happens | Why |
| --- | --- | --- |
| **Teams** | Rendered in that person's zone alone | The flow is called once per address, so each call carries its own rendering |
| **Email** | One body naming every zone its people are in: `10:30 AM EDT (7:30 AM PDT)` | One SNS publish hands every subscriber the identical body. There is no per-person text, so picking one person's zone would be wrong for the rest |

The date appears once and the other clocks carry only the time, because a second
full date invites reading it as a second event.

The chain is: the person's zone, then their group's, then the organization's
default, which is set at the top of the Groups tab and is UTC until changed.
Somebody added to a group has none of their own, so they read in the group's,
and a group with none reads in the organization's.

Only `{{time}}` moves. Every other value in a message is the reading that was
taken, so two people in two countries are never told different numbers about one
event, only the same event on their own clock.

An unrecognised zone is refused when it is saved rather than further down, where
it is not an error at all: it renders as UTC, and the only symptom is a
timestamp quietly hours out.

## Removing somebody who never confirmed

AWS cannot withdraw a pending SNS subscription. It has no ARN to unsubscribe and
simply expires after three days, so the X on an unconfirmed row did nothing,
reported success, and left the person in the list.

The address is recorded as revoked on the group instead, and that is enforced in
both directions:

- a still-pending invitation is hidden, so the button does what it appears to;
- one **confirmed afterwards is unsubscribed on sight**. Without that half, a
  person removed from a group could click a two-day-old link and start receiving
  its alarms while appearing on nobody's screen.

Adding them back clears the record, or their new invitation would be hidden and
then cancelled behind them.

## What a notification says on each channel

Every alarm, important event and feed message carries a subject and a body
template. Those render once, from one reading, and go to both channels.

A second pair can be set for Teams. Empty means "send the email wording", which
is what everything written before the field existed means, so nothing changed
for any existing alarm. They are separate because the two are read differently:
an email is opened deliberately and can carry a paragraph, a Teams message is
glanced at in a sidebar where the first few words decide whether anybody opens
it.

Both renderings draw on the **same variables and the same reading**, so the two
channels cannot report different numbers for one firing. What differs is the
wording, never the fact.

`notifyService.publish` is where the fallback lives, which is why the caller
renders the Teams pair only when a template was actually written: if it rendered
one unconditionally, `publish` would have nothing left to tell the two cases
apart by.

## Microsoft Teams as a delivery channel

Every notification in the app passes through one `publish(topicArn, subject,
body)`, widget alarms, guardrail alarms, important events, pull request
reminders, the Renovate feed. Teams was added at that seam, so all of them reach
it and none of them knows it exists.

### One flow, not one per person

The organization sets up **a single Power Automate workflow**, once, and the app
stores its URL in org config as `teamsFlow`. Each message carries who it is for:

    { "recipient": "someone@company.com", "card": "<adaptive card json>" }

The flow binds its Recipient field to `recipient` rather than to a name typed
into it, so one flow direct-messages anybody.

The first design gave every person their own flow and their own webhook URL.
That is ten steps in Power Automate per person, in a tool most of them do not
otherwise use, with a destination that fails silently if one dropdown is wrong,
and it was chosen only because it avoided any org-level setup. Multiplying that
friction by everybody who would ever use the feature was the wrong trade the
moment a second person needed it.

So what a person supplies is now **an address, not infrastructure**: their work
email, one field, once. A group holds a list of those addresses beside its email
list, and the app sends one request per recipient.

The card goes as a **string** rather than an object, because Power Automate's
Adaptive Card field is a text field and a string binds straight from the
dynamic-content picker. An object needs an expression somebody has to type
correctly, and the setup instructions are the product here: every expression
removed from them is a way they cannot be got wrong.

### What is a credential and what is not

The **flow URL** is the one credential, and it is never returned to the browser.
Anybody holding it can post as the flow, to anyone.

An **address** is not a credential, and is shown back. Being unable to see what
you typed is how a typo survives.

### Failing honestly

Power Automate answers **202 Accepted** before it runs the flow, so a queued
request says nothing about whether a message appeared. A misconfigured flow
therefore looks exactly like a working one from here, which is why the test send
distinguishes them: a 202 reports as accepted, not delivered, and points at the
flow's run history.

The two channels are attempted independently and neither can fail the other. A
broken flow must not stop the email, which is the channel people are more likely
to rely on. `publish` returns true when *anybody* was reached, because reporting
a delivered message as a failure would record a fired alarm as unsent.

Two different things can be missing, and they are reported separately: a person
with no address can fix that themselves, while an organization with no flow
needs an administrator, and telling somebody to check their own settings sends
them somewhere they cannot fix it.

---

## Personal dashboards

The same widget engine as the Overview tab, filtered to one person. A widget
with no `owner` is on the shared board and behaves exactly as it always did; one
with an owner appears on that person's **My work → My cards** and nowhere else.

The admin gate still applies to the shared board and deliberately does not apply
to a personal one, that gate exists because the Overview is a single board seen
by everybody. Editing and deleting read the stored owner first, so somebody
else's personal widget is refused outright rather than falling back to the admin
gate: an administrator has no more business rearranging a person's own dashboard
than anybody else does.

---

## Sign-in and permissions

**Shape: live, cached for a minute.**

### Signing in

1. You connect **AWS** first, with your own credentials, a profile, SSO, or
   pasted keys. Nothing else can happen until this works, because the GitHub
   credentials live in Secrets Manager in your AWS account.

   The **SSO** tab is shown whether or not a profile exists yet; with none it
   explains and offers to create one. It used to be filtered out until an SSO
   profile was already present, so a machine with none showed nothing about SSO
   anywhere and the only route to making one was a tab called "New profile",
   the people who needed it were the only ones who could not find it.

   **Pasted keys** accept all four shapes the AWS access portal hands out,
   `export` (bash), `set` (command prompt), `$Env:` (PowerShell) and the
   `aws_access_key_id=` credentials-file form. Parsing is line-based in
   `lib/awsCredentialBlock.ts`, splitting on the *first* `=` because session
   tokens are base64 and end in one. This once required the literal word
   `export`, so three of the four parsed to nothing and the button silently did
   nothing; `repro-credentialblock` pins every shape.
2. The app reads that secret and loads the OAuth credentials into its process.
3. You click **Sign in with GitHub**, which redirects to GitHub, and back to
   `localhost:4321/auth/callback` with a code. The app exchanges the code for a
   token, and issues you a session.

### Why it says "Continue with <name>" when you reopen it

Two different things are remembered, in two different places, and the split is
the whole mechanism:

| What | Where | Survives a restart |
| --- | --- | --- |
| Your session token (the JWT) | `sessionStorage` | **No** |
| Your login name and avatar URL | `localStorage` | **Yes** |

So reopening the app never leaves you signed in. `sessionStorage` is cleared when
the window closes, so the token is genuinely gone and the app is genuinely signed
out. What survives is only a note of *who you were*, enough to draw the button,
and nothing that grants access.

Clicking it does a real OAuth round trip. It feels instant because **GitHub's own
cookies** live in Electron's session partition, so GitHub recognizes the browser
and returns immediately without asking for a password.

**The `?login=` parameter is load-bearing.** The button links to
`/auth/github?login=<remembered>`, and without it GitHub signs in as whichever
account its cookie happens to hold, so "Continue with alice" could hand back
bob. That completes the moment it is asked, with no page and no choice offered,
which is why the account is named before the redirect rather than announced
after it.

**"Use a different account"** calls into the main process and deletes every
`github.com` cookie from the Electron session (`clearGitHubCookies` in
`desktop/src/main.ts`). The next sign-in then asks properly.

**The token itself** is a JWT signed with `JWT_SECRET`, which is read from
Secrets Manager along with the other GitHub credentials. Because that secret
lives in the AWS account rather than on the machine, a token stays valid across
restarts and across machines pointed at the same account, and rotating the
secret invalidates every outstanding session at once.

One consequence worth knowing: `bootstrap.ts` generates a random `JWT_SECRET`
if the secret does not provide one. That keeps the app usable before setup, but
sessions then die on every relaunch, because the key that signed them is gone.
A session that never persists is the symptom of a missing `JWT_SECRET` in
Secrets Manager.

The OAuth callback is `localhost` because the desktop app runs its own backend on
your machine. The code comes back to you and never transits a shared server,
which is also why one OAuth App serves every AWS account.

**Switching AWS accounts re-reads the secret** and clears any credential the new
account's secret does not set, so an account with no GitHub App never inherits
another account's. You stay signed in across the switch, and the GitHub tabs
appear or disappear according to what the account you moved to holds.

**The region comes with the profile.** Switching to a named profile adopts that
profile's `region` from `~/.aws/config`, and clears the inherited one when the
profile names none. This matters because `AWS_REGION` beats a profile's own
setting everywhere in the SDK, and the access-keys route sets it: without this,
signing in with keys for one region and then switching to a profile in another
left every client reading the first. The switch reported success, the account id
was right, and the tables looked empty, because they were in the region nobody
was reading.

**Access keys carry no region**, so the sign-in form has a field for one, and
it is the only thing on that path that can name a region. Left blank, the app
falls back to the region the process started with rather than to whichever
account was open before: a region exported for this machine is a choice the
operator made, and one left behind by a previous switch is not. Without that
distinction, connecting to a second account with keys read the first account's
tables under the second's credentials, and the dashboard was simply empty.

That is also **how you move between regions**. Each region is its own
installation, so a profile per region, each with its own `region` line, and the
account switcher moves between them. The switcher shows each profile's region
beside its account id, because with one install per region two profiles into the
same account are two entirely separate sets of rules, findings and alarms.

### The path

AWS first, GitHub second, and the order is the security model rather than a
preference.

```
  1. you connect AWS first ──▶ the app reads the GitHub credentials out of
     (your profile, SSO,        your AWS account and keeps them in memory
      or pasted keys)           (never written to disk)

  2. you click "Sign in with GitHub"
                │
                ├──▶ the app writes down a one-time ticket
                │
                ▼
           github.com asks you to approve
                │
                ▼
           GitHub sends you back to the app on your own machine,
           carrying a code
                │
                ├──▶ the ticket is looked up and deleted in one move,
                │    so it cannot be used twice
                │
                ▼
           the code is exchanged for your GitHub token ──▶ you are signed in

  3. from then on, every request checks three things: are you signed in,
     is GitHub even allowed in this AWS account, and are you on the team
     this particular action requires

  4. switching AWS accounts (account menu ▸ AWS account) keeps you signed
     in: your session is re-signed with the new account's key on the way
     through, the process forgets everything it cached about the account
     you left, and the window reloads into the new one
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| the GitHub credentials | Kept in AWS Secrets Manager, which is why AWS has to work first, an AWS account holding no GitHub credentials simply has no GitHub tabs |
| back to the app on your own machine | GitHub returns you to `localhost`, because the desktop app is its own backend. The code never passes through a shared server, which is also why one set of GitHub sign-in credentials can serve every AWS account |
| the one-time ticket | A row in the `github-control-hub-auth-codes` table, deleted the moment it is used and expiring by itself otherwise |
| are you on the team | Checked against GitHub and remembered for 60 seconds, in memory only. It vanishes on restart, which is correct for something that is a shortcut rather than a record |
| switching accounts | `components/AwsAccountSwitcher.tsx` in the navbar, calling the same endpoints the sign-in screen uses |

**Your session is yours, not the account's.** The key that signs it is read from
each AWS account's secret, so a session minted in dev stops verifying the moment
uat's secrets load, which used to sign you out for the crime of changing an AWS
setting. The switch now captures the session *before* the credentials move and
re-signs it after, keeping the original expiry: a switch every few minutes must
not be a session that never ends. Two consequences worth knowing:

- **The membership check is skipped where it cannot be answered.** Every request
  re-asks GitHub whether you are still in the organization. An account with no
  GitHub credentials has no organization configured, so asking throws, and the
  check reads a throw as "could not ask", which degrades to *not a member* about
  an hour later. That is why the session used to die shortly *after* a switch
  rather than at it. Nothing is loosened: an account with no GitHub credentials
  has no GitHub routes to reach, and the AWS tab's own permissions are still
  read from GitHub with your token.
- **The gate is asked again.** It caches which account it is in, which was safe
  while that could not change mid-run. Switching clears it, or uat would be
  judged on dev's account id and show GitHub tabs it cannot serve.
- **So is everything else cached per account.** Four things in the process were
  held on the reasoning that they could not change: the gate's account id, the
  guardrail store's own DynamoDB client, the home account id stamped on every
  finding, and the cached AWS health verdict. The client was the one that bit,
  the AWS tab showed whichever account was signed into *first*, in both
  directions, and refreshing could not help because every refresh asked the same
  stale client. `utils/awsAccountChange.ts` is now the one list of them, and a
  test fails if a module grows another and is not added to it.
- **The window reloads.** Clearing the query cache is not enough: every mounted
  page also holds state describing the account being left, a selected activity
  stream, an expanded row, a filter. A switch is rare and deliberate, so it
  gives you the state signing in to that account would, rather than a careful
  reconstruction of it that is wrong in one place nobody checks.

1. **Nothing GitHub-shaped can happen until AWS works**, because the GitHub
   credentials live in Secrets Manager in your account. An account whose secret
   holds none refuses every GitHub route and shows only the AWS and Activity
   tabs, keeping GitHub out of an account *is* keeping its credentials out of
   it.
2. **There are two secrets, deliberately.** The application bundle
   (`github-control-hub/secrets`) holds the GitHub App private key; the webhook
   secret is kept apart so the internet-facing receiver cannot read that key.
   Their IAM name wildcards are disjoint on purpose, which is why the second is
   not called something like `secrets-webhook`.
3. **The callback is `localhost` because the desktop app runs its own backend.**
   The code comes back to your machine and never transits a shared server, which
   is also why one OAuth App can serve every AWS account.
4. **The state row is deleted when redeemed, and the delete is the redemption**,
   so a code cannot be used twice even if two requests arrive at once. Anything
   left behind expires by TTL rather than accumulating.
5. **Team membership is cached in a module-level `Map`**, in the process, not
   in DynamoDB, keyed per team *and* per user, for 60 seconds. It disappears on
   restart, which is correct: it is an optimisation, not a record.
6. **A denial caused by a missing token is never cached.** That is a fact about
   the app, not about the person; caching it meant a credential problem lasting
   a second locked somebody out for a minute after it healed.
7. **Membership is normally read with the App's token**, because you cannot
   necessarily see a team you are not in. Where there is no App it falls back to
   your own token's `read:org`, safe precisely because it is narrower: with
   your token the only membership readable is your own, which is the only one
   being asked about.

### The infrastructure

**The GitHub credentials** live in AWS Secrets Manager, at
`github-control-hub/secrets`, as one JSON document. They are read into the
process's environment at startup and again whenever the AWS account changes.
Nothing writes them to disk.

**`github-control-hub-auth-codes`**, keyed on `code`, holds two short-lived
things and nothing else:

```
code  "state:7f3a…"    the OAuth state parameter, proving the callback is ours
ttl   <epoch+minutes>
```

The state row is written before redirecting to GitHub and **deleted when
redeemed**, the delete itself is the redemption, so a code cannot be used twice
even if two requests arrive at once. Anything left behind expires by TTL.

**Team membership is cached in memory**, not in DynamoDB: a `Map` in
`authorizationService`, keyed per team **and** per user, holding each answer for
60 seconds. It is per process, so it disappears on restart, which is correct,
it is an optimisation, not a record.

A denial caused by a **missing token is never cached**. That is a fact about the
app, not about the person, and caching it meant a credential problem lasting a
second locked someone out for a minute after it healed.

| File | Role |
|---|---|
| `routes/auth.ts` | the whole sign-in flow, plus AWS connection and secret reload |
| `github/oauth.ts` | builds the GitHub URLs and exchanges the code for a token |
| `services/authorizationService.ts` | `isControlHubAdmin`, `isAwsAdmin`, and the 60-second cache |
| `middleware/authMiddleware.ts` | verifies the session on every `/api` request |
| `middleware/githubGate.ts` | refuses GitHub routes in an account that should not have them. Two routers are exempt because they carry both halves: Activity, which filters itself to the AWS rows, and Alarms, which an AWS-only account needs for guardrail alarms and which reaches GitHub through no App credential |

### Creating an SSO profile from the app

`aws configure sso` does this already, and it is a wizard in a terminal. The
**New profile** tab on the login screen does the same thing without one.

The hard part is not writing the file. It is that somebody setting this up knows
their sign-in link and nothing else. Not the twelve-digit account number, not the
exact role name. Both are required, and both are what people guess wrong.

So it asks AWS, using the same device-authorization flow the CLI uses:

1. **You give the sign-in link** and the region it lives in.
2. The backend registers a throwaway client with AWS and starts an
   authorization. **A browser tab opens** carrying the code, so nothing is typed.
3. You approve it there. The page polls at the interval AWS asks for, and gives
   up when the code expires rather than asking about something gone.
4. Once approved, the backend reads back **every account you can reach and the
   roles you hold in each**, and you pick from lists.
5. It appends a profile to `~/.aws/config` and offers to sign in with it.

**No SDK.** The OIDC endpoints are unauthenticated by design. They run before
anybody has credentials, and the portal endpoints take a bearer token rather
than a signed request, so `fetch` covers all of it. Two fewer packages in a
bundle that ships to desktops.

**What is written**, in the modern `sso-session` form so profiles for two
accounts under one sign-in share a session and `aws sso login` authorizes both:

```ini
[sso-session work-sso]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile work]
sso_session = work-sso
sso_account_id = 123456789012
sso_role_name = AdministratorAccess
region = us-east-2
```

**Appended, never rewritten.** That file is the machine's, not this app's. It
may hold profiles for work with nothing to do with here, and the only safe edit
is one that adds. A name that already exists is refused rather than replaced.

**Every value is validated before any of it is written.** A role name carrying a
newline and a `[` would not corrupt the file; it would quietly define a *second*
profile pointing wherever the text said. `repro-ssosetup` asserts each field
refuses that shape.

**The access token never leaves the backend.** It would reach every account you
have, and the screen needs only the account and role names.

**The config cache is refreshed the moment the file changes.** The AWS SDK parses
`~/.aws/config` once per process and keeps it in a module-level cache
(`filePromises` in `@smithy/core/config`) that nothing invalidates, reasonably,
since a config file is not normally expected to change under a running program.
This app changes it. Without the refresh a profile was written correctly, signed
into successfully by the AWS CLI in its own process, and invisible to the app
that had just created it: `AWS_PROFILE=<new>` resolved to a profile the SDK
believed did not exist, so Verify reported AWS unreachable and appeared to do
nothing, and only restarting fixed it. `refreshAwsConfigCache()` in
`services/ssoSetupService.ts` re-reads with `ignoreCache`, which also replaces
the cached promise so ordinary lookups afterwards see the new content. It runs
after writing a profile and before either switch route resolves credentials by
name, the second covers a profile you added in a terminal while the app was
open. `repro-ssosetup` asserts the staleness and the fix against the real SDK
rather than by reading source, because what would break it is the SDK changing;
that module has already moved once, out of `@smithy/shared-ini-file-loader`.

| File | Role |
|---|---|
| `services/ssoSetupService.ts` | the device flow, the validation, and rendering the config block |
| `routes/auth.ts` | `/aws-sso-start`, `/aws-sso-poll`, `/aws-sso-create-profile`, desktop-only, same-origin |
| `pages/LoginPage.tsx` | the four-step panel on the **New profile** tab |

### What you are allowed to change

Team membership decides it:

| Team | Controls |
|---|---|
| `control-hub-admins` | everything GitHub-side |
| `aws-guardrail-admins` | AWS rules, sweeps, enforce mode, detailed-logging settings |

Org owners qualify for both, as a safety net against an empty or deleted team.
Membership answers are cached for 60 seconds, keyed per team **and** per user. A
denial caused by a missing token is never cached, that is a fact about the app,
not about the person.

Membership is normally read with the App's token, because a user cannot
necessarily see a team they are not in. Where there is no App, an account running
the guardrails and holding no GitHub App key. It falls back to the caller's own
token, which carries `read:org`. That is safe precisely because it is narrower:
with your token the only membership readable is your own, which is the only one
being asked about.

**Secrets are loaded per AWS account.** Switching accounts in the app re-reads
them and clears any key the new account's secret does not set, so an account with
no GitHub App never inherits another's.

---

## Confining GitHub to one AWS account

An account whose secret holds no GitHub credentials refuses every GitHub route
and shows only the AWS and Activity tabs. Nothing to switch on: keeping GitHub out
of an account *is* keeping GitHub's credentials out of it.

`GITHUB_ACCOUNT_ID` is the explicit form, for locking an account that has
credentials anyway. Activity is not gated. It filters itself to AWS rows, because
an account running guardrails needs the record of what they did.

---

## What it costs to keep checking

The largest line in the DynamoDB bill was never the alarms. It was that **every
graph-backed check starts by reading the whole edge table**, and the alarm pass
runs every five minutes.

Two changes, in the order they matter:

**A version counter.** One row in the edges table, incremented atomically by
every writer: webhook patches, the light refresh, the full rebuild. A reader
fetches that row, about one read unit, and skips the scan entirely when it
matches the version its cached copy was taken at. Most passes run over a graph
nobody has touched, and those passes now cost almost nothing.

The counter is read **after** a scan, never before: a change landing mid-scan
would be captured in the results and then stamped with the older version, so the
next reader would trust a copy that had already moved on. Reading afterwards can
only under-claim, which costs one extra scan and never a stale answer. An
unreadable counter falls through to scanning, because a cached graph should only
be served against a version somebody actually checked.

A failure to bump is logged, never thrown. A counter that does not move makes a
cached copy look current for longer than it is, which is stale; a counter that
takes its write down with it loses the edge, which is wrong. Stale is
recoverable.

**A pin for the length of a pass.** The pass evaluates alarms and then
recomputes every widget's snapshot, sequentially and deliberately so the checks
drawing on commit search do not all fire at once. That runs for a minute or more
on a large organization, and webhooks keep writing while it does. Pinning takes
one reading and holds it, so a change mid-pass neither triggers another scan nor
leaves two cards on the same dashboard computed from different graphs.

On a modelled thousand-repository organization this takes the graph line from
about $15.82 a month to under a dollar when the graph is quiet, and leaves it
unchanged only in the case where the graph really is being rewritten every five
minutes.

## The cost breakdown

**Activity → Costs** shows what each of this app's own resources has consumed, one
line per table, function, log group, topic and secret, largest first.

It sits on Activity rather than under AWS Guardrails, where it started. That
tab is about rules over *your* resources; this is the app's own bill, and it
covers both halves: the webhook receiver and worker, the graph aggregator and
the tables they write are the GitHub side. Activity is the tab that already
carries both, and the one that exists in an AWS-only install as well as a full
one.

**It is computed, not fetched, and that is not a shortcut.** Cost Explorer bills
a cent a call and groups by *service*: it can say "DynamoDB, $18" and never
which table, because AWS does not meter cost per resource for DynamoDB or Lambda
at all. The resource-level answer would need Cost and Usage Reports, an S3
bucket and Athena, which is a data pipeline for a question CloudWatch can
already answer.

So it multiplies **metered usage** by **published prices**: consumed read and
write units per table, invocations and duration times that function's own
memory, bytes ingested per log group, messages published per topic, requests
through the API and the queues.

**Some charges are fixed**, and those are marked on screen. A WAF web ACL is
five dollars a month whether it inspects one request or a million, each of its
rules is another, a CloudWatch alarm is ten cents and a secret is forty. On a
quiet install the web ACL is the largest line on the page, so a report that left
it out, as this one first did, was worse than no report: everything else reads
as "spend less by doing less", and these do not move.

**A fixed charge is billed for the resource's life, not for the window.** Every
one of them was first pro-rated by the length of the window instead, so asking
about ninety days on a nine-day-old install reported ninety days of WAF: $18 of
a $1.80 charge. That is worse than an overestimate, because the number grew the
further back you looked, which is the shape real history has, so it looked
right.

Each line now carries the days it actually existed within the window. Tables,
log groups, secrets and the API report their own creation date; WAF and
CloudWatch alarms do not, so the CloudFormation stack's creation time bounds
them, since nothing in a stack can predate it. A resource created after the
window bills nothing rather than a negative.

The monthly projection follows from the same figure, per resource rather than
from the total: nine days of use over a ninety-day window would otherwise be
divided by ninety and report a fifth of the real rate.

When the window is longer than the install, the page says so. Two windows giving
the same answer is correct and reads as a stuck number without an explanation.

`repro-costs.ts` derives what should be priced from `cdk-stack.ts` rather than
from a list, so a resource added to the infrastructure and not to the pricing is
caught rather than silently missing.

The trade is stated beside the number rather than in a footnote: this is list
price, and it knows nothing about the free tier, committed-use discounts,
credits or tax, so a real bill is usually lower. Somebody comparing it against
an invoice needs to know why they differ before concluding one of them is
broken. Prices carry the region and month they were taken from, and the panel
says so when the account is in a different region.

Each service is read in its own try, and anything unreadable is listed rather
than counted as zero: a total quietly missing DynamoDB reads as a cheap app. The
report is cached for an hour, since the numbers move slowly and every refresh is
real API calls.

## Restricted tabs

Three tabs are limited to a team, and the restriction is on the **server**. The
screen somebody sees instead is presentation; anybody can call the API directly,
so "this screen is restricted" is only true if the routes refuse.

| Tab | Team | What it protects |
| --- | --- | --- |
| Access | `control-hub-admins` | the organization's whole permission map |
| Overview | `control-hub-admins` | the shared board — which checks somebody thought worth watching |
| AWS | `aws-guardrail-admins` | an account a different team administers |

Two different teams on purpose: the people who run the repositories and the
people who run the AWS account are usually not the same, and conflating them
means one of the two gets access they were never meant to have.

### Reads, not just writes

Every one of these was already gated for *changes*. What moved is **reading**,
which is a stronger claim and was made only where the screen itself is the
sensitive artefact.

Access is the clearest case. It was open on the reasoning that GitHub already
shows members who is on which team — true, and beside the point. One screen
ranking who holds admin across every repository is a different artefact from the
same facts spread over a hundred pages, and it is the artefact somebody would
actually want.

The AWS tab carried a comment saying "reading is deliberately open: anyone
signed in can see rules and findings". That is an inventory of another team's
account, and it is now gated with the comment corrected rather than left to
contradict the code.

### What is deliberately *not* gated

**The check engine.** `/api/graph/query` runs the checks, and personal widgets
run the same ones. Gating it would take My work away from exactly the people it
was built for, and would buy nothing: a non-admin can build any check on their
own board. What the Overview gate protects is the organization's *curated*
board, not the ability to run a check.

That makes the Overview gate genuinely narrower than the other two, and worth
knowing: someone who is not an admin cannot read the shared board, but can
reproduce any single check on their own.

**Personal scope.** `GET /widgets?scope=personal` is open, and
`GET /widgets/snapshots` is **narrowed rather than refused** — an admin gets
every one, everybody else gets their own. A snapshot holds the check's actual
findings, so serving all of them past a gated board would hand over exactly what
the gate was for; refusing them outright would break My work.

### The locked screen

Hiding the tab was the other option and is worse. Somebody who cannot find a
screen they have heard about assumes the app is broken, or goes looking for a
link, and nothing tells them the one fact that would settle it: the name of the
team to ask for. A door that is visibly locked is more useful than a wall.

The screen names the team exactly as GitHub spells it, says organization owners
are admitted without being on it, and points at My work, which is still theirs.

Two details that matter more than they look:

- **An unreachable GitHub is an outage, not a refusal.** The middleware answers
  503, and the screen renders the page rather than the lock. Answering 403 would
  tell somebody they had lost access they still have.
- **The app opens somewhere they can read.** `/` sent everyone to Overview,
  which for most of the organization is now a locked door as a first impression.
  It resolves to Overview for admins and My work for everybody else.

The Costs lens in Activity reads the AWS route, so it is hidden from people who
are not on the AWS team — left visible it is a tab that only ever renders a
permission error.

## Usage is per account

The app connects to one AWS account at a time and can be switched between them.
Everything it counts belongs to the account it was counted in.

The table follows the account already: `docClient` is swapped on every switch, so
reads and writes land in the connected account's tables. What did not follow was
the **in-memory buffer**. GitHub request counts buffer for up to thirty seconds
before being written, so a switch with a full buffer wrote one account's usage
into another's table — which is how a fresh AWS-only account came to show
somebody else's numbers.

The buffer is now discarded when the account changes. Discarded rather than
flushed: by the time the switch runs, the credentials for the account those
requests belong to are already gone, so there is nowhere correct left to put
them. Losing a partial minute is the honest outcome; writing it to the wrong
account is not.

**An account with no GitHub App reports no GitHub anything.** The Statistics
chart drew all three streams unconditionally, so an AWS-only account carried a
permanent "GitHub 0" beside its real numbers, which reads as an organization
that has stopped doing anything rather than as a deployment that was never
watching one. The stream is dropped there.

The GitHub requests lens is likewise hidden until the app positively knows
GitHub is available, rather than until it learns it is not: while the answer was
still loading the lens appeared, and clicking it in that moment opened a tab
whose route is gated off. Appearing a moment late for everybody beats appearing
wrongly for the accounts that can never use it.

## Telling me about each new one

Every widget and every guardrail can carry an alarm with **no threshold**:
*Every new matching row*, or *Every new failing resource*.

A count alarm answers "is this bad enough yet". It fires on the way from clean
to not-clean and then stays quiet however many more arrive, because the state is
already ALARM. That is the wrong shape for what most people actually want, which
is to hear about a finding once, when it turns up — including the sixth one,
while the alarm is already firing.

So this kind remembers which rows it has reported and speaks about the ones it
has not.

**A row is identified by what it is, not by how it reads.** The key is built
from the subject and the finding — repository plus dependency, resource plus
rule — and never from `reason` or `details`, which are regenerated on every pass
and would make every row look new every five minutes, for ever.

**What it remembers is rewritten, not accumulated**, and capped at 500 keys. A
finding that is fixed and then comes back is worth hearing about again;
remembering it for ever would swallow exactly the recurrence somebody watching
for regressions cares about.

**The claim is on the remembered set, not on the state.** `claimTransition`
guards a state change, which is the wrong thing to guard here: this kind
commonly speaks while already in ALARM, where there is no state change for two
passes to compete over. What they race on is the set, so `claimSeen` writes it
conditionally on it still holding what was read, and only the winner sends. That
matters because the evaluator runs both on the five-minute tick and again
whenever guardrail findings are rewritten, so two passes overlap in practice.

**Clearing is told the same way as arriving.** The state machine's recovery
rule is right for a threshold and wrong here: it waits for the *last* row to go,
so a resource you fixed would go unacknowledged for as long as an unrelated one
stayed broken. An "each" alarm reports each row as it clears instead, while
others are still failing.

Arrivals take the pass when both happen in one. The departures are **held in the
remembered set** rather than dropped by the same write, so they are announced on
the next pass instead of being lost.

A row that clears is forgotten even when recovery messages are switched off —
the set is written on a silent pass too. Without that it would stay remembered
for ever and its return would never be reported, which is the one thing this
kind of alarm exists to catch.

**It names the rows the metric counts, not every row the check returned.**
`metricValue` filters before it counts — a guardrail's violation count skips the
passing and the deliberately excluded — so reading the raw rows announced an
excluded bucket as newly failing. `rowsForMetric` sits beside `metricValue` so
the two cannot drift: whatever one counts, the other names.

### Its own wording

The threshold template ends "your limit is `{{threshold}}`", and an alarm with
no threshold has none, so `String(undefined)` put the word **undefined** in the
message where a number belonged. Cosmetic only: `isBreaching` never consults a
threshold for this kind, so nothing about firing was affected. It was still the
wrong message.

An "each" alarm now gets its own default wording, chosen at creation from the
condition and prefilled in the form as soon as the reading is picked. The form
only replaces the text while it is still one of the defaults, so switching the
dropdown never discards a message somebody wrote.

The message carries **`{{items}}`**, **`{{count}}`** and **`{{change}}`**: which
ones changed, how many, and whether they started failing or came back. One
template serves both directions, so there is one piece of text to keep rather
than two that drift.

Alarms created before that wording existed still carry the count template, so
`{{threshold}}` renders **any** for this kind rather than being left empty: it
has to read sensibly inside a sentence that is already written. "Back to normal" without a name is unreadable on an alarm watching twenty
resources — it says something recovered and leaves the reader to work out what.

An unreadable check still never counts as breaching.

**One metric is now offered twice**, and everything that looks a spec up has to
match on the metric *and* the reading. `isValidCondition` matched on the name
alone, found whichever was declared first, and refused the other for having the
wrong kind — so switching a guardrail alarm from "every new failing resource" to
"failing resources" was rejected with a message listing the very option that had
been chosen. The message builder had the same bug and labelled messages with the
wrong reading.

The condition is `{ kind: "each", metric }`. The metric rides along only so the
message can still say how many there are in total. In the form, the selector is
keyed on `kind:metric` rather than the metric alone: one metric is now offered
twice, and keying on the name gave two options with one value and made the first
unselectable.

## Why the Vulnerabilities tab is fast now

Working the tab out takes an org-wide alert sweep plus two paged status reads.
On an organization where Dependabot has just been switched on everywhere, that
is long enough that the first open after launch looks broken.

There was already a sixty-second in-memory cache, and it does nothing for the
case that hurts: a freshly started process has none.

So the answer is **stored**, in the alarms table. The tab paints from it
immediately and, when it is older than ten minutes, a fresh sweep runs **behind
the reader** rather than in front of them. Ten minutes because that is roughly
how often the underlying data changes: GitHub rescans on its own schedule, and
an alert that appeared thirty seconds ago is not visible any sooner by asking
again.

**Stored compressed.** Two thousand alerts is about 434KB as JSON, past
DynamoDB's 400KB item limit; the data is extremely repetitive, so gzip takes it
to roughly 15KB.

**Never truncated.** The widget snapshots trim rows to fit, which is right for
something backing a count and a preview. This backs the table itself, where a
missing repository is a repository somebody concludes is clean, so a payload
that will not fit is refused with a log line and the tab keeps computing live.

**Every write refreshes it.** The bulk action and both single-repo toggles
recompute in the background, because the stored answer describes the account as
it was and changing it was the point. Recomputed rather than deleted: deleting
would make the next open slow again, which is what the store exists to prevent.

One sweep function serves both the route and the background refresh. Two copies
would be two places for the repository markers and the two status reads to
drift, and the drift shows as a repository appearing clean on one path and
unwatched on the other.

## Managing Dependabot in bulk

**Vulnerabilities → Manage Dependabot** lists every repository the last sweep
saw, whether or not it has a finding, and lets several be switched at once.

That list is built from rows the tab already holds, so opening the panel costs
nothing. Repositories nobody is scanning sort first: a repository with no
findings because Dependabot is off looks exactly like a clean one in the list
below, and its absence is not good news.

### Why it is one request

Doing this a repository at a time is what produced "an unexpected error
occurred". These are **writes**, GitHub applies a **secondary** rate limit to
writes made in quick succession, and this app's client is deliberately built to
surface those rather than retry them. Somebody clicking down a list is a burst,
and a burst is what that limit exists to stop.

The browser cannot pace itself usefully, because the header asking for the pause
arrives at the server. So the whole selection goes in one request and the pacing
sits next to the errors that cause it: three at a time, a quarter second apart,
backing off on GitHub's own `retry-after` when it gives one.

The two ways to get that wrong are both quiet, and both are tested:

- **Retrying a refusal that will never change** makes a run take minutes to say
  "you are not an admin on that one". Only a request to slow down is retried.
- **Not retrying a request to slow down** turns a pause into a failure and
  leaves half the selection untouched with no clue which half.

A repository that fails stays selected, so pressing again retries exactly those.

### Alerts and fixes are two switches

Alerts tell you a dependency is vulnerable. **Security updates** are what opens
the pull request that fixes it, and that is what "create fix with Dependabot"
does in GitHub's own interface.

There is no public API to open a pull request for one alert on demand. Turning
security updates on is the API equivalent, and GitHub then raises them itself,
usually within a few minutes rather than while somebody watches. The panel says
so before the button is pressed.

Turning fixes on turns alerts on first, because GitHub raises no updates for a
repository it is not scanning, and doing only the second would report success
while nothing ever arrived.

### One repository at a time, too

Each repository card carries its own **Auto-fix PRs** button, beside its
findings, which is where somebody is when they decide they want it. It goes
through the same bulk endpoint with a list of one: a second route would be a
second place for the pacing and the retry rules to live, and it is the same
write that trips the same limit.

**Three states, not two.** Whether a repository already opens fix pull requests
is read from `security_and_analysis.dependabot_security_updates`, and GitHub
returns that field only for repositories the signed-in account administers. A
repository where it is missing is left **unknown** rather than marked off:
drawing "turn it on" over a repository that already has it, because the caller
could not see the field, is worse than drawing nothing. So the button appears
only where the answer is known to be off, a pill says so where it is known to be
on, and neither appears where it could not be read.

The status comes from the **organization listing**, a hundred repositories at a
time. Asking per repository would be three hundred requests to draw one column,
on the budget that this page has already had to be careful with twice.

### The caller's own token

Like every other write in that file. GitHub decides per repository whether
somebody may, so a bulk action can never reach further than the same person
could one at a time. It is also why these requests do not move the allowance
shown at the top of the GitHub requests tab: that figure is the **App's**
headroom, and these are spent from the signed-in person's own.

## Only the reviews that are yours to do

A review request notification now says **who else is on it**, and can be limited
to requests small enough to be worth interrupting for.

The card names the other outstanding reviewers, or says outright that you are
the only one. That is usually the whole message: "review requested" tells you
whether to switch to Teams, and who else was asked tells you whether to switch
*now*.

The limit is a ceiling, chosen per person: **only me**, **me and at most one
other**, and so on up to five. Absent means every request, which is what
everybody had before and so is what an unset value has to mean.

Three counting rules, each of which would be a bug the other way:

- **You are counted.** "Only me" has to mean nobody else was asked, which is
  only true if the reader is in the total.
- **A team counts as one.** Treating it as nobody would make a request to four
  teams look like a request to one person, which is the opposite of what
  somebody choosing "only me" is asking for.
- **A list that cannot be read is sent.** The alternative is losing a review
  request to a number nobody could see.

The list comes from the pull request's `requested_reviewers`, not from the
event. The event names the one person just added; the pull request carries who
is still outstanding, and anybody who has already reviewed has correctly left
it. The reader's own name is removed before the card is built, because seeing
your own name in "also reviewing" reads as a bug.

Skipping is quiet: it is a preference, not a failure, so nothing is recorded as
a delivery error, and anything skipped is still in the daily summary.

## One measurement, not two that disagree

The GitHub requests page led each allowance with GitHub's own used-of-limit and
put this app's counts beside it. The two never matched, often by two orders of
magnitude: zero used against nine hundred counted.

Both were right. GitHub meters over a **rolling window of its own** that can have
opened a minute ago, so it reports almost nothing used; these counters bucket by
the **wall-clock hour** and hold everything since the top of it. Shown as a pair
they read as one number contradicting itself, and no amount of labelling fixed
that: the second attempt named both periods precisely and the page was still
being asked about.

The answer was to stop showing two counts. Each allowance now leads with **the
figure its own rows add up to**, so the headline, the per-bucket totals and the
list are always the same measurement. GitHub's number is still there, doing the
one job this app cannot do for itself: saying **how much room is left**, which
is a fact about this moment and needs no window to be understood.

**And headroom is not in the same box as a count.** That was the third attempt
at this, and the first two were both wording. A count is cumulative over a
window; headroom is a reading of this instant. Side by side they read as one
number contradicting itself, and no label fixes that.

**Search is the worst case**, because its allowance refills *every minute*: over
a busy hour the count says eight and GitHub says thirty of thirty available,
because none of the eight were in the current minute. Both true, and together
they look like a bug.

So the three boxes now hold only what this app spent, and headroom has its own
row underneath: all three allowances, what is left, when each refills, and one
sentence saying that a full reading is normal because these refill on GitHub's
clock rather than at the top of the hour, and are per token besides.

**And no progress bar.** One sat under the count, measuring GitHub's headroom,
so it read as a progress bar of the number above it and sat at full while that
number said five thousand. A bar under a figure it is not a fraction of is worse
than no bar. Where some of a bucket's requests went out on a signed-in account,
the box now says how many, which is what explains a large count beside an
allowance GitHub reports as untouched.

The window is also named exactly rather than implied. "This hour" was being read
as "the last sixty minutes", which is not what the counters bucket by.

## Why the Teams half never arrived

The Teams workflow URL lives in the organization-config row, and that row was
keyed on the **GitHub organization's name**. Two kinds of process cannot supply
one:

- An install with no GitHub has no name at all, and DynamoDB refuses an empty
  string as a key attribute, so every read threw outright.
- The **guardrail function is kept away from GitHub credentials on purpose**. It
  is given no secret to read and never loads one, so it could not know the name
  even where one existed.

The error was exact and said so: *The AttributeValue for a key attribute cannot
contain an empty string value. Key: org.* Email was unaffected, because SNS
needs nothing from that row. So a guardrail alarm sent its email and never its
Teams message, which is a narrow enough symptom to look like anything.

The name bought nothing. There is one configuration per table and the table is
per deployment, so the row is now keyed on a **constant** that every process can
compute without knowing anything about GitHub.

**Nothing has to be migrated.** A read falls back to the old key when
`GITHUB_ORG` is set, and hands the row back under the new one. Every writer
here reads the whole row and puts the whole row back, so the first write of any
kind moves it.

The alternative was giving the guardrail function the secret so it could learn
the name. That would hand the function that acts on the AWS account the GitHub
App's private key, to solve a problem caused by a key that did not need to exist.

## A notification that half arrived

`publish` sends to two channels and returned **one boolean**. The caller read it
as "delivered", so an alarm whose email went and whose Teams message did not
recorded a clean firing: no error on the alarm, nothing on the tab, nothing in
the feed. The only evidence was the email that did arrive, which is exactly what
makes somebody conclude the Teams half was never built.

It now reports each channel, and the alarm carries a **`lastDeliveryError`**
when one it was meant to reach did not take it. That is deliberately separate
from `lastError`, which means the reading could not be taken and governs whether
the alarm is trusted at all. An alarm can be perfectly healthy and simply not be
arriving, and those two send somebody to completely different places.

Three cases are kept apart, because collapsing any two of them is how this hid:

| Case | Recorded |
| --- | --- |
| nobody on the group uses Teams | nothing; not a failure |
| addresses expect Teams, no workflow is set up | the count and what is missing |
| the workflow refused some or all of them | which addresses, and why |

The tab shows it as "Sent, but not delivered everywhere", and a clean send
**deletes** the stored error rather than leaving it, or a workflow somebody
fixed keeps showing the failure that made them fix it.

## Why the instant guardrail alarm did nothing

The guardrail function evaluates alarms the moment it rewrites findings, so a
resource that starts failing is notified in seconds rather than at the next
five-minute tick.

It never worked. The function's environment named its own three tables and
`ORG_CONFIG_TABLE` and `ACTIVITY_TABLE`, and **not `ALARMS_TABLE`**.

`hasTable` asks whether the variable is set, and every service falls back to an
in-memory store when it is not. That fallback is right for local development and
catastrophic in Lambda: `listAlarms` returned the empty store, the evaluation
found nothing to do, and returned success. Groups live in the same table, so
even a found alarm would have had no topic to publish to.

**Nothing reported it.** There was no error to catch, because zero alarms is an
ordinary answer, and the handler only logged when it had evaluated at least one.
So the failing case and a quiet account printed the same thing: nothing. Every
symptom pointed elsewhere, which is why several rounds of real fixes to the
alarm logic changed nothing anybody could see.

Two changes, and the second matters more than the first:

- The stack gives that function `ALARMS_TABLE`.
- The sweep logs the zero case too, and says which of the two it might be.

**`repro-lambdaenv.ts` walks the static and dynamic import graph from each
Lambda's entry point**, collects every table the reachable code asks for by
name, and checks the stack names it. Derived from the code rather than from a
list, because a list is exactly the thing that was already wrong. Tables reached
only through code a function never runs are listed individually with the reason,
so a genuinely missing one still fails.

## Three reasons an alarm did not fire

All three were found by chasing one report: an AWS-only account whose guardrail
alarm said "never checked" and never reacted, and a full account where it
reacted but not straight away.

### A table named but never created

`hasTable` asks whether the environment variable is set, not whether the table
exists. The alarm Lambda was given `GRAPH_EDGES_TABLE`, `ALERTS_TABLE` and
`SCANNERS_TABLE` unconditionally, while `setup-aws-only.sh` deliberately creates
none of the three.

So in an AWS-only install the first read threw `ResourceNotFoundException`,
which killed the whole pass before a single alarm was evaluated. Nothing was
written, so `lastCheckedAt` stayed empty for ever, and the tab showed an alarm
that had simply never been checked with nothing anywhere explaining why.

The stack now withholds those three variables when `awsOnly`, and
`repro-tablegating.ts` derives the list from `GITHUB_ONLY_TABLES` in the setup
script and checks both directions: every skipped table is withheld, and nothing
else is.

### A pass that was all or nothing

Pinning the access graph is an **optimisation**: it reads the graph once so six
checks do not read it six times. Letting that read throw made it load-bearing,
so a pass containing one guardrail alarm, which never touches the graph, died
because a table belonging to the GitHub half could not be read.

A failed pin now falls through to an unpinned pass. Each check that genuinely
needs the graph fails on its own and is recorded as a reading that could not be
taken, which is the correct answer for one alarm; the ones that never needed it
are unaffected.

### A read that arrived before the write

`listFindings` used a Query, which is **eventually consistent by default**. The
alarm evaluation that runs the moment a sweep rewrites the findings could be
handed the replica from before the write: it saw the account as it was a second
ago, concluded nothing had changed, and stayed silent. The alarm then fired on
the next five-minute tick.

That is precisely the "it noticed, but not straight away" that evaluating
immediately after a sweep exists to avoid. The read is now consistent. It costs
double the read units on a table of a few hundred small rows, which is not a
number worth trading correctness for.

## When an alarm has never been checked

The evaluator runs as a **deployed Lambda**, on a five-minute schedule, and
again immediately whenever guardrail findings are rewritten. The app's own
server does not evaluate alarms at all.

That means a new alarm kind, or a fix to how alarms are evaluated, does nothing
until the stack is deployed again. The API accepts the alarm, the tab lists it,
and nothing ever reads it.

An alarm with no `lastCheckedAt` now says **never checked** and explains what
that usually means. It rendered as nothing before, which made "never evaluated"
and "evaluated a moment ago and quiet" identical on screen: the same absence
told as a definite answer that this codebase keeps having to remove.

## Which team owns an alarm

An alarm belongs to the team that owns **what it watches**, not to one team for
all of them.

| Alarm | Create, edit, delete |
| --- | --- |
| on a widget | `control-hub-admins` |
| on a `guardrail:` subject | `aws-guardrail-admins` |
| personal, on your own card | its owner, and nobody else |

Reading the tab is open to **either** team. That is deliberately weaker than
writing: an administrator who cannot see an alarm cannot sensibly be told they
may change it.

### What this replaced, and why it was wrong

Every alarm route was gated on the Control Hub team, with a stated rationale:
alarms watch GitHub activity and merely happen to be delivered by SNS. That was
true when written, and stopped being true when guardrail alarms arrived — those
watch AWS findings, and the reasoning does not reach them.

What it produced was backwards. Whoever administers the AWS account could not
touch the alarms watching it, while whoever administers only the repositories
could — and that got sharper when the AWS tab itself was restricted to the AWS
team, leaving the alarms **more open than the screen they are about**.

### How the decision is made

The subject decides, read from the stored record rather than from the request:
taking it from the body would let either team claim the other's. Because the
subject is only known once the body or the stored alarm has been read, the check
runs *inside* the handler (`refusedForSubject`) rather than as route middleware
— `repro-undo.ts`'s scanner was taught that this counts as naming a guard.

A membership check that cannot be answered is a **503**, not a refusal. A 403
would tell somebody they had lost a permission they still hold.

### What stays with the Control Hub team

The shared notification plumbing: creating groups, adding members, the Teams
flow, the security-alert settings. These are one set of destinations for the
whole organization rather than either team's own, and adding an address to a
topic is the "this app can email anyone" capability the gate exists for. An AWS
admin can point an alarm at an existing group; they cannot create one or change
who is in it.

`repro-authz.ts` holds the separation positively rather than by exclusion: it
asserts that in the one file holding both kinds, the AWS check is reached only
for AWS subjects, and that reading is open to either.

### One page, two sections

The Alarms tab keeps one list, split into **On GitHub widgets** and **On AWS
guardrails** — sections rather than tabs, because they are one answer to "what is
being watched" and a tab would hide half of it behind a click on a page whose
whole job is to be scanned.

A section the viewer's team does not own says **view only** once at the top,
with the team name, and its rows carry no controls: a button that only ever
returns a permission error is worse than no button.

A bug surfaced while doing this: the page gated *reading* on the AWS team alone,
so somebody who administers every GitHub setting in this app opened the Alarms
tab and was told it was for admins.

## Personal alarms

**My work → My alarms.** An alarm on one of your own cards, delivered to your own
addresses. Nobody else sees it, and nobody else has to agree the threshold is
the right one.

### Why it is a separate router

`/api/alarms` is gated on the Control Hub admin team, for a stated reason:
subscribing an address to an SNS topic means this app can send mail. Personal
alarms cannot sit behind that gate — asking an administrator for permission to
be told about your own card is the wrong shape — so `/api/me/alarms` is a
separate router, narrowed until that reason no longer applies:

- **The destination is never in the request.** It is resolved from the session,
  so there is no request shape that points a personal alarm at an organization
  topic or at somebody else's inbox. The edit route names the fields it writes
  rather than passing the body through, which is where that hole would reappear
  one request later.
- **The card must be one you own**, checked against what is stored.
- **The alarm is yours only if its stored `owner` says so.** An administrator is
  refused here like anybody else — being trusted with the organization's
  settings is not the same as being able to read what lands in one person's
  inbox. Absent and somebody-else's answer identically, because a 403 confirms
  the thing exists.
- **An unsubscribe ARN must belong to your own topic**, or one from elsewhere
  would remove a stranger from a group you do not own.
- **The lists are capped** at five email and five Teams addresses.

What remains is that somebody can have AWS send a confirmation email to an
address they typed. SNS delivers nothing until that address confirms, so the
widest this reaches is a handful of one-off confirmation emails — each recorded
in the activity feed like every other change.

### One group per person

A personal alarm points at a group like every other alarm — one per person,
created the first time they need it. That reuse is the whole design: the SNS
topic, the Teams recipients, the per-person timezones and the templates all work
unchanged. A second delivery path beside the tested one is how two ways of
sending an email end up disagreeing about what a message looks like.

Personal groups are filtered out of `GET /alarms/groups` and personal alarms out
of `GET /alarms`, so an administrator's screens show the organization's and only
the organization's.

### One form, two modes

`AlarmModal` takes a `personal` flag rather than being copied. Everything hard
about it — which conditions a widget supports, what the templates may say, what
the interval means — is identical, and the copy is always the one that goes
stale. What differs is the destination: the organization form picks a group, and
the personal one shows where the alarm will land, read-only, because the
addresses are managed in one place on the Alarms tab. Four alarms carrying four
copies of the same address is four things to change when an address changes, and
three get forgotten.

The summary is deliberately explicit about unconfirmed addresses: one that has
not confirmed receives nothing, and a form showing it as a destination leaves
somebody waiting for an email that was never going to arrive.

## Personal changes in the feed

A personal widget or alarm is a real change. It belongs in Activity and it
counts in Statistics — it is how somebody answers "why did that alert arrive".
It is not, however, the same event as an administrator changing what everybody
sees, and a feed that renders the two identically makes the organization's own
history harder to read.

So rows carry a **`personal`** flag, alongside `important` and `detailed`:

- Written from the **stored record** (`!!widget.owner`, `!!alarm.owner`), never
  from a parameter. A caller that forgot to pass it would file a personal change
  as an organization one.
- Rendered as a chip on the row.
- Filterable in three states — shown, only personal, hidden — because both
  narrowings are wanted and neither is the default. The control appears on the
  **Everything** and **App** streams, the two where these rows land.

The stream formerly labelled "App settings" is now **App**.

## Personal widgets, and narrowing them

**My work → your cards** run the same checks as the Overview tab, against the
same data path — the same hook, the same verdict function. Only the presentation
and the narrowing differ.

### Why the card looks different

The Overview card is a status tile built to be scanned across a wall of others:
it leads with a share of the organization and reports a verdict into a
page-level headline. A personal board has no such headline, and the share of the
organization is the wrong denominator for four cards you chose.

The personal card leads with **the count**, at a size that reads across a grid,
tinted and edged by severity, with the rows underneath as the evidence. The
first version led with the list and put the number in a subtitle, which made a
card with four problems look exactly like a card with none — the thing a
dashboard exists to prevent. Clear cards stay deliberately quiet: a board where
every card shouts is a board nobody reads.

What is deliberately **not** forked is the data. `PersonalCard` imports
`useWidgetData`, `verdictFor` and `entityForConfig` from the Overview, and
`repro-personalwidgets.ts` fails if it stops doing so. Two presentations of one
answer is a design choice; two data paths is a bug waiting to produce two
different numbers for the same check.

### Per-column filters

A check answers a question about the whole organization. On a shared board that
is the point; on your own it usually is not, because "which repositories have
gone dormant" is a hundred rows of which four are yours.

Narrowing the check was never an option — the checks are shared, and a personal
board that could redefine them would change what everybody else sees. So the
narrowing happens to the **rows**, and is stored on the widget: a dashboard you
have to re-narrow every time you open it is not a dashboard.

**Every column except three.** `index` is the row number, a property of the list
rather than the row. `link` is a button. `details` is excluded on purpose: it is
prose assembled per row, so a filter on it would be a text search wearing a
filter's clothes, and the alarm on the same check already matches that text
properly.

**Three shapes of control, decided by the data rather than by a list of check
ids**, so a check that starts returning a new field becomes filterable without
this being edited — the same rule the columns themselves already follow:

| The column holds | Control | Matching |
| --- | --- | --- |
| free text (repository, owner) | type values, keep or hide | case-insensitive **substring** |
| a small fixed set (status, visibility, worst) | tick the values present | exact |
| a count (bypasses, age, severity totals) | min and max | inclusive both ends |

Substring, because what people type is a name they half-remember; an exact match
would make a filter that returns nothing look like a check that found nothing.
A column with more than a dozen distinct values is treated as text, one with
fewer as a set.

Filters combine **AND across columns, OR within one**, which is how people
describe a board out loud: "my two repositories, only the failing ones".

**Absence is not a wildcard.** A row with no owner does not belong in a board
narrowed to two owners. The inverse holds too: excluding those two owners keeps
the row that has neither.

**Ranges ignore `exclude`** rather than inverting themselves. A range with a
hole in the middle is two filters, not one turned inside out.

### The three ways this could have gone wrong

**A count that disagrees with its own rows.** Filtering happens inside
`useWidgetData`, so the number on the card and the rows behind it come out of
the same function. A card reading 112 that opens onto four rows is the bug that
placement prevents.

**Filtering a list that is missing rows.** A stored snapshot is trimmed to fit
the row limit and carries the true count of everything. Filtering that compares
against rows that are not there and reports the answer as exact, so a filtered
widget reads live instead — the same rule the detail table already followed.

**A filter that cannot be undone.** The editor builds its choices from
`allItems`, the rows *before* this widget's filters. Drawing them from the
filtered rows would mean the value you wanted had already been filtered out of
the list of values to pick from.

### Making a zero explainable

A filter that keeps nothing looks identical to a check that found nothing, and
the commonest cause is filtering the wrong column — a username typed into
Entity, where the values are repository names.

So the editor shows its work:

- **A per-column match count** beside each control (`2 of 47`), red at zero. The
  total at the bottom is every filter together, which says only that *something*
  is wrong; this says which control caused it.
- **A count on each tickable value**, so a choice that would keep nothing is
  visible before it is made.
- **Real example values** under each text box, clickable to insert — which makes
  the wrong-column mistake self-correcting.
- **A column nothing fills** says so outright, rather than accepting a filter
  that could never match.

`repro-widgetrowshapes.ts` reads every check's `results.push({…})` out of
`graphService.ts` and asserts that every column its table shows is backed by a
field the rows actually carry, and that a filter built from a row's own value
keeps that row. Across all 16 checks nothing is mismatched — worth recording
that **`stale-repos` is the only check that reports an owner**, so filtering by
person applies there and the column is correctly absent elsewhere rather than
present-and-empty.

### Saying when a filter is deciding the number

The card prints the unfiltered figure beside the filtered one, an empty result
distinguishes "nothing matches your filters" from "nothing found", and the
detail view opened from a narrowed card says so at the top. Without those, this
card and the Overview show two different numbers for the same check and neither
explains why.

### A bug this uncovered

`PUT /widgets/:id` destructured every field out of the body and passed them all
to `updateWidget`, which merges over what is stored. A field the request did not
send arrived as `undefined` and, with `removeUndefinedValues`, deleted the stored
attribute. It never showed, because the only caller sent the whole widget every
time. The filter editor sends `filters` alone, and would have erased the title.

The route now copies only the keys actually present in the body — with `filters`
included whenever the key is there even if it cleans to undefined, because that
is how the last filter gets removed.

## One change, one event, everywhere

Pressing **Fix** on a guardrail finding writes two activity rows on purpose:

| Row | Actor | What it records |
| --- | --- | --- |
| `aws.guardrail.run` | the person | who asked |
| `aws.guardrail` | `system (aws guardrail, <account>)` | what actually changed, with the undo payload, account and region |

Both belong in **Events**, which is the tab you go to precisely to find out who
triggered something.

They are one event, though, and **Statistics** was counting them twice. A person
fixing ten findings showed twenty events, and the AWS category read as twice as
busy as it was.

The first attempt at this kept both rows and had **Statistics** skip the
duplicate. That was worse than the double count it replaced: the feed did not
skip it, so the same hour reported two different totals depending on which
screen you read it from.

The route no longer writes that second row at all. The engine's row carries
`triggeredBy`, so one row says both what changed and who asked, and the feed
renders the person under the actor. One row, one count, everywhere, with nothing
lost: a fix that changed nothing writes no engine row, so the route's row stays
as the sole record of the attempt.

`echoOf` survives as a read-time filter, in both the feed and the statistics,
because rows written under the old scheme live for thirteen months.

Two details that are easy to get wrong:

- **Only when the engine actually wrote a row.** A fix that found nothing to
  change leaves the route's row as the sole record of the attempt, so it is not
  marked and still counts.
- **The previous window is deduplicated too.** Comparing a deduplicated week
  against a doubled one would report a 50% fall that never happened.

The person is not lost. The manual-fix invocation carries `triggeredBy`, the
engine stamps it on its own row, and the top-actors count reads that in
preference to the actor. The actor stays the system, which is what did the work:
a row claiming a person changed a bucket policy directly would be a worse record
than one naming both.

## The GitHub request breakdown

**Activity → GitHub requests** answers the other half of the question the Costs
lens answers: not what the app costs in dollars, but what it spends of the
organization's GitHub allowance, and which feature spends it.

It sits beside Costs because the two are read together, and is hidden in an
AWS-only install, where there is no GitHub App and the route behind it is gated
off anyway.

**Both halves are measured.**

**The allowances** come from GitHub. `GET /rate_limit` is the one endpoint that
does not count against the limit it reports, so a page about the budget cannot
spend it. Three allowances that do not share, so exhausting one leaves the
others untouched:

| Bucket | Allowance | What draws on it |
| --- | --- | --- |
| core | 15,000 per hour | ordinary REST reads and writes, almost everything |
| search | **30 per minute** | commit, code and issue search. The smallest budget in the app by a wide margin |
| graphql | points per hour | the open pull request walk, and nothing else |

Shown as **used**, not remaining. "14,985 / 15,000" is the same fact told
backwards, and every reader takes the first number for what they have spent,
because a figure over a total means that everywhere else.

**The per-feature counts** come from a counter this app increments on every
request it makes. GitHub reports that a request happened and never which feature
made it, so attribution has to happen at the moment of the call.

Every GitHub client is built by `createOctokit`, which installs a `before`
request hook. The hook counts before the request rather than after, so a call
that fails or is rate-limited still counts: GitHub charged for it either way,
and a page that counted only successes would go quietest exactly when the
allowance was under most pressure.

The feature name comes from one of two places, **async-local first**:

- an **async-local** set by `withFeature(...)` at the function that does the
  work — the alert sweep, the Renovate search, the pull request walk, a repository
  detail page. Nesting works, and the innermost name wins, because that is the one
  that answers "what would I change to spend less".
- the **client itself**, via `createOctokit(token, "…")`, used when nothing wraps
  the call. The per-subject checks make their calls inline inside a much larger
  function, and naming the client beats wrapping sixty lines of loop.

The order matters and was wrong at first. A client is built once and handed
around: the alarm pass builds one and passes it to the Dependabot sweep, so a
label fixed at construction filed the sweep's requests under the pass. The
async-local is set by whatever is actually doing the work, so it wins wherever
there is one.

Anything made outside either is counted as **Unattributed** rather than dropped
— which is exactly what happened: five clients in the dependency routes and one
in the alarm pass carried no label, and the largest row on the page was a word
that explained nothing.

That row's own description was worse than useless for a while. It listed
sign-ins, membership checks and writes to GitHub as examples of unlabelled
work, and stayed there after all three were given rows of their own three lines
above it. A description written before the thing it describes changed, and never
revisited, contradicts the page it sits on. `repro-githubbudget.ts` now
fails on any `createOctokit(` built without one, matching parens so a call whose
first argument contains brackets is still read as one argument.

### Which process wrote a count

Four processes write to this table — the app's own server and three Lambdas —
and they **deploy separately**. A Lambda running a build from before a label
existed keeps writing rows under the old name, and on the page those are
indistinguishable from a call site nobody labelled. One is fixed by deploying,
the other by editing code, so every count records the process that made it.

The name comes from `AWS_LAMBDA_FUNCTION_NAME` at runtime, with the stack prefix
stripped, so nothing has to be threaded through CDK and a function added
tomorrow is named correctly the day it appears. Absent means the app's own
server.

An expanded row lists the processes that recorded it, and an `Unattributed` row
recorded by anything other than the app says outright that redeploying is what
moves those counts into named rows.

**The stored attribute has grown twice**, so `parseAttr` reads three shapes:
`u#<bucket>#<via>#<source>#<feature>` and the two earlier forms. Rows live for
two days, so the older ones are still in the table; they read as the app's own
credentials, which is what nearly all of them were, and as an unknown source,
which is honest. Dropping them would make an hour look emptier than it was.

### Two credentials, two allowances

GitHub meters **per token**, and this app holds two kinds: its own App
installation token, and each signed-in person's. Counting them together and
comparing the total against the App's headroom is how the page came to report 39
requests against an allowance showing 10 used.

Each request now records which credential it went out on, decided in the hook by
comparing against `getSystemToken()` rather than from anything a caller passes —
a flag supplied at the call site would be wrong wherever the token is chosen
there (`getSystemToken() || req.user.accessToken`). The page shows the app's own
count beside each allowance, and names the user-token half separately.

They still will not match exactly, and the page says why: the windows differ.
GitHub's allowance refills on its own clock; these counters bucket by the hour.

**Counted across three processes.** The app's own server, the alarm evaluator
and the graph aggregator all make GitHub requests, so an in-memory count would
describe only whichever one happened to answer the page. Counts are buffered in
memory and flushed to the **alarms table**, which all three already reach and
which already has TTL enabled — no new table, no CDK change.

- The server flushes on a 30-second timer, started at **module level**. It was
  first started inside `if (!process.env.__STANDALONE__)`, which is the
  *developer's* server: the desktop app sets that variable and calls `listen()`
  itself, so on every real install the timer never armed. Counts buffered in
  memory, nothing was ever written, and the page reported nothing — correctly,
  and for ever. `repro-githubusage.ts` now fails if the call moves back inside
  that block.
- Reading the page flushes this process's buffer first, so a request made a
  moment ago is on the page rather than up to half a minute behind it. The
  Refresh button is therefore immediate for anything the app itself just did,
  and holds its spinner for a moment so a cached answer returning in single-digit
  milliseconds still looks like it did something.

**Reloading a tab often adds nothing, and the page says so.** Most checks are
computed from stored data and never reach GitHub at all, and the alert sweep and
the Renovate search are held for a minute and shared — so a second look inside
that minute costs nothing. Without that stated, a counter working exactly as
designed reads as a broken one.
- The Lambdas flush at the end of their pass. A timer there would fire at an
  unrelated moment or not at all, because they are frozen between invocations.
  The alarm pass flushes outside every `try`, so a pass that failed half way
  still records what it spent — the hour that went wrong is the hour somebody
  most wants the numbers for.

**One row per clock hour**, `github-usage#YYYY-MM-DDTHH`, with a 48-hour TTL.
Counters are flattened into top-level attributes named `u#<bucket>#<feature>` so
each can be incremented with `ADD`, which is atomic and needs no read first.
Three processes write these concurrently, and a read-modify-write would silently
drop whichever update lost the race, undercounting in exactly the busy hour
somebody opened the page to understand.

**The two halves will not agree exactly, and the page says so.** GitHub's figure
covers every request against the installation; this app's covers what it made
and could attribute. Where they differ, the gap is itself worth knowing.

**Nothing recorded is said out loud.** A fresh install and a quiet one produce
identical numbers and are completely different situations, so an empty window
explains itself rather than rendering as a row of zeros.

**What this replaced.** The first version of this page published estimates:
requests-per-run times runs-per-hour, derived from the code and from the size of
the organization. They were arithmetic about a hypothetical installation, sat in
the same visual voice as the real allowance numbers beside them, and gave nobody
anything to act on. `repro-githubbudget.ts` now fails if `perRun`, `runsPerHour`,
`perHour` or `worstCase` reappears in that file.

**Two tests hold it together**, because every failure here is silent — a new
call site works perfectly, spends the allowance, and is invisible to the counter
while the page keeps rendering and keeps adding up.

- `repro-githubusage.ts` fails if any file constructs a GitHub client outside
  `github/client.ts`. It matches the aliased form too: three checks were building
  clients as `new SbpOctokit(...)`, `new PbrOctokit(...)` and `new DormOctokit(...)`,
  which a search for `new Octokit(` misses entirely.
- `repro-githubbudget.ts` walks `src/` for call sites and fails when one belongs
  to no feature, when a feature names a file that no longer calls GitHub, or when
  a label passed in the code has no write-up beside it.

The reference material beside each count — what the feature does, the endpoints
it calls, the files to change — is what those tests keep honest. The counts
themselves cannot drift, because they are counted.

Cached for 30 seconds. Both halves are live and the counters flush every 30
seconds, so a shorter cache repaints the same figures and a longer one makes a
limit look stuck while it recovers.

## Not asking GitHub the same question twice a minute

Two reads here are org-wide, and both are the kind that trip a **secondary**
rate limit, which is not the hourly budget but "too much, too fast":

| Read | Cost |
| --- | --- |
| The Dependabot alert sweep | pages a hundred alerts at a time, so one call is several requests back to back |
| The Renovate search | the search API, whose limit is **thirty requests a minute**, the smallest budget the app draws on. One call pages, and tries each candidate bot spelling, because search answers an unknown author with 422 rather than an empty result |

Both were memoised **inside the alarm pass and nowhere else**, so the pass was
careful and every page load was not. Somebody clicking around the
Vulnerabilities tab, with widgets computing live beside them, issues exactly the
burst that limit exists to stop.

Both are now held for a minute and shared by every caller, with the in-flight
promise shared as well as the result, because the case this exists for is
several callers starting together and all missing the cache. Six concurrent
callers cost one sweep; five cost one search pass.

**A failed read is not cached.** "We could not read this" held for a minute
turns one failed request into a minute of them, and hides a token whose scope
has just been fixed.

Sixty seconds because GitHub rescans on its own schedule: a fresher answer than
that does not exist to be had.

## When the desktop app checks for an update

The check needs a GitHub App token, that token comes from Secrets Manager, and
so **AWS has to be reachable before GitHub can be asked anything**. That
coupling is structural: there is no credential to check with until somebody has
signed in.

What is not structural is treating "not yet" as "not until you relaunch", which
it did in three ways:

| Situation | What happened | Now |
| --- | --- | --- |
| AWS not reachable within five minutes | Gave up for half an hour; signing in a minute later changed nothing | Keeps retrying |
| No GitHub App token | Reported an error and returned. **Permanent in an AWS-only account**, which holds no App key by design, so it could never check at all | Waits, and starts on its own if you switch to an account that has one |
| Switching into an account with an App | Nothing re-triggered a check | Picked up by the retry |

So it retries every 20 seconds until a check actually runs, then settles into
the ordinary 30-minute interval. Each attempt is one local HTTP call and one
function call inside the same process, so retrying costs nothing worth saving.

A check that ran and *failed* counts as having run: GitHub being unreachable is
the interval's problem, not a reason to poll every twenty seconds.

Each distinct reason for waiting is logged once rather than on every retry,
because the AWS-only case is normal and permanent there, and a line repeating
for ever is one nobody reads. The reasons reset after a successful check, so a
later failure explains itself rather than being silenced by something said an
hour ago.

The token is read by calling into the backend running in the same process. It
was once served over an unauthenticated `GET /auth/system-token`, which put an
org-wide admin token behind anything that could open a socket to the app.

## Where the code runs

| | |
|---|---|
| Desktop app | the whole backend, in-process, on `localhost:4321`, using your AWS credentials |
| Lambda | five functions: guardrails, webhook receiver, webhook worker, alarm evaluator, graph aggregator. An AWS-only install has two, the guardrail sweep and the alarm evaluator |

The same backend is compiled once and started both ways. What differs is who it
authenticates as and what triggers it.
