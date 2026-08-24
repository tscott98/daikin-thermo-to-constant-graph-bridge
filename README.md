# Daikin One → ConstantGraph bridge

Polls a Daikin One thermostat every 5 minutes, keeps every reading in a Turso database, and
publishes it to ConstantGraph for graphing. Compute and storage run on the free tiers of
Cloudflare Workers and Turso. ConstantGraph requires their **Premium** tier: the `/data/timedata`
endpoint this depends on is not available below it.

## Why it keeps its own copy

Neither service keeps your history. The Daikin API reports current state only, so anything you
don't poll is gone. ConstantGraph's retention is bounded even on Premium: one month of raw
5-minute data, 12 months hourly, then daily for 5 years. (Their pricing page describes the daily
rollup as lifetime and the subscriptions page says 5 years. Either way, 5-minute resolution older
than a month cannot be recovered from it.)

So Turso is the system of record and ConstantGraph is the view. Turso is also how you get at the
data from anywhere else, since it is plain SQLite over libSQL and any driver can connect to it.
For hosted dashboards that cannot reach Turso, `/api/series` serves the same data over HTTP.

## How it works

```
Cloudflare Worker  (cron: */5 * * * *)
  │
  ├─ 1. CAPTURE   GET /v1/devices → GET /v1/devices/{id}  (sequential)
  │               INSERT OR IGNORE into readings, published = 0
  │
  ├─ 2. PUBLISH   SELECT ... WHERE published = 0  (up to PUBLISH_BATCH)
  │               POST /data/timedata with each row's original timestamp
  │               mark published = 1 only on confirmed success
  │
  └─ 3. PRUNE     once daily, null out raw JSON older than RAW_RETENTION_DAYS
```

Capture and publish are independent. If ConstantGraph is unreachable for six hours, capture keeps
working and rows pile up unpublished; the next successful publish replays them at their true
timestamps, so the graph fills in retroactively instead of showing a hole. That is why this uses
`/data/timedata` (Premium) rather than `/data/data`.

Samples are snapped to their 5-minute bucket. Cron jitter therefore doesn't produce uneven
spacing, and a manual `/admin/poll` in the same window collapses onto the scheduled sample
instead of creating a near-duplicate.

## Setup

See [SETUP.md](SETUP.md).

## What gets recorded

Each thermostat gets a block of 100 ConstantGraph channel IDs starting at `CHANNEL_BASE`
(default 1000), so device 1 owns 1000–1099 and device 2 owns 1100–1199. Eleven of each hundred
are used today; the remainder leaves room to add metrics without renumbering.

| Offset | Channel | Units | DataType |
|---|---|---|---|
| +0 | Indoor Temp | °F | 11 temperature |
| +1 | Indoor Humidity | % | 7 humidity |
| +2 | Outdoor Temp | °F | 11 temperature |
| +3 | Outdoor Humidity | % | 7 humidity |
| +4 | Heat Setpoint | °F | 12 high setpoint |
| +5 | Cool Setpoint | °F | 13 low setpoint |
| +6 | Mode | 0 off, 1 heat, 2 cool, 3 auto, 4 em-heat | 5 HVAC mode status |
| +7 | Equipment Status | 1 cool, 2 overcool, 3 heat, 4 fan, 5 idle | 16 HVAC operating state |
| +8 | Heating Runtime | min | 15 sensor level |
| +9 | Cooling Runtime | min | 15 sensor level |
| +10 | Indoor−Outdoor Delta | °F | 11 temperature |

Turso keeps more than it graphs: the metrics above as typed columns, plus `setpoint_delta_c`,
`setpoint_min_c` and `setpoint_max_c` (the system's configured limits), plus the complete API
response as raw JSON. The raw JSON is pruned after `RAW_RETENTION_DAYS`, so any field outside the
typed columns is retained only for that window.

**Units.** Temperatures are stored in Celsius exactly as the API returns them, so nothing is lost
to rounding. Conversion to Fahrenheit happens once, on the way out to ConstantGraph. Queries
against the database must do the conversion themselves — see
[Querying the history](#querying-the-history). A whole-degree Fahrenheit setpoint often reads
back with a decimal (71 °F is stored as 21.7 °C, which converts back to 71.06) because the API's
0.1 °C granularity doesn't line up with whole Fahrenheit degrees.

**The setpoint DataTypes look swapped and are not.** ConstantGraph's reference defines "High
Setpoint" as the heating set point and "Low Setpoint" as the cooling one, the reverse of the
usual convention, where cooling is the numerically higher edge of the deadband. This only affects
icons and axis labelling.

**Runtime channels are estimates.** `equipmentStatus` is a point sample, not a meter. Runtime
credits the whole 5-minute interval whenever the system was running at the instant of the poll.
Over a day that is a fair duty-cycle estimate, but a cycle shorter than the sampling gap can be
missed entirely or counted as a full interval. Treat them as a trend indicator, not a total.

**Channel filtering is deliberately left off.** ConstantGraph's extreme-value filter discards
out-of-range readings rather than flagging them, so enabling it risks silently dropping a real
measurement.

## Dashboard graphs

`POST /admin/bootstrap` names the channels, registers the thermostat as a device so its channels
group together, and creates four graphs per unit:

| Graph | Window | What it shows |
|---|---|---|
| Comfort | 7 days | Indoor temp against both setpoints, with outdoor for context, all on one axis |
| Runtime (Hours per Day) | 30 days | Heating and cooling hours per day, via On Duration aggregation |
| Humidity | 7 days | Indoor vs outdoor relative humidity |
| Indoor vs Outdoor Delta | 30 days | Daily average delta, as an area chart |

Graph references are stable slugs (`daikin-1-comfort`, `daikin-2-runtime`, …), so re-running
bootstrap updates the existing graphs rather than duplicating them.

## Querying the history

This is the intended way to analyse the data. Any libSQL driver connects directly — see Turso's
[client SDK docs](https://docs.turso.tech/sdk) for Python (`libsql`), JavaScript
(`@libsql/client`), Rust (`libsql`), and Go (`libsql-client-go`).

```bash
turso db shell daikin
```

Recent readings in Fahrenheit:

```sql
SELECT datetime(ts, 'unixepoch', 'localtime') AS local_time,
       ROUND(temp_indoor_c  * 9 / 5 + 32, 1) AS indoor_f,
       ROUND(temp_outdoor_c * 9 / 5 + 32, 1) AS outdoor_f,
       hum_indoor,
       equipment_status
FROM readings
ORDER BY ts DESC
LIMIT 50;
```

Daily heating and cooling hours (the `5` is the sampling interval in minutes):

```sql
SELECT date(ts, 'unixepoch', 'localtime') AS day,
       ROUND(SUM(CASE WHEN equipment_status = 3       THEN 5 ELSE 0 END) / 60.0, 2) AS heat_hours,
       ROUND(SUM(CASE WHEN equipment_status IN (1, 2) THEN 5 ELSE 0 END) / 60.0, 2) AS cool_hours
FROM readings
GROUP BY day
ORDER BY day DESC;
```

Run time against outdoor temperature, which is roughly your system's efficiency curve:

```sql
SELECT CAST(ROUND(temp_outdoor_c * 9 / 5 + 32) AS INT) AS outdoor_f,
       COUNT(*)                                        AS samples,
       ROUND(AVG(CASE WHEN equipment_status IN (1,2,3) THEN 1.0 ELSE 0.0 END) * 100, 1) AS pct_running
FROM readings
WHERE temp_outdoor_c IS NOT NULL
GROUP BY outdoor_f
HAVING samples > 5
ORDER BY outdoor_f;
```

## Grafana dashboards

ConstantGraph covers the basics. For richer dashboards, Grafana can read this data through its
Infinity data source, which queries JSON over HTTP. Grafana cannot connect to Turso directly —
its SQLite plugin needs a local file — so `/api/series` exists to bridge that gap.

Note that Grafana only *renders* here; it stores nothing. Its free-tier retention limits (14 days
for metrics) don't apply, because the history stays in Turso.

**Set up the data source.** Infinity ships pre-installed on Grafana Cloud. Add it, then:

- Base URL: your Worker's origin
- Under *Headers*, add `X-Api-Key` with your `READ_API_KEY`
- Under *Security → Allowed hosts*, add the same origin

**Import the dashboard.** [`grafana/dashboard-v2.json`](grafana/dashboard-v2.json) is the
current one, in the `dashboard.grafana.app/v2` schema, with six panels pre-wired.
[`grafana/dashboard.json`](grafana/dashboard.json) is the same dashboard in the classic
schema for older Grafana. The v2 file references its data source by UID, so change that to
yours after importing; the classic file prompts for it instead. Dashboards → New → Import → paste the file, then pick your Infinity data source when
prompted. It ships with a `device` textbox variable; leave it blank for all thermostats or paste
an ID from `/api/stats`.

| Panel | Shows |
|---|---|
| Comfort | Indoor temp vs both setpoints and outdoor, setpoints as dashed step lines |
| Duty cycle | Percent of samples with the compressor running |
| Runtime per bucket | Heating and cooling minutes, as bars |
| Humidity | Indoor vs outdoor relative humidity |
| Indoor − Outdoor delta | How hard the envelope is working |
| Efficiency curve | Percent running against outdoor temperature, hourly buckets, XY chart |

**To build panels by hand instead,** query type JSON, source URL, parser **Backend**, format
**Time Series**:

```
/api/series?from=$__from&to=$__to&interval=$__interval_ms
```

Grafana substitutes epoch milliseconds for `$__from`/`$__to` and the panel resolution for
`$__interval_ms`; the endpoint normalises all three to seconds. The Backend parser needs each
column declared under *Parsing options & Result fields*: add `time` with Format `Time`, and each
numeric column with Format `Number`. Infinity will not infer these, and a missing `time` column
is the usual cause of "Data is missing a time field".

**Alerting.** `/health` is unauthenticated and returns `seconds_since_last_reading`, so an alert
on that crossing ~600 tells you collection has stopped. That is the one alert worth having.

**Available columns.** Integrator-API metrics: `time` (ISO-8601), `ts_ms` (epoch ms),
`device_id`, `samples`, `indoor_f`, `outdoor_f`, `heat_setpoint_f`, `cool_setpoint_f`,
`hum_indoor`, `hum_outdoor`, `delta_f`, `mode`, `equipment_status`, `runtime_heat_min`,
`runtime_cool_min`, `pct_running`.

Skyport metrics (see below): all 38 `sp_*` columns from `readings`, aggregated by bucket. Most
average; `sp_compressor_runtime` and the six `sp_fault_*` columns take the bucket maximum
instead, for the reasons in the next paragraph.

Aggregation is per metric rather than a blanket average, which matters once a panel spans more
than a few days: sensor readings average, runtime minutes sum so a daily bucket reports real
minutes, `mode`/`equipment_status` take the maximum so a bucket shows the system ran at all
rather than a meaningless fraction, fault codes take the maximum so a fault anywhere in the
bucket is not averaged away, and `sp_compressor_runtime` — a cumulative counter, not a level —
takes the maximum so a client can difference it between buckets for exact runtime.

Query parameters: `from`, `to` (epoch seconds or milliseconds), `interval` (bucket size in
seconds or milliseconds, omit for raw 5-minute rows), `device`, `limit` (max 20,000), and
`format=csv`.

**If a panel is empty rather than erroring,** check the time range first: `from`/`to` accept both
units, so passing seconds where Grafana would have sent milliseconds silently queries a window
with no data.

## Ops endpoints

Everything except `/health` requires an `X-Api-Key` header matching `READ_API_KEY`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Unauthenticated liveness. Counts and lag only, never readings. |
| `GET /api/stats` | Row counts, date range, backlog, per-device channel blocks. |
| `GET /api/series` | Time-bucketed rows in Fahrenheit, for charting tools. See below. |
| `POST /admin/poll` | Force a capture and publish cycle without waiting for cron. |
| `POST /admin/bootstrap` | Register channels, devices, and graphs. Safe to re-run. |
| `POST /admin/config` | Forward a raw JSON body to ConstantGraph's `/data/config`. |

`/admin/bootstrap` accepts optional path segments for partial runs, such as
`/admin/bootstrap/graphs` or `/admin/bootstrap/graphs/2` (first two graphs only).

`/admin/config` is an escape hatch for experimenting with ConstantGraph configuration. It can
rewrite your channel and graph setup, so remove the route if you would rather not have that
behind a single API key.

## Configuration

Vars live in `wrangler.toml`. Secrets are set with `wrangler secret put`.

| Var | Default | Meaning |
|---|---|---|
| `CHANNEL_BASE` | `1000` | First ConstantGraph channel ID. Raise it to avoid existing channels. |
| `POLL_INTERVAL_MIN` | `5` | Keep at 3 or above — Daikin's documented floor. Change the cron to match. |
| `PUBLISH_BATCH` | `200` | Max rows published per run. Bounds payload size when draining a backlog. |
| `RAW_RETENTION_DAYS` | `30` | Days to keep raw JSON. `0` disables raw capture entirely. |
| `DRY_RUN` | `false` | Capture to Turso but send nothing to ConstantGraph. |

## Free-tier headroom

Per thermostat, against Turso's free plan:

| Resource | Usage | Limit |
|---|---|---|
| Row writes | ~26,000/month | 10,000,000/month |
| Row reads | ~86,000/month | 500,000,000/month |
| Storage | ~10 MB/year, plus ~13 MB rolling raw JSON | 5 GB |

Cloudflare's free tier allows 100,000 requests/day (this uses 288) and 5 cron triggers (uses 1).
A measured cycle costs about 25 ms CPU, 1.4 s wall time, and 10 subrequests.

The subrequest cap of 50 per invocation is the limit that actually shapes the code: every libSQL
call is one, so multi-row writes go through `batch()` rather than a loop.

## ConstantGraph API notes

Quirks worth knowing if you write against their Data API. All of these are things the published
docs either omit or contradict.

- **`/data/config` must not include `app` and `version`,** even though the general error section
  says every request requires them. `/data/data` and `/data/timedata` do require them.
- **`/data/config` rejects composite requests.** Sending `Variables`, `Devices`, and `Graphs`
  together fails, as does sending two graphs in one call, even though each succeeds alone. Post
  one section, and one graph, per request.
- **A graph's `Reference` has an undocumented length cap.** 22 characters is rejected; 17 works.
- **`AggregationType: 2` (Sum) is rejected** on sensor-level channels. Aggregation validity
  depends on the channel's data type. Use `6` (On Duration) for run-time totals, which is what
  their own "Heating Hours per Week" example does.
- **Errors can arrive with HTTP 200,** so treat `status != "success"` or the presence of
  `error_code` as failure regardless of status code.
- **Every malformed-payload failure above reports as `InvalidSession` / "user not found"** with
  HTTP 500. The error code is misleading. On `/data/config`, read it as "malformed request"
  unless `/data/timedata` is failing too.
- **A successful config response echoes `node`,** the location ID, which is a quick way to
  confirm which location your API key writes to.

The general rule: where the field tables and the worked examples disagree, follow the examples.

## Development

```bash
npm install
npm test          # 57 unit tests, no network or database needed
npm run typecheck
npx wrangler dev  # needs .dev.vars; see SETUP.md
```

Tests cover unit conversion, runtime derivation, channel allocation and collision, timestamp
bucketing, graph reference limits, series query parsing, and the ConstantGraph payload builder, including that null
readings are omitted rather than sent as zero so a missing outdoor sensor leaves a gap instead of
plotting 32 °F.

## Scope

Read-only. The Daikin write endpoints (`PUT /msp`, `/schedule`, `/fan`) are deliberately not
implemented, so nothing here can change your thermostat's settings.

## License

MIT, see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or sponsored by Daikin, ConstantGraph, Cloudflare, or Turso.
"Daikin" and "Daikin One" are trademarks of Daikin Industries, Ltd.; "ConstantGraph" is a
trademark of its respective owner. Both APIs are used here as a customer of those services; you
need your own accounts and credentials, and their terms govern your use of them.
