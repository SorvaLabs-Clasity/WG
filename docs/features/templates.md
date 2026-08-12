# Templates

Two related things share this tab, and they are easy to confuse.

## Templates

A **template** is what a repository should look like when it is created:
branches to create, files to seed, protection to apply, rulesets to install.

Applied by:

- pressing Apply against chosen repositories, or
- automatically, when a repository is created — see
  [webhooks](../github-api/webhooks.md)

Exclusion lists are checked before applying, so a scratch repository can be
skipped by name or pattern.

## Rule templates

A **rule template** is a reusable protection or ruleset definition that
templates reference. Editing one changes every template that uses it, instead
of editing the same branch-protection block in nine places.

Put simply: a template says *what to set up*; a rule template says *what "our
standard protection" means*.

## Exclusion lists

Named sets of repositories to skip, matched by:

- exact name
- pattern (`starts_with`, `contains`)
- tag equality

With a whitelist that wins over patterns, so one repository can be pulled back
into scope without unpicking the rule that excluded it.

## Who can edit

The [Control Hub admin team](../auth/permissions-model.md). Applying a template
to a repository still uses **your** token, so GitHub decides whether you may
actually change that repository.

## Configuration transfer

The same tab carries export and import of everything above. See
[config transfer](config-transfer.md).
