#!/usr/bin/env bash
# Exchange a Daikin account email + password for a refresh token, once.
#
# The password is read from the terminal with echo off, passed to curl on stdin
# (never in argv, so it cannot appear in `ps`), and never written to disk. Only
# the refresh token is printed. Nothing here is stored by the script.
#
# Usage:  ./scripts/get-refresh-token.sh
# Then:   npx wrangler secret put DAIKIN_SKYPORT_REFRESH_TOKEN

set -euo pipefail

API='https://api.daikinskyport.com'

# Refuse credentials as arguments: argv is visible to other processes.
if [ "$#" -gt 0 ]; then
  echo "error: pass nothing on the command line; this script prompts instead." >&2
  exit 2
fi

printf 'Daikin account email: ' >&2
IFS= read -r EMAIL
printf 'Daikin account password (not echoed): ' >&2
IFS= read -rs PASSWORD
printf '\n' >&2

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "error: email and password are both required." >&2
  exit 2
fi

json_escape() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

BODY="{\"email\": $(json_escape "$EMAIL"), \"password\": $(json_escape "$PASSWORD")}"
unset PASSWORD

# --data @- keeps the body off the command line.
RESPONSE=$(printf '%s' "$BODY" | curl -sS -X POST "$API/users/auth/login" \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  --data @-)
unset BODY

TOKEN=$(printf '%s' "$RESPONSE" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit("error: response was not JSON")
t = d.get("refreshToken")
if not t:
    sys.exit("error: no refreshToken in response: " + json.dumps({k: "***" if "oken" in k else v for k, v in d.items()}))
print(t)
')

cat >&2 <<'NOTE'

Refresh token obtained. It is printed once, below.

Treat it as a credential: it can mint access tokens until you change your
Daikin account password. Do not paste it into a file in this repository.

Store it with:
  npx wrangler secret put DAIKIN_SKYPORT_REFRESH_TOKEN

NOTE
printf '%s\n' "$TOKEN"
