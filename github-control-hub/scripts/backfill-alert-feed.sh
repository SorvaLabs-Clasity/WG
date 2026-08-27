#!/usr/bin/env bash
#
# One-time: put existing alerts into the time index, so the Security tab can see
# them.
#
# The tab reads through `feed-index`, a global secondary index keyed on
# feed="ALERT" with the timestamp as its sort key. That is what makes "the
# newest three hundred" a real query rather than a scan of the whole table.
#
# A GSI only holds rows that carry both of its key attributes. Alerts written
# before the index existed have no `feed`, so they are **invisible to the tab**
# until this runs. They are not lost: the row is untouched and still there.
#
# Safe to run twice. It writes only where `feed` is absent, and a row that
# already has one is left alone by the condition rather than by this script
# guessing.
#
#   ./scripts/backfill-alert-feed.sh                 # show what would change
#   ./scripts/backfill-alert-feed.sh --apply         # do it
#
set -euo pipefail

PREFIX="${STACK_NAME:-github-control-hub}"
TABLE="${PREFIX}-alerts"
PROFILE="${AWS_PROFILE:-}"
AWS=(aws)
[ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE")

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

echo "Table:  $TABLE"
echo "Mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (pass --apply to write)')"
echo

# Only rows without a `feed`. Reading them all is fine: this runs once, against
# a table the whole point of the index is to stop scanning *routinely*.
rows=$("${AWS[@]}" dynamodb scan \
  --table-name "$TABLE" \
  --filter-expression "attribute_not_exists(feed)" \
  --projection-expression "id" \
  --output json)

ids=$(printf '%s' "$rows" | python3 -c '
import json, sys
for item in json.load(sys.stdin).get("Items", []):
    print(item["id"]["S"])
')

if [ -z "$ids" ]; then
  echo "Nothing to do: every alert is already in the index."
  exit 0
fi

count=$(printf '%s\n' "$ids" | grep -c . || true)
echo "$count alert(s) are not in the index."

if [ "$APPLY" != 1 ]; then
  echo
  echo "Dry run. Re-run with --apply to add them."
  exit 0
fi

echo
done_n=0
while IFS= read -r id; do
  [ -z "$id" ] && continue
  # `attribute_not_exists(feed)` makes this idempotent at the item level rather
  # than relying on the scan above still being accurate by the time we write.
  # A row that gained a `feed` in between is skipped, not overwritten.
  if "${AWS[@]}" dynamodb update-item \
      --table-name "$TABLE" \
      --key "{\"id\":{\"S\":\"$id\"}}" \
      --update-expression "SET feed = :f" \
      --condition-expression "attribute_not_exists(feed)" \
      --expression-attribute-values '{":f":{"S":"ALERT"}}' \
      >/dev/null 2>&1; then
    done_n=$((done_n + 1))
  fi
done <<< "$ids"

echo "Added $done_n of $count to the index."
echo
echo "A GSI is populated asynchronously, so give it a moment before the tab"
echo "shows them. Nothing was deleted or changed apart from the new attribute."
