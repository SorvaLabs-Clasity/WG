# How every feature actually works

What each feature *does* is in [`docs/features/`](features/). This file is about
the mechanism: where the data lives, what puts it there, how often, and how
stale it can be before somebody notices.

It exists because those are the questions asked when something looks wrong. "The
page says zero" has three completely different answers depending on whether that
page reads GitHub live, reads a stored snapshot, or reads a snapshot nobody has
rebuilt since Tuesday.

Every feature below is written twice, on purpose:

- **The path** — what actually happens, in plain English, as a diagram plus a
  table saying what each box in it really is. Read this. Most questions are
  answered by working out which step you are on the wrong side of.
- **The infrastructure** — table names, row shapes and which file does what.
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
stack was deployed. Three of these exist, at 15 minutes, 5 minutes and 6 hours.

**A sweep.** One complete run of the guardrail engine: list the resources in the
account, check each against each rule, write down what it found. Described in
full under [AWS guardrails](#aws-guardrails).

**A walk.** One complete read of the open pull requests from GitHub. It is called
a walk because GitHub will not hand over the whole list at once — you ask for a
page, get a cursor, ask for the next, and keep going. Described in full under
[Pull requests](#pull-requests).

**An expiry (TTL).** A time stamped on a row, after which DynamoDB deletes it
for you. Nothing has to run to clean up — but it is also not punctual: DynamoDB
often deletes hours or days after the stamp passes, which is why anything that
must be *ignored* on time is checked when it is read rather than trusted to
disappear.

**A connection.** One row in the access graph, saying *this person can reach
this repository, at this level, by this route*. Bob is in the platform team, the
platform team can write to payments-api, so Bob has a connection to payments-api
at write level, by way of that team. Your organization has 1,849 of them.

The app says "connections" and so does this file. The code and the table call
them **edges**, which is the usual word for a link between two things in a
graph, and is why the table is named `github-control-hub-graph-edges` — worth
knowing only when you are looking at the table itself.

### How to read the diagrams

Each feature has a **path** — a diagram written in plain English, followed by a
table saying what each box in it really is. Read the diagram to understand what
happens; read the table only if you are about to change something.

The things the tables name:

| Term | What it means |
|---|---|
| **Lambda** | Code AWS runs for you when something triggers it. No server, nothing running between triggers, billed by the millisecond. Each one has a memory size and a time limit |
| **EventBridge rule** | AWS's timer. "Every 5 minutes, run that Lambda." It can also watch for a specific thing happening rather than a clock |
| **DynamoDB table** | The database. Every table here is a pile of rows looked up by a key — there are no joins and no queries across tables |
| **SQS queue** | A waiting line for work. Something puts a job in, something else takes it out later. The point is that the taker can be slow or broken without the putter caring |
| **SNS topic** | AWS's mailing list. The app publishes one message; AWS delivers it to everyone subscribed |
| **S3 bucket** | File storage |
| **API Gateway** | The public front door. The only address anything outside your account can reach |
| **Secrets Manager** | Where the GitHub credentials are kept |
| **app code** | Ordinary code with no infrastructure of its own. When you click something, this runs on **your own machine** — the desktop app contains the whole backend |

Where a box names a file, it is `like/this.ts`, and it is there for whoever
edits the code — you can ignore it otherwise.

---

## What runs on a schedule

Five things happen without anybody pressing anything. Everything else happens
because a person clicked, or GitHub sent a webhook.

| What | Runs | Which Lambda |
|---|---|---|
| Guardrail sweep | every 15 minutes | `github-control-hub-guardrail-enforcer` |
| Guardrail run for one resource | seconds after a covered resource changes, via CloudTrail | the same function |
| Alarm evaluation, then the PR walk | every 5 minutes, whenever **Monitor pull requests** is on | `github-control-hub-alarm-evaluator` |
| Access graph rebuild | every 6 hours | `github-control-hub-graph-aggregator` |
| Audit-log ingest | when GitHub drops a batch into S3 | `github-control-hub-audit-ingest` |

The schedules are EventBridge rules created by the CDK stack. Changing one means
editing `infra/cdk-stack.ts` and redeploying — they are not settings in the app.

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
| the ticker | A Lambda: `github-control-hub-alarm-evaluator`, 512 MB, 5-minute limit. The same one that checks alarms — this rides along rather than having a timer of its own |
| ask GitHub | GitHub's search, a page at a time, following a cursor (`services/prNudgeService.ts`) |
| the saved row | **One** row in the `github-control-hub-alarms` table, holding the entire list as text, under the name `pr-snapshot` |
| you open it | The Pull requests tab's backend (`routes/pulls.ts`), running on your machine |
| re-checks every 30 s | The page itself polling, and it stops polling entirely if you switch the feature off |

1. **One Lambda does three jobs on the same timer** — checks alarms, sends
   buffered notifications, and this. Adding a second timer would mean two clocks
   to keep in step, so the pull request walk rides on the existing one. It fires
   288 times a day whether or not anybody is signed in.
2. **The first thing it does is check whether the feature is on**, which is a
   single row read. Switched off, the walk never starts — the check sits
   deliberately *before* the fetch, so "off" costs nothing rather than fetching
   the world and then declining to use it.
3. **Asking GitHub is the slow part, and it comes back a page at a time.** You
   ask for a page, GitHub gives you the page and a bookmark, you ask for the
   next. Each pull request also needs its last commit, its requested reviewers
   and its existing reviews resolved, which is why a *page* is the expensive
   unit here, not a request.
4. **How many fit in a page is learned, not configured.** GitHub gives up on a
   page it finds too expensive and returns an error after about eleven seconds.
   So the walk starts at 30 per page and, on that error, steps down — 24, 18,
   12, 6 — retrying **from the same bookmark** so nothing is skipped, and
   remembers the size that worked for next time. Every twentieth walk it tries
   one size bigger, so a bad afternoon does not pin you to the smallest page for
   ever.
5. **The whole list is saved as one row, not a row per pull request** — the list
   as a block of text, plus when the walk finished. If that block exceeds
   300 KB it drops the last fifth and tries again, and flags the result as
   trimmed. The reason for the cap: a row over 400 KB is rejected outright, and
   a rejected save looks exactly like a cache that is quietly working and merely
   old.
6. **Opening the tab reads that one row and looks at its age.** Fresh enough, it
   paints immediately and starts a walk behind you — one walk however many tabs
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
is no single call that returns them — you ask GitHub's search API for a page, it
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
The walk feeds two things — the stored copy, and the decision about who to
remind — and only the second one is what the reminders switch governs. That
distinction was wrong in the code until 2026-08-20: the tick returned early when
reminders were off, which is the default, so in the shipped configuration
nothing kept the stored copy warm and the first open of the day always paid for
a live walk. Switching monitoring off still stops the walk entirely, and that is
the switch to use if you want the tick to stop looking.

**2. Any walk the app itself does.** If the tab is opened and there is no stored
copy — first ever launch, or the stored one has expired — the app walks GitHub
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
   wait — but that walk is then stored, so the next open is fast.

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
not a graceful failure — the write is rejected and the stored copy silently stops
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
is exactly the route's response — pinning it as columns would create a second
definition of the same rows, free to drift from the first.

**Which code touches it:**

| File | Role |
|---|---|
| `services/prNudgeService.ts` | `fetchOpenPrs` — the walk itself, the page-size ladder, the reminder logic |
| `services/alarmService.ts` | `savePrSnapshot` / `readPrSnapshot` — **the only reader and writer of the row** |
| `routes/pulls.ts` | the tab: serve the snapshot, refresh behind it, honour `?refresh=1` |
| `alarms/handler.ts` | the 5-minute tick that walks and saves |
| `services/orgConfigService.ts` | `savePrPageSize` — the learned page size, in a different table |

**Two tables, not one.** The list lives in `alarms`; the learned page size lives
in `org-config` alongside the graph's freshness. They are separated because the
list expires after a day and the page size should not — an organization's
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

- **Monitoring on** — the walk happens and the list is stored. This is what the
  tab shows.
- **Reminders on** — additionally, people are messaged about what the walk found.

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

  every 6 hours ──────▶ the rebuilder ──▶ ask GitHub for everything ──┐
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
| every 6 hours | An EventBridge rule, `github-control-hub-graph-aggregation` |
| the rebuilder | A Lambda: `github-control-hub-graph-aggregator`, 1024 MB, 15-minute limit (`jobs/graphAggregator.ts`) |
| ask GitHub | Ordinary GitHub API calls with the app's own credentials — about four per repository |
| the connections table | A DynamoDB table, `github-control-hub-graph-edges` |
| GitHub tells us | A webhook arriving, handled by `github-control-hub-webhook-worker` (`services/graphEdgeService.ts` does the updating) |
| press "Sync from GitHub" | The same rebuild code, run inside the desktop app on your machine, using **your** GitHub login rather than the app's |
| work out every route | `services/accessMapService.ts`, holding its answer in memory for 60 seconds |

Two more things the rebuild writes on its way past: the compliance score for
every repository, and a note of when it finished — which is what the Access page
header reads to tell you how old the picture is.

1. **Nothing runs the rebuild except that timer and that button.** The Lambda
   is allowed to *read* every table in the stack but to *write* only three: the
   connections, the compliance scores, and the freshness note. Something that
   clears and rewrites a whole table is deliberately kept away from the activity
   log, which is the record you would use to reconstruct what happened.
2. **The walk is ordinary GitHub API calls**, using the app's own credentials:
   list the repositories, the teams, the members and the outside collaborators;
   then for each team its repositories and its members; then for each repository
   who can reach it and at what level, plus its branches, workflows and open
   Dependabot alerts. Roughly four requests per repository.
3. **"Compare and write only what changed" means this, concretely.** It is done
   in the Lambda's own memory — DynamoDB has no such feature:
   - It reads every connection already stored — the whole row, not just its
     identifier, because it needs the contents to compare them.
   - It gives each one a short summary of its contents — a **fingerprint** —
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
     and a workflow genuinely named `Build :: Test` split into three parts — the
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
   freshness stamp is never reached — a snapshot dated now is worse than one
   dated six hours ago, because only one of them looks wrong.
6. **Sync from GitHub calls the same function in-process**, not the Lambda:
   `routes/graph.ts` imports `aggregateGraphData` and runs it in the desktop
   backend with your token. (Guardrails do the opposite and invoke their Lambda.
   The difference is that a sweep holds write permissions on your AWS account
   worth confining to one place; a graph walk only reads GitHub.)
7. **The read path never touches GitHub.** `accessMapService.load()` scans
   `graph-edges` once, derives every route by which each person reaches each
   repository into a set of `Map`s, and keeps that derived object in a
   module-level variable for **60 seconds** — a plain `let cache` in the
   process, not DynamoDB and not Redis. The aggregator calls
   `invalidateAccessMap()` when it finishes, so a completed sync is visible
   immediately rather than up to a minute later.

### What the rebuild does

The rebuild — the 6-hour tick, or **Sync from GitHub** on the Access tab — walks
the whole organization and turns it into *connections*: small rows saying "this
person reaches this repository, at this level, by this route".

1. **List every repository**, every team, every member, and every outside
   collaborator.
2. **Read the organization's default permission**, because the map's biggest
   claim — "everyone can already read everything" — is only true if the default
   says so.
3. **For each team**, list its repositories and its members. That is where "Bob
   can write to payments-api because he is in platform-eng" comes from.
4. **For each repository**, list its collaborators with the level each has, plus
   its branches, workflows and open Dependabot alerts.
5. **Turn all of that into connections** — roughly `USER#bob → REPO#payments-api`,
   carrying the level and how it was obtained.
6. **Compare against what is already stored**, and write only the difference.

Step 6 is why this is cheap to run often. A rebuild where nobody joined, left or
changed team writes **nothing at all** — it reads the stored connections, finds
them identical, and stops. Before that comparison existed it deleted and rewrote every
row every time, which was the single most expensive thing in the app.

### What it costs

Roughly four GitHub requests per repository for the walk, plus about six more per
repository for compliance scores, which ride along. A few hundred repositories is
a few thousand requests — a meaningful slice of one hour's rate limit, which is
why it runs every six hours rather than every few minutes.

### What is recorded, and the one thing that is not

Every explicit grant: admin, maintain, write, triage, and custom repository roles
under whatever name your organization gave them. Outside collaborators always,
including at read — the person who is not in your organization and can still see
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

Most are written in both directions — `USER#alice → REPO#api` *and*
`REPO#api → USER#alice` — because DynamoDB can only query by partition key. One
direction answers "what can Alice reach", the other answers "who can reach this
repository", and without both one of those questions would need a full scan.

**Four files touch this table, and they do different jobs:**

| File | What it does |
|---|---|
| `jobs/graphAggregator.ts` | **the only full writer.** Rebuilds everything: reads all edges, diffs, writes the difference |
| `services/graphEdgeService.ts` | **patches single edges** between rebuilds — `addBranchEdge`, `removeBranchEdge`, `addCollaboratorEdge`, `removeCollaboratorEdge`, `addRepoEdges`, `updateBranchProtection` |
| `services/graphService.ts` | reads for the security checks — `scanGraphEdges`, `evaluateSecurityQuery` |
| `services/accessMapService.ts` | reads and derives the access map — `accessSummary`, `accessForUser`, `accessForRepo`, `accessForTeam` |

### Webhooks patch it between rebuilds

The six-hour rebuild is not the only writer. When GitHub sends a webhook saying a
branch was created, a collaborator was added, or protection changed,
`webhooks/processDelivery.ts` calls the matching function in `graphEdgeService`
and updates **just those rows**.

So the graph is usually more current than "six hours old" suggests: the rebuild is
the floor, and webhooks keep the fast-moving parts up to date in between. What a
rebuild catches that webhooks cannot is anything that happened while the webhook
was misconfigured, plus connection types no webhook reports.

`routes/activity.ts` calls the same functions when you undo something, so undoing
a branch deletion puts its connection back rather than waiting for a rebuild.

### Reading it back

The Access tab does not read connections directly. `accessMapService` derives the
answer — for each person, every route by which they reach each repository — and
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

Three different things can start a sweep. All three run **the same code** — the
app has no checking logic of its own, which is what makes a sweep you started
identical to one the clock started.

```
  every 15 minutes ─────────────┐
                                │
  something in your AWS         │        ┌──────────────────────────────────┐
  account just changed ─────────┼───────▶│          the sweeper             │
                                │        │                                  │
  you press "Run" in the app ───┘        │  1. read your rules              │
                                         │  2. list what is really in the   │
                                         │     account — buckets, log       │
                                         │     groups, and so on            │
                                         │  3. judge each thing against     │
                                         │     each rule                    │
                                         │  4. write down every verdict     │
                                         │  5. fix it — only if that rule   │
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
| every 15 minutes | An EventBridge rule — an AWS timer pointed at the sweeper |
| something just changed | CloudTrail (AWS's own record of who did what) noticing one of six specific API calls — creating a bucket, changing a bucket policy, changing log retention — and firing the sweeper within seconds, for just that one thing |
| you press "Run" | The AWS tab's backend asking AWS to run the sweeper and waiting for the answer (`routes/awsGuardrails.ts`) |
| the sweeper | A Lambda: `github-control-hub-guardrail-enforcer`, 512 MB, 10-minute limit (`aws-guardrails/engine.ts` is the judging part) |
| your rules | A DynamoDB table, `github-control-hub-aws-guardrails` — one row per rule |
| every verdict | A DynamoDB table, `github-control-hub-aws-findings` — one row per rule-and-resource pair |
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
   rules read that one list — the ninth rule costs nothing extra. The list is
   kept per account *and* per region, because buckets in one region tell you
   nothing about another.
5. **Each resource is then judged twice.** First: is it on one of this rule's
   exclusion lists, by name or by tag? If so it is recorded as *not applicable*
   and skipped. Otherwise: does it pass the rule? The answer comes back as a
   verdict, a one-line summary, and — where a fix exists — a description of
   exactly what would be changed.
6. **Everything that passed is written down too, not just the failures.** Each
   verdict is stored under a key built from account, region, rule and resource,
   so the next sweep **overwrites** the same row rather than adding a second
   one. The table is the current state of your account, not a history: a bucket
   that was broken and is now fine has one row, saying fine.
7. **Report mode does everything except the fix.** It lists, excludes, judges,
   and writes down the fix it *would* have made. It just never makes it. Across
   your entire AWS account the sweeper can perform exactly three write
   operations — set a bucket policy, set a log retention, delete a log retention
   — and no IAM action of any kind.
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
   Eight S3 rules do not mean eight passes over every bucket — the buckets are
   listed once and all eight rules read that one list. This is a `ListBuckets`
   or `DescribeLogGroups` call and the `Get*` calls needed to see each one's
   configuration. Nothing reads the contents of anything.
3. **For each rule, for each resource, decide one of four verdicts:**
   - *excluded* — the resource is on one of the rule's exclusion lists, so it is
     recorded as not applicable and skipped
   - *compliant* — nothing to do
   - *violation, rule in report mode* — recorded, including the exact fix it
     would have made, and **nothing is changed**
   - *violation, rule in enforce mode* — the fix is applied
4. **Write every verdict** — compliant ones too — to the `aws-findings` table as
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
table holds the current state of the account, not a history — a bucket that was
in violation and is now compliant has one row, saying compliant.

History is the activity feed's job, and only real changes go there.

**Which code touches what:**

| File | Role |
|---|---|
| `aws-guardrails/handler.ts` | the Lambda. Loads rules, runs the engine, persists the result |
| `aws-guardrails/engine.ts` | the sweep itself — collect, evaluate, remediate |
| `aws-guardrails/store.ts` | **the only file that reads or writes the three tables** |
| `routes/awsGuardrails.ts` | the AWS tab: create, edit, delete rules; run or preview a sweep |

`store.ts` being the only reader and writer is deliberate: the Lambda and the app
both reach these tables, and one file owning the key format is what stops the two
disagreeing about what a finding's `sk` looks like.

**After a full sweep**, `store.ts` also deletes findings whose rule or resource no
longer exists. That runs only after a *full* sweep — a run scoped to one resource
has not rewritten the rows it would be deleting, so doing it there would erase
findings and replace them with nothing.

### Report and enforce

Every rule starts in report mode and is switched to enforce individually. A
report-mode rule is not a dry run of a switched-off feature — it does the full
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
watches for six specific API calls — `CreateBucket`, `PutBucketPolicy`,
`DeleteBucketPolicy`, `CreateLogGroup`, `PutRetentionPolicy`,
`DeleteRetentionPolicy` — and invokes the same function within seconds, scoped to
just the resource that changed.

Those events only exist if CloudTrail is recording. No trail means no fast path;
the sweep still catches everything, up to fifteen minutes later. Setup only
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
| send the email | The app publishes one message to an **SNS topic** — AWS's mailing list, one per email group — and AWS delivers it to everyone who confirmed their address |

1. **Five minutes is how often it *looks*, not how often each alarm is
   checked.** Every alarm carries its own interval — 10 minutes for the
   Dependabot-backed ones, 15 for everything else — and is checked on the first
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
6. **Where an alarm stands is stored on the alarm itself**, in the same write —
   its state, how many clean checks in a row, when it was last checked, what the
   value was. There is no separate state table, so there is no way for an alarm
   and its state to disagree.

### Setting one up

1. **You create an email group.** The app calls SNS to create a *topic* — AWS's
   fan-out mechanism — and writes a row to the `alarms` table with
   `kind: "group"` holding the group's name and the topic's ARN.
2. **You add addresses to it.** Each is subscribed to that SNS topic, and AWS
   emails the person a confirmation link. **Until they click it they receive
   nothing.** The app reads the member list back from SNS rather than from its
   own table, so an unconfirmed address shows as unconfirmed instead of looking
   like a working recipient.
3. **You create the alarm.** A row in the same table with `kind: "alarm"`,
   holding the widget it watches, the condition, the group to notify, the email
   templates, and its starting state — always `OK`, so creating an alarm never
   emails everyone the first time it runs.

### What the 5-minute tick does

The evaluator Lambda wakes every five minutes and, for each enabled alarm:

1. **Decides whether it is due.** Five minutes is the *tick*, not the interval —
   each alarm carries its own (10 minutes for Dependabot-backed widgets, 15 for
   everything else) and is evaluated on the first tick after it comes due. One
   rule serves every tiering, and a not-due alarm costs one row read.
2. **Computes the widget's current value**, which may mean a GitHub call or a
   read of the stored graph, depending on the widget.
3. **Compares it to the condition** — breaching, or not.
4. **Steps the state machine** and writes the result back:

   | Now | Was | Result |
   |---|---|---|
   | breaching | `OK` | → `ALARM`, **send the email** |
   | breaching | `ALARM` | stays `ALARM`, sends nothing — it already told you |
   | not breaching | `ALARM` | clean streak +1; at **2** clean checks → `OK`, send the recovery email |
   | not breaching | `OK` | nothing |

   Recovery waits for two clean checks while firing waits for none. That
   asymmetry is deliberate: a value resting exactly on its threshold would
   otherwise flip OK-ALARM-OK-ALARM and email every cycle, which teaches people
   to filter the alarm that mattered.
5. **Publishes to the group's SNS topic** if the state changed, and SNS delivers
   to every confirmed address on it.
6. **Writes the runtime back** — state, clean streak, last checked time, last
   value — onto the same alarm row. There is no separate state table: an alarm
   and its state are read and written together on every evaluation, and splitting
   them would buy a second round trip and a chance for the two to disagree.

### Editing an alarm

Changing **what** an alarm watches resets its state to `OK`. Otherwise an alarm
firing on "critical ≥ 1" that becomes "total ≥ 500" would stay in `ALARM` and
never email again, because the first breach under the new condition is not a
transition.

That comparison is structural, not string equality. DynamoDB returns a map's keys
in its own order, so comparing the stored condition as JSON text made *every*
save look like a condition change — renaming an alarm was enough to reset a
firing one and re-email everybody.

Only seven fields can be edited through the API. The table is shared by alarms,
groups, PR state and the security toggle, all keyed on `id`, so a request body
passed through wholesale could overwrite a *different kind of row* — an email
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
| `services/alarmService.ts` | reads and writes five of the six kinds — alarms, groups, PR state, the snapshot, security settings |
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
is one call. There is nothing to precompute because there is no walk — GitHub
answers in one round trip, and storing it would only create a copy that can be
wrong.

### The path

```
  you open the page ──▶ the app on your machine ──▶ GitHub ──▶ straight back
                                                                to the screen

  nothing is saved. no table, no timer, nothing to go stale.
```

1. **There is no server hop.** The desktop app runs the backend in-process on
   `localhost:4321`, so "live" here means exactly one network call — your
   machine to GitHub and back.
2. **Which token depends on the verb, not the route.** Reads use the GitHub
   App's installation token so everyone sees the same organization-wide picture;
   writes — enabling Dependabot, changing protection, creating a branch — use
   *your* OAuth token, so GitHub authorizes precisely what it would have
   authorized on github.com. The app never decides you may change a repository.
3. **Nothing is written down**, so there is no table, no expiry, and no staleness
   to reason about. The failure mode here is a slow page, never a wrong one.
4. **Vulnerabilities is the one with a trick in it.** Dependabot alerts are read
   **org-wide in a single paginated call** rather than per repository — one
   request instead of 350. Two consequences: a repository with no alerts is
   recorded as *alerts off* or *on and clean*, never collapsed into one number;
   and a sweep that could only read part of the organization returns `degraded`
   rather than a partial list, which any alarm reading it treats as no reading
   at all.

### The infrastructure

There isn't any, and that is the point — no table, no cache, no scheduled job.
The route builds an Octokit client from a token and returns what GitHub says.

| Page | Route | Reads |
|---|---|---|
| Repos | `routes/repos.ts` | `repos.listForOrg`, then per-repo detail on demand |
| Vulnerabilities | `routes/dependencies.ts` | `dependabot.listAlertsForOrg` |
| Org settings | `routes/org.ts` | `orgs.get`, `orgs.listCustomRepoRoles` |
| Who knows | `routes/expertise.ts` | commit and comment history |

**Which token** depends on what is being done. Reading uses the GitHub App's
token, so everyone sees the same organization-wide picture. **Writing** — enabling
Dependabot, changing protection, creating a branch — uses *your* token, so GitHub
authorizes exactly what it would have authorized had you done it on github.com.
The app never decides you may change a repository; it asks GitHub, as you.

**Vulnerabilities** is the one worth understanding. Dependabot alerts are read
**org-wide in a single call** rather than per repository, which is the difference
between one request and 350. Two details follow from that:

- A repository with no alerts is ambiguous — alerts might be switched off, or on
  and clean. Those are recorded as different things, so a clean repository never
  looks like a vanished one.
- If the sweep can only read part of the organization, it reports `degraded`
  rather than returning what it managed. An alarm reading a degraded sweep treats
  it as *no reading*, so an alarm cannot resolve itself because half the answer
  was missing.

---

## Compliance scores

**Shape: stored, refreshed on demand.**

A compliance score is one number per repository, from a set of rules you define —
"has a README", "has CODEOWNERS", "default branch is protected", and so on.

**Scoring one repository** means reading it from GitHub: its settings, its
branch protection, its rulesets, and a `getContent` call per required file to see
whether it exists. That is roughly six requests, so scoring 350 repositories is
about 2,000 — far too many to do while somebody waits.

So the score is computed and stored, one row per repository in the
`compliance-cache` table. Four things write it:

1. **The 6-hour graph rebuild**, which scores every repository as its last step.
   This is the normal path and why scores are usually current without anyone
   doing anything.
2. **Refresh on the dashboard**, which rescores every repository now.
3. **Refresh on one repository**, which rescores just that one — a few requests
   rather than thousands.
4. **A webhook that changes what a score measures** — branch protection, a
   ruleset, a membership, a repository being created, or a push to the default
   branch. The worker rescores that repository alone, so the dashboard is
   current for the thing that just changed without waiting for the rebuild.

### The path

Four writers, one row per repository, one reader.

```
  FOUR THINGS ASK FOR A RESCORE

  the 6-hour rebuild, as its last step ─────┐
  you press Refresh on the dashboard ───────┤
  you press Refresh on one repository ──────┼──▶ score it: ask GitHub about
  GitHub reports a change that would        │    that repository — its settings,
  affect a score ───────────────────────────┘    its protection, whether the
   (protection, a ruleset, a member,             required files exist
    a new repo, a push to the main branch)                  │
                                                            ▼
                                              save one row per repository,
                                              replacing whatever was there
                                                            │
                                                            ▼
                                                   the dashboard reads it
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| score it | About six GitHub calls per repository (`services/complianceService.ts`) — which is why 350 repositories is ~2,000 calls and never done while you wait |
| one row per repository | The `github-control-hub-compliance-cache` table, keyed on the repository's name |
| GitHub reports a change | A webhook, handled by `github-control-hub-webhook-worker` |

1. **Scoring one repository is about six GitHub calls**: `repos.get` for its
   settings, branch protection, a ruleset detail request per ruleset, a
   `getContent` per required file to see whether it exists, and
   `listCollaborators` for the outside-collaborator count. Times 350
   repositories that is roughly 2,000 requests, which is why nobody waits for it.
2. **The 6-hour rebuild is the normal path** — `refreshAll` is the last step of
   the same walk that rebuilds the graph, which is why scores are usually
   current without anyone pressing anything.
3. **The webhook path keeps one repository current in between.** The worker
   checks the event against a small list — `branch_protection_rule`,
   `repository_ruleset`, `member`, `repository` created, or a push to the
   default branch — and calls `refreshRepo` for that repository alone, as
   best-effort background work inside the invocation.
4. **All four writers end at the same single write, filed under the repository's
   name.** Rescoring replaces that row outright — nothing to merge, no partial
   update, and no way to end up holding two different scores for one
   repository.
5. **`complianceCacheService` is the only module that reads or writes the
   table.** `complianceService` computes and returns a score and never persists
   one.
6. **Changing the rules rescores nothing.** The rules live in `org-config` and
   the stored scores were computed under the old ones, so a rule change is
   normally followed by a dashboard refresh.

### The infrastructure

**Table:** `github-control-hub-compliance-cache`, keyed on `repo`. One row per
repository:

```
repo                  "payments-api"
score                 82
protectionsActive     true
rulesetsActive        false
hasRequiredFiles      true
outsideCollaborators  2
issues                ["No CODEOWNERS file"]
lastChecked           "2026-08-20T03:00:11Z"
```

Keyed on the repository name rather than an id, so rescoring one repository is a
single `PutItem` that replaces its row — there is nothing to reconcile and no way
to end up with two scores for one repository.

**Which code touches it:**

| File | Role |
|---|---|
| `services/complianceService.ts` | does the scoring — the ~6 GitHub calls per repository |
| `services/complianceCacheService.ts` | **the only reader and writer of the table** — `refreshAll`, `refreshRepo`, `getCachedScores` |
| `services/complianceConfigService.ts` | the rules, in `org-config` |
| `jobs/graphAggregator.ts` | calls `refreshAll` as the last step of every rebuild |
| `routes/compliance.ts` | the dashboard and its two refresh buttons |

The **rules themselves** live in `org-config` and are edited in the app by
`control-hub-admins`. Changing them does not rescore anything: the stored scores
were computed under the old rules until something recomputes them, so a rule
change is usually followed by a dashboard refresh.

---

## Security checks (the widget queries)

**Shape: two kinds — some answer instantly, some are built up over time.**

A widget on the Overview page runs a *check*: "repositories with no branch
protection", "people with admin nobody explains", and so on.

**Most read the stored graph** and answer immediately. The graph is already in
DynamoDB, so this is one scan and some filtering — no GitHub call, and no waiting.

**Some cannot be answered in one go.** A check like "which accounts have committed
in the last 90 days" needs one GitHub search *per subject*, and GitHub allows
thirty searches a minute. Two hundred and fifty accounts cannot be checked in one
request no matter how patient you are.

Those work differently:

1. Each pass checks as many subjects as the rate limit allows.
2. Each answer is stored as its own row in the `alarms` table
   (`kind: "query-subject"`), expiring after 24 hours.
3. The check reports its coverage — *"checked 25 of 250"* — rather than a number
   that is only partly true.
4. Later passes fill in the rest, and the card completes over several minutes.

### The path

Two, and the card tells you which one it is on.

```
  MOST CHECKS — answered immediately

  the widget ──▶ read the stored connections ──▶ filter them ──▶ the answer
                 (no GitHub call at all)

  THREE CHECKS — built up over several minutes

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
| a batch | 25 subjects for the search-based check, 50 for the others — sized to GitHub's limits, which are 30 searches a **minute** but 15,000 ordinary calls an **hour** |

1. **Most checks never leave your own database.** The connections are already
   stored, so the check is one read of them and some filtering — no GitHub call
   and nothing to wait for.
2. **Three checks cost one GitHub call per subject**, which is what makes them
   different: `dormant-privileged-users` runs a commit search per privileged
   account; `stale-branch-protections` and `protection-bypasses-ranking` read
   protection and merged pull requests per repository.
3. **The batch size is the rate-limit budget, declared per check.**
   `dormant-privileged-users` is `{ budget: "search", gapMs: 61_000, perPass: 25 }`
   — search allows thirty requests a *minute*, so twenty-five is one batch and a
   second inside the same minute would be over the line, hence the 61-second
   gap. The two protection checks spend the core allowance (15,000 an hour) and
   run 50 a pass, seconds apart.
4. **Subjects are picked never-checked first, then oldest-first**, so coverage
   completes rather than re-asking about the same accounts.
5. **"Checked and clean" is stored as a verdict**, not left out. Without it a
   clean subject would be indistinguishable from one never reached and coverage
   could never reach 100%.
6. **Nothing is reported until coverage is complete.** While it builds, the card
   says *"checked 25 of 250"* rather than a number that is only partly true —
   the only place in the app that deliberately shows an incomplete answer, and
   it says so.
7. **An answer counts for 24 hours, and that is checked when it is read** rather
   than trusted to the expiry. DynamoDB deletes late — often days late — and a
   row still sitting there is not the same as an answer still worth having.

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
server-side** — on a large organization there are hundreds of them, and every
alarm pass would otherwise page through a cache it never reads.

**Which code touches it:**

| File | Role |
|---|---|
| `services/queryCacheService.ts` | verdict storage, the per-check budgets, the throttle |
| `services/graphService.ts` | `evaluateSecurityQuery` — runs a check, cached or direct |
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

## Security alerts

**Shape: push.** Nothing here is computed or scanned. Every row on the Security
tab's alert list exists because GitHub sent a webhook saying something changed.

This is a different mechanism from the checks above, on the same page. The
checks answer *what is true now*, by querying the stored graph. The alerts
answer *what changed, and when* — and they can only know what GitHub told them.

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
                 the Security tab shows it
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| the front door | API Gateway — the only address anything outside your AWS account can reach. It only accepts requests from GitHub's four published address ranges, and that check happens before any code runs |
| the signature | GitHub signs each message with a shared secret. The doorman recomputes the signature and compares |
| the doorman | A Lambda: `github-control-hub-webhook-receiver`, 256 MB, 8-second limit. It can reach exactly two things — the secret it needs, and the waiting line |
| the waiting line | An SQS queue. Five failed attempts and the message moves to a dead-letter queue instead of being lost |
| the handler | A Lambda: `github-control-hub-webhook-worker`, 512 MB, 10-minute limit (`webhooks/processDelivery.ts` is the matching part) |
| "already handled this one?" | A row written in the `github-control-hub-webhook-deliveries` table, written only if it is not already there — so a message delivered twice is handled once |
| an alert | A row in the `github-control-hub-alerts` table |

1. **The only reason this works is that the app asked GitHub to tell it.** The
   GitHub App is subscribed to team events. Nothing scans for this, so if that
   subscription is off, nothing is ever flagged and nothing looks wrong.
2. **There is no rules engine and no inference.** The handler compares two
   strings — the event is `team`, the action is `added_to_repository` — and
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
   alert is already stored, and a failure there is logged and dropped —
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

**Some alerts clear themselves and some do not.** `repo_made_public` resolves
when the repository is made private again, `protection_removed` when a rule is
recreated, `admin_added` when the member is removed. `team_added` has no such
partner — removing the team writes a *second* alert rather than resolving the
first. The `alerts` table has no TTL either, so these accumulate until somebody
resolves them by hand.

**An alert does not touch the access graph.** The worker updates connections for
branches, collaborators and protection, but not for teams — so the alert appears
in seconds while the Access map still shows the team's old connections until the 6-hour
rebuild.

**A lost delivery is lost.** Rejected at the gateway, GitHub retries for a while
and gives up, and nothing back-fills it. The team's access will surface on the
Access map at the next rebuild, but no alert is ever created for it. The Activity
page's *Receiving events / Quiet / Stale* indicator is the only sign the feed has
gone silent.

## Activity feed

**Shape: stored, append-only.** Nothing here is ever recomputed — each row is
written once, when the thing happened, and read back later.

### What writes a row

| Writer | When |
|---|---|
| Any route that changes something | as it changes it — branch protection, a widget, a scanner, a ruleset |
| The guardrail Lambda | when a rule **actually fixed** something, or failed trying |
| The webhook worker | when GitHub reports a change somebody made on github.com |
| The audit ingest Lambda | when GitHub delivers an enterprise audit-log batch |
| Any sync | when a refresh, sweep or re-check runs |

### The path

Five things write to it. Nothing ever rewrites a row: each one is written once,
when the thing happened, and read back later.

```
  anything in the app that changes something ─┐
  the webhook handler, when GitHub reports    │
    a change somebody made on github.com ─────┤
  the AWS sweeper, when a rule actually       ├──▶ one long list, newest first
    fixed something ──────────────────────────┤    every row expires after
  the audit-log reader ─────────────────────  ┤    13 months
  any refresh, sweep or re-check ─────────────┘              │
                                                             ▼
                                                     the Activity tab
                                                             │
                                            some rows carry the opposite of
                                            what was done — that is Undo
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| one long list | The `github-control-hub-activity` table. Every row is filed under the same single key so the whole feed can be read newest-first in one go, without searching |
| newest first | The row's sort key starts with the time, so the database is already holding them in the order the page wants |
| Undo | The row stores what would reverse the action. Pressing Undo replays that **using your own GitHub login**, so GitHub decides whether you may — the app does not |

1. **Every row is filed under the same single key**, which is what lets the whole
   feed be read newest-first in one go. The part that orders them starts with
   the time, so the database is already holding them in the order the page
   wants — it never has to search through everything to build the list.
2. **The AWS sweeper writes its rows itself**, rather than going through the
   shared code every other writer uses — the one exception, and deliberate. It
   is packaged on its own, and reusing that code would drag the entire app into
   that function. The catch is that it has to stamp the 13-month expiry itself,
   and a row written without one would sit there for ever.
3. **`id-index` exists because undo needs a row by its id.** Without it,
   `getActivityById` falls back to reading the newest rows and filtering, which
   answers "is it recent?" rather than "does it exist?" — correct on a small
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
| `id-index` | Undo needs to find one row *by its id*. Without this, `getActivityById` falls back to reading the newest rows and filtering — which answers "is it recent?" rather than "does it exist?" Correct on a small log, silently wrong on a large one |
| `parentId-index` | Finding a row's children. Sparse: only child rows carry `parentId`, so the index holds exactly those |

**Which code touches it:**

| File | Role |
|---|---|
| `services/activityService.ts` | `logActivity`, `logSync`, and every read — **the app's only writer** |
| `aws-guardrails/handler.ts` | writes rows **directly**, bypassing the service |
| `audit/ingest.ts` | writes enterprise audit-log rows |
| `routes/activity.ts` | the tab, plus undo, redo and retry |

The guardrail Lambda writing directly is the one exception, and deliberate: it is
bundled on its own and importing the service would pull the whole app into that
function. It inlines the retention stamp instead, with a comment saying it must
match — a row without a TTL is a row that never expires.

### The four streams

Rows are sorted into Organization, AWS, App settings and Audit log by the prefix
of their action name — `branch.` and `repository.` are organization changes,
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

A row can carry an *undo payload* — the inverse of what was done. Undo replays it
**using the caller's own GitHub token**, so GitHub authorizes it exactly as it
would have authorized the original action. The app is not deciding you may
reverse something; GitHub is, on the same terms as when you did it.

## Enterprise audit log

**Shape: push, from S3.** The only feature whose data arrives as a file rather
than as an API response, and the only Lambda in the stack with no schedule at
all.

### The path

```
  GitHub uploads a file of audit events to your S3 bucket
  (no AWS password is stored on GitHub — it gets a temporary
   one for each upload)
        │
        ▼
  the file landing IS the trigger ──▶ the reader wakes up
  (no timer, nothing polling)          (a Lambda)
                                            │
                                            ▼
                              unzip it, read it line by line,
                              keep the events that matter
                                            │
                                            ▼
                              add them to the activity feed,
                              25 at a time
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| your S3 bucket | File storage. The raw files are kept for 400 days and moved to cheaper storage after 30, and deleting the stack will not delete them |
| the trigger | An S3 notification. This is the only Lambda here with no timer behind it — a quiet month costs nothing |
| the reader | A Lambda: `github-control-hub-audit-ingest`, 512 MB, 5-minute limit. It can read the bucket and add rows to one table, and nothing else — it cannot even read the feed back |
| the events that matter | A configurable list. Anything ending in a dot matches a whole family, so `repo.` catches everything about repositories |

1. **GitHub authenticates with OIDC, not an access key.** A key pair would mean
   long-lived AWS credentials stored on GitHub for the bucket holding the record
   of who did what. OIDC hands GitHub a temporary credential per upload and
   stores nothing. The provider and the role GitHub assumes are created from the
   Activity page, not by a flag documented in a code comment.
2. **S3 invokes the function per object**, through an `ObjectCreated`
   notification on the bucket. Nothing polls and nothing is scheduled — a quiet
   enterprise costs nothing at all, and this is the only Lambda in the stack
   with no EventBridge rule behind it.
3. **One object is a batch of events**, gzipped newline-delimited JSON. The
   handler `GetObject`s it, `gunzipSync`es it, splits on newlines and parses each
   line. The 5-minute ceiling exists so a large object on a busy enterprise is
   never cut off part way, because a truncated batch silently loses audit rows.
4. **The filter is a prefix match, changeable without a code change.**
   `isConsequential` tests each action against an allow-list in which an entry
   ending in `.` matches by prefix — `repo.` catches everything under it — and
   anything else matches exactly. The `AUDIT_EVENT_ALLOWLIST` environment
   variable overrides the built-in list; empty means the built-in one.
5. **Each row's id is a SHA-256 of the event's own fields**, base64url-encoded,
   cut to 40 characters and prefixed `audit-`. Hashing rather than concatenating
   is what makes it both *stable* — replaying an object overwrites the same rows
   instead of duplicating them — and *distinct*, which the old
   truncated-concatenation id was not: an ISO timestamp ate 25 of its 30 bytes,
   so the actor and the repository never reached the id at all and a bulk
   operation's events collided.
6. **Rows are added 25 at a time**, which is DynamoDB's limit per batch, and
   whatever the database says it did not take is retried. It reports that as a
   list rather than as an error, so ignoring it would drop audit rows in
   silence.
7. **The 13-month expiry is counted from when the event happened**, not from when
   the file was read. Re-uploading an old file therefore does not give ancient
   events another thirteen months of life.
8. **The raw object stays in S3, untouched.** That is the complete record; this
   only builds an index over the part anyone reads, which is why widening the
   filter later loses nothing that already arrived.

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
              activity feed   connections   security alert   rescore that
                                                             repository
```

**What each box really is:**

| In the diagram | What it is |
|---|---|
| the front door | API Gateway. Only GitHub's four published address ranges are allowed, enforced before any code runs, with a firewall in front of that |
| the doorman | A Lambda: `github-control-hub-webhook-receiver`, 256 MB, 8-second limit — deliberately under GitHub's 10-second cutoff, because past that nobody is listening for the answer |
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
3. **If a rotation changes the secret, it retries once with a fresh copy** —
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
7. **One message can write to four different places** — the activity feed, the
   access connections, an alert, a rescore. All of it is finished *inside* the
   handler rather than left running afterwards, because AWS freezes the function
   the moment it returns and unfinished work would simply never happen.

### Why the split

The receiver is the only thing in this app reachable from the internet. It holds
a key to the webhook secret **and nothing else** — no GitHub App key, no database
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
| `webhooks/deliveryLock.ts` | **the only file touching the deliveries table** — `claimDelivery`, `completeDelivery`, `releaseDelivery` |
| `webhooks/worker.ts` | the queue-driven Lambda |
| `webhooks/processDelivery.ts` | decides what each event means, and writes the consequences |

**What the worker writes** is not one table but several: rows in `activity`,
updated connections in `graph-edges`, and buffered notifications
in `alarms` via `alarms/feedNotify.ts`, for the evaluator to flush on its next tick. A single push
event can touch all three.

### When something goes wrong

A delivery rejected at the API Gateway is **lost** — GitHub sees the failure, and
the Activity page will show as stale within 72 hours. A delivery that reached the
queue and then failed is **retried**, and after five attempts lands in a
dead-letter queue rather than vanishing.

### Which events

Ten are subscribed: pushes, repositories, branch or tag creation and deletion,
branch protection rules, repository rulesets, collaborator changes, teams, pull
requests, and Dependabot alerts.

`organization` and `issues` are deliberately **not** among them. Nothing in the
worker handles either, so ticking them means GitHub sends a delivery, API Gateway
accepts it, the receiver verifies it, the queue holds it, and the worker drops
it — the whole path, for nothing.

## Sign-in and permissions

**Shape: live, cached for a minute.**

### Signing in

1. You connect **AWS** first, with your own credentials — a profile, SSO, or
   pasted keys. Nothing else can happen until this works, because the GitHub
   credentials live in Secrets Manager in your AWS account.
2. The app reads that secret and loads the OAuth credentials into its process.
3. You click **Sign in with GitHub**, which redirects to GitHub, and back to
   `localhost:4321/auth/callback` with a code. The app exchanges the code for a
   token, and issues you a session.

The OAuth callback is `localhost` because the desktop app runs its own backend on
your machine. The code comes back to you and never transits a shared server —
which is also why one OAuth App serves every AWS account.

**Switching AWS accounts re-reads the secret** and clears any credential the new
account's secret does not set, so an account with no GitHub App never inherits
another account's. You stay signed in across the switch, and the GitHub tabs
appear or disappear according to what the account you moved to holds.

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
| the GitHub credentials | Kept in AWS Secrets Manager, which is why AWS has to work first — an AWS account holding no GitHub credentials simply has no GitHub tabs |
| back to the app on your own machine | GitHub returns you to `localhost`, because the desktop app is its own backend. The code never passes through a shared server, which is also why one set of GitHub sign-in credentials can serve every AWS account |
| the one-time ticket | A row in the `github-control-hub-auth-codes` table, deleted the moment it is used and expiring by itself otherwise |
| are you on the team | Checked against GitHub and remembered for 60 seconds, in memory only — it vanishes on restart, which is correct for something that is a shortcut rather than a record |
| switching accounts | `components/AwsAccountSwitcher.tsx` in the navbar, calling the same endpoints the sign-in screen uses |

**Your session is yours, not the account's.** The key that signs it is read from
each AWS account's secret, so a session minted in dev stops verifying the moment
uat's secrets load — which used to sign you out for the crime of changing an AWS
setting. The switch now captures the session *before* the credentials move and
re-signs it after, keeping the original expiry: a switch every few minutes must
not be a session that never ends. Two consequences worth knowing:

- **The membership check is skipped where it cannot be answered.** Every request
  re-asks GitHub whether you are still in the organization. An account with no
  GitHub credentials has no organization configured, so asking throws — and the
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
  finding, and the cached AWS health verdict. The client was the one that bit —
  the AWS tab showed whichever account was signed into *first*, in both
  directions, and refreshing could not help because every refresh asked the same
  stale client. `utils/awsAccountChange.ts` is now the one list of them, and a
  test fails if a module grows another and is not added to it.
- **The window reloads.** Clearing the query cache is not enough: every mounted
  page also holds state describing the account being left — a selected activity
  stream, an expanded row, a filter. A switch is rare and deliberate, so it
  gives you the state signing in to that account would, rather than a careful
  reconstruction of it that is wrong in one place nobody checks.

1. **Nothing GitHub-shaped can happen until AWS works**, because the GitHub
   credentials live in Secrets Manager in your account. An account whose secret
   holds none refuses every GitHub route and shows only the AWS and Activity
   tabs — keeping GitHub out of an account *is* keeping its credentials out of
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
5. **Team membership is cached in a module-level `Map`** — in the process, not
   in DynamoDB — keyed per team *and* per user, for 60 seconds. It disappears on
   restart, which is correct: it is an optimisation, not a record.
6. **A denial caused by a missing token is never cached.** That is a fact about
   the app, not about the person; caching it meant a credential problem lasting
   a second locked somebody out for a minute after it healed.
7. **Membership is normally read with the App's token**, because you cannot
   necessarily see a team you are not in. Where there is no App it falls back to
   your own token's `read:org` — safe precisely because it is narrower: with
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
redeemed** — the delete itself is the redemption, so a code cannot be used twice
even if two requests arrive at once. Anything left behind expires by TTL.

**Team membership is cached in memory**, not in DynamoDB: a `Map` in
`authorizationService`, keyed per team **and** per user, holding each answer for
60 seconds. It is per process, so it disappears on restart, which is correct —
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
| `middleware/githubGate.ts` | refuses GitHub routes in an account that should not have them |

### What you are allowed to change

Team membership decides it:

| Team | Controls |
|---|---|
| `control-hub-admins` | everything GitHub-side |
| `aws-guardrail-admins` | AWS rules, sweeps, enforce mode, audit-log streaming |

Org owners qualify for both, as a safety net against an empty or deleted team.
Membership answers are cached for 60 seconds, keyed per team **and** per user. A
denial caused by a missing token is never cached — that is a fact about the app,
not about the person.

Membership is normally read with the App's token, because a user cannot
necessarily see a team they are not in. Where there is no App — an account running
the guardrails and holding no GitHub App key — it falls back to the caller's own
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
credentials anyway. Activity is not gated — it filters itself to AWS rows, because
an account running guardrails needs the record of what they did.

---

## Where the code runs

| | |
|---|---|
| Desktop app | the whole backend, in-process, on `localhost:4321`, using your AWS credentials |
| Lambda | six functions: guardrails, webhook receiver, webhook worker, alarm evaluator, graph aggregator, audit ingest |

The same backend is compiled once and started both ways. What differs is who it
authenticates as and what triggers it.
