# Permissions model

Who is allowed to do what, and who decides.

## Two different authorities

**GitHub decides repository actions.** The call is made with your token, so
GitHub applies your permissions. The app adds no check of its own and needs
none.

**The app decides its own settings.** Scanners, widgets, alarms, compliance
rules and AWS guardrails are the app's concepts; GitHub has never heard of them.
So the app gates those on membership of a team.

## The two admin teams, and what replaces them

Historically there were two, and membership of one was the whole answer:

| Team | Controls | Default name |
|---|---|---|
| Control Hub admins | Scanners, widgets, alarms and email groups, security alerts, compliance rules, the Renovate bot name, pull request reminders, graph rebuilds, config import/export | `control-hub-admins` |
| AWS guardrail admins | AWS rules, exclusions, sweeps, enforce mode, detailed-logging settings | `aws-guardrail-admins` |

Both are overridable with `CONTROL_HUB_ADMIN_TEAM` and `AWS_ADMIN_TEAM`.

They were deliberately separate: the person who curates branch-protection
settings is not necessarily the person who should be able to let an application
write to production S3 buckets.

**A config import cannot cross between them.** An export bundle carries scanners
and widgets *and* AWS guardrails in one file, so importing it is a write to both
sides. The AWS sections need the AWS team; a Control Hub admin importing a
bundle that contains them is refused and told which sections to remove. Without
that, the import route was a way to create an enforcing AWS guardrail while only
ever proving membership of the GitHub team.

That rule outlived the teams that motivated it — see *every change class in the
diff*, below, which is the same idea applied to the permission file itself.

### What replaces them

Two teams is two bits of information about a person. It cannot express "may
read AWS findings but never move a rule into enforce", which is a real role.

So team membership stops being the answer and becomes one input to it.
`control-hub-admins` keeps exactly one meaning — who may open the Admin tab —
and `aws-guardrail-admins` is no longer read by the app at all. Everything else
comes from a permission file: about 109 individual permissions, assignable
singly or by whole branches of the tree, grouped into presets, attachable to a
person or to a GitHub team.

**This is off until an operator turns it on.** With `PERMISSIONS_ENABLED`
unset — the state this ships in — every gate falls through to the two-team
behaviour described above and nothing changes for anyone. The Admin tab, the
file, the dry-run and the migration all exist so that the flip can be made
with the answer already known. Deleting `aws-guardrail-admins` on GitHub is a
separate, later, human decision.

## The permission file

`permissions.json`, in a private repository in the organization
(`control-hub-permissions` by default). Git is the audit log: every change is a
commit with an author and a message, and the Admin tab's Audit screen is that
history.

**Administrators commit it with their own accounts; the App only reads it.**
That keeps the file inside the rule at the top of this document — the app does
nothing on GitHub the person could not have done themselves — and it means the
author on each commit is the person who made the change rather than the App
nine times over. It also lets the organization grant a *team* write access
instead of granting an application a ruleset bypass.

Reads are the deliberate exception: the gate in front of every request needs
this file to decide whether the caller may do anything at all, including
callers who cannot read the repository, which under deny-by-default is most
people. So the App reads and the administrator writes.

The trade this makes explicit: anyone with push access to that repository can
edit the file by hand and bypass the app's own rules, including the
self-widening refusal. That is the same trust you place in anybody you give
write access to a repository, it is visible in the history like any other
commit, and it is the reason the write access is granted to a named team rather
than to everyone who can open the tab.

**The dots in a key are the group tree.** `alarms.org.create` sits under
`alarms.org`, which sits under `alarms`. A grant or a revoke may name any node
at any depth and means every leaf beneath it. This is what makes 109
permissions assignable without ticking 109 boxes, while leaving every
individual box tickable. There is no separate "group" concept to keep in sync —
the tree *is* the list, read at a different depth.

Conflicts resolve in this order:

1. **Longest prefix wins.** `alarms.org.create` beats `alarms`, so "everything
   in alarms except creating org alarms" is two entries, not twelve.
2. **Then layer:** team &lt; preset &lt; person. The specific overrides the general.
3. **Then revoke beats grant** on an exact tie. A tie means two rules of equal
   standing disagree, and the safe reading of a disagreement is no.

Grants of a branch include leaves added by later versions of the app. That is
the intended behaviour and the reason the Admin tab saves the shortest entry
that expresses your intent rather than expanding it to leaves.

### Every change class in the diff

The Admin tab writes the whole file, so the endpoint that accepts it cannot
know what changed. Gating that endpoint on one permission would mean whoever
may assign a preset may also rewrite every preset and override any individual.

Instead the write is compared against the stored file, the change classes are
derived from the diff, and **every class present** must be permitted:
assigning a preset needs `admin.people.assign`, editing one needs
`admin.presets.edit`, and a write that does both needs both. Never "the most
specific class". This is the `config.import` rule again, and for the same
reason: a coarse gate on a composite write is a way around every fine one.

### And no write may widen the writer

Change classes say what a write *does*. They say nothing about who it is done
*to*, and that gap collapsed the five-way split back into one: a holder of
`admin.people.assign` alone could add the `control-hub-admin` preset — which
grants the whole `admin` branch — to their own entry. The diff is exactly one
preset assignment, so it was permitted, and afterwards they held all five. The
same trick worked from the other side: edit a preset you already hold to add
`grant: ["admin"]`, which classifies as `admin.presets.edit` and nothing more.

So the question is asked directly rather than enumerated as a list of forbidden
routes. What does the caller hold under the stored file, and what would they
hold under the one being submitted — computed by `permissionsFor`, the same
evaluator every gate uses, over the caller's real teams and presets. If the
second set contains anything the first does not, the write is refused with a
403 naming what would have been gained.

This is deliberately narrower than "you may not edit your own entry". Narrowing
yourself is exactly what an administrator handing over should be able to do,
and editing a preset you hold is ordinary work as long as it does not widen
you. It is also wider than any list of known escalations, because it closes the
ones nobody has thought of yet.

Organization owners are exempt, as they are everywhere else: they already hold
everything, so there is nothing to widen into.

The rule belongs to **writing the file**, not to one endpoint. It was
implemented on `PUT /api/admin/file` alone, and `POST /api/admin/migrate` —
which writes a whole file, and writes one handing the `control-hub-admin`
preset to everybody on `control-hub-admins` — took a caller holding
`admin.people.assign` to the entire vocabulary in one call. Every write path in
the Admin router now goes through one function that asks the question before it
saves; a route that reaches `savePermissions` directly is a bug.

And the comparison refuses rather than guesses when the caller's own standing
cannot be established. A subject whose GitHub teams could not be read is not a
subject with no teams: both sides of the comparison would lose the same teams,
so granting `admin` to a team the caller is in would register as no gain. That
answers 503 `PERMISSIONS_UNAVAILABLE`, the same thing the gates say when they
cannot decide — the fail-closed rule this design commits to everywhere else.

### A section you may not read is one you may not write blind

`GET /api/admin/file` is reachable with either `admin.people.read` or
`admin.presets.read`, because People and Presets render from one file. It
returns only the halves the caller holds the read for — the other is **absent
from the response**, with its name in a `withheld` list, per the rule below.

The Admin tab submits the file it was given, so the write path puts a withheld
section back from the stored file before diffing or saving it. Without that, a
presets-only editor's next save would delete every person in the organization.
A section the caller *did* submit is judged normally by the diff, whatever they
may read: quietly reverting somebody's edit is worse than refusing it.

### The tree edits one layer, as a difference from the ones beneath it

The permission tree on the Admin tab writes one thing: a person's own
`grant`/`revoke`, which outranks their presets and their GitHub teams. So a
click has to be saved as the *difference* from what those other layers already
give — a leaf whose desired state already matches them produces no rule at all.
Writing the resolved state instead freezes a team's grants into the person's
entry and revokes, at the person layer, every branch the screen happened not to
show.

The baseline that difference is taken against comes from the server. `GET
/api/admin/person/:login` answers with `inherited` — every rule from the layers
beneath that person, **at the depth each was written** — and `baseline`, what
those rules alone decide, leaf by leaf. Neither is derived from the
`explanations` map, which reports the rule that won *overall* and is a
different question: a leaf the person's own `revoke` suppresses reads there as
"not granted", exactly like a leaf nothing grants, so filtering their own
entries out of it loses the revoke instead of stepping beneath it. Flattening
what is left to leaf depth then inverts the resolver, which ranks depth above
layer.

The property this exists for, and the one `frontend/repro-permissiontree.ts`
asserts directly: **for any tree edit, what is saved resolves — through the
server's own `permissionsFor` — to exactly the set the administrator saw
ticked.**

## When GitHub is down

The file is read from GitHub, so if GitHub is unreachable the app cannot
establish what anyone is allowed to do. It **fails closed**: everyone is
refused, with a 503 that says the permissions could not be read rather than a
403 that says you are not allowed. There is no cached fallback and this is on
purpose — serving yesterday's permissions is exactly what you do not want on
the day somebody's access was revoked this morning.

Organization owners are exempt, as they are from every other gate here. The
people who can fix it can still get in.

## Organization owners pass every check

Always, whatever team they are on and whatever the permission file says. Otherwise an empty, renamed or deleted team
locks everyone out of their own settings, including out of the screen that would
let them fix it.

**This is the rule that gets reported as a bug.** Somebody removes themselves
from both teams to satisfy themselves that the gate works, nothing whatsoever
changes, and the honest conclusion from the inside is that the permissions are
broken. They are not — an owner was never being admitted by the team.

So `/auth/permissions` reports the *route* alongside the verdict:

```json
{ "isAwsAdmin": true, "awsAdminVia": "owner", "awsAdminTeam": "aws-guardrail-admins" }
```

`"owner"` | `"team"` | `null`, and the account menu says which in a sentence. To
actually test the team gate, use an account that is a plain org **member**.

Removing yourself from an admin team while remaining an owner changes nothing,
and the app now says so before you go looking for what broke.

## What "the app's own settings" covers

Anything with no GitHub equivalent, which is broader than it first looks. The
test that keeps this honest is `repro-undo.ts`: it reads every route file and
fails if a `post`, `put` or `delete` does not name an authorization guard, and
separately fails if a route file with writes is neither guarded nor listed as
deliberately exempt with a reason.

The compliance rule set was the last thing to be caught by it. Its router was
exempted as "read models over the graph", true of everything in it except
`PUT /api/compliance/config`, which replaces the definition every repository in
the organization is scored against. `{"rules": []}` scores everything 100.

## Reading is a permission

It did not used to be. This document said *"reading is open — anyone signed in
can see rules, findings, the access map and the activity log"*, on the argument
that knowing who can write to which repository is not privileged information
inside an organization.

That argument still holds for the organizations it was written for. It stopped
being the app's decision to make. Under the permission file every read is a
permission like every write: `overview.read`, `aws.findings.read`,
`activity.read.app.rows`. Somebody with no entry sees nothing — not the
Activity log, not the access map, not their own queue.

**Nothing at all until granted** is the deliberate shape. The alternative —
everyone starts with reads and an administrator takes things away — means the
day a new tab ships, everybody can read it before anyone has decided they
should.

### Overview is not a side channel

The Overview tab draws on seven other tabs' data. A dashboard that aggregates
everything is the classic way a permission system leaks: you cannot open the
Vulnerabilities tab, but a card on Overview shows you its numbers.

So `overview.read` opens the tab and nothing more. Every card additionally
requires the read permission for the data it displays, and a card whose data
you may not read is **absent, not empty**. An empty card invites somebody to
report a bug; an absent one tells the truth.

The same rule applies anywhere one screen surfaces another's data. It is why
the Activity feed refills its page after redaction rather than reporting how
many rows it hid — a count of hidden rows is itself the fact the permission
withholds, and why the Admin tab's own file arrives with the sections you may
not read missing rather than empty.

That refill is a response to redaction and to nothing else. A page that comes
back short because the store's own read budget ran out has always meant "here
is what fitted, ask again", and is still returned exactly as it was: the batch
is measured before and after redaction, and a batch nothing was taken from is
not refetched. Otherwise every viewer on a large table would pay six reads for
one, whether or not anything was being withheld from them.

## Undo is gated as hard as the original action

Undoing something is doing something. Every undo is re-checked against what the
person could do *now*, per repository, being on the admin team says nothing
about whether you may touch a particular repo. Actions with no safe reversal
are refused rather than faked. See
[activity and undo](../features/activity-and-undo.md).
