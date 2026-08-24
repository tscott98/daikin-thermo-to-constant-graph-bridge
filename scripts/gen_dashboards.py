#!/usr/bin/env python3
"""Generate the Grafana dashboards from a single panel description.

Hand-maintaining Grafana JSON is how panels drift apart: one gets a unit, its
neighbour does not. Everything shared -- the Infinity query shape, the column
declarations, the datasource placeholder -- is defined once here.

Dashboards are grouped by the question being asked and how often, not by which
sensor the data came from. See todo.md for the reasoning.
"""
import json

DS = {"type": "yesoreyeram-infinity-datasource", "uid": "${DS_INFINITY}"}
BASE_URL = "api/series?from=$__from&to=$__to&interval=$__interval_ms&device=$device"


def target(columns, url=BASE_URL, fmt="timeseries"):
    """One Infinity query. Columns must be declared explicitly for the backend
    parser; it will not infer them, and a missing time column is the usual
    cause of 'Data is missing a time field'."""
    cols = [{"selector": "time", "text": "time", "type": "timestamp"}] if fmt == "timeseries" else []
    cols += [{"selector": s, "text": t, "type": "number"} for s, t in columns]
    return [{
        "refId": "A", "datasource": DS, "type": "json", "source": "url",
        "parser": "backend", "format": fmt, "url": url,
        "url_options": {"method": "GET"}, "root_selector": "",
        "columns": cols, "filters": [],
    }]


def color(name, c):
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}}]}


def panel(pid, title, columns, gp, unit="", desc="", ptype="timeseries",
          overrides=None, url=BASE_URL, fmt="timeseries", opts=None, custom=None,
          thresholds=None):
    fc = {"defaults": {"unit": unit, "custom": custom or {"lineWidth": 2, "fillOpacity": 6}},
          "overrides": overrides or []}
    if thresholds:
        fc["defaults"]["thresholds"] = thresholds
        fc["defaults"]["color"] = {"mode": "thresholds"}
    return {
        "id": pid, "title": title, "type": ptype, "datasource": DS,
        "description": desc, "gridPos": gp,
        "targets": target(columns, url, fmt),
        "fieldConfig": fc,
        "options": opts or {
            "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "none"},
        },
    }


STAT_OPTS = {
    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
    "orientation": "auto", "textMode": "auto", "colorMode": "background",
    "graphMode": "none", "justifyMode": "auto",
}

OK_BAD = {"mode": "absolute", "steps": [
    {"color": "green", "value": None}, {"color": "red", "value": 1}]}


def dashboard(title, description, panels, refresh="5m", time_from="now-7d", tags=None):
    return {
        "__inputs": [{
            "name": "DS_INFINITY", "label": "Infinity data source", "type": "datasource",
            "pluginId": "yesoreyeram-infinity-datasource", "pluginName": "Infinity",
            "description": "Infinity data source pointing at your Worker's base URL.",
        }],
        "__requires": [{"type": "datasource", "id": "yesoreyeram-infinity-datasource",
                        "name": "Infinity", "version": "1.0.0"}],
        "title": title, "description": description,
        "schemaVersion": 39, "editable": True, "graphTooltip": 1,
        "refresh": refresh, "time": {"from": time_from, "to": "now"},
        "timezone": "browser", "tags": tags or ["daikin"],
        "templating": {"list": [{
            "name": "device", "label": "Device ID", "type": "textbox",
            "query": "", "current": {"text": "", "value": ""},
            "description": "Optional. Blank for all thermostats; IDs from /api/stats.",
            "hide": 0, "skipUrlSync": False,
        }]},
        "panels": panels,
    }


# ---------------------------------------------------------------- Dashboard B
# Energy & Efficiency. Question: what is this costing, and is it performing?
# Cadence: monthly, or when a bill surprises. Default range is 30 days because
# a single day tells you nothing about cost.

ENERGY = [
    panel(1, "Power draw", [("sp_outdoor_power", "Outdoor unit")],
          {"h": 8, "w": 16, "x": 0, "y": 0}, unit="watt",
          desc="Outdoor unit power. The indoor figure is omitted: its scale is "
               "unverified, so charting it next to a real watt value would imply "
               "a precision we do not have.",
          overrides=[color("Outdoor unit", "yellow")],
          custom={"lineWidth": 1, "fillOpacity": 20}),

    panel(2, "Compressor hours per day", [("compressor_runtime_delta", "Hours")],
          {"h": 8, "w": 8, "x": 16, "y": 0}, unit="h",
          desc="From the equipment's own cumulative compressor-hour counter, "
               "differenced between buckets. Exact at daily resolution. Set the "
               "panel interval to 1d; at finer intervals this reads mostly zero "
               "because the counter only ticks once per accumulated hour.",
          overrides=[{"matcher": {"id": "byName", "options": "Hours"},
                      "properties": [{"id": "custom.drawStyle", "value": "bars"},
                                     {"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]}]),

    panel(3, "Power vs outdoor temperature",
          [("outdoor_f", "Outdoor"), ("sp_outdoor_power", "Power")],
          {"h": 9, "w": 12, "x": 0, "y": 8}, unit="watt", ptype="xychart", fmt="table",
          url="api/series?from=$__from&to=$__to&interval=3600&device=$device",
          desc="The efficiency curve. Hourly buckets. Rising power at a given "
               "outdoor temperature, compared across seasons, is how degradation "
               "shows up before anything feels wrong.",
          opts={"mapping": "auto",
                "series": [{"showPoints": "always", "pointSize": {"fixed": 5}}],
                "legend": {"displayMode": "list", "placement": "bottom", "showLegend": False},
                "tooltip": {"mode": "single"}},
          custom={"show": "points", "pointSize": {"fixed": 5}}),

    panel(4, "Compressor modulation vs outdoor temperature",
          [("outdoor_f", "Outdoor"), ("sp_compressor_rps", "Compressor RPS")],
          {"h": 9, "w": 12, "x": 12, "y": 8}, ptype="xychart", fmt="table",
          url="api/series?from=$__from&to=$__to&interval=3600&device=$device",
          desc="Whether the inverter actually modulates or just cycles on and "
               "off. A spread of speeds across temperatures is the behaviour a "
               "variable-speed system is sold on; clustering at one speed is not.",
          opts={"mapping": "auto",
                "series": [{"showPoints": "always", "pointSize": {"fixed": 5}}],
                "legend": {"displayMode": "list", "placement": "bottom", "showLegend": False},
                "tooltip": {"mode": "single"}},
          custom={"show": "points", "pointSize": {"fixed": 5}}),

    panel(6, "Energy and cost per day",
          [("energy_kwh", "kWh"), ("cost", "Cost")],
          {"h": 8, "w": 16, "x": 0, "y": 25}, unit="kwatth",
          desc="Set the panel interval to 1d. Energy is integrated from the "
               "sample count rather than the bucket width, so a gap in "
               "collection contributes nothing instead of being billed at the "
               "average rate. Outdoor unit only -- the blower is not included, "
               "because its power reading has an unverified scale.",
          overrides=[
              color("kWh", "yellow"),
              {"matcher": {"id": "byName", "options": "Cost"},
               "properties": [{"id": "unit", "value": "currencyUSD"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}},
                              {"id": "custom.axisPlacement", "value": "right"}]},
              {"matcher": {"id": "byRegexp", "options": ".*"},
               "properties": [{"id": "custom.drawStyle", "value": "bars"},
                              {"id": "custom.fillOpacity", "value": 60}]},
          ]),

    panel(7, "Cost for selected range", [("cost", "Cost")],
          {"h": 8, "w": 8, "x": 16, "y": 25}, unit="currencyUSD", ptype="stat",
          desc="Sum of per-bucket cost across the dashboard time range, at the "
               "rate configured in RATE_PER_KWH. Outdoor unit only.",
          opts={**STAT_OPTS,
                "reduceOptions": {"calcs": ["sum"], "fields": "", "values": False},
                "colorMode": "value"}),

    panel(5, "Compressor speed and demand",
          [("sp_compressor_rps", "Actual RPS"), ("sp_target_compressor_rps", "Target RPS"),
           ("sp_frequency_pct", "Frequency %")],
          {"h": 8, "w": 24, "x": 0, "y": 17},
          desc="Actual against commanded speed. Sustained divergence means the "
               "unit cannot reach the speed it is being asked for.",
          overrides=[color("Actual RPS", "green"), color("Target RPS", "blue"),
                     color("Frequency %", "purple")]),
]


# ---------------------------------------------------------------- Dashboard C
# System Health & Diagnostics. Question: is anything wrong, or getting worse?
# Cadence: rarely by choice. Usually opened because an alert fired.

FAULTS = [
    ("sp_fault_od_critical", "Outdoor critical"),
    ("sp_fault_od_minor", "Outdoor minor"),
    ("sp_fault_ifc_critical", "Indoor critical"),
    ("sp_fault_ifc_minor", "Indoor minor"),
    ("sp_fault_stat_critical", "Thermostat critical"),
    ("sp_fault_stat_minor", "Thermostat minor"),
]

HEALTH = [
    # Fault stats first: this is what the dashboard is for.
    panel(10 + i, label, [(col, label)],
          {"h": 4, "w": 4, "x": (i % 6) * 4, "y": 0},
          ptype="stat", desc="0 is healthy. Any other value is an equipment fault code.",
          opts=STAT_OPTS, thresholds=OK_BAD)
    for i, (col, label) in enumerate(FAULTS)
]

HEALTH += [
    panel(20, "Refrigerant circuit temperatures",
          [("sp_discharge_temp_f", "Discharge"), ("sp_od_coil_temp_f", "Outdoor coil"),
           ("sp_od_liquid_temp_f", "Liquid line"), ("sp_suction_temp_f", "Suction"),
           ("sp_eev_suction_temp_f", "Indoor coil suction")],
          {"h": 9, "w": 16, "x": 0, "y": 4}, unit="fahrenheit",
          desc="The shape matters more than the values. Discharge well above "
               "coil, coil above ambient, suction coldest. A convergence between "
               "discharge and suction suggests the compressor is not pumping.",
          overrides=[color("Discharge", "red"), color("Outdoor coil", "orange"),
                     color("Liquid line", "yellow"), color("Suction", "blue"),
                     color("Indoor coil suction", "light-blue")]),

    panel(21, "Suction pressure", [("sp_suction_pressure", "Suction")],
          {"h": 9, "w": 8, "x": 16, "y": 4}, unit="pressurepsi",
          desc="R-410A. Low suction pressure alongside high superheat is the "
               "classic undercharge signature.",
          overrides=[color("Suction", "purple")]),

    panel(22, "Superheat (raw units)", [("sp_eev_superheat_raw", "Superheat (raw)")],
          {"h": 8, "w": 12, "x": 0, "y": 13},
          desc="Deliberately unconverted. Observed 271-846, which as tenths of a "
               "degree would be 27-85 F of superheat against a normal 8-15 -- so "
               "the scale is not established. Trend it over weeks and watch the "
               "direction, not the number: a steady climb is how a slow "
               "refrigerant leak announces itself.",
          overrides=[color("Superheat (raw)", "semi-dark-orange")]),

    panel(23, "Airflow and fan speed",
          [("sp_indoor_airflow", "Indoor airflow (CFM)"), ("sp_od_fan_rpm", "Outdoor fan (RPM)"),
           ("sp_eev_opening", "EEV opening (%)")],
          {"h": 8, "w": 12, "x": 12, "y": 13},
          desc="Falling indoor airflow at an unchanged fan demand is the usual "
               "sign of a loaded filter.",
          overrides=[color("Indoor airflow (CFM)", "green"),
                     color("Outdoor fan (RPM)", "blue"),
                     color("EEV opening (%)", "yellow")]),

    panel(24, "Data freshness — samples per bucket", [("samples", "Samples")],
          {"h": 6, "w": 24, "x": 0, "y": 21},
          desc="How many readings landed in each bucket. A drop to zero means "
               "collection stopped, which is different from the system being "
               "idle -- without this, a broken poller and a quiet house look "
               "identical on every other panel.",
          overrides=[color("Samples", "text")],
          custom={"lineWidth": 1, "fillOpacity": 30, "drawStyle": "bars"}),
]


if __name__ == "__main__":
    import io

    out = {
        "grafana/dashboard-energy.json": dashboard(
            "Daikin — Energy & Efficiency",
            "What the system costs to run and whether it is performing as it should. "
            "Defaults to 30 days; a single day says nothing about cost.",
            ENERGY, refresh="15m", time_from="now-30d",
            tags=["daikin", "energy"]),
        "grafana/dashboard-health.json": dashboard(
            "Daikin — System Health & Diagnostics",
            "Whether anything is wrong or slowly getting worse. Defaults to 14 days "
            "so slow trends are visible; widen to months for superheat.",
            HEALTH, refresh="5m", time_from="now-14d",
            tags=["daikin", "health"]),
    }
    for path, dash in out.items():
        io.open(path, "w", encoding="utf-8", newline="\n").write(
            json.dumps(dash, indent=2) + "\n")
        print(f"{path}: {len(dash['panels'])} panels")
