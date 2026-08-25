#!/usr/bin/env bash
# Record an equipment or configuration change as a Grafana annotation.
#
# The point of one-change-at-a-time is that effects stay attributable, and that
# only holds if the change is visible on the same timeline as the effect. This
# puts an orange marker on every dashboard at the moment of the change.
#
# Usage:
#   ./scripts/mark-change.sh "cool airflow trim low/intermediate -> -9%"
#   ./scripts/mark-change.sh "dehumidification -> B" "2026-08-26 14:30"

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .grafana-env ] || { echo "error: .grafana-env not found" >&2; exit 2; }
# shellcheck disable=SC1091
set -a; . ./.grafana-env; set +a
: "${GRAFANA_URL:?}" "${GRAFANA_TOKEN:?}"

TEXT="${1:-}"
[ -n "$TEXT" ] || { echo "usage: $0 \"what changed\" [\"YYYY-MM-DD HH:MM\" local]" >&2; exit 2; }
WHEN="${2:-}"

MS=$(python3 - "$WHEN" <<'PY'
import sys, time, datetime
w = sys.argv[1] if len(sys.argv) > 1 else ""
if w:
    # Naive local time, matching how the readings table is read back.
    dt = datetime.datetime.strptime(w, "%Y-%m-%d %H:%M")
    print(int(dt.timestamp() * 1000))
else:
    print(int(time.time() * 1000))
PY
)

python3 - "$MS" "$TEXT" > .annotation.json <<'PY'
import json, sys
print(json.dumps({"time": int(sys.argv[1]),
                  "tags": ["daikin", "config-change"],
                  "text": sys.argv[2]}))
PY

curl -sS -X POST "${GRAFANA_URL%/}/api/annotations" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" -H 'Content-Type: application/json' \
  --data @.annotation.json -o .annotation-resp.json
python3 - <<'PY'
import json, datetime
r = json.load(open(".annotation-resp.json", encoding="utf-8"))
b = json.load(open(".annotation.json", encoding="utf-8"))
when = datetime.datetime.fromtimestamp(b["time"] / 1000).strftime("%Y-%m-%d %H:%M")
print(f"{r.get('message','?')} (id {r.get('id')}) at {when}: {b['text']}")
PY
rm -f .annotation.json .annotation-resp.json
