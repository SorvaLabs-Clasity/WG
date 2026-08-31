#!/usr/bin/env bash
#
# What the alarm and guardrail checking actually costs this account, per month.
#
# Estimated from the tables as they are rather than from a guess at "a large
# organization". The dominant term is the graph scan on every alarm pass, and it
# scales with the size of your graph, which nobody can guess for you.
#
# On-demand pricing, us-east-2, as of August 2026. Change RCU_PRICE and friends
# if AWS moves them or you are in another region.

set -uo pipefail

bold=$(tput bold 2>/dev/null || true); off=$(tput sgr0 2>/dev/null || true)
dim=$(tput dim 2>/dev/null || true)
die() { echo "  ✗ $*" >&2; exit 1; }
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply
  read -r -p "  $__prompt [$__default]: " __reply
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

command -v aws >/dev/null || die "aws CLI not found."
command -v node >/dev/null || die "node not found."

echo; echo "${bold}── Account ──${off}"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  ask AWS_PROFILE_IN "AWS profile" "${AWS_PROFILE:-}"
  export AWS_PROFILE="$AWS_PROFILE_IN"
  aws sts get-caller-identity >/dev/null 2>&1 || aws sso login --profile "$AWS_PROFILE" || die "Could not sign in."
fi
ask REGION "AWS region" "${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
export AWS_REGION="$REGION"
ask PREFIX "Resource name prefix" "github-control-hub"

# DynamoDB reports table size and item count, updated roughly every six hours.
# Good enough: this is an estimate, and the number moves slowly.
size_of() {
  aws dynamodb describe-table --table-name "$1" \
    --query 'Table.[TableSizeBytes,ItemCount]' --output text 2>/dev/null || echo "0 0"
}

read -r EDGES_B EDGES_N   <<<"$(size_of "${PREFIX}-graph-edges")"
read -r FIND_B  FIND_N    <<<"$(size_of "${PREFIX}-aws-findings")"
read -r ALARM_B ALARM_N   <<<"$(size_of "${PREFIX}-alarms")"
read -r WIDG_B  WIDG_N    <<<"$(size_of "${PREFIX}-widgets")"

echo; echo "${bold}── What is there ──${off}"
printf "    graph-edges   %10s bytes  %6s items\n" "$EDGES_B" "$EDGES_N"
printf "    aws-findings  %10s bytes  %6s items\n" "$FIND_B"  "$FIND_N"
printf "    alarms        %10s bytes  %6s items\n" "$ALARM_B" "$ALARM_N"
printf "    widgets       %10s bytes  %6s items\n" "$WIDG_B"  "$WIDG_N"

EDGES_B="$EDGES_B" FIND_B="$FIND_B" ALARM_B="$ALARM_B" WIDG_B="$WIDG_B" WIDG_N="$WIDG_N" node -e '
const b = k => Number(process.env[k] || 0);
const RCU = 0.25 / 1e6;          // per read unit, on-demand
const WCU = 1.25 / 1e6;          // per write unit
const REQ = 0.20 / 1e6;          // per Lambda request
const GBS = 0.0000166667;        // per GB-second
const MEM = 0.5;                 // both functions are 512 MB

const alarmPasses = 30 * 24 * 12;   // every 5 minutes
const sweeps      = 30 * 24 * 6;    // every 10 minutes

// A scan bills 0.5 read units per 4KB, eventually consistent.
const scan = (bytes, times) => (bytes / 4096) * 0.5 * times * RCU;

// One graph reading per pass, because the pass is pinned. Before that the
// six-second cache expired inside a long pass and this was several times more.
const graph    = scan(b("EDGES_B"), alarmPasses);
const findings = scan(b("FIND_B"), alarmPasses + sweeps * 2);
const small    = scan(b("ALARM_B") + b("WIDG_B"), alarmPasses);

// One snapshot per widget per pass.
const writes = Number(process.env.WIDG_N || 0) * alarmPasses * WCU;

// Duration is the one thing not readable from a table. Two shapes, so the
// answer is a range rather than a number pretending to be exact.
const lambda = s => alarmPasses * REQ + alarmPasses * s * MEM * GBS
                  + sweeps * REQ + sweeps * (s / 2) * MEM * GBS;

const fixed = graph + findings + small + writes;
const lo = fixed + lambda(15), hi = fixed + lambda(90);

const money = n => "$" + n.toFixed(2).padStart(7);
console.log("");
console.log("── Per month ──");
console.log("    graph scan, one per alarm pass  " + money(graph));
console.log("    findings scans                  " + money(findings));
console.log("    alarms and widgets tables       " + money(small));
console.log("    snapshot writes                 " + money(writes));
console.log("    Lambda (15s to 90s per pass)    " + money(lambda(15)) + " to" + money(lambda(90)));
console.log("");
console.log("    TOTAL                           " + money(lo) + " to" + money(hi) + " / month");
console.log("");
if (graph > lo * 0.4) {
  console.log("  The graph scan is the largest line. It is read once per alarm pass,");
  console.log("  every five minutes, because the pass recomputes every widget for the");
  console.log("  dashboard. Halving the pass rate roughly halves this.");
}
console.log("  GitHub API costs nothing: it is rate-limited, not billed.");
'
