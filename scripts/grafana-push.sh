#!/usr/bin/env bash
# Push generated dashboards to Grafana and read back what landed.
#
# Credentials come from .grafana-env (gitignored), never from argv, so the
# token cannot appear in shell history or `ps`.
#
# Usage:
#   ./scripts/grafana-push.sh                      push the generated dashboards
#   ./scripts/grafana-push.sh grafana/dashboard-energy.json
#   ./scripts/grafana-push.sh --verify             list what Grafana currently has

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .grafana-env ] || { echo "error: .grafana-env not found; copy .grafana-env.example" >&2; exit 2; }
# shellcheck disable=SC1091
set -a; . ./.grafana-env; set +a
: "${GRAFANA_URL:?GRAFANA_URL not set in .grafana-env}"
: "${GRAFANA_TOKEN:?GRAFANA_TOKEN not set in .grafana-env}"

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" "${GRAFANA_URL%/}$path" \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    -H 'Content-Type: application/json' "$@"
}

if [ "${1:-}" = "--verify" ]; then
  echo "== dashboards in Grafana =="
  api GET '/api/search?type=dash-db' > /tmp/gf_search.json
  python3 scripts/grafana_fmt.py search /tmp/gf_search.json
  echo
  echo "== infinity datasources =="
  api GET '/api/datasources' > /tmp/gf_ds.json
  python3 scripts/grafana_fmt.py datasources /tmp/gf_ds.json
  exit 0
fi

FILES=("$@")
[ ${#FILES[@]} -eq 0 ] && FILES=(grafana/dashboard-energy.json grafana/dashboard-health.json)

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "skip (missing): $f" >&2; continue; }
  python3 scripts/grafana_fmt.py payload "$f" > /tmp/gf_body.json
  printf '%-34s ' "$(basename "$f")"
  api POST '/api/dashboards/db' --data @/tmp/gf_body.json > /tmp/gf_resp.json
  python3 scripts/grafana_fmt.py result /tmp/gf_resp.json
done
