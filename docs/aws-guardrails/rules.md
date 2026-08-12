# Rule catalog

Two kinds today. Both are enforceable, which is the reason they exist — rules
that could only report were removed, since a separate tool already did that and
the duplication produced noise nobody acted on.

## `s3_https_only`

Every bucket policy must deny requests arriving over plain HTTP.

| | |
|---|---|
| Resource | `s3:bucket` |
| Default mode | report |
| Params | `sid` — the statement name to manage |
| Fix | Merges a deny statement into the bucket policy |

**Coverage matters.** A bucket has two addressable halves —
`arn:aws:s3:::b` for the bucket and `arn:aws:s3:::b/*` for its objects. A deny
naming only the objects still leaves filenames listable over plain HTTP, so a
statement covering one half is not treated as protection.

**Merged by `Sid`, never replaced.** Statements with the managed name are
replaced; everything else survives. Overwriting a whole policy document could
silently cut off legitimate access.

## `log_retention_min`

Log groups must retain data for at least N days.

| | |
|---|---|
| Resource | `logs:log-group` |
| Default mode | report |
| Params | `minDays`, `setToDays`, `neverExpireIsCompliant`, `leaveLongerAlone` |
| Fix | Sets retention, rounded up to a value CloudWatch accepts |

CloudWatch only accepts a fixed list of retention periods, so a requested 400
days becomes the next value it will take rather than an API error.

Two params exist because "never expires" is ambiguous — for some organizations
it is the safest state, for others it is an unbounded bill. The rule asks rather
than deciding.

## Adding a kind

Add an entry to `catalog.ts` with an `evaluate()` and a `paramSchema`, and a
remediator if it can be fixed safely. The schema is what lets the UI render real
controls instead of asking someone to type raw JSON keys.

Anything whose fix could cut live access — revoking a security-group rule, for
instance — should have **no** remediator. Report-only is a property of the
catalog, not a setting someone can turn off by accident.
