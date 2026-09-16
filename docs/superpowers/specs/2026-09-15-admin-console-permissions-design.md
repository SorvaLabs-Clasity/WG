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

These four were settled with the product owner and are load-bearing. Everything
below follows from them.

| Decision | Choice |
|---|---|
| **Scope** | App concepts only. Repo actions stay with GitHub. |
| **Failure mode** | Fail closed. Organization owners exempt. |
| **Trust model** | The repo is the source of truth, and is locked down so only the App can commit. |
| **Default grant** | Deny by default. A person with no entry has *nothing*, including their own personal screens. |

The fourth is the strictest of the available readings and was chosen
deliberately. It has a consequence that is not optional: **switching this on
locks the entire organization out until the file names them.** That is handled
as an explicit migration step below, never as a deploy side-effect.

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

Flat, dotted, one key per action. Flat because a key is a string in a JSON file
and a string in a route declaration, and any structure in between is a chance
for the two to disagree.

The list is derived from the actual endpoint inventory, not invented. Every key
below corresponds to at least one route that exists today.

### Admin

```
admin.console.open            Open the Admin tab at all
admin.people.assign           Assign a preset to a person
admin.people.override         Toggle an individual permission on a person
admin.presets.create          Create a preset
admin.presets.edit            Edit a preset
admin.presets.delete          Delete a preset
admin.audit.read              Read the change history of the permissions file
```

`admin.console.open` is deliberately *not* sufficient to change anything. A
read-only auditor is a real role.

### My work — personal, and still granted

```
me.work.read                  The queue: your PRs, reviews, checks
me.push.check                 "Why can't I push"
me.repos.read                 Your own repository list (feeds the suggestions)
me.alerts.read                Your notification settings
me.alerts.manage              Change them
me.alerts.test                Send yourself a test
me.alarms.read                Your own alarms
me.alarms.manage              Create, edit, delete your own alarms
me.destination.manage         Your own email/Teams destination
me.widgets.manage             Your own cards
```

Under the chosen default these are granted rather than assumed. Every
realistic preset will include them; the engine has no special case.

### Activity

```
activity.read.own             Rows where you are the actor
activity.read.app             Rows where somebody else is the actor    ← issue #5
activity.read.github          Rows sourced from GitHub webhooks
activity.pulse.read           The activity pulse chart
activity.undo.repo            Undo a repository action
activity.undo.app             Undo an app-config action (scanner, widget)
activity.undo.aws             Undo an AWS action
activity.retry                Retry a failed action
activity.resolution.undo      Undo a conflict resolution
activity.detailedLogging.read
activity.detailedLogging.manage
```

`activity.undo.*` is split three ways because the three answer to different
people, and because `undoPolicy.ts` already distinguishes them —
`UndoRequirement` gained an `awsTeam` field on 2026-09-15 for exactly this
reason. These permissions replace that field's team lookup with a permission
lookup; the three-way split survives intact.

**An undo permission is necessary, never sufficient.** The repo-level check in
`denyIfNotPermitted` — `assertWritable` with the caller's own token — still
runs, and still refuses. Undo is the clearest case where both authorities must
agree, and where only one of them is ours.

### Alarms

```
alarms.org.read      alarms.org.create    alarms.org.edit      alarms.org.delete
alarms.groups.read   alarms.groups.manage alarms.groups.test
alarms.teamsFlow.read
alarms.teamsFlow.manage
alarms.security.manage        The security-alert settings
alarms.feeds.manage           Per-feed notification settings
```

`alarms.ts` already contains `refusedForSubject`, which decides *which* team may
write based on what the alarm watches — an alarm on an AWS guardrail is an AWS
change. That logic is kept and re-expressed: an alarm whose subject is a
guardrail requires `aws.rules.edit` in addition to `alarms.org.*`. This is the
one place where the route alone cannot decide, and the capability object
(approach C, borrowed) is used.

### AWS

```
aws.rules.read       aws.rules.create     aws.rules.edit       aws.rules.delete
aws.rules.enforce             Move a rule from report to enforce
aws.sweep.run                 Run a sweep
aws.remediate                 Fix a finding
aws.preview                   Preview a remediation
aws.exclusions.read  aws.exclusions.manage
aws.findings.read    aws.accounts.read    aws.costs.read
```

`aws.rules.enforce` is separated from `aws.rules.edit` on purpose: moving a rule
into enforce mode is the act that can break production, and it is reasonable to
let somebody author rules without being able to arm them.

### The rest

```
scanners.read      scanners.create   scanners.edit    scanners.delete   scanners.run
widgets.org.read   widgets.org.create widgets.org.edit widgets.org.delete
access.read                  The access map — aggregates everyone's permissions
access.refresh
graph.read         graph.rebuild
pulls.read         pulls.pause      pulls.mute       pulls.settings.manage  pulls.run
deps.read          deps.dependabot.manage  deps.renovate.manage  deps.bulk
expertise.read     org.read         budget.read
config.export      config.import
```

`config.import` warrants its own note. An export bundle carries scanners,
widgets *and* AWS guardrails in one file, so importing it writes to both sides.
The existing rule — an import containing AWS sections is refused unless the
caller has AWS authority — is kept, expressed as: `config.import` requires the
permission for every section present in the bundle. Without that, import is a
way around every other gate, which is a hole this codebase has already found
once.

**Total: ~95 keys.** Deep enough that presets are not a convenience.

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
      "permissions": ["me.work.read", "me.alarms.manage", "activity.read.own", "..."]
    },
    "alarms-admin": {
      "name": "Alarms administrator",
      "inherits": "engineer",
      "permissions": ["alarms.org.create", "alarms.org.edit", "alarms.groups.manage"]
    }
  },

  "people": {
    "some-login": {
      "presets": ["alarms-admin"],
      "grant": ["config.export"],
      "revoke": ["alarms.org.delete"],
      "note": "Owns the release alarms. No delete, by request.",
      "updatedAt": "2026-09-15T14:02:11Z",
      "updatedBy": "someone-else"
    }
  }
}
```

**Effective permissions** for a person are computed as:

1. Start empty. *(Deny by default.)*
2. Union the permissions of every assigned preset, resolving `inherits` first.
3. Union `grant`.
4. Subtract `revoke`.

`revoke` is applied last and always wins, so "this preset, but not that one
thing" is expressible without cloning a preset. The UI must show each permission
as *from preset X*, *granted here*, or *revoked here* — a permission whose
origin is invisible is a permission nobody will dare change.

**Preset inheritance is single-parent and depth-limited to 4.** A cycle is a
schema error and fails the file closed. Multiple inheritance was rejected:
diamond resolution is a rule nobody remembers, and `presets: []` on a person
already allows composition where it is genuinely wanted.

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

If this proves too brittle in practice, the softening is in Open Questions
below rather than in the design — it is a decision to revisit deliberately, not
a default to slide into.

## Failure modes

The product owner asked for these to be thought through rather than discovered.

| Scenario | Behaviour |
|---|---|
| Repo does not exist | Fail closed. Admin tab shows a one-click "create the repository" flow for owners. Everyone else sees the no-access screen. |
| File does not exist, repo does | Same, with "initialise permissions" instead. |
| Malformed JSON | Fail closed. A syntax error means somebody edited by hand, which is exactly when a stale grant must not be resurrected. Owners see the parse error with the line. |
| Schema-invalid (unknown preset ref, cycle) | Fail closed, same reasoning. The specific invalid entry is named. |
| Unknown permission key in the file | **Ignored, not fatal.** A key removed by an app upgrade must not lock the org out. Surfaced in the admin UI as "unknown, ignored" so it can be cleaned up. |
| GitHub unreachable / rate-limited | Fail closed. Owners keep access and can see the read error. Everyone else is read-only until GitHub recovers. No cached fallback — see Reading, above. |
| App token loses repo access | Indistinguishable from unreachable at the API level; treated the same, but the admin UI distinguishes 404 from 5xx in its message. |
| Someone pushes to the repo directly | The ruleset should prevent it. If it happens, the app reads it — the file *is* the source of truth. This is the accepted consequence of the chosen trust model, and the repo's ruleset is the control. The admin UI shows the last commit author, so a non-App committer is visible. |
| Two admins save at once | Second save refused on `sha` mismatch, editor re-reads, shows what changed, re-applies. No silent overwrite. |
| An admin revokes their own `admin.console.open` | Allowed, with a confirmation naming the consequence. Owners can always restore. This is deliberate: blocking it requires the app to reason about who *else* remains, which is the next row. |
| The last admin is removed | Allowed. Organization owners are exempt from every check and can always reach the console, so the org is never locked out. The UI warns when a save would leave zero non-owner admins. |
| A preset is deleted while assigned | Refused. The UI lists who holds it and offers to reassign them first. |
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

**Person.** Every permission, grouped by tab, each showing its state and its
origin — *from Engineer*, *granted here*, *revoked here* — with a toggle. A free
text note. Save is one commit.

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

- `repro-permissions.ts` — evaluation: deny-by-default, preset union, inherit
  depth, cycle rejection, revoke-wins, unknown-key tolerance, owner exemption.
- `repro-permissionsfile.ts` — the file: parse, schema-validate, `sha`
  concurrency, malformed input fails closed and does *not* use the cached copy,
  stale copy expiry.
- `repro-permissiongates.ts` — completeness: every write route names a key,
  every key in a route exists in the vocabulary and vice versa, no route file
  unguarded and unexempted.
- Extensions to `repro-undo.ts` for the three-way undo split, and
  `repro-authz.ts` for owner exemption reporting.

## Staging

Four pieces, each shippable and useful alone:

1. **Vocabulary + evaluation engine + tests.** No UI, no file, no enforcement.
   Pure functions; the riskiest logic tested before anything depends on it.
2. **Storage: repo read/write, caching, failure modes.** Still not enforcing.
3. **Enforcement: middleware on every route, behind `PERMISSIONS_ENABLED`.**
   Plus the build-time completeness assertions.
4. **The Admin tab, migration generator and dry-run.** Then the flip.

## Open questions

None blocking. Two worth revisiting after stage 1:

- Whether `activity.read.app` should support the *redaction* variant discussed
  (see the row it came from) rather than being binary. The engine supports it as
  a third key if wanted; it is not in the vocabulary above.
- Whether a short last-known-good window (minutes, not hours) should soften the
  GitHub-outage case. Rejected above so that a revocation cannot outlive its
  own file, but the brittleness is real and the AWS half of the app has no
  business depending on GitHub's availability. Revisit with operational
  evidence rather than in advance.
- Whether presets should be assignable to GitHub *teams* as well as people. It
  was rejected above for resolution complexity, but an org this size may find
  per-person assignment tedious enough to justify revisiting with a strict
  "union, never subtract" rule for team presets.
