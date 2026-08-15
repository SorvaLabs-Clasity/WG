# Features

One page per tab. Each says what the tab answers, where the data comes from,
and — usually the most useful part — what it deliberately does not tell you.

| Tab | Page | Answers |
|---|---|---|
| Overview | [overview.md](overview.md) | How is the org doing, on checks I chose |
| AWS | [../aws-guardrails/](../aws-guardrails/) | What is wrong in our AWS accounts |
| Security | [security-checks.md](security-checks.md) | Which repos fail which check |
| Access | [access-map.md](access-map.md) | Who can reach what, and how |
| Vulnerabilities | [dependabot.md](dependabot.md) · [renovate.md](renovate.md) | What is vulnerable, and what has been raised to fix it |
- [who-knows.md](who-knows.md) — ranking people by what they have touched, for incidents
- [ci-correlation.md](ci-correlation.md) — spotting that many CI failures share one cause
| Repos | [repos.md](repos.md) | Everything about one repository |
| Activity | [activity-and-undo.md](activity-and-undo.md) | What changed, who did it, undo |

Also here:

- [Config transfer](config-transfer.md) — export and import the app's own setup
- [Audit log](audit-log.md) — the enterprise's own record of who did what
- [Alarms and email](alarms.md) — thresholds on widgets, and security alerts by email
