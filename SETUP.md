# Setup

One-time setup, start to finish. Roughly 20 minutes for the required parts.

Only the Daikin integrator API, Turso and ConstantGraph are required. Three further sources are
optional and additive — skip any of them and the bridge runs without those columns:

| Optional source | Section | Adds |
|---|---|---|
| Daikin Skyport | 9 | Power, compressor speed, refrigerant circuit, faults |
| Duct sensors | 10 | Return and supply air temperature and humidity |
| AirGradient | 11 | CO₂, particulates, TVOC and NOx |

Each is wrapped so a failure degrades to null columns rather than costing the reading.

## 1. Daikin credentials

Two separate values are needed and they come from different places in the app.

**Integrator API Key** (`x-api-key`)
1. Open the **SkyportHome** app.
2. Enable **developer mode**.
3. From the developer menu, create an API Key.

**Integrator Token**
1. In the same app, go to **home integration settings**.
2. Request an Integrator Token. It is tied to your account email.

You also need the **account email** itself — it goes in the token request body alongside
the integrator token.

## 2. ConstantGraph location and API key

Go to **Accounts → Locations, Keys and Tokens**. Create a location for this data if you want it
kept separate from your existing channels, then copy **that location's** API key.

Each location issues its own key, and the key alone decides where writes land; there is no
location field in the request. Using the wrong location's key publishes there silently.

`CHANNEL_BASE` defaults to 1000 to avoid colliding with channels you may already have. If the
location is new and empty, 1 is fine too.

This project uses `/data/timedata`, which is **Premium only**. On a lower tier the publish step
fails with `AccessDenied`. Readings still accumulate in Turso and are published retroactively if
you upgrade later. Premium also allows up to 5 locations.

## 3. Turso database

Turso has no single "API key". You need two values: a database **URL** and a database **auth
token**. (The "platform API token" from `turso auth api-tokens create` manages infrastructure and
is *not* needed here.)

Install the CLI and sign in:

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
```

Create the database. **Omit `--tursodb`** — that flag creates a new-engine Turso Database, while
this project uses `@libsql/client`, which targets classic libSQL on Turso Cloud:

```bash
turso db create daikin
```

If your account has more than one group, add `--group <name>`. A fresh account has a single
default group and needs no flag.

Apply the schema. This is the step most easily skipped, and everything 500s without it:

```bash
for f in migrations/*.sql; do turso db shell daikin < "$f"; done
```

Confirm all three tables exist:

```bash
turso db shell daikin ".tables"
```

Expect `devices  kv_state  readings`.

Get the URL (looks like `libsql://daikin-<your-org>.turso.io`):

```bash
turso db show daikin --url
```

Create the auth token. **Set the expiration explicitly** — the CLI docs do not state a default,
and a token that quietly expires months from now would stop the bridge with no obvious cause:

```bash
turso db tokens create daikin --expiration never
```

That prints a long JWT. It is the `TURSO_AUTH_TOKEN` value, and it is shown once.

### Optional: a separate read-only token for analysis

The token above has write access, because the Worker needs it. For notebooks, BI tools, or
anything else querying the history, mint a second token that cannot modify the data:

```bash
turso db tokens create daikin --read-only --expiration never
```

Use that one in analysis tools and keep the writable token to the Worker.

## 4. Local configuration

Copy the template into place. `.dev.vars` is gitignored and must never be committed:

```bash
cp .dev.vars.example .dev.vars
```

The template lists the required values first, then the optional sources. Leave any optional
block blank to skip that source.

For `READ_API_KEY` — which is yours, not any vendor's, and guards this Worker's own endpoints —
any long random string works:

```bash
openssl rand -hex 32
```

**On Windows, write `.dev.vars` as UTF-8 without a BOM.** PowerShell's `Out-File -Encoding utf8`
adds one, and the first variable then parses as `\ufeffTURSO_DATABASE_URL` and silently fails to
match. `Set-Content -Encoding utf8NoBOM` avoids it, as does editing the file in an editor.

## 5. Dry run against your real thermostat

Set `DRY_RUN = "true"` in `wrangler.toml`, then:

```bash
npm install
npm test
npx wrangler dev
```

In a second terminal. Note that `.dev.vars` is read by `wrangler dev`, not by your shell, so the
key has to be exported there as well — the same value you just put in the file:

```bash
export READ_API_KEY=<the value from .dev.vars>
curl -sS -X POST -H "X-Api-Key: $READ_API_KEY" http://localhost:8787/admin/poll
```

This calls Daikin for real and writes to Turso, but sends **nothing** to ConstantGraph. Confirm
the readings landed:

```bash
turso db shell daikin "SELECT device_id, ts, temp_indoor_c, hum_indoor, equipment_status FROM readings ORDER BY ts DESC LIMIT 5;"
```

Sanity-check that `temp_indoor_c` matches what the thermostat actually shows, remembering the
stored value is **Celsius**.

## 6. Go live

Set `DRY_RUN = "false"` in `wrangler.toml`, restart `wrangler dev`, and poll once more. Confirm
points appear in ConstantGraph at the correct timestamps, then register the channel names,
devices, and dashboard graphs:

```bash
curl -sS -X POST -H "X-Api-Key: $READ_API_KEY" http://localhost:8787/admin/bootstrap
```

This creates four graphs per thermostat. Graph references are stable, so it is safe to re-run
after adding a thermostat. With `DRY_RUN = "true"` it returns exactly what it *would* send
without touching your account — worth a look first.

## 7. Deploy

Push each secret to Cloudflare (they are *not* read from `.dev.vars` in production):

```bash
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put DAIKIN_API_KEY
npx wrangler secret put DAIKIN_EMAIL
npx wrangler secret put DAIKIN_INTEGRATOR_TOKEN
npx wrangler secret put CG_API_KEY
npx wrangler secret put READ_API_KEY
```

Then:

```bash
npx wrangler deploy
npx wrangler tail
```

Watch `wrangler tail` until the first `cycle ok` appears — within 5 minutes.

## 8. Confirm it is healthy

After ~30 minutes:

```bash
curl -sS https://<your-worker>.workers.dev/health
```

Expect `unpublished` at or near 0 and `seconds_since_last_reading` under 300. A steadily growing
`unpublished` count means ConstantGraph is rejecting writes — check the subscription tier and
the API key.

## 9. Optional: Daikin Skyport

The consumer API the phone app uses. Undocumented and unsanctioned, so treat it as a supplement
that may break without notice — but it is the only source of power draw, compressor speed and
refrigerant-circuit data.

Your account password is never stored. Mint a refresh token once, locally:

```bash
./scripts/get-refresh-token.sh
```

The password is read with echo off, passed to curl on stdin so it never appears in `ps`, and
never written to disk. Only the refresh token is kept:

```bash
npx wrangler secret put DAIKIN_SKYPORT_REFRESH_TOKEN
```

```bash
npx wrangler secret put DAIKIN_SKYPORT_EMAIL
```

Refresh tokens may rotate. The live one is cached in Turso and the secret is only the bootstrap
value, so rotation is handled either way.

Before relying on any of it, see what your hardware actually reports:

```bash
./scripts/probe-skyport.sh
```

That dumps the full response to `probe/` (gitignored) and prints which fields are real, which
return the not-available sentinels (255, 32767, 65535, 4294967295), and which are absent. The
column set in `scripts/gen_skyport_fields.py` was chosen from such a probe, not from the API's
field list — most of its ~1500 fields are sentinels on any given unit.

## 10. Optional: duct sensors

Return and supply air probes, read back out of ConstantGraph. This needs a **read** key, which
is a different credential from the write key and is created separately on the account page.

```bash
npx wrangler secret put CG_READ_API_KEY
```

Then set the channel IDs and location in `wrangler.toml`: `CG_SENSOR_NODE` is the location the
sensors publish to, which is *not* the location this bridge writes to. Channel IDs come from
Data → Channel Config. Set any channel to `0` to skip it.

Sensible cooling capacity is exact from these. Latent is not, unless you have humidity at the
supply as well as the return — see the derived-columns notes in the README for why an `shr_est`
of 1.0 does not mean what it appears to.

## 11. Optional: AirGradient

An indoor air quality monitor. CO₂ is the valuable part: it is an occupancy proxy, and that is
what distinguishes moisture generated indoors from moisture leaking in.

Get a place token from [app.airgradient.com/settings/place](https://app.airgradient.com/settings/place):

```bash
npx wrangler secret put AG_TOKEN
```

Set `AG_LOCATION_ID` in `wrangler.toml` to the location id from the AirGradient dashboard.

Note this API authenticates with a token in the **query string** rather than a header, so the
token ends up in request URLs. The client never includes the URL in an error message for that
reason; if you add logging here, keep that property.

## Troubleshooting

| Symptom | Cause / what to do |
|---|---|
| `403` from Daikin | Bad `DAIKIN_API_KEY` |
| `401` from Daikin that never recovers | Bad `DAIKIN_EMAIL` or `DAIKIN_INTEGRATOR_TOKEN` |
| `AccessDenied` from ConstantGraph | `/data/timedata` needs Premium |
| `InvalidSession` from `/data/timedata` | Bad `CG_API_KEY` |
| `InvalidSession` from `/data/config` | Almost always a malformed payload, not a bad key. See the API notes in the README. |
| `RateLimit` from ConstantGraph | Below Premium; lower `PUBLISH_BATCH` or raise the tier |
| `429` from Daikin | Something else is polling the same account; the client retries with backoff |
| `unpublished` grows without bound | Publish is failing — check `wrangler tail` |
| Readings stop entirely | Check `/health`; if it 503s, the Turso token may have expired or been revoked |
| `sp_*` columns all null | Skyport poll off or failing. Check `/admin/poll` for `skyport` and an `errors` entry |
| `duct_*` columns all null | Needs `CG_READ_API_KEY` (the *read* key) and the right `CG_SENSOR_NODE` |
| `ag_*` columns all null | Check `/admin/poll` for `airGradient`; 401 means the token, 404 means the location id |
| A source fails but readings continue | Working as intended — optional sources degrade to null columns |
| `curl` returns nothing at all | Use `-sS`, not `-s`, which hides errors. On WSL, add `--http1.1` |
