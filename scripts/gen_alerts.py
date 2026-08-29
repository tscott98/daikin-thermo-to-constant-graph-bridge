#!/usr/bin/env python3
"""Create the Daikin alert rules in Grafana, and verify they evaluate.

Written as a provisioning script rather than a YAML file because the YAML that
preceded it was never importable: Grafana Cloud has no provisioning directory
to drop a file into, and its import UI expects a different shape. This talks to
/api/v1/provisioning/alert-rules, which is the interface that actually exists.

Rules ask the API for a relative window (`last=`) rather than $__from/$__to.
The alerting evaluator does not interpolate those macros -- it sends them
through literally, the API sees no range, and every evaluation silently pulls
its 24-hour default.

Usage:
    python scripts/gen_alerts.py          create or update the rules
    python scripts/gen_alerts.py --check  report each rule's current state
"""
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ["GRAFANA_URL"].rstrip("/")
TOKEN = os.environ["GRAFANA_TOKEN"]
FOLDER = "Daikin"
GROUP = "daikin-bridge"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, method=method, data=data, headers={
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
        # Provisioned rules are normally read-only in the UI. This says the
        # rules may also be edited there, which suits a single-operator setup
        # better than locking them to this script.
        "X-Disable-Provenance": "true",
    })
    try:
        with urllib.request.urlopen(r) as f:
            raw = f.read().decode()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()[:400]}


def infinity_uid():
    for d in api("GET", "/api/datasources"):
        if "infinity" in d.get("type", "").lower():
            return d["uid"]
    sys.exit("error: no Infinity datasource")


DS = infinity_uid()


def query(ref, url, selector, window, timeseries=True):
    """One Infinity query stage, over a relative window the alerting path can express.

    Series queries must come back as a time series, not a table. A multi-row
    table frame carries a value column and no time column, and the reducer
    rejects it with "invalid format of evaluation results" -- which looks like
    a rule bug rather than a shape mismatch. /health is the exception: it
    returns a single object with no timestamp, so one table row is the whole
    answer and reduces cleanly.
    """
    cols = [{"selector": "time", "text": "time", "type": "timestamp"}] if timeseries else []
    cols.append({"selector": selector, "text": "value", "type": "number"})
    return {
        "refId": ref,
        "relativeTimeRange": {"from": window, "to": 0},
        "datasourceUid": DS,
        "model": {
            "refId": ref, "datasource": {"type": "yesoreyeram-infinity-datasource", "uid": DS},
            "type": "json", "source": "url", "parser": "backend",
            "format": "timeseries" if timeseries else "table",
            "url": url, "url_options": {"method": "GET"}, "root_selector": "",
            "columns": cols, "filters": [],
        },
    }


def reduce_(ref, on, reducer="last"):
    return {
        "refId": ref, "datasourceUid": "__expr__",
        "model": {"refId": ref, "type": "reduce", "expression": on, "reducer": reducer,
                  "datasource": {"type": "__expr__", "uid": "__expr__"},
                  "settings": {"mode": "dropNN"}},
    }


def threshold(ref, on, op, value):
    return {
        "refId": ref, "datasourceUid": "__expr__",
        "model": {"refId": ref, "type": "threshold", "expression": on,
                  "datasource": {"type": "__expr__", "uid": "__expr__"},
                  "conditions": [{"evaluator": {"type": op, "params": [value]}}]},
    }


def rule(uid, title, url, selector, op, value, window, for_, severity,
         summary, description, reducer="last", no_data="Alerting", timeseries=True):
    return {
        "uid": uid, "title": title, "condition": "C", "ruleGroup": GROUP,
        "orgID": 1, "for": for_,
        "annotations": {"summary": summary, "description": description},
        "labels": {"severity": severity, "service": "daikin-bridge"},
        "noDataState": no_data, "execErrState": "Alerting",
        "data": [query("A", url, selector, window, timeseries), reduce_("B", "A", reducer),
                 threshold("C", "B", op, value)],
    }


SERIES = "/api/series?last={w}&interval=300000&fields={f}"
AIR = "/api/air?last={w}&interval=300000&fields={f}"

RULES = [
    # The one that matters most: everything else assumes data is arriving, and
    # this is the only thing that notices when it stops. /health is
    # unauthenticated and returns counts only, so it keeps working through a
    # read-key rotation.
    rule("daikin-collection-stalled", "Daikin bridge has stopped collecting",
         "/health", "seconds_since_last_reading", "gt", 600, 900, "10m", "critical",
         "No thermostat reading for over 10 minutes",
         "The cron runs every 5 minutes, so 600s is two missed cycles -- one is "
         "normal jitter and must not page. The Worker cron may have failed, Turso "
         "may be unreachable, or the Daikin credentials may have expired. "
         "Check /health, then wrangler tail.", timeseries=False),

    # Six separate fault registers; max across them means any one firing trips
    # this, without six near-identical rules.
    rule("daikin-equipment-fault", "Daikin equipment fault",
         SERIES.format(w=1800, f="sp_fault_od_critical,sp_fault_od_minor,"
                                 "sp_fault_ifc_critical,sp_fault_ifc_minor,"
                                 "sp_fault_stat_critical,sp_fault_stat_minor"),
         "sp_fault_od_critical", "gt", 0, 1800, "5m", "critical",
         "Equipment is reporting a fault code",
         "One of the fault registers went non-zero. sp_fault1_code on the health "
         "dashboard says which code; note that field is the fault LOG and stays "
         "populated after the condition clears, so trust these booleans for "
         "whether it is live.",
         reducer="max",
         # Not Alerting. Its query returns nothing whenever collection stops, so
         # a NoData->Alerting default made every outage raise a second, false
         # "equipment fault" alongside the true "stopped collecting" -- which it
         # did on 2026-08-28. Two alerts for one cause is noise at exactly the
         # moment the signal matters. Collection-stalled already covers silence.
         no_data="OK"),

    # The dehumidification investigation in alert form. An hour of breach, so a
    # shower or a pot on the stove does not fire it.
    rule("daikin-humidity-high", "Indoor humidity above target",
         SERIES.format(w=5400, f="hum_indoor"), "hum_indoor", "gt", 55, 5400,
         "1h", "warning",
         "Indoor RH above 55% for an hour",
         "The target band is 45-55%. Sustained for an hour, so brief moisture "
         "events do not trigger it. Check the dehumidification dashboard: the "
         "capability panel shows whether the equipment is already at its limit, "
         "which distinguishes 'not keeping up' from 'not trying'.",
         no_data="OK"),

    # Twice a year at most.
    rule("daikin-filter-due", "Air filter due for replacement",
         SERIES.format(w=3600, f="sp_filter_days,sp_filter_days_limit"),
         "sp_filter_days", "gt", 183, 3600, "6h", "info",
         "Media filter has reached its service interval",
         "Days elapsed passed the 183-day interval. Beyond maintenance, a loaded "
         "filter is one candidate explanation for airflow running under "
         "commanded, so replacing it also removes a variable from that question.",
         no_data="OK"),

    # Uses the _max columns: a five-minute cooking spike averaged across a
    # bucket is exactly the event this should catch, and AVG erases it.
    rule("daikin-pm25-high", "Indoor PM2.5 elevated",
         AIR.format(w=3600, f="ag_pm02_max"), "ag_pm02_max", "gt", 35, 3600,
         "30m", "warning",
         "Indoor PM2.5 peak above 35 ug/m3 for 30 minutes",
         "35 is the EPA 24-hour standard. Reads the bucket peak rather than the "
         "mean, so short events are not averaged away -- which does mean cooking "
         "will trigger it. Sustained half an hour separates a meal from a "
         "genuine air quality problem.",
         no_data="OK"),

    rule("daikin-co2-high", "Indoor CO2 elevated",
         AIR.format(w=3600, f="ag_co2_max"), "ag_co2_max", "gt", 1200, 3600,
         "30m", "warning",
         "Indoor CO2 peak above 1200 ppm for 30 minutes",
         "Above 1200 ppm has measurable effects on concentration. Outdoor air is "
         "about 420, so the excess is accumulated breath -- the response is "
         "ventilation, not filtration.",
         no_data="OK"),
]


def folder_uid():
    """An existing folder this token can actually write rules into.

    Deliberately does not create one. A folder created through the API is not
    granted to the service account that created it, so the create succeeds,
    returns a uid, and every subsequent write to it fails 403 -- the folder is
    then invisible in listings and cannot be deleted by the same token either.
    Better to use a folder that exists than to mint one that cannot be used.

    Set GRAFANA_ALERT_FOLDER to pick a specific one; make it in the Grafana UI
    first, where ownership is granted properly.
    """
    folders = [f for f in (api("GET", "/api/folders") or [])
               if f.get("uid") not in ("sharedwithme",)]
    want = os.environ.get("GRAFANA_ALERT_FOLDER", FOLDER)
    for f in folders:
        if f.get("title") == want:
            return f["uid"]
    if not folders:
        sys.exit("error: no writable folder; create one in the Grafana UI first")
    pick = folders[0]
    print(f"note: no folder named {want!r}; using {pick['title']!r}. "
          "Create one in the UI and set GRAFANA_ALERT_FOLDER to move them.")
    return pick["uid"]


def check():
    state = api("GET", "/api/prometheus/grafana/api/v1/rules") or {}
    seen = {}
    for g in (state.get("data") or {}).get("groups", []):
        for r in g.get("rules", []):
            seen[r.get("name")] = (r.get("state"), r.get("health"), r.get("lastError", ""))
    print(f"{'rule':44} {'state':10} {'health':8} error")
    for r in RULES:
        s, h, e = seen.get(r["title"], ("MISSING", "-", ""))
        print(f"{r['title'][:44]:44} {s:10} {h:8} {e[:70]}")
    return seen


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
        raise SystemExit

    fuid = folder_uid()
    for r in RULES:
        r["folderUID"] = fuid
        existing = api("GET", f"/api/v1/provisioning/alert-rules/{r['uid']}")
        is_new = isinstance(existing, dict) and existing.get("_error")
        res = (api("POST", "/api/v1/provisioning/alert-rules", r) if is_new
               else api("PUT", f"/api/v1/provisioning/alert-rules/{r['uid']}", r))
        if isinstance(res, dict) and res.get("_error"):
            print(f"FAILED {r['title']}: {res['_error']} {res['_body']}")
        else:
            print(f"{'created' if is_new else 'updated'}  {r['title']}")
