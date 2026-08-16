# Testing

Thirty-eight suites, each a script named `repro-*.ts`, run with `tsx`. No
framework. Thirty-five live in `backend/`, three in `frontend/`, and each runs
from its own directory.

```bash
cd github-control-hub/backend
npx tsx repro-accounts.ts
```

## Why this shape

Each file reproduces a specific failure and then asserts it stays fixed. The
names read as claims about behavior, not as coverage:

> `PASS  a role that cannot be assumed does not end the sweep`
> `PASS  an entry with no id is skipped rather than written under a new one`

A test that needs a mocking framework to express usually means the seam is in
the wrong place.

## The suites

| Suite | Guards |
|---|---|
| `repro-queries` | The graph-backed security checks |
| `repro-engine` | Guardrail engine safety — report never writes |
| `repro-guardrails` | Rule evaluation |
| `repro-accounts` | Multi-account sweeps, credential chain, deploy scoping |
| `repro-leastprivilege` | **What the IAM does not contain** |
| `repro-accessmap` | Access-path derivation |
| `repro-activity` | Activity lookups and indexes |
| `repro-audit` | Audit-log reading and actor attribution |
| `repro-auditstream` | Audit-log streaming setup, and turning it off |
| `repro-retention` | TTL stamping |
| `repro-undo` | Undo gating; every write route names its guard |
| `repro-authz` | Authorization |
| `repro-membership` | Org membership |
| `repro-token` | GitHub App token refresh |
| `repro-ratelimit` | Rate-limit reporting and countdown |
| `repro-config` | Config export/import semantics |
| `repro-prefs` | Remembered AWS profile |
| `repro-setupauth` | Setup-time auth |
| `repro-repodetails` | Repository detail assembly |
| `repro-alarms` | Widget alarm conditions, templates and delivery |
| `repro-appsec` | Source-level security controls — CSP, no-shell, fail-closed webhooks |
| `repro-dependencies` | Dependabot alert paging — counts every alert, not the first hundred |
| `repro-renovate` | Renovate pull request classification |
| `repro-feednotify` | Per-event email batching — one message per repository, not per finding |
| `repro-expertise` | Ranking who knows a repository, path or library |
| `repro-prnudge` | Stale pull requests — who is reminded, who is muted, and the sticky comment |
| `repro-orgmembers` | Org member paging, and refusing a mute on somebody outside the org |
| `repro-alarmrefire` | **Saving a setting must never make something send again** |
| `repro-dormantadmins` | **A security check must never report fewer findings than exist** |
| `repro-querycache` | Per-subject verdict caching — covering a large org a batch at a time |
| `repro-scanpaging` | **A table scan must read the whole table** |
| `repro-largeorg` | The whole path at 300 accounts, against a rate-limited GitHub |
| `repro-blastradius` | **An unread service is never "safe to delete"** |
| `repro-loginstates` | What the sign-in page says in each state, and in what order |
| `repro-webhookdelivery` | Signature verification over raw bytes, and the delivery lock |

Frontend, run from `github-control-hub/frontend`:

| Suite | Guards |
|---|---|
| `repro-tablecontrols` | Search, sort and paging arithmetic at the boundaries |
| `repro-activitycategories` | Grouping activity into the categories the page shows |
| `repro-nestedcomponents` | **No component is declared inside another** |

## Two unusual ones

**`repro-leastprivilege`** reads the shipped CDK and CloudFormation and asserts
what they do *not* contain — no `iam:` action, no wildcard `AssumeRole`, no
administrator role, no unconditional write grant. It is the only test whose
failure means "someone widened the blast radius".

**`repro-undo`** greps the route files to check every write route names an
authorization guard. Adding a route without one fails the suite.

**`repro-nestedcomponents`** reads every `.tsx` file for a capitalised
declaration indented inside another. React reconciles by element type, so a
component declared inside a render is a new type each time and gets rebuilt
rather than updated — which drops the caret out of any text box inside it after
every character. This shipped once, in the "Who knows this?" repository box, and
the scan then found three more that had been there longer.

## Running everything

```bash
for t in repro-*.ts; do echo "== $t"; npx tsx "$t" | tail -1; done
```

Plus `npx tsc --noEmit` in `backend`, `frontend`, `desktop` and `infra`.

## Mutation testing: a crash is a catch

Mutations are verified by breaking the code on purpose and checking the suite
notices. The obvious way to count that — how many FAIL lines were printed — is
wrong, and was wrong three separate times in one afternoon.

An uncaught exception ends the process. No FAIL lines are printed, the count
reads zero, and the mutation looks like it survived when the suite actually
detected it by dying. One mutation here crashed at line 555, long before
reaching the assertion aimed at it, and scored zero.

Count the verdict, not the failures:

- **caught** — the run does not end in ALL PASS, whether it reported failures or
  crashed
- **survived** — the run ends in ALL PASS

A shell harness for that:

    verdict() {
      local out; out=$(npx tsx "$1" 2>&1)
      if echo "$out" | tail -1 | grep -q "ALL PASS"; then echo SURVIVED
      else echo caught; fi
    }

The same trap appears inside a test. An assertion that awaits something which
throws takes the whole file with it, so the remaining assertions never run and
the summary is silence rather than a failure. Where behaviour *under* failure is
what is being asserted — a delete that 404s, a repository that cannot be
commented on — catch it explicitly and assert on the outcome, so a throw becomes
a readable failure instead of a silent exit.

## A guard cannot prove itself on clean input

repro-appsec scans the repository for leaked identifiers. On a clean repository
it passes — and it passes just as happily with the scanner narrowed to one file
type, pointed at one directory, or with its pattern emptied. Three mutations
doing exactly that changed nothing, because there was nothing there to miss
either way.

"No findings" is therefore not evidence. The guard now plants a canary in every
file type it claims to read, inside a directory it claims to walk, and requires
the scan to find all of them before its silence about the real repository counts
for anything. The canaries are removed in a finally, since one left behind reads
as a genuine leak on the next run.

The canary values are assembled at runtime rather than written as literals. The
first version spelled them out, and since the guard scans its own source, it
reported itself.
