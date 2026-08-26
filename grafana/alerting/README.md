# Alerting

The rules live in [`scripts/gen_alerts.py`](../../scripts/gen_alerts.py), not in
a YAML file here.

There was a `daikin-alerts.yaml`. It could not be imported: Grafana Cloud has no
provisioning directory to drop a file into, and the import UI expects a
different shape. It carried a "NOT VERIFIED" warning, and the warning was
justified -- when finally tried against a live instance, none of it worked. The
script talks to `/api/v1/provisioning/alert-rules`, which is the interface that
actually exists, and can verify what it created.

```bash
python scripts/gen_alerts.py           # create or update the rules
python scripts/gen_alerts.py --check   # report each rule's state and health
```

Credentials come from `.grafana-env`, same as the dashboard push.

## Rules

| Rule | Fires when | For | Severity |
|---|---|---|---|
| Bridge has stopped collecting | `seconds_since_last_reading` > 600 | 10m | critical |
| Equipment fault | any of six fault registers non-zero | 5m | critical |
| Indoor humidity above target | `hum_indoor` > 55% | 1h | warning |
| Air filter due | `sp_filter_days` > 183 | 6h | info |
| Indoor PM2.5 elevated | `ag_pm02_max` > 35 µg/m³ | 30m | warning |
| Indoor CO2 elevated | `ag_co2_max` > 1200 ppm | 30m | warning |

Collection-stalled is the one that matters most: every other rule assumes data
is arriving, and this is the only thing that notices when it stops. It reads
`/health`, which is unauthenticated and returns counts only, so it keeps working
through a read-key rotation.

The two air quality rules read the `_max` columns rather than the means. A
five-minute cooking spike averaged across a bucket is exactly the event they
should catch, and `AVG` erases it -- which does mean cooking will trigger them,
hence the 30-minute `for`.

## Three things that are easy to get wrong

**The alerting evaluator does not interpolate `$__from` / `$__to`.** Dashboard
panels do; alert queries send the macros through literally, the API sees no
range and falls back to its 24-hour default. Every evaluation then drags a day
of data and the rule's own time range means nothing. Rules use `last=<seconds>`
instead, which the alerting path can express.

**Series queries must return a time series, not a table.** A multi-row table
frame has a value column and no time column, and the reducer rejects it with
`invalid format of evaluation results` -- which reads like a broken rule rather
than a shape mismatch. `/health` is the exception: one object, no timestamp, so
a single table row is the whole answer.

**A folder created through the API is not granted to the service account that
created it.** The create returns a uid, then every write to it fails 403, the
folder is invisible in listings, and the same token cannot delete it either.
Create folders in the UI; `gen_alerts.py` deliberately never creates one.

## Verifying

`--check` reports health, which catches a rule that errors. It does not prove a
rule would fire -- an alert that silently never triggers looks identical to one
that has nothing to report. To test the whole path, provision a copy with `for`
set to `0s` and a threshold current data must cross, confirm it reaches
`firing`, then delete it.

## Delivery

Rules evaluate and show state in Grafana but notify nobody: the only contact
point is Grafana Cloud's default, which points at `<example@email.com>`. Point
it somewhere real under Alerting -> Contact points to start receiving them.
