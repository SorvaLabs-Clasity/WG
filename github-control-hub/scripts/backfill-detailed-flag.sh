#!/usr/bin/env bash
#
# One-time: mark historical rows as detailed, so the feed's "hide detailed rows"
# filter covers them.
#
# Rows written before detailed logging existed carry no `detailed` flag, so the
# filter leaves them on screen while hiding their newer equivalents. That reads
# as the filter being broken rather than as the rows predating it.
#
# Only rows GitHub reported are touched. A branch deleted *through this app* is
# recorded by routes/branches.ts with an undo payload and is not detailed
# traffic: it is a thing somebody did here, and it stays visible.
#
# Safe to run twice. It writes only where the flag is absent.
#
#   ./scripts/backfill-detailed-flag.sh                 # show what would change
#   ./scripts/backfill-detailed-flag.sh --apply         # do it
#
set -euo pipefail

PREFIX="${STACK_NAME:-github-control-hub}"
TABLE="${PREFIX}-activity"
PROFILE="${AWS_PROFILE:-}"
AWS=(aws)
[ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE")

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Which actions are detailed traffic. Kept in step with DETAILED_LOG_KINDS in
# backend/src/webhooks/detailedLogging.ts.
ACTIONS=("branch.create" "branch.delete" "tag.create" "tag.delete"
         "github.push" "github.pr_opened" "github.pr_merged" "github.pr_closed")

echo "Table:  $TABLE"
echo "Mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (pass --apply to write)')"
echo

total=0
for action in "${ACTIONS[@]}"; do
  # source = github: only what GitHub reported. Rows this app wrote itself carry
  # an undo payload and are not detailed traffic.
  rows=$("${AWS[@]}" dynamodb scan \
    --table-name "$TABLE" \
    --filter-expression "#a = :a AND #s = :s AND attribute_not_exists(detailed)" \
    --expression-attribute-names '{"#a":"action","#s":"source"}' \
    --expression-attribute-values "{\":a\":{\"S\":\"$action\"},\":s\":{\"S\":\"github\"}}" \
    --projection-expression "pk, sk" \
    --output json)

  n=$(echo "$rows" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["Items"]))')
  [ "$n" = "0" ] && { printf "  %-22s %s\n" "$action" "none"; continue; }
  printf "  %-22s %s\n" "$action" "$n"
  total=$((total + n))

  [ "$APPLY" = 0 ] && continue

  echo "$rows" | python3 -c '
import sys, json, subprocess, os
items = json.load(sys.stdin)["Items"]
table, profile = os.environ["TABLE"], os.environ.get("PROFILE", "")
for it in items:
    cmd = ["aws", "dynamodb", "update-item",
           "--table-name", table,
           "--key", json.dumps({"pk": it["pk"], "sk": it["sk"]}),
           "--update-expression", "SET detailed = :t",
           # Only where it is still absent, so a concurrent write is not clobbered
           # and a second run of this script is a no-op rather than a rewrite.
           "--condition-expression", "attribute_not_exists(detailed)",
           "--expression-attribute-values", json.dumps({":t": {"BOOL": True}})]
    if profile: cmd += ["--profile", profile]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and "ConditionalCheckFailed" not in r.stderr:
        print("   failed:", it["sk"]["S"][:40], r.stderr.strip()[:120], file=sys.stderr)
'
done

echo
if [ "$APPLY" = 1 ]; then
  echo "Marked $total row(s) as detailed."
else
  echo "$total row(s) would be marked. Re-run with --apply to write."
fi
