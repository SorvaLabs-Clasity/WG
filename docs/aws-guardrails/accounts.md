# Multiple AWS accounts

Guardrails run in every registered account. The account hosting the app is
always included and needs no setup.

## How other accounts are reached

By assuming a role that account grants — never a stored key, unless you choose
that for an account outside your organization.

**Exactly one role name is assumable**, `github-control-hub-guardrail-access`.
The app's IAM permits nothing else, which is why it cannot use
`OrganizationAccountAccessRole` even though AWS puts it in every organization
account. That role carries AdministratorAccess.

## Three ways to grant access

| Method | Setup | Notes |
|---|---|---|
| Organization | Deploy one StackSet | Covers chosen or all accounts |
| Specific role | Deploy one stack in that account | For accounts outside the org |
| Access key | Paste into the app | Last resort; kept in Secrets Manager |

The app's **AWS → Accounts → How do I add an account?** panel generates the
template, every parameter, a fresh external ID, and console links. It does not
press Create — that requires permissions which would let the holder deploy an
administrator role into every account, which is worse than what was removed.

## Choosing which accounts

"All of them" is offered, never assumed:

| | Reaches | Accounts created later |
|---|---|---|
| Accounts I choose | only the ids you list | not included |
| Every account | the whole organization | included automatically |
| Just one | one account | repeat per account |

The chosen-accounts form uses `AccountFilterType=INTERSECTION`. Without it,
naming accounts alongside an organizational unit deploys to the whole unit as
well.

## Behavior during a sweep

- Each account is visited in turn, each of its regions separately
- An account that cannot be reached is **reported and skipped** — losing sight
  of dev is not a reason to stop checking prod
- Findings are keyed on account and region, since two accounts routinely have a
  log group with the same name
- Buckets in a region the account does not sweep are counted and named, because
  a resource nobody looked at reads on screen exactly like a compliant one
