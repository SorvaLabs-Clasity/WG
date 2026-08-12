# Configuration transfer

Export everything the organization configured, and import it somewhere else.
Lives on the Templates tab, restricted to the
[Control Hub admin team](../auth/permissions-model.md).

## Why it exists

Templates, rule templates, exclusion lists, scanners, widgets and AWS guardrails
live only in DynamoDB, and standing up a second account creates empty tables.
Without this, moving to another account means retyping every branch rule and
ruleset by hand — and there is no backup of any of it.

## What is included

`templates`, `ruleTemplates`, `exclusions`, `scanners`, `widgets`,
`awsGuardrails`, `awsExclusions`.

## What is not, and why

**Findings and activity.** They are observations about one account at one
moment, not configuration. Carrying them across would be importing somebody
else's history as your own.

## Import semantics

- **Dry run first, always.** The counts are shown before anything is written.
  The honest answer to "what will this do to my production account" is a list,
  not a promise.
- **Overwrites by id, deletes nothing.** An import adds to an account rather
  than replacing it — replacing would silently drop whatever the target had
  that the source did not.
- **Rule templates are written before templates**, since templates reference
  them.
- **An entry with no id is skipped and reported.** An id is what makes an import
  idempotent; inventing one turns a re-import into a duplicate.
- **One failure does not abandon the rest**, and each failure names the record
  and the reason.

## Format

A JSON file carrying a format version. An export from a newer version is refused
rather than partially understood.
