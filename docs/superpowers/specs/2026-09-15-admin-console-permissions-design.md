# Admin console and fine-grained permissions: design

**Date:** 2026-09-15
**Status:** proposed, not implemented
**Supersedes in part:** [2026-08-10-permissions-design.md](2026-08-10-permissions-design.md)
— that document's central rule is unchanged and is restated below. What changes
is the second half: how the app decides its *own* settings.

## The problem

Authority in this app is currently one bit wide, twice over. You are on
`control-hub-admins` or you are not; you are on `aws-guardrail-admins` or you
are not. Everything else follows from those two booleans.

That is too coarse in both directions at once. Somebody who should be able to
create an alarm must be handed the whole of Scanners, Widgets, config import
and the access map to get it. Somebody who should be able to read the Activity
log must be able to undo from it. And a person who needs one screen either gets
a team membership that grants twenty, or gets nothing.

It is also invisible. Membership lives on GitHub, the consequences live here,
and nothing on either side says what the other will do.

## What this changes, and what it must not

**Unchanged — the rule from the August design:**

> The app must not let anyone do something they could not do themselves on
> github.com.

Repository actions — branches, protection, rulesets, Dependabot toggles,
repository reads — are made with the signed-in user's own OAuth token, and
GitHub authorizes them natively. That is not a permission check we perform; it
is a permission check we *delegate*, and delegation cannot drift because it is
not a copy.

**This design does not touch that.** `branches.ts`, `protection.ts`, `repos.ts`
and `dependencies.ts` remain exactly as they are, and remain exempt in
`repro-undo.ts`'s inventory with their existing reasons. A permission in this
system can never make GitHub allow something, and must never be used to reach a
repository action GitHub would refuse.

**Changed — everything GitHub has never heard of.** Scanners, widgets, alarms,
email groups, AWS guardrails, activity visibility and undo, config
import/export, pull-request reminder settings, detailed logging. These have no
natural authority, which is precisely why they were given an artificial one.
They get a real permission model instead.

## Decisions taken before design

These were settled with the product owner and are load-bearing. Everything below
follows from them.

| Decision | Choice |
|---|---|
| **Scope** | App concepts only. Repo actions stay with GitHub. |
| **Failure mode** | Fail closed, with no cached fallback. Organization owners exempt. |
| **Trust model** | The repo is the source of truth, and is locked down so only the App can commit. |
| **Default grant** | Deny by default. A person with no entry has *nothing* — including reading, and including their own personal screens. |
| **Granularity** | A permission for every action, reads included. Grouped into a tree so a branch can be granted in one click, with every individual leaf still togglable. |
| **Assignment** | Presets assignable to people *and* to GitHub teams, as the lowest of three layers. |

Two of these have consequences that are not optional and are designed for
rather than discovered.

**Deny by default means switching this on locks the whole organization out**
until the file names them. Handled as an explicit migration step with a dry-run
diff, never as a deploy side-effect.

**Fail closed with no fallback means a GitHub outage stops the app** for
everybody except organization owners, including the AWS half, which does not
otherwise depend on GitHub. Accepted explicitly, so that a cached grant can
never outlive the file that granted it.

## The two teams become one

`control-hub-admins` stops meaning "can change org-wide settings" and comes to
mean exactly one thing: **who can open the Admin tab.** It is the only
membership the app reads, and it is the root of the permission tree rather than
a branch of it.

`aws-guardrail-admins` is removed. Everything it gated becomes permissions
(`aws.rules.*`, `aws.sweep.run`, `aws.exclusions.*`,
`activity.detailedLogging.manage`). The team itself is left in place on GitHub
for the org to delete when ready; the app simply stops reading it, and
`AWS_ADMIN_TEAM` stops being consulted.

This is a reduction in the number of things that confer authority, which is the
point. Two teams plus a permission file would be three sources of truth.

## The vocabulary

**Reading is a permission.** Every tab, every panel. A person with no entry
cannot read anything — not the Activity log, not the access map, not a
repository list, not their own queue. This reverses the *"reading is open"*
rule in `docs/auth/permissions-model.md`, which must be updated when this
ships.

### Leaves and branches

The canonical permissions are the **leaves**. Only a leaf is ever checked by
`requirePermission`, and only a leaf may appear in a route declaration.

The dots are not decoration — they are the group tree. `alarms.org.create` sits
under `alarms.org`, which sits under `alarms`. **A grant or a revoke may name
any node, at any depth**, and means every leaf beneath it. So:

| Entry | Means |
|---|---|
| `alarms` | every alarms permission |
| `alarms.org` | the four org-alarm permissions |
| `alarms.org.create` | exactly one |

This is what makes ~120 permissions assignable without ticking 120 boxes, while
leaving every individual box tickable. There is no separate "group" concept to
keep in sync with the permission list: the tree *is* the list, read at a
different depth.

### The tree

```
me                              My work — all of it is about you and nobody else
  me.work.read                    Your queue: your PRs, reviews, checks
  me.push.check                   "Why can't I push"
  me.repos.read                   Your own repository list
  me.alerts.read                  Your notification settings
  me.alerts.manage                Change them
  me.alerts.test                  Send yourself a test
  me.alarms.read                  Your own alarms
  me.alarms.manage                Create, edit, delete them
  me.destination.read             Your own email / Teams destination
  me.destination.manage
  me.widgets.read                 Your own cards
  me.widgets.manage

overview                        The Overview tab
  overview.read                   Open it at all
  overview.cards.read             The cards on it
  overview.freshness.read         Query freshness indicators
  overview.refresh                Force a query to refresh now

activity                        The Activity tab
  activity.read.own               Rows where you are the actor
  activity.read.app.rows          That something happened — actor redacted
  activity.read.app.actor         Who did it                          ← issue #5
  activity.read.github            Rows from GitHub webhooks
  activity.pulse.read             The pulse chart
  activity.undo.repo              Undo a repository action
  activity.undo.app               Undo an app-config action
  activity.undo.aws               Undo an AWS action
  activity.retry                  Retry a failed action
  activity.resolution.undo        Undo a conflict resolution
  activity.detailedLogging.read
  activity.detailedLogging.manage

alarms                          The Alarms tab
  alarms.org.read                 Org-wide alarms
  alarms.org.create
  alarms.org.edit
  alarms.org.delete
  alarms.groups.read              Email groups
  alarms.groups.manage
  alarms.groups.test
  alarms.teamsFlow.read           The shared Teams webhook
  alarms.teamsFlow.manage
  alarms.security.read            Security-alert settings
  alarms.security.manage
  alarms.feeds.read               Per-feed notification settings
  alarms.feeds.manage

aws                             The AWS tab
  aws.read                        Open it at all
  aws.rules.read
  aws.rules.create
  aws.rules.edit
  aws.rules.delete
  aws.rules.enforce               Move a rule from report into enforce
  aws.findings.read
  aws.sweep.run
  aws.remediate                   Fix a finding
  aws.preview                     Preview a remediation
  aws.exclusions.read
  aws.exclusions.manage
  aws.accounts.read
  aws.costs.read

access                          The Access tab
  access.read                     Open it at all
  access.people.read              By person
  access.teams.read               By team
  access.repos.read               By repository
  access.refresh                  Force a recrawl

deps                            The Vulnerabilities tab
  deps.read                       Open it at all
  deps.advisories.read
  deps.age.read
  deps.dependabot.read
  deps.dependabot.manage          Enable / disable on a repository
  deps.dependabot.bulk            Bulk operations, close PRs
  deps.renovate.read
  deps.renovate.manage            The bot name, dashboard ticks

repos                           The Repos tab
  repos.read                      Open it at all
  repos.detail.read               One repository's detail
  repos.blastRadius.read
  repos.query.read                Saved graph queries
  repos.query.refresh
  repos.graph.rebuild             Re-aggregate the whole graph

pulls                           The Pull requests tab
  pulls.read                      Open it at all
  pulls.state.read
  pulls.mutes.read
  pulls.mute                      Mute a reminder
  pulls.pause                     Pause reminders for everyone
  pulls.settings.read
  pulls.settings.manage
  pulls.run                       Run the reminder pass now

expertise                       The Who knows tab
  expertise.read                  Open it at all
  expertise.repo.read
  expertise.path.read
  expertise.library.read

org                             Organization-level reads
  org.members.read
  org.config.read
  org.webhookHealth.read
  org.budget.read                 The GitHub API budget

config                          Import and export
  config.export
  config.import

admin                           The Admin tab
  admin.console.open              Open it at all
  admin.people.read               See who has what
  admin.people.assign             Assign a preset
  admin.people.override           Toggle one permission on one person
  admin.presets.read
  admin.presets.create
  admin.presets.edit
  admin.presets.delete
  admin.audit.read                The change history of the file
```

**101 leaves, 13 top-level branches.** `admin.console.open` is
deliberately not sufficient to change anything — a read-only auditor is a real
role.

### Redaction is a permission, not a mode

`activity.read.app` is a **branch**, not a leaf. Under it:

| Held | Sees |
|---|---|
| nothing | no rows by anybody else at all |
| `activity.read.app.rows` | *"A scanner was deleted, 20 minutes ago"* |
| the branch (both leaves) | *"…by some-login"* |

This is why no node in this vocabulary is both a leaf and a branch. Had
`activity.read.app` been a checkable leaf *and* the parent of `.actor`,
granting it would have meant two different things depending on who was asking,
and the tri-state checkbox in the UI would have had nothing coherent to show.
The rule is now explicit: **a node is a group or a permission, never both.**

The middle row is the useful one. It keeps Activity answering *"has anything
changed here recently"* — which is most of why people open it — without
answering *"what is my colleague doing"*, which is most of why you would
restrict it.

### Overview must not be a side channel

The Overview tab reads data belonging to seven other tabs: alarms,
dependencies, the graph, repositories, security queries, org config. A
dashboard that aggregates everything is the classic way a permission system
leaks — you cannot open the Vulnerabilities tab, but a card on Overview shows
you its numbers.

So `overview.read` opens the tab and **nothing more**. Every card additionally
requires the read permission of the data it displays, and a card whose data you
may not read is *absent*, not empty — an empty card invites somebody to report a
bug. The same rule applies anywhere one screen surfaces another's data.

### Two that are necessary but never sufficient

`activity.undo.repo` does not let you undo a repository action. It lets you
*ask*; `denyIfNotPermitted` then runs `assertWritable` with your own token and
GitHub decides. Both must agree, and only one of them is ours.

`config.import` requires the permission for **every section present in the
bundle**. An export carries scanners, widgets *and* AWS guardrails in one file,
so without that rule import is a way around every other gate — a hole this
codebase has already found once.

### One that the route cannot decide

`alarms.ts` already contains `refusedForSubject`, which picks the authority
from what the alarm *watches*: an alarm on a guardrail is an AWS change. Kept
and re-expressed — such an alarm additionally requires `aws.rules.edit`. This is
the one place the capability object (approach C) is used instead of middleware,
because the subject is not known until the body or the stored record is read.

## The file

`control-hub-permissions`, private, in the org. One file:
`permissions.json`.

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-15T14:02:11Z",
  "updatedBy": "someone",

  "presets": {
    "engineer": {
      "name": "Engineer",
      "description": "Own work, read-only elsewhere",
      "grant": ["me", "activity.read.own", "repos.read", "pulls.read"],
      "revoke": []
    },
    "alarms-admin": {
      "name": "Alarms administrator",
      "inherits": "engineer",
      "grant": ["alarms"],
      "revoke": ["alarms.org.delete"]
    }
  },

  "teams": {
    "platform-engineers": {
      "presets": ["engineer"],
      "grant": ["repos.graph.rebuild"],
      "revoke": []
    },
    "contractors": {
      "presets": [],
      "grant": ["me", "pulls.read"],
      "revoke": ["access", "org"]
    }
  },

  "people": {
    "some-login": {
      "id": 1234567,
      "presets": ["alarms-admin"],
      "grant": ["config.export", "aws.findings.read"],
      "revoke": ["alarms.groups"],
      "note": "Owns the release alarms. No delete, by request.",
      "updatedAt": "2026-09-15T14:02:11Z",
      "updatedBy": "someone-else"
    }
  }
}
```

Every string in a `grant` or `revoke` is a **node**, not necessarily a leaf.
`"me"` is twelve permissions; `"alarms.org.delete"` is one.

### Effective permissions: most specific wins

Permissions come from three **layers**, in increasing authority:

1. **Teams** — every GitHub team the person is in, via `teams` above.
2. **Their presets** — via `people[login].presets`.
3. **Their own entries** — `people[login].grant` and `.revoke`.

For each leaf in the vocabulary, collect every entry across all three layers
that is that leaf or an ancestor of it. **The longest match decides.** Ties
break in this order:

1. The higher layer wins: a person's own entry beats their preset, which beats
   a team's.
2. Between a preset and the preset it inherits from, the child wins.
3. At equal depth and layer — including two different teams disagreeing —
   **revoke beats grant.**

A leaf matched by nothing at all is denied, because the default is deny.

This is the rule rather than "union the grants, then subtract the revokes",
because the blanket version cannot express the second of these two, and both
are things somebody will want on their first afternoon:

| Written as | Means |
|---|---|
| `grant: ["alarms"]`, `revoke: ["alarms.org.delete"]` | all alarms except deleting one |
| `revoke: ["aws"]`, `grant: ["aws.findings.read"]` | no AWS at all, except seeing findings |

Under subtract-last the second silently yields nothing, and the person who
wrote it has no way to tell from the file that it did not work.

### What team assignment costs

Two consequences worth stating rather than meeting later.

**Joining a team can take access away.** `contractors` above revokes `access`
and `org`; somebody added to it loses those unless they hold a longer-matching
grant of their own. That is genuinely useful and genuinely surprising, so the
person screen shows team-derived entries with the team's name attached, and the
dry-run diff (migration, below) covers team changes as well as file changes.

**Effective permissions can change without the file changing.** Team membership
lives on GitHub. Somebody added to `platform-engineers` gains its permissions
with no commit to `permissions.json`, which means git history is no longer the
whole audit trail — it is the history of *policy*, not of *who held what*. The
Admin tab's audit screen must say so, and show current team membership beside
the commit log rather than implying the log is complete.

Team membership is read with the App token, cached for the same 60 seconds as
the file, and a team that no longer exists is ignored and surfaced — the same
treatment as an unknown permission key.

The UI must show, for every permission, *why* it is on or off: **from preset
X**, **granted here**, **revoked here**, or **not granted**. A permission whose
origin is invisible is one nobody will dare change.

**Preset inheritance is single-parent and depth-limited to 4.** A cycle is a
schema error and fails the file closed. Multiple inheritance was rejected:
diamond resolution is a rule nobody remembers, and `presets: []` on a person
already allows composition where it is genuinely wanted.

### A branch grant is live, and that is visible

Somebody holding `alarms` holds every leaf under it — *including leaves added
by a later version of the app*. That is what makes a group a group rather than
a snapshot, and it is the behaviour asked for. It is also a way for an upgrade
to widen access without anybody deciding to.

So the vocabulary carries an `addedIn` version per leaf, the file carries
`reviewedAt`, and the Admin tab shows a banner when the vocabulary has gained
leaves under a branch anybody holds: *"3 new permissions exist under `aws`.
6 people gained them. Review."* Acknowledging sets `reviewedAt`. The grant stays
live; what changes is that it stops being silent.

### Logins

Keys are GitHub logins, lower-cased on write and on lookup. GitHub logins can be
*renamed*, which would silently orphan an entry — so each person entry also
carries `"id"`, the numeric GitHub user id, which never changes. Lookup is by
login; a mismatch between stored id and current id is surfaced in the admin UI
as "this entry may be stale" rather than silently resolved, because the two
plausible causes (a rename, and a login being reused by a different person after
deletion) want opposite handling.

## Storage, reading and caching

**Writing.** Only through the app, only with the App token, always via
`repos.createOrUpdateFileContents` with the `sha` the editor loaded. A changed
`sha` means somebody else saved first: the write is refused and the editor
re-reads and re-applies. This is the same optimistic-concurrency shape the
Artifact and DynamoDB code in this repo already uses, and it is what stops two
admins on the same screen from silently discarding each other's work.

The commit message names the actor and the change:
`Grant alarms.org.create to some-login (by other-login)`. Git history is the
audit log; `admin.audit.read` reads it through `repos.listCommits`.

**Reading.** `repos.getContent` with the App token, parsed and schema-validated,
held in memory behind a 60-second TTL. The admin console's own writes invalidate
immediately, so a change you just made is live before the screen repaints. A
revocation made by someone else takes at most 60 seconds — chosen to match the
existing `authorizationService` cache, which this replaces and whose TTL nobody
has complained about.

**There is no fallback copy.** A read that fails grants nothing, to anybody
except organization owners, until it succeeds again. This was chosen explicitly
over serving a last-known-good copy, with the consequence understood: a GitHub
outage makes the app read-only for everyone who is not an owner, including in
the AWS half, which does not otherwise depend on GitHub.

The reasoning for preferring it: a cached grant that outlives the file is a
grant nobody can revoke. Somebody removing a permission during an incident has
to be able to believe it took effect. The 60-second TTL is the entire window in
which a revocation can still be honoured, and it is bounded and stated rather
than dependent on how long an outage lasts.

**Accepted explicitly by the product owner:** if GitHub is down, nobody can use
the app except organization owners. That includes the AWS half, which does not
otherwise depend on GitHub. It is a known cost of not letting a cached grant
outlive the file that granted it.

## Failure modes

The product owner asked for these to be thought through rather than discovered.

| Scenario | Behaviour |
|---|---|
| Repo does not exist | Fail closed. Admin tab shows a one-click "create the repository" flow for owners. Everyone else sees the no-access screen. |
| File does not exist, repo does | Same, with "initialise permissions" instead. |
| Malformed JSON | Fail closed. A syntax error means somebody edited by hand, which is exactly when a stale grant must not be resurrected. Owners see the parse error with the line. |
| Schema-invalid (unknown preset ref, cycle) | Fail closed, same reasoning. The specific invalid entry is named. |
| Unknown permission key in the file | **Ignored, not fatal.** A key removed by an app upgrade must not lock the org out. Surfaced in the admin UI as "unknown, ignored" so it can be cleaned up. |
| A `grant` names a branch that no longer exists | Same: ignored, surfaced. A renamed branch would otherwise silently drop everyone under it, which fails closed but looks like the app breaking. |
| An upgrade adds leaves under a held branch | Granted live, and the Admin tab says so until acknowledged. See "A branch grant is live". |
| A card on Overview shows data from a tab you cannot read | The card is absent, not empty. An empty card reads as a bug and invites a report; an absent one is the permission working. |
| Someone holds a write permission but not the matching read | Allowed, and shown as odd in the UI. `alarms.org.create` without `alarms.org.read` is strange but coherent, and refusing it would mean the engine second-guesses the administrator. |
| GitHub unreachable / rate-limited | Fail closed. Owners keep access and can see the read error. Everyone else is read-only until GitHub recovers. No cached fallback — see Reading, above. |
| App token loses repo access | Indistinguishable from unreachable at the API level; treated the same, but the admin UI distinguishes 404 from 5xx in its message. |
| Someone pushes to the repo directly | The ruleset should prevent it. If it happens, the app reads it — the file *is* the source of truth. This is the accepted consequence of the chosen trust model, and the repo's ruleset is the control. The admin UI shows the last commit author, so a non-App committer is visible. |
| Two admins save at once | Second save refused on `sha` mismatch, editor re-reads, shows what changed, re-applies. No silent overwrite. |
| An admin revokes their own `admin.console.open` | Allowed, with a confirmation naming the consequence. Owners can always restore. This is deliberate: blocking it requires the app to reason about who *else* remains, which is the next row. |
| The last admin is removed | Allowed. Organization owners are exempt from every check and can always reach the console, so the org is never locked out. The UI warns when a save would leave zero non-owner admins. |
| A preset is deleted while assigned | Refused. The UI lists who holds it and offers to reassign them first, counting team assignments as well as people. |
| A team named in the file is deleted on GitHub | Ignored and surfaced, like an unknown key. Its members quietly lose what it granted, which is correct and must be visible — the dry-run diff names them. |
| Team membership cannot be read | Fail closed for the team layer: the person keeps only what their own entries and presets give. Not a fallback to last-known membership, for the same reason there is no cached file. |
| Two teams disagree on the same leaf | Revoke wins, and the UI flags the conflict on both teams so it is fixed rather than relied on. |
| Somebody holds `activity.read.app.actor` but not `.rows` | Coherent and strange: they can see actors on rows they can otherwise see, and there are none. Shown as odd, not refused. |
| A person leaves the org | Their entry stays (harmless — permissions are meaningless without a session) and is flagged in the UI as "no longer in the organization" for tidying. |
| Outside collaborators | Treated as people like any other. They have no entry, therefore nothing, which is the correct default for a contractor. |
| Organization owners | Exempt from every permission check, always. Shown in the admin UI as such, with the reason, so their access is never mistaken for a grant — the same fix already made for `AdminStanding` in the account menu. |
| **AWS-only installs** (`AWS_ONLY=true`) | There is no GitHub org and no repo to store a file in. The permission system is **inert**: every check passes, and the app behaves exactly as it does today. Documented loudly, because "permissions do nothing here" must not be a surprise. |
| Demo mode | Inert, as today. |
| Webhook worker, scheduled jobs | Not users, hold no session, consult no permissions. Unchanged. |
| Notifications already configured for someone who now has none | Keep firing. The settings were validly made; a permission governs *changing* them, not the org's obligation to tell somebody their PR was approved. Revoking `me.alerts.manage` freezes settings rather than silencing them. Anything else turns a permission change into a silent notification outage. |

## Enforcement

A `requirePermission("key")` middleware, shaped exactly like the existing
`requireControlHubAdmin`, returning `403` with `{ code, permission, error }` so
the client can distinguish "you may not" from "this is broken" — the property
`teamGate.ts` already has and which the restricted-screen UI already relies on.

**The completeness guarantee is the point of choosing this approach.**
`repro-undo.ts` already fails if a write route does not name a guard, and
separately fails if a route file is absent from its inventory. That second
assertion exists because the rule-templates router once shipped with no
authorization at all and the suite passed *by not looking at it*. Both
assertions extend to permission keys:

- every write route names a `requirePermission` or an inline equivalent;
- every route file is guarded or explicitly exempt with a reason;
- **every permission key named in a route exists in the vocabulary**, and vice
  versa — a typo'd key must be a build failure, not a permission nobody holds.

That last one is new and is the highest-value assertion in the design. A
misspelled key in a `requirePermission` call fails closed, which is safe, and is
invisible, which is not.

## Migration

Deliberately a step somebody takes, never a deploy side-effect.

1. Ship the vocabulary, the middleware and the reader **disabled**
   (`PERMISSIONS_ENABLED=false`). Existing team gates continue to decide.
2. The Admin tab appears for `control-hub-admins`, and can create the repo,
   generate a starting file, and edit it — with a banner saying it is not yet in
   force.
3. The generated file grants: current `control-hub-admins` members a `Full
   administrator` preset; current `aws-guardrail-admins` members an `AWS
   administrator` preset; **every other org member a `Member` preset** covering
   the `me.*` keys and the read keys that are open today. This mirrors current
   behaviour, so switching on changes nothing for anybody on day one.
4. A dry-run view: "with this file in force, these N people would lose access to
   these things." Diffed against today's actual behaviour.
5. Flip `PERMISSIONS_ENABLED=true`. Team gates stop being consulted.
6. Delete `aws-guardrail-admins` when satisfied.

Step 4 is what makes step 5 safe, and it is the step most likely to be skipped
if it is not built.

## The Admin tab

Four screens.

**People.** Every org member, their preset, and whether they have overrides.
Search, filter by preset, filter to "no permissions". Clicking one opens the
grid below.

**Person.** The permission **tree**, collapsed to its 11 branches by default.
Every node carries a tri-state checkbox — all, some, none — so a branch can be
granted with one click and then opened to untick one leaf. Each leaf shows its
origin: *from Engineer*, *granted here*, *revoked here*, *not granted*. Toggling
a node writes the shortest entry that expresses the intent: ticking every leaf
under `alarms` one at a time collapses to `grant: ["alarms"]` on save, so the
file stays legible and a later-added leaf is included rather than missed.

A free text note. Save is one commit.

**Presets.** Create, edit, delete, and see who holds each. Editing shows "this
will change N people" before saving.

**Audit.** The commit history of `permissions.json`, rendered as "who changed
whose what, when", from `repos.listCommits` plus the diff.

The no-access screen — what an ungranted person sees — is the fifth surface and
matters more than it sounds: under deny-by-default it is the entire app for a
new hire. It names the organization, says permissions have not been granted yet,
and lists the Control Hub admins to ask, by name. Reading that list is the one
thing the app must do without a permission.

## Testing

Following this repo's convention, `repro-*.ts` suites asserting properties, not
implementations:

- `repro-permissions.ts` — evaluation: deny-by-default; branch grants expand to
  their leaves; **longest prefix wins**, in both directions (grant-branch with
  revoke-leaf, and revoke-branch with grant-leaf); person beats preset at equal
  depth; child preset beats parent; revoke beats grant at equal depth and layer;
  inherit depth limit; cycle rejection; unknown key and unknown branch tolerated
  and reported; owner exemption; **the three layers** — team beaten by preset
  beaten by person at equal depth, a longer team entry beating a shorter
  personal one, two teams disagreeing resolving to revoke.
- `repro-permissionsfile.ts` — the file: parse, schema-validate, `sha`
  concurrency, malformed input fails closed and does *not* use the cached copy,
  stale copy expiry.
- `repro-permissiongates.ts` — completeness: every write route **and every read
  route** names a key; every key named in a route exists in the vocabulary and
  every vocabulary leaf is named by at least one route; no route file unguarded
  and unexempted. Reads are in scope now, which roughly doubles what this
  covers and is the assertion that makes "read is a permission" real rather
  than aspirational.
- Extensions to `repro-undo.ts` for the three-way undo split, and
  `repro-authz.ts` for owner exemption reporting.

## Documents this invalidates

Both must be updated in the same change that flips `PERMISSIONS_ENABLED`, not
after:

- `docs/auth/permissions-model.md` — states **"Reading is open. Anyone signed in
  can see rules, findings, the access map and the activity log."** That stops
  being true. It also documents the two admin teams; one of them is going away.
- `docs/operations/setup.md` — the `AWS_ADMIN_TEAM` setup step, and the App
  permission table, which gains nothing but whose *reasons* change.

A design that silently contradicts a document somebody will read next month is
how the org ends up with two answers to the same question.

## Staging

Four pieces, each shippable and useful alone:

1. **Vocabulary + evaluation engine + tests.** No UI, no file, no enforcement.
   Pure functions; the riskiest logic tested before anything depends on it.
2. **Storage: repo read/write, caching, failure modes.** Still not enforcing.
3. **Enforcement: middleware on every route — reads included — behind
   `PERMISSIONS_ENABLED`.** Plus the build-time completeness assertions. Reads
   roughly double this stage: ~77 read endpoints join the ~78 writes, and the
   read side is where a wrong answer is least visible, because a screen that
   renders empty looks like a screen with no data.
4. **The Admin tab, migration generator and dry-run.** Then the flip.

## Open questions

None. The two that were open — whether activity redaction should be a
permission, and whether presets should be assignable to teams — were both
resolved as yes and are designed above.

The team layer was initially rejected here for resolution complexity. Adopting
it turned out to cost one rule rather than a scheme: teams are simply the
lowest of three layers, and the longest-prefix rule that already existed
decides the rest. What it genuinely costs is stated under *What team assignment
costs* — the audit log stops being the whole story once membership lives
somewhere the file cannot see.
