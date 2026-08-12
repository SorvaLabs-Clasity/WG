# AWS exclusion lists

A named set of resources every rule attached to it should skip.

## Matching

| Type | Matches |
|---|---|
| Exact | The resource id exactly |
| `starts_with` | Prefix of the resource id |
| `contains` | Substring of the resource id |
| `tag_equals` | `Key=Value` on the resource's tags |

Plus a **whitelist**, which wins over patterns — so `sandbox-*` can be excluded
while `sandbox-prod-mirror` is pulled back into scope, without unpicking the
pattern.

## What an exclusion does

An excluded resource produces a finding with verdict `not_applicable` and the
reason it was skipped. It is not silently dropped: the report distinguishes
"checked and fine" from "deliberately not checked", and both from "never
looked at".

## Attaching

Exclusion lists are attached per rule. The same list can serve several rules,
and a rule can use several lists.

## Why by tag

Resource names drift; tags are the thing organizations actually maintain.
`tag_equals` lets a rule skip everything tagged `Environment=sandbox` without
anyone maintaining a list of names.
