#!/usr/bin/env bash
#
# One-time: relabel security alerts that were logged as "Issue Opened".
#
# `createAlert` used to write its activity row as `"github.issue_opened" as any`
# — and the cast is the tell, because nothing there opens an issue. The Activity
# tab therefore showed every security alert under a green "Issue Opened" chip:
# a different event, on a different part of GitHub, and the one row somebody
# scanning for a security alert would skip past.
#
# The code was fixed; rows written before it were not. This rewrites their
# `action` to `security.alert`, which the Activity tab renders as a rose
# "Security Alert".
#
# Only rows that are actually security alerts are touched. Nothing in this app
# has ever written a genuine `github.issue_opened` row, but the filter still
# requires the security-alert target rather than trusting that, so a real issue
# row arriving later cannot be caught by a re-run.
#
# Safe to run twice: each write is conditional on the row still carrying the old
# action, so a row already fixed is skipped rather than rewritten.
#
#   ./scripts/backfill-security-alert-action.sh                 # show what would change
#   ./scripts/backfill-security-alert-action.sh --apply         # do it
#
set -euo pipefail

PREFIX="${STACK_NAME:-github-control-hub}"
TABLE="${PREFIX}-activity"
PROFILE="${AWS_PROFILE:-}"
AWS=(aws)
[ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE")

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

echo "Table:  $TABLE"
echo "Mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (pass --apply to write)')"
echo

# Every attribute is aliased, including ones that look safe. DynamoDB's reserved
# word list is long and unmemorable, and a projection naming a reserved word
# fails the whole scan rather than skipping that field, which under `set -e`
# ends the script before it prints anything useful.
#
# `target` is the discriminator: createAlert has always written "security_alert"
# there. The `details` prefix is checked too, because a target alone would also
# match anything else that ever adopted that word.
#
# Either prefix. Rows written before the feature was renamed say "Security
# Alert"; ones written after say "Important event". Both are the same event and
# both need the same action.
rows=$("${AWS[@]}" dynamodb scan \
  --table-name "$TABLE" \
  --filter-expression "#a = :old AND #t = :tgt" \
  --expression-attribute-names '{"#a":"action","#t":"target","#d":"details"}' \
  --expression-attribute-values '{":old":{"S":"github.issue_opened"},":tgt":{"S":"security_alert"}}' \
  --projection-expression "pk,sk,#d" \
  --output json)

keys=$(printf '%s' "$rows" | python3 -c '
import json, sys
items = json.load(sys.stdin).get("Items", [])
for it in items:
    # `details`, not `message`. logActivity takes (action, actor, repo, target,
    # details, ...) and the caller passes the "Security Alert [...]" string in
    # the fifth position, so that is where it is stored. Reading `message` found
    # nothing on every row and silently dropped all of them, which the script
    # then reported as "nothing to do".
    text = (it.get("details") or {}).get("S", "")
    if not (text.startswith("Security Alert [") or text.startswith("Important event [")):
        continue
    print("%s\t%s" % (it["pk"]["S"], it["sk"]["S"]))
')

if [ -z "$keys" ]; then
  echo "Nothing to do: no security alerts are labelled as issues."
  exit 0
fi

count=$(printf '%s\n' "$keys" | grep -c . || true)
echo "$count row(s) are labelled \"Issue Opened\" and are security alerts."

if [ "$APPLY" != 1 ]; then
  echo
  printf '%s\n' "$rows" | python3 -c '
import json, sys
for it in json.load(sys.stdin).get("Items", [])[:5]:
    text = (it.get("details") or {}).get("S", "")
    if text.startswith(("Security Alert [", "Important event [")):
        print("    " + text[:90])
'
  echo
  echo "Dry run. Re-run with --apply to relabel them."
  exit 0
fi

echo
done_n=0
while IFS=$'\t' read -r pk sk; do
  [ -z "$pk" ] && continue
  # Conditional on the old value, so a row fixed by a concurrent run or an
  # earlier pass is skipped rather than written again.
  if "${AWS[@]}" dynamodb update-item \
      --table-name "$TABLE" \
      --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"$sk\"}}" \
      --update-expression "SET #a = :new" \
      --condition-expression "#a = :old" \
      --expression-attribute-names '{"#a":"action"}' \
      --expression-attribute-values '{":new":{"S":"security.alert"},":old":{"S":"github.issue_opened"}}' \
      >/dev/null 2>&1; then
    done_n=$((done_n + 1))
  fi
done <<< "$keys"

echo "Relabelled $done_n of $count."
echo
echo "Only the action changed. Timestamps, messages, actors and details are"
echo "untouched, and no row was created or removed."
