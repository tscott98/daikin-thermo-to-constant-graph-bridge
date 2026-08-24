# Review: HVAC dehumidification brief, against this pipeline's data

What the brief asks for, mapped onto what `readings` actually holds. Written
without live database access — see *Caveat* below — so every claim here is from
the schema, the mapper, and the observed value ranges already recorded in
`todo.md`. The SQL was run against a scratch database built from `migrations/`,
so it parses and returns the right shape; the numbers it returns are yours to
read.

## Caveat: no live data was reached

This session has no `TURSO_*` credentials, no `READ_API_KEY`, and no deployed
Worker URL, so nothing here is a measurement of your system. What it is: a
determination of which of your eight questions this pipeline can answer, which
it cannot, and the exact query for each. Run them and the answers follow.

## Bottom line

1. **Two of your four "not yet verified" open items are already columns in your
   database.** The homeowner humidity target and the overcool allowance are
   recorded on every 5-minute sample as `sp_dehum_setpoint` and
   `sp_overcool_amount`. You do not need the installer PIN, and you do not need
   to open a menu. This is the first thing to run, because it reorders
   everything else.
2. **The Cool CFM question is directly measurable, not inferrable.**
   `sp_indoor_airflow` is CFM. You do not have to derive implied CFM/ton from
   tonnage assumptions — the blower reports its own airflow.
3. **Question 5 (SHR from coil entering/leaving conditions) cannot be answered.**
   Supply and return air temperatures were probed for on this hardware and read
   as sentinels. There is a substitute that answers the underlying question, and
   it is arguably better suited to the complaint.
4. **RH is the wrong variable and it is distorting the diagnosis.** Every
   question in the brief is really a question about humidity ratio. The pipeline
   stores the inputs but computes W nowhere. Adding it is the single highest-value
   change to the code.
5. **Before you take airflow down 9%, check the low-end suction pressure.** The
   recorded range bottoms at 61 psi, which is a saturation temperature near 11 °F.
   If that occurs in steady state rather than at startup, there is no margin for
   the trim.

## Run this first: the dehum decision table

```sql
-- The two homeowner settings, as the equipment reports them.
SELECT sp_dehum_setpoint            AS dehumidify_if_more_than_pct,
       sp_overcool_amount           AS overcool_allowance_raw,
       COUNT(*)                     AS samples,
       MIN(date(ts,'unixepoch','localtime')) AS first_seen,
       MAX(date(ts,'unixepoch','localtime')) AS last_seen
FROM readings
WHERE sp_dehum_setpoint IS NOT NULL
GROUP BY 1, 2
ORDER BY first_seen;

-- Has the system ever actually overcooled to dehumidify?
SELECT SUM(equipment_status = 2) AS overcool_samples,
       SUM(equipment_status = 1) AS cool_samples,
       ROUND(100.0 * SUM(equipment_status = 2)
             / NULLIF(SUM(equipment_status IN (1,2)), 0), 2) AS pct_of_cooling_that_was_dehum
FROM readings;
```

`equipment_status = 2` is `overcool` — the system driving below the cooling
setpoint specifically to pull moisture. It is the closest thing you have to the
"requested dehum demand" the brief asks for; the actual
`ctOutdoorDeHumidificationRequestedDemand` field was probed for and did not
survive field selection, meaning it was absent or sentinel on this equipment.

Read the two results together:

| `dehum_setpoint` | `overcool_amount` | overcool samples | What it means | Where the fix is |
|---|---|---|---|---|
| at or above observed indoor RH | any | 0 | The target is never crossed, so no dehum call is ever generated | Homeowner menu. Lower the target. No PIN. |
| ~50 | 0 | 0 | Target is crossed but the system is not permitted to overcool | Homeowner menu. Set 2 °F. No PIN. |
| ~50 | > 0 | 0 | The request is being made and never served | Commissioning side. This is where dehum profile A and the airflow trim actually matter. |
| ~50 | > 0 | > 0 | Dehum is running and still losing ground | Capacity or load. Go to question 8, and consider the whole-house dehumidifier. |

Only the third row justifies the changes already made and the trim planned next.
The first two rows mean the equipment-side tuning is being applied to a system
that was never asked to dehumidify — the capability is enabled and never invoked,
exactly as the brief suspected.

**One unit check before trusting row 2.** The mapper comments `overcoolAmount` as
Celsius, but that is an annotation, not a calibration. The homeowner range is
0–3 °F. If you see values like 0 / 0.6 / 1.1 / 1.7, it is Celsius; if 0 / 1 / 2 / 3,
it is Fahrenheit. Either way **0 means the feature is off**, and that is the part
that matters.

## Question by question

### 1. Runtime distribution across compressor speed — answerable

`sp_compressor_rps` is stored per sample, unconverted, in rev/sec. Your ceiling
is 73 rps.

```sql
SELECT CASE WHEN sp_compressor_rps <  25 THEN 'low 1-24'
            WHEN sp_compressor_rps <  40 THEN 'mid 25-39'
            WHEN sp_compressor_rps <  55 THEN 'high 40-54'
            ELSE 'max 55+' END                                  AS band,
       COUNT(*)                                                 AS samples,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)       AS pct_of_runtime,
       ROUND(AVG(temp_outdoor_c * 9/5 + 32), 1)                 AS avg_outdoor_f,
       ROUND(AVG(sp_indoor_airflow), 0)                         AS avg_cfm
FROM readings
WHERE sp_compressor_rps > 0
GROUP BY band
ORDER BY MIN(sp_compressor_rps);
```

Segment by outdoor temperature band as well — the hypothesis is specifically
about hot-afternoon behaviour, and mild-weather runtime will dilute it.

The three sample rows in `todo.md` show hours averaging 39.3, 35.0 and 9.8 rps
against a 73 rps ceiling. That is real modulation rather than bang-bang cycling,
which weakly argues against the "never runs at low speed" hypothesis — but those
were mild-weather hours and three rows is not a distribution.

### 2. Cycle length and count — partially answerable, with a caveat you should not skip

5-minute sampling cannot resolve a cycle shorter than 5 minutes. `README.md`
already says this about the runtime channels and it applies with equal force
here. Three things make it tractable anyway:

- `devices.sp_compressor_min_on` and `sp_compressor_min_off` (milliseconds) give
  the enforced floor. Cycles cannot be shorter than that, which bounds the error.
- `sp_compressor_runtime` is an exact cumulative counter, incrementing by 1 per
  compressor-hour. Compare duty cycle derived from sample counts against duty
  cycle derived from the counter. **The divergence between the two is itself the
  short-cycling detector**: if the sample-based estimate materially exceeds the
  counter, samples are landing during brief on-periods and crediting full
  intervals.
- `sp_target_compressor_rps` versus `sp_compressor_rps`: a target repeatedly
  stepping to zero and back is cycling, visible even between samples.

```sql
SELECT date(ts,'unixepoch','localtime')                              AS day,
       ROUND(SUM(CASE WHEN sp_compressor_rps > 0 THEN 5 ELSE 0 END)/60.0, 2) AS est_hours_from_samples,
       MAX(sp_compressor_runtime) - MIN(sp_compressor_runtime)       AS exact_hours_from_counter
FROM readings
WHERE sp_compressor_runtime IS NOT NULL
GROUP BY day
ORDER BY day DESC;
```

If you want true cycle counts, `POLL_INTERVAL_MIN` can go to 3 — Daikin's
documented floor — at the cost of ~40% more rows. Still far inside free tier.

### 3. Actual vs commanded CFM — answerable, and better than the brief expects

You do not need to derive implied CFM/ton. `sp_indoor_airflow` is
`ctIFCIndoorBlowerAirflow` in CFM; the blower reports what it is moving.

```sql
SELECT CAST(sp_compressor_rps / 10 AS INT) * 10 AS rps_band,
       COUNT(*)                                AS samples,
       ROUND(AVG(sp_indoor_airflow), 0)        AS avg_cfm,
       MAX(sp_indoor_airflow)                  AS max_cfm,
       ROUND(AVG(sp_cool_demand_pct), 0)       AS avg_cool_demand_pct,
       ROUND(AVG(sp_indoor_airflow) / 3.5, 0)  AS cfm_per_ton_if_3p5
FROM readings
WHERE sp_compressor_rps > 0
GROUP BY rps_band
ORDER BY rps_band;
```

Read the top band, at or near 100% cool demand:

- **~1400 CFM** → Cool CFM is set to 42. Correct, and the brief's dominant-factor
  worry is ruled out.
- **~1600 CFM** → Cool CFM is set to 48. That is the 14% overshoot, and it does
  dominate everything else.

`todo.md` records a maximum observed airflow of **1126 CFM**, but over a window
where outdoor temperature ranged 75–84 °F. The compressor almost certainly never
reached full demand there, so 1126 is not the ceiling — it is weak evidence
against 1600, not proof of 1400. Filter to genuinely high-demand samples before
concluding.

**Confidence note.** The temperature family was calibrated by cross-reference
against a known-good field (`sp_od_air_temp` against `outdoor_f`). Airflow was
"confirmed" by plausible range only. It is a reasonable bet — the 65535 sentinel
is documented as the unavailable-airflow marker, which implies the field is
genuinely airflow — but it has not been cross-checked the way the temperatures
were.

### 4. Is dehum demand ever requested — answerable

See the decision table above. This is the question that should be answered before
any other work happens, because two of its four outcomes make the rest moot.

### 5. Latent capacity / SHR — **not answerable as specified**

The brief asks for SHR from coil entering and leaving conditions. That requires
leaving-air temperature and humidity. Neither exists here, and this is
established rather than assumed: `scripts/summarize_skyport.py` probes for
`ctIFCReturnAirTemperature` and `ctIFCSupplyAirTemperature`, and neither made it
into `SKYPORT_COLUMNS`. `src/skyport/map.ts` says so directly — "the whole ctAH*
air-handler group, return/supply air temps" read as sentinels on this equipment.
There is no refrigerant-side substitute for an air-side enthalpy difference.

**What to do instead: an indoor moisture balance.** It answers the question
behind the question, and needs only columns you already have.

Convert every sample to indoor humidity ratio, then measure two slopes:

- **dW/dt while the compressor is running** — net moisture removal rate.
- **dW/dt while it is off** — the house's moisture gain rate, from infiltration
  plus internal sources.

Multiply each by the house air mass (volume × ~0.075 lb/ft³) and you have
lb/hr; times ~1061 BTU/lb gives latent BTU/hr.

This distinguishes exactly what the brief wants distinguished. If removal
during runs barely exceeds gain during off-periods, the system is at
equilibrium at 60% and no amount of coil tuning will move it — the answer is
load reduction or a dedicated dehumidifier. If removal comfortably exceeds gain
but the system runs too little, the tuning is the right lever after all.

It is also the more honest measurement for this complaint: SHR is a nameplate
comparison, whereas moisture balance measures whether the house is actually
losing the fight.

### 6. Before/after on the two changes — answerable, and self-documenting

You do not have to remember when you made change 1. **`fan_circulate` is a stored
column**, so the change is timestamped in the data:

```sql
SELECT datetime(ts,'unixepoch','localtime') AS changed_at, prev, fan_circulate
FROM (SELECT ts, fan_circulate,
             LAG(fan_circulate) OVER (PARTITION BY device_id ORDER BY ts) AS prev
      FROM readings)
WHERE prev IS NOT NULL AND prev <> fan_circulate;
```

Better still, the *mechanism* you hypothesised is directly measurable, not just
its downstream RH effect. Re-evaporation requires the blower to run while the
coil is wet and the compressor is off:

```sql
SELECT date(ts,'unixepoch','localtime') AS day,
       ROUND(100.0 * AVG(CASE WHEN sp_compressor_rps = 0
                               AND sp_indoor_airflow > 0 THEN 1.0 ELSE 0 END), 1)
         AS pct_samples_fan_on_compressor_off
FROM readings
GROUP BY day ORDER BY day;
```

That percentage should fall to near zero across the change timestamp. If it
does not, circulation was not actually off, and any RH improvement came from
somewhere else.

Change 2 (dehumidification → A) is **not** self-documenting: no commissioning
setting is stored, so there is no column that moves when you change it. Only its
effect on the RPS distribution is observable. Worth closing — see *Gaps* below.

**Segment on comparable outdoor conditions, not on calendar days.** Comparing
before-day to after-day only works if outdoor humidity ratio was similar. Bucket
by outdoor W, not by date.

### 7. Superheat and suction margin before trimming — answerable, and it resolves a stuck calibration

`sp_eev_superheat` is uncalibrated (raw 271–846, which as tenths °F would be
27–85 °F against a normal 8–15). Do not use it. **Derive superheat from first
principles instead**, from two fields that *are* calibrated:

```
superheat_F = eev_suction_temp_F − Tsat_R410A(suction_pressure_psi)
```

A quadratic fit to the R-410A saturated-vapour curve, accurate to ±0.53 °F over
20–65 °F:

```
Tsat_F = -28.509381 + 0.718356 * P - 0.00118439 * P * P
```

```sql
SELECT datetime(ts,'unixepoch','localtime') AS local_time,
       ROUND(sp_compressor_rps, 1)                                AS rps,
       ROUND(sp_suction_pressure, 1)                              AS suction_psi,
       ROUND(-28.509381 + 0.718356 * sp_suction_pressure
             - 0.00118439 * sp_suction_pressure * sp_suction_pressure, 1) AS sat_temp_f,
       ROUND(sp_eev_suction_temp / 10.0, 1)                       AS suction_temp_f,
       ROUND(sp_eev_suction_temp / 10.0
             - (-28.509381 + 0.718356 * sp_suction_pressure
                - 0.00118439 * sp_suction_pressure * sp_suction_pressure), 1) AS derived_superheat_f,
       sp_eev_superheat                                           AS raw_superheat_field
FROM readings
WHERE sp_compressor_rps > 0 AND sp_suction_pressure IS NOT NULL
ORDER BY ts DESC LIMIT 200;
```

Two payoffs. First, it gives you the safety margin the brief wants before
trimming. Second, regressing `raw_superheat_field` against `derived_superheat_f`
should finally calibrate `sp_eev_superheat` — one of the three fields `todo.md`
lists as blocked.

**Two things to check before trusting the number:**

- **Gauge or absolute?** A 14.7 psi offset shifts saturation temperature by
  roughly 5–6 °F in this range, which is most of a superheat budget. Sanity-check
  against a steady-state run: an evaporator saturation temperature of 40–45 °F
  during normal cooling means gauge.
- **The pressure is measured at the outdoor unit.** `ctEEVCoilPressureSensor` was
  probed for and is not stored, so there is no indoor coil pressure. Line loss
  between coil and compressor means the indoor coil sits slightly higher than
  the measured suction pressure, so this derivation slightly *overestimates*
  superheat — it errs toward saying you have margin you do not have.

**The flag that matters most.** `todo.md` records suction pressure ranging
61–192 psi. **61 psi is a saturation temperature near 11 °F.** If that is a
startup or pump-down transient, it is unremarkable. If it occurs during steady
low-speed running, your evaporator is already below freezing at current airflow
and the planned −9% trim will ice the coil. Settle this before touching the trim:

```sql
SELECT ROUND(-28.509381 + 0.718356 * sp_suction_pressure
             - 0.00118439 * sp_suction_pressure * sp_suction_pressure, 0) AS sat_temp_f,
       COUNT(*) AS samples,
       ROUND(AVG(sp_compressor_rps), 1) AS avg_rps,
       ROUND(AVG(sp_indoor_airflow), 0) AS avg_cfm
FROM readings
WHERE sp_compressor_rps > 0 AND sp_suction_pressure IS NOT NULL
GROUP BY sat_temp_f
ORDER BY sat_temp_f;
```

Anything with meaningful sample counts below ~32 °F, at low rps, is a stop sign.

### 8. Infiltration vs internal load — answerable, with one real caveat

Both indoor and outdoor temperature and RH are stored, so both humidity ratios
are derivable. SQLite's `exp()` is available in the build used here; if libSQL
rejects it, compute W client-side from `/api/series` instead.

```sql
WITH w AS (
  SELECT ts,
         0.622 * (6.112 * exp(17.67 * temp_indoor_c / (temp_indoor_c + 243.5)) * hum_indoor / 100.0)
           / (1013.25 - (6.112 * exp(17.67 * temp_indoor_c / (temp_indoor_c + 243.5)) * hum_indoor / 100.0))
           * 7000 AS w_in_gr,
         0.622 * (6.112 * exp(17.67 * temp_outdoor_c / (temp_outdoor_c + 243.5)) * hum_outdoor / 100.0)
           / (1013.25 - (6.112 * exp(17.67 * temp_outdoor_c / (temp_outdoor_c + 243.5)) * hum_outdoor / 100.0))
           * 7000 AS w_out_gr
  FROM readings
  WHERE temp_indoor_c IS NOT NULL AND hum_indoor IS NOT NULL
)
SELECT strftime('%H', ts, 'unixepoch', 'localtime') AS hour,
       ROUND(AVG(w_in_gr), 1)  AS indoor_gr_lb,
       ROUND(AVG(w_out_gr), 1) AS outdoor_gr_lb
FROM w GROUP BY hour ORDER BY hour;
```

Then cross-correlate `w_in` against `w_out` at lags of 0–12 hours. A clear peak
at some positive lag points to envelope leakage or an outside-air damper. No
correlation with outdoor W but a strong diurnal or occupancy pattern points to
internal latent load. As the brief says, this determines whether any thermostat
setting can solve the problem at all.

**Caveat: outdoor humidity is probably not measured on site.** There is no
outdoor humidity sensor in the field list. `sp_od_air_temp` is the outdoor unit's
own air sensor, and `todo.md` shows it reading 76.3–89.1 °F while thermostat
`outdoor_f` read 75.2–84.2 °F over the same window — different sources, with the
hardware sensor running hotter (sun and condenser heat). Since there is no
hardware humidity equivalent, `hum_outdoor` is almost certainly a weather-service
value for your postal code. It carries its own lag and smoothing, which will blur
the correlation. Treat a weak result as inconclusive rather than as evidence of
no infiltration.

## Two corrections to the brief

**Indoor humidity ratio is ~65.5 gr/lb, not ~62.** At 70 °F and 60% RH at sea
level, W = 0.00936 lb/lb = 65.5 gr/lb. The verified query above returns exactly
this. The dew point (~55 °F), the outdoor figures (~104 gr/lb, ~68 °F dew point)
and the setpoint observation ("~50% at 75 °F" — computes to 50.7%) all check out;
only the indoor humidity ratio is off, by about 5%. It changes no conclusion in
the brief, but question 8 is arithmetic *on* these numbers, so it is worth
correcting before the moisture balance is built on it.

**The 1126 CFM figure is not a ceiling.** It is the maximum observed during a
mild-weather calibration window. Do not read it as evidence that Cool CFM is set
correctly, and do not compute the −9% trim from it.

## Gaps worth closing in the pipeline

Ordered by what they unblock.

1. **Compute humidity ratio in `/api/series`.** Add `w_indoor_gr` and
   `w_outdoor_gr` from the four columns already stored. RH at a moving dry-bulb
   is not a moisture measurement, and the brief's own note about the setpoint
   inflating the RH number is precisely this problem. Every dehumidification
   question here becomes cleaner in W. Highest value, lowest effort — no schema
   change, no new capture.
2. **Add derived superheat** as `derived_superheat_f`, per question 7. It gives a
   trustworthy number where `sp_eev_superheat_raw` gives an untrustworthy one,
   and it is the path to calibrating that field rather than leaving it raw
   indefinitely.
3. **Re-probe for the dehum and commissioning fields.** Run
   `scripts/probe-skyport.sh` again and grep the ~900-field response for
   `dehum`, `CFM`, `airflow`, `trim`, and `profile`. If a dehum-demand or
   Cool-CFM field is populated on current firmware, adding columns would make
   question 4 direct rather than proxied through `equipment_status = 2`, and
   would make commissioning changes self-documenting the way `fan_circulate`
   already is. The earlier probe predates whatever firmware is running now.
4. **Consider `POLL_INTERVAL_MIN = 3`** for the duration of this investigation.
   Question 2 is the one question genuinely limited by sampling rate, and 3
   minutes is Daikin's documented floor. Revert afterwards.
5. **Supply and return air temperature are not recoverable from Skyport.** If SHR
   against nameplate really matters, that needs a supply-air sensor, outside
   this pipeline. The moisture balance in question 5 is the better answer for
   the question actually being asked.

## Suggested order of work

1. Run the dehum decision table. If it lands in row 1 or 2, stop — fix the
   homeowner setting and re-measure. Everything downstream is moot.
2. Run the CFM-by-rps-band query at high demand. Settle Cool CFM = 42 vs 48.
3. Run the saturation-temperature histogram. Establish whether the −9% trim has
   any margin at all.
4. Only then: RPS distribution, cycle cross-check, and the before/after on
   circulation.
5. Build the moisture balance and the infiltration correlation. These decide
   whether the whole equipment-side effort can succeed.
