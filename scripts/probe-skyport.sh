#!/usr/bin/env bash
# Dump what YOUR thermostat actually reports from the Skyport consumer API,
# so field selection is based on your hardware rather than on a field list.
#
# Credentials are prompted for, never echoed, never written to disk, and never
# passed in argv. The raw dump lands in probe/ which is gitignored.
#
# Usage:  ./scripts/probe-skyport.sh
#   or:   DAIKIN_SKYPORT_REFRESH_TOKEN=... ./scripts/probe-skyport.sh

set -euo pipefail
API='https://api.daikinskyport.com'
OUT_DIR='probe'
mkdir -p "$OUT_DIR"

[ "$#" -gt 0 ] && { echo "error: pass nothing on the command line." >&2; exit 2; }

if [ -n "${DAIKIN_SKYPORT_REFRESH_TOKEN:-}" ]; then
  printf 'Daikin account email: ' >&2; IFS= read -r EMAIL
  BODY=$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"refreshToken":sys.argv[2]}))' \
    "$EMAIL" "$DAIKIN_SKYPORT_REFRESH_TOKEN")
  AUTH_PATH='/users/auth/token'
else
  printf 'Daikin account email: ' >&2; IFS= read -r EMAIL
  printf 'Daikin account password (not echoed): ' >&2; IFS= read -rs PASSWORD; printf '\n' >&2
  BODY=$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' \
    "$EMAIL" "$PASSWORD")
  unset PASSWORD
  AUTH_PATH='/users/auth/login'
fi

TOKEN=$(printf '%s' "$BODY" | curl -sS -X POST "$API$AUTH_PATH" \
  -H 'Accept: application/json' -H 'Content-Type: application/json' --data @- \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("accessToken"); sys.exit("no accessToken: "+str(list(d))) if not t else print(t)')
unset BODY

echo "authenticated" >&2

curl -sS "$API/devices" -H 'Accept: application/json' -H "Authorization: Bearer $TOKEN" \
  > "$OUT_DIR/devices.json"

IDS=$(python3 -c '
import json,sys
for d in json.load(open(sys.argv[1])):
    print(d.get("id",""), d.get("name",""), d.get("model",""), sep="\t")
' "$OUT_DIR/devices.json")

printf '%s\n' "$IDS" | while IFS=$'\t' read -r ID NAME MODEL; do
  [ -n "$ID" ] || continue
  echo "probing $NAME ($MODEL)" >&2
  curl -sS "$API/deviceData/$ID" -H 'Accept: application/json' \
    -H "Authorization: Bearer $TOKEN" > "$OUT_DIR/deviceData-$ID.json"
  python3 scripts/summarize_skyport.py "$OUT_DIR/deviceData-$ID.json"
done

echo >&2
echo "raw dumps written to $OUT_DIR/ (gitignored)" >&2
