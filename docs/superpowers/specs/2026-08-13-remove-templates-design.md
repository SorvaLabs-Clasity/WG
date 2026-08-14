# Removing Templates and Exclusions — design

**Date:** 2026-08-13

## Goal

Delete the Templates feature entirely: repository templates, rule templates
(the protection presets), auto-apply on new repositories, one-click preset
application, and the exclusion lists that scoped auto-apply.

Exclusions go with it. Their only consumer is `TemplatesPage.tsx:185`, the sole
importer of `useExclusions`, and their only purpose is telling auto-apply which
repositories to skip. Without templates they would be a settings screen nobody
reads. AWS guardrail exclusions (`/aws/exclusions`, the `aws-exclusions` table,
`AwsPage`) are a separate system and are untouched.

## What must survive

The feature goes; its history stays readable. Rows for `template.apply`,
`template.apply.repo`, `template.create/update/delete` and the exclusion
equivalents already exist in DynamoDB and must keep rendering.

**No DynamoDB row is deleted, and no table is dropped.** Nothing in this repo
can drop a table — `delete-table` and `DeleteTable` appear nowhere in `scripts/`,
`backend/src/` or `infra/`. The two tables are created by the `TABLES[@]` loop in
`scripts/setup-aws-account.sh`, whose `create_table` skips tables that already
exist. They are removed from that array so fresh accounts stop creating them,
and left in place everywhere they already exist. Unread rows cost nothing at
PAY_PER_REQUEST, and reversing a deletion is impossible.

## Frontend

**Deleted:** `pages/TemplatesPage.tsx` and its route; the Templates entry in
`components/Navbar.tsx:26`; `api/templates.ts`, `api/ruleTemplates.ts`,
`api/exclusions.ts`; `hooks/useTemplates.ts`, `hooks/useRuleTemplates.ts`,
`hooks/useExclusions.ts`; `types/Template.ts`, `types/RuleTemplate.ts`; template
and exclusion entries in `api/mock.ts`.

**Modified:** `ProtectBranchModal`, `ProtectTagModal`, `ProtectPushModal` lose
the preset dropdown. `ruleTemplateOptions` and `onPickRuleTemplate` are optional
props, so the props and the picker block go (around `ProtectBranchModal:164`,
`:346`, `:524-545`).

**Correction (found during the follow-up cleanup review):** this section
originally claimed the modals' manual protection configuration "is untouched
and must keep working — that is the whole remaining purpose of those modals."
That was wrong. `TemplatesPage.tsx` was their only caller — nothing else in the
frontend imported `ProtectBranchModal`, `ProtectTagModal`, `ProtectPushModal` or
the `RulesetShared` helpers they share — so deleting it left all four files,
plus the `types/Protection.ts` they depend on, unreachable rather than merely
lighter. The review deleted them outright, with the user confirming they were
part of the Templates feature and had no purpose left to serve.

### `buildConflictComparison` has to move

`pages/ActivityPage.tsx:10` imports `buildConflictComparison` from
`api/templates.ts`, and uses it at `:882` to render the comparison table inside
historical conflict rows. Deleting `api/templates.ts` would break the Activity
page.

It is a pure display function. Move it into the frontend alongside the Activity
page rather than deleting it, so historical conflict rows still render their
before/after table. Losing the feature should not mean losing the ability to
read what it did.

### `ACTION_CONFIG` entries stay

`ActivityPage.tsx:352`, `:468`, `:475` and `:795` already fall back to
`{ label: entry.action, … }` for unrecognised actions, so removing the template
entries would not crash — it would render raw strings like `template.apply`.

Keep them. They are four lines of label and colour that make existing history
legible, and they cost nothing once the code that emits them is gone.

## Backend

**Deleted:** `routes/templates.ts`, `routes/ruleTemplates.ts`,
`routes/exclusions.ts` and their mounts at `server.ts:117-119` (plus the imports
at `:11-13`); `services/templateService.ts`, `services/ruleTemplateService.ts`,
`services/exclusionService.ts`; the auto-apply block in
`webhooks/processDelivery.ts` and in `routes/webhooks.ts`.

**`routes/config.ts`:** the `templates`, `ruleTemplates` and `exclusions`
sections, their entries in `IMPORT_ORDER` and their raw writers.

### Undo handlers go; undo history stays readable

`routes/activity.ts` carries undo and redo cases for `delete_exclusion`,
`restore_exclusion`, `revert_exclusion` and the template equivalents, calling
`putExclusionRaw`/`deleteExclusionRaw` and their template counterparts. Those
services are being deleted, so the handlers go with them.

`canUndo` in `ActivityPage.tsx:107-111` decides from `entry.undoPayload`, not
from a list of known actions — so a historical template row that carries an undo
payload will still show an Undo button. Pressing it must fail clearly rather
than silently appearing to work. The undo dispatch's fallback path must return
an explicit "this action can no longer be undone — the feature was removed"
error.

The corresponding entries in `undoPolicy.ts` (`delete_template`,
`restore_template`, `revert_template`, `delete_exclusion`, `restore_exclusion`,
`revert_exclusion`) are removed. Verify that an action absent from the policy is
**denied** rather than permitted — this codebase fails closed elsewhere and must
here.

### Conflict resolution goes; conflict display stays

Conflicts are created only by `templateService.ts` (four call sites, all
`conflictPayload:`). No new conflict can occur once it is gone.

The stored fields on `activityService.ts` (`conflictPayload`,
`conflictResolution`) stay — they are data on rows that already exist. The
resolve action in `routes/activity.ts:460+` goes: resolving with "override"
applies a template's configuration to a repository, which requires the deleted
service. Historical unresolved `conflict.pending` rows render as history, and
the resolve affordance is not offered for them.

## Config bundle

`FORMAT` goes from 1 to 2.

Import already rejects only `bundle.format > FORMAT`, so an old format-1 bundle
still imports — its template sections are simply no longer iterated once they
leave `IMPORT_ORDER`, which is benign. The risk runs the other way: an older
build reading a new bundle would find `bundle.templates` undefined. Bumping the
format makes that fail with the existing "written by a newer version" message
instead of crashing on a missing section.

## Effect on the webhook migration

Auto-apply is the only GitHub **write** in the webhook path — `git.createRef`,
`createOrUpdateFileContents`, `updateBranchProtection`, `createRepoRuleset` all
live inside it. With it gone:

- The worker Lambda performs no GitHub writes. The GitHub App can drop
  `Administration: write` and `Contents: write`. That is a change made in
  GitHub's UI, not in this repository, and is left to the operator.
- The worker's 10-minute timeout was sized for the five-second provisioning wait
  plus four `applyTemplate` retries. Reassess it — the remaining work is
  compliance refresh, graph edges and scanner runs.
- A final-review finding — that the auto-apply retry loop was unbounded and
  could exceed the function timeout — is deleted rather than fixed.

The delivery lock still earns its place. A reprocessed delivery would still
write duplicate alerts and activity rows, and SQS remains at-least-once.

## Tests

**`repro-undo.ts`** names `templates.ts` in its `GUARDED` list. That row goes
because the file goes. The suite's real assertion — that every route file with
writes is either guarded or explicitly exempt — must still pass for the
remaining files, and the exempt list must not grow to cover something that
should be guarded.

**`repro-config.ts`** asserts the bundle's sections. Update to the reduced set
and the new `FORMAT`.

Neither suite is weakened. Removing an entry for a deleted file is not the same
as relaxing a check.

## Out of scope

- Deleting any DynamoDB table or row.
- Changing the GitHub App's permission scopes (done in GitHub's UI).
- Anything in the AWS guardrails feature, including its own exclusion lists.
