#!/bin/bash
# Render every screen as each harness person, in real Chrome, and summarise.
#
#   e2e/run.sh [github|aws-only] [out-dir]      from github-control-hub/backend
#
# Needs Google Chrome installed, and playwright-core (not a repo dependency):
#   npm i --no-save playwright-core          — or install it anywhere and set
#   PLAYWRIGHT_CORE=/that/node_modules/playwright-core
# Starts its own harness on 4100 and Vite on 5273, so a dev server already on
# 4000/5173 is left alone. One fresh harness per person, so the server's own
# rate limit never carries from one walkthrough into the next.
set -e
MODE=${1:-github}; OUT=${2:-/tmp/control-hub-e2e-$MODE}
HERE=$(cd "$(dirname "$0")" && pwd); B=$(dirname "$HERE"); F=$(dirname "$B")/frontend
PEOPLE=$([ "$MODE" = aws-only ] && echo "fran" || echo "fran carl ava root nia ned")
rm -rf "$OUT"; mkdir -p "$OUT"
lsof -ti:5273 -sTCP:LISTEN | xargs kill 2>/dev/null || true
(cd "$F" && VITE_PROXY_TARGET=http://127.0.0.1:4100 VITE_BACKEND_URL=http://127.0.0.1:4100 \
  nohup npx vite --port 5273 --strictPort > "$OUT/vite.log" 2>&1 < /dev/null &)
for i in $(seq 1 60); do curl -sf http://localhost:5273 >/dev/null && break; sleep 0.5; done
for who in $PEOPLE; do
  lsof -ti:4100 -sTCP:LISTEN | xargs kill 2>/dev/null || true; sleep 0.5
  (cd "$B" && nohup npx tsx e2e/harness-server.ts "$MODE" 4100 > "$OUT/harness-$who.log" 2>&1 < /dev/null &)
  for i in $(seq 1 80); do grep -q '"sessions"' "$OUT/harness-$who.log" 2>/dev/null && break; sleep 0.25; done
  node "$HERE/render.mjs" "$HERE/.sessions.json" "$OUT" "$who" > /dev/null
done
lsof -ti:4100 -sTCP:LISTEN | xargs kill 2>/dev/null || true
lsof -ti:5273 -sTCP:LISTEN | xargs kill 2>/dev/null || true
python3 "$HERE/summarise.py" "$OUT/report.json"
echo; echo "Screenshots: $OUT/<person>/"
