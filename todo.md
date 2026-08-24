# Dashboard expansion — plan

`/api/series` exposes all 38 Skyport (`sp_*`) columns. This is the plan for what
to build on top of that data.

## State

- `/api/series` Skyport expansion is committed and **deployed** (`5d97cd1c`).
- Migration 0003 has run; `sp_*` columns are populating on every 5-minute cycle.
- ConstantGraph publishing is unchanged and stays that way.
- Existing dashboards (`grafana/dashboard.json`, `grafana/dashboard-v2.json`)
  cover Comfort / Duty cycle / Runtime / Humidity / Delta / Efficiency curve.

## Product review — what changed from the first draft

The first draft proposed six dashboards grouped by "audience". That was wrong in
three ways, corrected here:

**The audience is always one person.** Grouping by audience produced six
near-identical labels. The real differentiator is *cadence and decision*: what
question is being asked, how often, and what action follows. Regrouped on that.

**Six dashboards is sprawl.** Nobody maintains six dashboards for their own
house. Two of the six overlapped almost entirely (Energy & Cost and Performance
Curve are both "efficiency versus outdoor temperature"), and Weekly Summary was
the same data at a different time range — which is a time-picker, not a
dashboard. Consolidated to **three**.

**Fault detection was framed as a dashboard.** A dashboard you must remember to
open is a failed design for detecting failure. The only thing that actually
works is a push alert. Promoted to its own first-class deliverable, ahead of
any charting work.

Two gaps the first draft missed entirely:

**Unit calibration blocks legibility.** Nine fields were stored raw with unknown
units. A panel reading `1630` for discharge temperature is not a product, it is
a number. This had to be resolved before charting anything — see below. Mostly
now resolved.

**Data-trust needs to be visible.** If the Skyport poll silently stops, every
new panel goes blank and there is no way to tell "system is off" from "data
collection broke". Every dashboard needs a freshness indicator.

## Unit calibration — resolved from live data

Method: cross-reference against a field whose unit is already known.
`sp_od_air_temp` ranged 763–891 over a period when `outdoor_f` ranged 75.2–84.2.
Divide by 10 and they coincide, which fixes the scale for the whole temperature
family.

**Confirmed — safe to convert:**

| Field(s) | Unit | Evidence |
|---|---|---|
| `sp_od_air_temp`, `sp_suction_temp`, `sp_discharge_temp`, `sp_od_coil_temp`, `sp_od_liquid_temp`, `sp_eev_suction_temp`, `sp_eev_liquid_temp` | tenths °F | od_air matches known outdoor_f; all others land in plausible ranges (suction 38.9–76.8 °F, discharge 102.5–150.6 °F) |
| `sp_suction_pressure` | psi | 61–192, right for R-410A across on/off |
| `sp_od_fan_rpm` | RPM | 0–998 |
| `sp_indoor_airflow` | CFM | 0–1126 |
| `sp_eev_opening` | percent | 0–100 |
| `sp_compressor_current`, `sp_inverter_current` | deciamps | 0–9.3 A and 0–5.0 A once scaled |

**Still uncertain — chart raw, label as raw, do not convert:**

| Field | Observed | Problem |
|---|---|---|
| `sp_eev_superheat` | 271–846 | As tenths °F that is 27–85 °F superheat. Normal is 8–15 °F. Either a different scale or not superheat as understood. |
| `sp_inverter_fin_temp` | 5.5–8.5 | Implausibly narrow and cold for a heatsink. |
| `sp_indoor_power` | 842–2830, never zero | Scale unclear, and a blower drawing 842 W at idle is not credible. |

Do not guess these into a conversion. The sentinel bug and the equipment-status
misreading both came from confident guesses; raw with an honest label is better
than wrong with a unit.

## Three dashboards

### A. Home — daily glance
Question: *is the house comfortable and is the system behaving?*
Cadence: ambient, several times a day. Must read in five seconds.

Largely exists. Additions:
- Current power draw as a single stat
- Data-freshness stat (minutes since last reading), amber past 10, red past 20

### B. Energy & Efficiency — monthly decision
Question: *what is this costing, and is it performing as it should?*
Cadence: monthly, or when a bill surprises. Merges the old Energy & Cost and
Performance Curve.

- Power over time; kWh per day, per month
- Cost, via a dashboard variable for $/kWh (ask for the actual rate)
- Power vs. outdoor temperature — the real efficiency curve, now with watts
  instead of a running/not-running proxy
- Compressor modulation (`sp_compressor_rps`, `sp_frequency_pct`) vs. outdoor
  temperature — shows whether the inverter is actually modulating or just
  cycling, which is the thing a variable-speed system is sold on
- Runtime hours per day, from the exact counter delta once built

### C. System Health & Diagnostics — seasonal and troubleshooting
Question: *is anything wrong, or slowly getting worse?*
Cadence: rarely by choice, often because the alert fired. Merges the old Health
and Refrigeration dashboards.

- All six `sp_fault_*` as stat panels, green at 0
- Refrigerant circuit: suction / discharge / coil / liquid, converted to °F
- Suction pressure, EEV opening
- Superheat trended over weeks, clearly labelled as raw units
- Airflow and fan RPM
- Skyport enrichment freshness — how long since `sp_*` columns were last non-null

## Deliverables, in order

1. ~~**Unit conversion in `/api/series`**~~ — **done**. Confirmed set served as
   `_f` and `_a`; the three uncertain fields as `_raw`.
2. ~~**Alert rule**~~ — **done**, as `grafana/alerting/daikin-alerts.yaml`.
   Two rules: collection stalled (>600s, two missed cycles) and any non-zero
   fault. **Untested against a live Grafana** — provisioning schemas move
   between versions. If import fails, build them in the UI; the thresholds and
   reasoning are the durable part.
3. ~~**Exact runtime from the counter delta**~~ — **done**, but it does less
   than the first draft claimed. Measured against live data, the counter
   increments by exactly 1 per hour of compressor operation:

   ```
   HR            RT     DELTA  AVG RPS
   1787554800    9333   1      39.3
   1787558400    9334   1      35.0
   1787572800    9337   0      9.8
   ```

   So it is **exact at hourly and daily buckets** and **mostly zero at
   five-minute** ones. It gives true runtime totals, but it does not supersede
   the `equipment_status` estimate for fine-grained cycling — the two answer
   different questions and both should stay. Exposed as
   `compressor_runtime_delta`.
4. ~~**Dashboard B** — Energy & Efficiency~~ — **done**,
   `grafana/dashboard-energy.json`, 5 panels, 30-day default.
5. ~~**Dashboard C** — System Health & Diagnostics~~ — **done**,
   `grafana/dashboard-health.json`, 11 panels, 14-day default.
6. **Dashboard A additions** — deliberately *not* done. The two additions
   (current power, data freshness) now live on the Energy and Health
   dashboards respectively, and `grafana/dashboard.json` is Tim's own export
   carrying his UI customisations. Editing it programmatically risked clobbering
   those for marginal gain. Add them by hand if the daily-glance view still
   wants them.

## Open questions

- Electricity rate for cost panels ($/kWh)? Until then, cost panels use a
  variable defaulting to a placeholder.
- Is `sp_indoor_power` worth charting at all given the unresolved scale?
- Grafana alert delivery: email, or something else?

## Remaining

- Import the two new dashboards and confirm they render (all columns verified
  present in the API response, but not yet viewed in Grafana).
- Import or hand-build the alert rules.
- ~~Electricity rate~~ — set to $0.14/kWh via `RATE_PER_KWH` in `wrangler.toml`,
  overridable per-request with `?rate=`. Energy dashboard now has kWh/cost per
  day and a range-total cost stat. Covers the outdoor unit only.
- `sp_eev_superheat`, `sp_inverter_fin_temp`, `sp_indoor_power` remain
  uncalibrated. Superheat is charted raw because its *trend* is meaningful even
  when its scale is not; the other two are not charted at all.
