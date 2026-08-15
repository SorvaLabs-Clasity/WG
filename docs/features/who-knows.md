# Who knows this?

Ranks people by what they have actually touched, for the moment something is
broken and the question is who to ask first.

## Three subjects

| Subject | Reads | Requests |
|---|---|---|
| **Repository** | Commits, review comments, issue and pull-request discussion | 3 |
| **File or folder** | Commits touching that path | 1 |
| **Library** | Manifests across the organization that name it, and their history | 1 search + up to 12 |

Nothing is stored and nothing is synced. This is a question asked during an
incident, not a dashboard: a nightly job over every repository would cost far
more than the feature is worth, and a stored answer would be stale exactly when
it mattered.

## How the ranking works

Three signals, weighted, because any one alone is misleading:

- **commits** (1.0) — who changed it
- **reviews** (0.7) — who read it. Close to a commit deliberately: during an
  incident the person who reviewed the change that broke it is often the fastest
  to recognise it
- **comments** (0.25) — who discussed it, which catches the person who argued
  about the design without touching the file

Each contribution decays with age, **halving every 90 days**. Ten commits last
week therefore outrank two hundred from three years ago, which is the point —
this ranks who is likely to *remember*, not who has done the most over all time.
A year-old contribution still counts about a sixteenth, so a long-departed owner
does not vanish from a list whose whole purpose is finding whoever knows it.

Scores are relative to the top person, not absolute. The question is who to ask
first; an absolute scale would read as "nobody here knows it" on a quiet
repository.

## Deliberate exclusions

**Bot accounts.** `github-actions` has more commits than any human and knows
nothing. A bot at the top of the list is the one outcome that makes the feature
useless.

**Lockfiles, for the library question.** They change on every unrelated install,
so whoever last ran one would rank as the expert on every library in the
project. Only manifests are read.

**Reviews, for a path lookup.** A review belongs to the pull request, not to one
file. Attributing repository-wide reviews to a single path would rank people who
never opened it.

## What it can and cannot see

Lookups run with **your own GitHub token**, not the app's. You see exactly what
you could see on github.com and nothing more — using the app's installation
token would let anyone signed in enumerate contributors on private repositories
they have no access to.

A partial answer says so. If one signal fails — issues disabled on a repository
404s that endpoint — the ranking is built from the rest and the panel names what
was lost, rather than presenting a thinner answer as complete.
