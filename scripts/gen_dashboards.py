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
AIR_URL = "/api/air?from=$__from&to=$__to&interval=$__interval_ms"


def target(columns, url=BASE_URL, fmt="timeseries"):
    """One Infinity query. Columns must be declared explicitly for the backend
    parser; it will not infer them, and a missing time column is the usual
    cause of 'Data is missing a time field'.

    A series row carries about 88 columns and the average panel charts three,
    so each query names the ones it wants. The values are identical either
    way -- the rest are simply not computed or sent, which is what keeps the
    Worker inside its CPU budget as history accumulates.
    """
    cols = [{"selector": "time", "text": "time", "type": "timestamp"}] if fmt == "timeseries" else []
    cols += [{"selector": s, "text": t, "type": "number"} for s, t in columns]
    if "/api/series" in url or "/api/air" in url:
        url += "&fields=" + ",".join(s for s, _ in columns)
    return [{
        "refId": "A", "datasource": DS, "type": "json", "source": "url",
        "parser": "backend", "format": fmt, "url": url,
        "url_options": {"method": "GET"}, "root_selector": "",
        "columns": cols, "filters": [],
    }]


def color_faint(name, c):
    """A companion series: same chart, deliberately subordinate to the main one."""
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}},
                           {"id": "custom.lineWidth", "value": 1},
                           {"id": "custom.fillOpacity", "value": 0},
                           {"id": "custom.lineStyle",
                            "value": {"fill": "dash", "dash": [6, 4]}}]}


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

    panel(8, "Duct temperatures and split",
          [("duct_return_temp_f", "Return"), ("duct_supply_temp_f", "Supply"),
           ("return_dewpoint_f", "Return dew point"), ("duct_split_f", "Split")],
          {"h": 8, "w": 12, "x": 0, "y": 34}, unit="fahrenheit",
          desc="Return against supply, with the return dew point for reference. "
               "A 15-20F split is normal for cooling. The supply probe is at a "
               "register rather than the plenum, so it reads warmer than the air "
               "leaving the coil.",
          overrides=[color("Return", "orange"), color("Supply", "blue"),
                     color("Return dew point", "purple"), color("Split", "green")]),

    panel(9, "Condensing margin",
          [("condensing_margin_f", "Supply above dew point")],
          {"h": 8, "w": 12, "x": 12, "y": 34}, unit="fahrenheit",
          desc="Supply dry bulb minus return dew point. Negative means "
               "condensation is visible at the probe. A small positive value is "
               "expected while the coil is still condensing, because duct gain "
               "warms the air before it reaches the register - so read the trend, "
               "not the sign. This is the honest version of the SHR question: "
               "with no humidity sensor at the supply, shr_est bottoms out at "
               "1.0 whenever the probe cannot see condensation.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Supply above dew point"},
               "properties": [
                   {"id": "color", "value": {"mode": "fixed", "fixedColor": "purple"}},
                   {"id": "custom.fillOpacity", "value": 15},
                   {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                       {"color": "green", "value": None},
                       {"color": "orange", "value": 0},
                   ]}},
                   {"id": "custom.thresholdsStyle", "value": {"mode": "dashed"}},
               ]},
          ]),

    panel(10, "Measured cooling capacity and efficiency",
          [("sensible_btuh", "Sensible BTU/hr"), ("eer_est", "EER (est)")],
          {"h": 8, "w": 24, "x": 0, "y": 42},
          desc="Sensible capacity is exact: 1.08 x CFM x split. Compare against "
               "the 42,000 BTU/hr nameplate, remembering the unit spends most of "
               "its time at part load, and that duct gain at the register biases "
               "this low. EER counts sensible plus the latent floor, so it "
               "understates true efficiency whenever the probe cannot see "
               "condensation.",
          overrides=[
              color("Sensible BTU/hr", "yellow"),
              {"matcher": {"id": "byName", "options": "EER (est)"},
               "properties": [{"id": "custom.axisPlacement", "value": "right"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]},
          ]),

    panel(7, "Derived superheat - the margin before trimming airflow",
          [("superheat_f", "Superheat")],
          {"h": 8, "w": 24, "x": 0, "y": 50}, unit="fahrenheit",
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


# ---------------------------------------------------------------- Dashboard E
# Air quality. Separate from the dehumidification investigation because it
# answers a different question on a different cadence: that one is a temporary
# enquiry into a specific fault, this is ongoing ambient monitoring.

# EPA AQI breakpoints, encoded as thresholds so the panel colour carries the
# judgement rather than leaving the reader to recall what counts as bad.
CO2_STEPS = {"mode": "absolute", "steps": [
    {"color": "green", "value": None},
    {"color": "yellow", "value": 800},
    {"color": "orange", "value": 1200},
    {"color": "red", "value": 2000},
]}
PM25_STEPS = {"mode": "absolute", "steps": [
    {"color": "green", "value": None},
    {"color": "yellow", "value": 12},
    {"color": "orange", "value": 35.5},
    {"color": "red", "value": 55.5},
]}
OZONE_STEPS = {"mode": "absolute", "steps": [
    {"color": "green", "value": None},
    {"color": "yellow", "value": 55},
    {"color": "orange", "value": 71},
    {"color": "red", "value": 86},
]}

AIR = [
    panel(1, "CO2 - ventilation and occupancy",
          [("ag_co2", "CO2"), ("ag_co2_max", "CO2 peak")],
          {"h": 9, "w": 12, "x": 0, "y": 0}, unit="ppm",
          url=AIR_URL,
          desc="Outdoor air is about 420 ppm, so the excess over that is your own "
               "breath accumulating. Below 800 is comfortable; above 1200 has "
               "measurable effects on concentration. It doubles as an occupancy "
               "signal, which is what separates moisture generated indoors from "
               "moisture leaking in. The solid line is the bucket mean and the "
               "faint one its peak; at wide zoom they separate whenever a short "
               "excursion is being averaged down.",
          overrides=[color_faint("CO2 peak", "semi-dark-blue"),
                     {"matcher": {"id": "byName", "options": "CO2"},
                      "properties": [{"id": "thresholds", "value": CO2_STEPS},
                                     {"id": "custom.thresholdsStyle", "value": {"mode": "area"}},
                                     {"id": "custom.fillOpacity", "value": 0},
                                     {"id": "custom.lineWidth", "value": 2}]}]),

    panel(2, "PM2.5 indoors vs outdoors",
          [("ag_pm02", "Indoor PM2.5"), ("ag_pm02_max", "Indoor peak"),
           ("sp_aq_outdoor_particles", "Outdoor particulates")],
          {"h": 9, "w": 12, "x": 12, "y": 0},
          desc="The gap between the lines is filtration doing its job. Indoor "
               "tracking outdoor closely would mean particulates arrive faster "
               "than the filter removes them. The two come from different sensors "
               "on different scales, so compare shapes rather than subtracting. "
               "Indoor shows mean and peak; a peak that rises while the mean "
               "stays flat is a brief indoor source rather than a filtration "
               "problem.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Indoor PM2.5"},
               "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "blue"}},
                              {"id": "thresholds", "value": PM25_STEPS}]},
              color_faint("Indoor peak", "semi-dark-blue"),
              color("Outdoor particulates", "orange"),
          ]),

    panel(3, "Particle sizes",
          [("ag_pm01_max", "PM1"), ("ag_pm02_max", "PM2.5"), ("ag_pm10_max", "PM10")],
          {"h": 8, "w": 12, "x": 0, "y": 9},
          url=AIR_URL,
          desc="Bucket peaks, not means: these are event detectors, and a "
               "five-minute cooking spike averaged across a wide bucket "
               "disappears into the number that made it worth plotting. "
               "PM1 rising while PM2.5 stays flat suggests combustion or "
               "cooking. PM10 moving alone suggests dust, or activity stirring "
               "up settled material.",
          overrides=[color("PM1", "purple"), color("PM2.5", "blue"),
                     color("PM10", "orange")]),

    panel(4, "Chemical pollutants",
          [("ag_tvoc_index_max", "TVOC index"), ("ag_nox_index_max", "NOx index")],
          {"h": 8, "w": 12, "x": 12, "y": 9},
          url=AIR_URL,
          desc="Bucket peaks, for the same reason as the particle panel. "
               "Sensor indices, not concentrations: 100 is the running baseline "
               "for this room, so excursions mark a change rather than an "
               "absolute level. Useful for spotting cleaning products, cooking, "
               "or off-gassing.",
          overrides=[color("TVOC index", "green"), color("NOx index", "red")]),

    panel(5, "Outdoor ozone", [("sp_aq_outdoor_ozone", "Ozone")],
          {"h": 8, "w": 24, "x": 0, "y": 17}, unit="ppb",
          desc="From the thermostat's outdoor feed. The EPA 8-hour standard is 70 "
               "ppb. On high-ozone days the useful response is minimising outside "
               "air, since a particulate filter does not remove ozone.",
          overrides=[{"matcher": {"id": "byName", "options": "Ozone"},
                      "properties": [{"id": "thresholds", "value": OZONE_STEPS},
                                     {"id": "custom.thresholdsStyle", "value": {"mode": "area"}},
                                     {"id": "custom.fillOpacity", "value": 0}]}]),

    panel(6, "Room vs thermostat - temperature and humidity",
          [("ag_temp_f", "AirGradient room"), ("indoor_f", "Thermostat"),
           ("ag_rh", "Room RH"), ("hum_indoor", "Thermostat RH")],
          {"h": 8, "w": 24, "x": 0, "y": 25},
          desc="Two independent sensors in different places. Bound to the window "
               "the bridge has been running, because it needs thermostat data; the "
               "panel below covers the sensor's full history. The room reads "
               "several degrees warmer than the thermostat, which matters because "
               "at equal moisture the cooler location reports the higher relative "
               "humidity. Compare ag_w_gr against indoor_w_gr on the "
               "dehumidification dashboard to see moisture without that confound.",
          overrides=[
              {"matcher": {"id": "byName", "options": "AirGradient room"},
               "properties": [{"id": "unit", "value": "fahrenheit"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]},
              {"matcher": {"id": "byName", "options": "Thermostat"},
               "properties": [{"id": "unit", "value": "fahrenheit"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]},
              {"matcher": {"id": "byName", "options": "Room RH"},
               "properties": [{"id": "unit", "value": "percent"},
                              {"id": "custom.axisPlacement", "value": "right"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "blue"}}]},
              {"matcher": {"id": "byName", "options": "Thermostat RH"},
               "properties": [{"id": "unit", "value": "percent"},
                              {"id": "custom.axisPlacement", "value": "right"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "light-blue"}}]},
          ]),

    panel(7, "Room temperature, humidity and moisture - full history",
          [("ag_temp_f", "Temperature"), ("ag_rh", "Relative humidity"),
           ("ag_w_gr", "Humidity ratio")],
          {"h": 9, "w": 24, "x": 0, "y": 33},
          url=AIR_URL,
          desc="Reads /api/air, so it covers the sensor's whole history rather than "
               "only the window the bridge has been running. Humidity ratio is the "
               "one to trust for moisture: relative humidity moves whenever the "
               "temperature moves even if the actual water content has not, so a "
               "step in RH means little until you check that grains per pound "
               "stepped with it.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Temperature"},
               "properties": [{"id": "unit", "value": "fahrenheit"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]},
              {"matcher": {"id": "byName", "options": "Relative humidity"},
               "properties": [{"id": "unit", "value": "percent"},
                              {"id": "custom.axisPlacement", "value": "right"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "blue"}}]},
              {"matcher": {"id": "byName", "options": "Humidity ratio"},
               "properties": [{"id": "custom.axisPlacement", "value": "right"},
                              {"id": "custom.fillOpacity", "value": 12},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "purple"}}]},
          ]),
]




# ---------------------------------------------------------------- Additions
# Panels for the fields added by migration 0009, plus the two derived
# capability columns. Appended with += to match how the lists above are
# extended, rather than editing the comprehension that builds the fault stats.

HEALTH += [
panel(25, "Superheat and subcooling - the charge pair",
          [("sp_eev_superheat_raw", "Superheat"), ("sp_eev_subcool_raw", "Subcooling")],
          {"h": 9, "w": 12, "x": 0, "y": 40},
          desc="Neither number diagnoses a charge problem alone; the pair does. "
               "Superheat high with subcooling low points at undercharge or a "
               "starved evaporator. Superheat low with subcooling high points at "
               "overcharge or a restriction. Both moving together usually means "
               "load changed, not the charge. Raw units on both -- the scale is "
               "unverified, so read the shapes and the divergence rather than "
               "the absolute values.",
          overrides=[color("Superheat", "orange"), color("Subcooling", "blue")]),

    panel(26, "Outdoor fan - commanded vs actual",
          [("sp_od_fan_demand_pct", "Commanded"), ("sp_od_fan_rpm", "Actual RPM")],
          {"h": 9, "w": 12, "x": 12, "y": 40},
          desc="A fan pinned at full RPM while commanded demand sits well below "
               "it, or the reverse, is the signature of a failing motor or a "
               "control fault. The two axes are different units, so watch "
               "whether they move together, not whether they overlap.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Commanded"},
               "properties": [{"id": "unit", "value": "percent"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]},
              {"matcher": {"id": "byName", "options": "Actual RPM"},
               "properties": [{"id": "unit", "value": "rotrpm"},
                              {"id": "custom.axisPlacement", "value": "right"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "purple"}}]},
          ]),

    panel(27, "Coil pressure vs suction pressure",
          [("sp_eev_coil_pressure", "Indoor coil"), ("sp_suction_pressure", "Suction line")],
          {"h": 8, "w": 12, "x": 0, "y": 49}, unit="pressurepsi",
          desc="These read within a few psi of each other, which is expected on "
               "a single-circuit system -- they are near the same point in the "
               "loop. The panel exists to catch them diverging: a growing gap "
               "means pressure drop between the coil and the suction sensor, "
               "which is a restriction forming.",
          overrides=[color("Indoor coil", "blue"), color("Suction line", "orange")]),

    panel(28, "Filter life", [("sp_filter_days", "Days used")],
          {"h": 8, "w": 6, "x": 12, "y": 49}, unit="d", ptype="stat", fmt="table",
          opts=STAT_OPTS,
          desc="Days elapsed against the 183-day service interval. Confirmed to "
               "count up rather than down, so this is age, not remaining life. "
               "Relevant beyond maintenance: a loaded filter is one of the "
               "candidate explanations for airflow running under commanded, and "
               "a new filter rules it out.",
          thresholds={"mode": "absolute", "steps": [
              {"color": "green", "value": None},
              {"color": "yellow", "value": 150},
              {"color": "red", "value": 183}]}),

    panel(29, "Most recent fault log entry", [("sp_fault1_code", "Code")],
          {"h": 8, "w": 6, "x": 18, "y": 49}, ptype="stat", fmt="table",
          opts=STAT_OPTS,
          desc="The thermostat's fault LOG, not its current state -- this stays "
               "populated long after the condition clears. The six fault stats "
               "at the top of this dashboard are what say whether anything is "
               "wrong now; this says what went wrong last. Alerting is on those, "
               "deliberately not on this.",
          thresholds={"mode": "absolute", "steps": [{"color": "text", "value": None}]}),
]

DEHUM += [
panel(11, "Capability - how hard is each half working?",
          [("compressor_pct_max", "Compressor"), ("airflow_pct_max", "Airflow")],
          {"h": 9, "w": 24, "x": 0, "y": 43}, unit="percent",
          desc="Both as a percentage of what this equipment can do, from the "
               "blower's rated CFM and the configured compressor ceiling. This "
               "is the dehumidification story in one chart: a high compressor "
               "percentage against a low airflow percentage means a cold coil "
               "with little air over it, which is the condition that removes "
               "moisture. Compressor can exceed 100 -- the ceiling is a setting "
               "and boost mode overrides it.",
          overrides=[color("Compressor", "red"), color("Airflow", "blue")]),

    panel(12, "Thermostat calibration - sensor vs reported",
          [("sp_tstat_raw_temp", "Sensor raw"), ("sp_tstat_calc_temp", "Reported"),
           ("ag_temp_f", "AirGradient room")],
          {"h": 9, "w": 24, "x": 0, "y": 52},
          desc="The thermostat subtracts about 5 C from its own sensor before "
               "reporting. That correction is why the room sensor looks like it "
               "disagrees with the thermostat -- compare the room against the "
               "raw line rather than the reported one. It matters here because "
               "relative humidity is only meaningful against the temperature it "
               "was measured at, so a disputed temperature is a disputed RH. "
               "Raw and reported are Celsius; the room sensor is Fahrenheit.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Sensor raw"},
               "properties": [{"id": "unit", "value": "celsius"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]},
              {"matcher": {"id": "byName", "options": "Reported"},
               "properties": [{"id": "unit", "value": "celsius"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]},
              {"matcher": {"id": "byName", "options": "AirGradient room"},
               "properties": [{"id": "unit", "value": "fahrenheit"},
                              {"id": "custom.axisPlacement", "value": "right"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]},
          ]),

    panel(13, "Demand before and after trimming",
          [("sp_alg_raw_demand", "Raw"), ("sp_alg_cool_demand", "Cool"),
           ("sp_alg_dehum_demand", "Dehum")],
          {"h": 8, "w": 24, "x": 0, "y": 61},
          desc="What the control algorithm computed before trimming, against the "
               "trimmed demands it acted on. A persistent gap between raw and "
               "cool demand is the equipment declining to deliver what the "
               "algorithm asked for -- which is a different problem from the "
               "algorithm not asking.",
          overrides=[color("Raw", "purple"), color("Cool", "blue"),
                     color("Dehum", "green")]),
]

AIR += [
panel(8, "Outdoor air quality index", [("sp_aq_outdoor_aqi", "AQI"),
                                           ("sp_aq_outdoor_aqi_max", "AQI peak")],
          {"h": 8, "w": 24, "x": 0, "y": 42},
          desc="The composite the thermostat computes from its outdoor feed, "
               "which the separate particle and ozone panels break apart. Useful "
               "as the one-line answer to whether outside air is worth letting "
               "in today; use the other two panels to find out which pollutant "
               "is driving it.",
          overrides=[color("AQI", "orange"), color_faint("AQI peak", "semi-dark-orange")]),
]


ENERGY += [
    panel(8, "Cost against cooling load, accumulated",
          [("cum_degree_hours", "Cooling degree-hours"), ("cum_cost", "Cost")],
          # No panel-level unit: on an XY chart it applies to both axes, which
          # would label degree-hours in dollars. Units go on the fields.
          {"h": 10, "w": 24, "x": 0, "y": 24}, unit="", ptype="xychart", fmt="table",
          url="/api/series?from=$__from&to=$__to&interval=86400000&device=$device",
          desc="One point per day, both axes running totals. These should fall "
               "on a straight line: the same house losing the same heat per "
               "degree costs the same per degree to cool. The slope is dollars "
               "per degree-hour, currently about $0.0105, and that is the number "
               "worth knowing -- it has the weather divided out, so it compares "
               "across months and across summers in a way a monthly bill cannot. "
               "A kink is the signal. Points drifting above the established line "
               "mean the same weather costs more than it used to, which is what "
               "a fouling coil or a lost charge looks like long before anything "
               "reports a fault. Degree-hours are measured above a 65F base, "
               "this house's measured balance point, and counted only while "
               "power was being metered so both totals cover the same period. "
               "Buckets are UTC days, so the first and last point are partial "
               "and will sit off the line.",
          overrides=[
              {"matcher": {"id": "byName", "options": "Cooling degree-hours"},
               "properties": [{"id": "unit", "value": "none"}]},
              {"matcher": {"id": "byName", "options": "Cost"},
               "properties": [{"id": "unit", "value": "currencyUSD"},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]},
          ],
          opts={"mapping": "auto",
                "series": [{"showPoints": "always", "pointSize": {"fixed": 9}}],
                "legend": {"displayMode": "list", "placement": "bottom", "showLegend": False},
                "tooltip": {"mode": "single"}},
          custom={"show": "points", "pointSize": {"fixed": 9}}),
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
        "grafana/dashboard-air.json": dashboard(
            "daikin-air",
            "Daikin — Air Quality",
            "Indoor air quality from the AirGradient monitor, with outdoor context "
            "from the thermostat feed. Ongoing monitoring, unlike the "
            "dehumidification investigation.",
            AIR, refresh="5m", time_from="now-2d",
            tags=["daikin", "air-quality"]),
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
