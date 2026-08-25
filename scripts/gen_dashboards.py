#!/usr/bin/env python3
"""Generate the Grafana dashboards from a single panel description.

Hand-maintaining Grafana JSON is how panels drift apart: one gets a unit, its
neighbour does not. Everything shared -- the Infinity query shape, the column
declarations, the datasource placeholder -- is defined once here.

Dashboards are grouped by the question being asked and how often, not by which
sensor the data came from. See todo.md for the reasoning.
"""
import json

# Panel URLs keep a leading slash. The Infinity data source joins them onto its
# base URL, and that base may or may not carry a trailing slash depending on how
# it was configured -- a leading slash works either way, because the Worker
# collapses duplicate slashes in the request path.
DS = {"type": "yesoreyeram-infinity-datasource", "uid": "${DS_INFINITY}"}
BASE_URL = "/api/series?from=$__from&to=$__to&interval=$__interval_ms&device=$device"


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


def dashboard(uid, title, description, panels, refresh="5m", time_from="now-7d", tags=None):
    return {
        "__inputs": [{
            "name": "DS_INFINITY", "label": "Infinity data source", "type": "datasource",
            "pluginId": "yesoreyeram-infinity-datasource", "pluginName": "Infinity",
            "description": "Infinity data source pointing at your Worker's base URL.",
        }],
        "__requires": [{"type": "datasource", "id": "yesoreyeram-infinity-datasource",
                        "name": "Infinity", "version": "1.0.0"}],
        # A stable uid makes a re-push an update rather than a new copy.
        # Without it Grafana mints a fresh uid each time and the dashboard list
        # fills with near-identical duplicates.
        "uid": uid,
        # Surface config-change annotations on every chart. The brief's own
        # constraint is one change at a time with a day between so effects stay
        # attributable -- that only works if the changes are visible on the
        # timeline you are reading the effect from.
        "annotations": {"list": [
            {
                "builtIn": 1,
                "datasource": {"type": "grafana", "uid": "-- Grafana --"},
                "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)",
                "name": "Annotations & Alerts", "type": "dashboard",
            },
            {
                "datasource": {"type": "grafana", "uid": "-- Grafana --"},
                "enable": True, "hide": False, "iconColor": "orange",
                "name": "Config changes", "target": {"limit": 100,
                "matchAny": False, "tags": ["daikin", "config-change"], "type": "tags"},
            },
        ]},
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
          # No panel-level unit: on an XY chart the default applies to both
          # axes, which would label outdoor temperature in watts. Units go on
          # the fields instead.
          {"h": 9, "w": 12, "x": 0, "y": 8}, unit="", ptype="xychart", fmt="table",
          overrides=[
              {"matcher": {"id": "byName", "options": "Outdoor"},
               "properties": [{"id": "unit", "value": "fahrenheit"}]},
              {"matcher": {"id": "byName", "options": "Power"},
               "properties": [{"id": "unit", "value": "watt"}]},
          ],
          url="/api/series?from=$__from&to=$__to&interval=3600&device=$device",
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
          overrides=[
              {"matcher": {"id": "byName", "options": "Outdoor"},
               "properties": [{"id": "unit", "value": "fahrenheit"}]},
          ],
          url="/api/series?from=$__from&to=$__to&interval=3600&device=$device",
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





# ---------------------------------------------------------------- Dashboard D
# Dehumidification investigation. Unlike the other three this is temporary:
# it exists to answer the questions in reference/hvac-dehumidification-brief.md
# and should be retired or folded into Home once the question is settled.

RH_BAND = [
    {"matcher": {"id": "byName", "options": "Indoor RH"},
     "properties": [
         {"id": "custom.fillOpacity", "value": 0},
         {"id": "custom.lineWidth", "value": 3},
         {"id": "color", "value": {"mode": "fixed", "fixedColor": "blue"}},
         {"id": "max", "value": 70}, {"id": "min", "value": 35},
         {"id": "thresholds", "value": {"mode": "absolute", "steps": [
             {"color": "orange", "value": None},   # below 45: too dry
             {"color": "green", "value": 45},      # target band
             {"color": "red", "value": 55},        # above target
         ]}},
         {"id": "custom.thresholdsStyle", "value": {"mode": "area"}},
     ]},
]

DEHUM = [
    panel(1, "Indoor RH against the 45-55% target", [("hum_indoor", "Indoor RH")],
          {"h": 9, "w": 24, "x": 0, "y": 0}, unit="percent",
          desc="The goal metric. Green band is target; red above, amber below. "
               "Read it alongside the humidity ratio panel: RH alone conflates "
               "'the air got wetter' with 'the setpoint moved', because the same "
               "moisture reads 60% at 70F and about 50% at 75F.",
          overrides=RH_BAND),

    panel(2, "Humidity ratio - indoor vs outdoor",
          [("indoor_w_gr", "Indoor"), ("outdoor_w_gr", "Outdoor")],
          {"h": 9, "w": 12, "x": 0, "y": 9},
          desc="Absolute moisture, grains per pound of dry air, independent of "
               "temperature. If indoor tracks outdoor with a lag, moisture is "
               "getting in through the envelope and no thermostat setting fixes "
               "it. If it tracks time of day instead, the load is internal. "
               "Needs several diurnal cycles to tell those apart.",
          overrides=[color("Indoor", "blue"), color("Outdoor", "orange")]),

    panel(3, "Dew point - indoor vs outdoor",
          [("indoor_dewpoint_f", "Indoor"), ("outdoor_dewpoint_f", "Outdoor")],
          {"h": 9, "w": 12, "x": 12, "y": 9}, unit="fahrenheit",
          desc="Indoor dew point below outdoor means the coil is removing "
               "moisture. The size of the gap is how much.",
          overrides=[color("Indoor", "blue"), color("Outdoor", "orange")]),

    panel(4, "Is dehumidification actually being requested?",
          [("sp_dehum_demand_pct", "Outdoor dehum demand"),
           ("sp_alg_dehum_demand", "Algorithm dehum"),
           ("sp_alg_overcool_demand", "Algorithm overcool"),
           ("sp_alg_cool_demand", "Algorithm cool")],
          {"h": 8, "w": 24, "x": 0, "y": 18}, unit="percent",
          desc="If dehum demand sits at zero while cool demand is active, the "
               "humidity target is misconfigured and no equipment-side airflow "
               "tuning can help. Cool demand is plotted alongside so a zero "
               "reading can be told apart from the system simply not running.",
          overrides=[color("Outdoor dehum demand", "blue"),
                     color("Algorithm dehum", "light-blue"),
                     color("Algorithm overcool", "purple"),
                     color("Algorithm cool", "text")]),

    panel(5, "Airflow - commanded vs actual",
          [("sp_requested_airflow", "Commanded CFM"), ("sp_indoor_airflow", "Actual CFM")],
          {"h": 8, "w": 12, "x": 0, "y": 26},
          desc="Actual oscillating around commanded is normal control lag. "
               "Actual sitting persistently below commanded points at static "
               "pressure - a loaded filter or duct restriction. Sustained "
               "divergence is the signal, not any single sample.",
          overrides=[color("Commanded CFM", "yellow"), color("Actual CFM", "green")]),

    panel(6, "Compressor speed - long low-speed runs are what dehumidify",
          [("sp_compressor_rps", "Compressor RPS"), ("sp_frequency_pct", "Frequency %")],
          {"h": 8, "w": 12, "x": 12, "y": 26},
          desc="Moisture removal comes from sustained low-speed operation, not "
               "from short bursts at high speed: the coil needs time to get wet. "
               "Frequent excursions to high RPS with little time at low speed is "
               "the pattern that under-dehumidifies.",
          overrides=[color("Compressor RPS", "green"), color("Frequency %", "purple")]),

    panel(7, "Derived superheat - the margin before trimming airflow",
          [("superheat_f", "Superheat")],
          {"h": 8, "w": 24, "x": 0, "y": 34}, unit="fahrenheit",
          desc="Computed from suction pressure and coil suction temperature "
               "against an R-410A curve, not read from the equipment's own "
               "superheat field, whose scale could not be established. Normal is "
               "8-15F. Trimming airflow lowers this; watch it before and after "
               "any trim, because too little superheat floods the compressor.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Superheat"},
               "properties": [
                   {"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}},
                   {"id": "custom.fillOpacity", "value": 15},
                   {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                       {"color": "red", "value": None},
                       {"color": "green", "value": 8},
                   ]}},
                   {"id": "custom.thresholdsStyle", "value": {"mode": "dashed"}},
               ]},
          ]),
]


if __name__ == "__main__":
    import io

    out = {
        "grafana/dashboard-energy.json": dashboard(
            "daikin-energy",
            "Daikin — Energy & Efficiency",
            "What the system costs to run and whether it is performing as it should. "
            "Defaults to 30 days; a single day says nothing about cost.",
            ENERGY, refresh="15m", time_from="now-30d",
            tags=["daikin", "energy"]),
        "grafana/dashboard-dehum.json": dashboard(
            "daikin-dehum",
            "Daikin — Dehumidification investigation",
            "Answers the questions in reference/hvac-dehumidification-brief.md. "
            "Temporary by design: retire or fold into Home once the question is settled.",
            DEHUM, refresh="5m", time_from="now-3d",
            tags=["daikin", "dehumidification"]),
        "grafana/dashboard-health.json": dashboard(
            "daikin-health",
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
