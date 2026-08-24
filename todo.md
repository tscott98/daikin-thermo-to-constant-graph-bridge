# Dashboard expansion — plan for next session

Context: `/api/series` now exposes all 38 Skyport (`sp_*`) columns alongside the
original integrator-API metrics. This is the plan for what to build on top of
that data. Written by Sonnet while Tim was AFK; pick up here.

## State when this was written

- The `/api/series` Skyport expansion is **committed and tested** (72 tests,
  typecheck clean), but **not yet deployed** — run `npx wrangler deploy` before
  building any dashboard against the `sp_*` columns, or Grafana will query a
  Worker that does not return them yet.
- The generated SQL was validated against the live Turso schema: all 38 `sp_*`
  columns project correctly, and recent buckets carry real values.
- `getSeries()` in `src/db/repo.ts` aggregates every `sp_*` column: most by
  `AVG`, but `sp_compressor_runtime` and the six `sp_fault_*` columns by `MAX`
  (see the comment on `SKYPORT_MAX_COLUMNS` for why).
- ConstantGraph publishing is unchanged — this expansion is Grafana/`/api/series`
  only, per Tim's instruction.
- Existing dashboards (`grafana/dashboard.json` classic, `grafana/dashboard-v2.json`)
  are untouched and still just cover Comfort/Duty cycle/Runtime/Humidity/Delta/
  Efficiency curve.

## Proposed dashboards, grouped by use case (not by data type)

Tim's instruction was explicit: group by *who's looking and why*, not by
sensor category. Priority order below is a recommendation, not a mandate —
confirm with Tim before building all of them.

### 1. Daily Comfort — exists, no changes needed

### 2. System Health & Alerting — build first
Audience: Tim, wanting to know if something's broken before the house gets warm.
- Single-stat panels for all 6 `sp_fault_*` columns — green at 0, red otherwise
- A Grafana **alert rule** (not just a panel) on `/health`'s
  `seconds_since_last_reading` crossing ~600s
- Skyport enrichment rate — consider whether `attempted`/`enriched` from
  `/admin/poll` needs to be persisted somewhere queryable, since right now
  it's only visible in the response of a manual poll, not stored per-cycle
- Any comms/signal fields, if they turn out to be populated on this unit

This is the one dashboard that should ship with a real alert, not just charts —
silent failure is the main risk in an unattended bridge.

### 3. Energy & Cost
Audience: Tim, wanting to know what this costs to run.
- `sp_outdoor_power` over time; daily/monthly kWh
- Needs a Grafana dashboard variable for electricity rate ($/kWh) to convert
  kWh → dollars — ask Tim for the rate, or make it a text variable
- Compressor current & inverter current as a sanity cross-check against power
- Energy vs. outdoor temperature scatter — "what does a 95° day cost"

### 4. Refrigeration Diagnostics
Audience: Tim or a technician, troubleshooting or watching for slow degradation.
- Suction/discharge/coil/liquid temps, one panel, four lines
- `sp_eev_superheat` trended over **weeks** — a slow upward drift is the
  classic early signature of a refrigerant leak, well before it shows up in
  comfort. This is the panel that most needs a long time window by default.
- EEV opening, suction pressure, inverter fin temp

### 5. Performance Curve
Audience: Tim, curious how well the system actually performs.
- Compressor RPS / `sp_frequency_pct` vs. outdoor temp — replaces the old
  `pct_running`-only efficiency curve with real modulation data
- Power vs. outdoor temp — a proper power-based efficiency curve, now that
  actual watts exist instead of a binary running/not-running proxy

### 6. Weekly Summary
Audience: Tim, once a week, not wanting to dig.
- Single stats: total heat/cool hours, kWh used, min/max indoor & outdoor,
  any faults this week
- Table/stat format, not time series — a report, not something to stare at

## The one capability gap worth prioritizing above the dashboards

`sp_compressor_runtime` is a **cumulative counter** from the equipment itself —
not a point sample, not an estimate. `getSeries()` already exposes it correctly
(bucket `MAX`, so it reports the running total as of the end of the bucket),
but nothing yet computes the actual **interval delta** between buckets, which
is what gives exact compressor-on seconds with zero sampling error — strictly
better than every runtime number the bridge has produced so far, including the
`equipment_status`-based `runtime_heat_min`/`runtime_cool_min` that's been in
place since the start.

Two ways to get there, pick one when picking this up:
- A `LAG()` window function either directly in `getSeries()`'s SQL, or as a
  new query/endpoint dedicated to it
- Or handle it client-side in Grafana via a transform on the raw `MAX` series

This is arguably higher-value than dashboards 3–5 above and should probably be
built before or alongside them, since several of those panels (Energy & Cost's
runtime framing, Performance Curve) would be more meaningful with exact runtime
instead of the sampled estimate.

## Suggested order

1. Deploy the `/api/series` expansion (`npx wrangler deploy`) — committed but not live
2. System Health & Alerting dashboard + the actual Grafana alert rule
3. Compressor runtime delta (LAG-based exact runtime)
4. Energy & Cost
5. Refrigeration Diagnostics
6. Performance Curve
7. Weekly Summary

Confirm this ordering and the dashboard scope with Tim before building —
this file is a proposal, not an approved spec.
