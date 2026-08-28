#!/usr/bin/env bash
#
# One-time: tell existing activity rows which event they recorded.
#
# The Activity feed names the event on the chip — "Repository made public",
# "Admin access granted" — by reading `importantKind` off the row. That field is
# written by `createAlert` and only exists on rows written since it was added.
# Older rows fall back to the generic "Security event", which is honest but is
# the label this whole change was meant to get rid of.
#
# The kind is recoverable, and not by guessing. Every one of these activity rows
# was written by `createAlert` in the same call that wrote an alert, and the
# alert carries the exact `type`. The alert's `message` is embedded verbatim in
# the activity row's `details`, after the "[SEVERITY]: " prefix. So this is a
# join on two stored strings, not a parse of prose:
#
#   alert    { repo: "acme/api", type: "repo_made_public", message: "Repository acme/api was made public." }
#   activity { repo: "acme/api", details: "Security Alert [CRITICAL]: Repository acme/api was made public." }
#
# Rows whose message matches no alert are left alone. The alerts table expires
# after 13 months and the activity table after the same, but they were not
# stamped from the same moment, so an activity row can outlive its alert. No
# match means the kind is genuinely unrecoverable, and the generic label is the
# right answer for it.
#
# Safe to run twice: each write is conditional on the field still being absent.
#
#   ./scripts/backfill-important-kind.sh                 # show what would change
#   ./scripts/backfill-important-kind.sh --apply         # do it
#
set -euo pipefail

PREFIX="${STACK_NAME:-github-control-hub}"
ALERTS="${PREFIX}-alerts"
ACTIVITY="${PREFIX}-activity"
PROFILE="${AWS_PROFILE:-}"
AWS=(aws)
[ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE")

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

echo "Alerts:   $ALERTS"
echo "Activity: $ACTIVITY"
echo "Mode:     $([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (pass --apply to write)')"
echo

alerts=$("${AWS[@]}" dynamodb scan \
  --table-name "$ALERTS" \
  --projection-expression "repo,#t,#m" \
  --expression-attribute-names '{"#t":"type","#m":"message"}' \
  --output json)

rows=$("${AWS[@]}" dynamodb scan \
  --table-name "$ACTIVITY" \
  --filter-expression "#a = :a AND attribute_not_exists(importantKind)" \
  --expression-attribute-names '{"#a":"action","#d":"details"}' \
  --expression-attribute-values '{":a":{"S":"security.alert"}}' \
  --projection-expression "pk,sk,repo,#d" \
  --output json)

# Each line: pk, sk, and the kind the alert says it was.
pairs=$(ALERTS_JSON="$alerts" ROWS_JSON="$rows" python3 -c '
import json, os, re

alerts = json.loads(os.environ["ALERTS_JSON"]).get("Items", [])
rows   = json.loads(os.environ["ROWS_JSON"]).get("Items", [])

# (repo, message) -> type. Where two alerts share both, they are the same kind
# of thing in the same place and either answer is the same answer.
by_key = {}
for a in alerts:
    repo = (a.get("repo") or {}).get("S", "")
    msg  = (a.get("message") or {}).get("S", "")
    typ  = (a.get("type") or {}).get("S", "")
    if repo and msg and typ:
        by_key[(repo, msg)] = typ

# Either prefix: rows written before the rename say "Security Alert", ones
# after say "Important event". Both carry the message verbatim after "]: ".
PREFIX = re.compile(r"^(?:Security Alert|Important event) \[[A-Z]+\]: ")

for r in rows:
    details = (r.get("details") or {}).get("S", "")
    if not PREFIX.match(details):
        continue
    typ = by_key.get(((r.get("repo") or {}).get("S", ""), PREFIX.sub("", details)))
    if typ:
        print("%s\t%s\t%s" % (r["pk"]["S"], r["sk"]["S"], typ))
')

total=$(ROWS_JSON="$rows" python3 -c '
import json, os
print(len(json.loads(os.environ["ROWS_JSON"]).get("Items", [])))
')

count=$(printf '%s\n' "$pairs" | grep -c . || true)
echo "$total activity row(s) have no kind recorded."
echo "$count of them match an alert and can be named."
echo

if [ "$count" = "0" ]; then
  echo "Nothing to write. Any unmatched rows keep the generic label, which is"
  echo "the honest answer when the kind cannot be recovered."
  exit 0
fi

if [ "$APPLY" != 1 ]; then
  printf '%s\n' "$pairs" | head -5 | while IFS=$'\t' read -r pk sk typ; do
    [ -n "$typ" ] && echo "    $typ"
  done
  echo
  echo "Dry run. Re-run with --apply to write them."
  exit 0
fi

done_n=0
while IFS=$'\t' read -r pk sk typ; do
  [ -z "$typ" ] && continue
  # Conditional, so a row that gained a kind since the scan is skipped rather
  # than overwritten with a second opinion.
  if "${AWS[@]}" dynamodb update-item \
      --table-name "$ACTIVITY" \
      --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"$sk\"}}" \
      --update-expression "SET importantKind = :k" \
      --condition-expression "attribute_not_exists(importantKind)" \
      --expression-attribute-values "{\":k\":{\"S\":\"$typ\"}}" \
      >/dev/null 2>&1; then
    done_n=$((done_n + 1))
  fi
done <<< "$pairs"

echo "Named $done_n of $count."
echo
echo "Only importantKind was added. Actions, timestamps, actors and details are"
echo "untouched, and no row was created or removed."
