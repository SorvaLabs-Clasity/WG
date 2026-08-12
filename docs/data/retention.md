# Retention

## Activity: thirteen months

A year of audit history plus a month of slack, so an auditor looking back twelve
months always finds a complete record.

Implemented as a DynamoDB TTL attribute stamped from **each row's own
timestamp**, not from write time. DynamoDB only deletes items that carry the
attribute, so:

- rows written before TTL existed never expire — they are not silently lost
- a backdated row expires on its own schedule, not thirteen months from import

The Lambda writes activity rows too, and stamps the same TTL. That value is
inlined there rather than imported, because the handler is bundled on its own —
and a row without the stamp is a row that never expires.

## Findings: overwritten, not accumulated

The findings table answers "what is true now". Each sweep overwrites in place,
keyed by account, region, rule and resource. History lives in the activity feed,
which is the thing that records *changes*.

Findings for a deleted rule are removed, so the UI does not show results for a
rule that no longer exists. Findings from before multi-account support are
dropped on the next full sweep, once the same facts have been rewritten under
their account-qualified keys.

## Auth codes

Short-lived OAuth exchange codes with a TTL, so an unused code cannot sit around
being exchangeable.

## Everything else

No retention. Templates, exclusions, widgets and the graph live until changed or
rebuilt.
