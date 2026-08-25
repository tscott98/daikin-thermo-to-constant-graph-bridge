#!/usr/bin/env python3
"""Single source of truth for Skyport columns; emits the migration and the TS map.

Values chosen from an actual ONETOUCH probe (scripts/probe-skyport.sh), not from
a documentation field list: every column here was observed populated and
non-sentinel on real hardware.

raw   = store the wire value unchanged; unit uncertain, documented as such
pct2  = 0-200 in half-percent steps -> 0-100
dw    = deciwatts -> watts
"""
FIELDS = [
    # column,                    api field,                          kind,  note
    ("sp_outdoor_power",         "ctOutdoorPower",                    "dw",  "outdoor unit power, W"),
    ("sp_indoor_power",          "ctIndoorPower",                     "raw", "indoor unit power, unit unverified"),
    ("sp_compressor_current",    "ctCompressorCurrent",               "raw", "compressor current, likely deciamps"),
    ("sp_inverter_current",      "ctInverterCurrent",                 "raw", "inverter current, likely deciamps"),
    ("sp_od_fan_current",        "ctODFanMotorCurrent",               "raw", "outdoor fan motor current"),

    ("sp_compressor_runtime",    "ctOutdoorCompressorRunTime",        "raw", "CUMULATIVE counter; difference it for true runtime"),

    ("sp_compressor_rps",        "ctCurrentCompressorRPS",            "raw", "compressor speed, rev/sec"),
    ("sp_target_compressor_rps", "ctTargetCompressorspeed",           "raw", "commanded compressor speed"),
    ("sp_frequency_pct",         "ctOutdoorFrequencyInPercent",       "pct2","inverter frequency, %"),
    ("sp_cool_demand_pct",       "ctOutdoorCoolRequestedDemand",      "pct2","outdoor cool demand, %"),
    ("sp_fan_demand_pct",        "ctIFCFanRequestedDemandPercent",    "pct2","indoor fan demand, %"),
    ("sp_indoor_airflow",        "ctIFCIndoorBlowerAirflow",          "raw", "blower airflow, CFM"),
    ("sp_od_fan_rpm",            "ctOutdoorFanRPM",                   "raw", "outdoor fan speed, RPM"),
    ("sp_od_fan_target",         "ctTargetODFanRPM",                  "raw", "commanded outdoor fan, unit unverified"),

    ("sp_suction_temp",          "ctOutdoorSuctionTemperature",       "raw", "suction line temp, likely tenths F"),
    ("sp_discharge_temp",        "ctOutdoorDischargeTemperature",     "raw", "discharge temp, likely tenths F"),
    ("sp_od_coil_temp",          "ctOutdoorCoilTemperature",          "raw", "outdoor coil temp, likely tenths F"),
    ("sp_od_liquid_temp",        "ctOutdoorLiquidTemperature",        "raw", "outdoor liquid line temp, likely tenths F"),
    ("sp_suction_pressure",      "ctOutdoorSuctionPressure",          "raw", "suction pressure, likely psi"),
    ("sp_eev_opening",           "ctOutdoorEEVOpening",               "raw", "expansion valve opening"),
    ("sp_inverter_fin_temp",     "ctInverterFinTemp",                 "raw", "inverter heatsink temp, C"),
    ("sp_eev_superheat",         "ctEEVCoilSuperHeatValue",           "raw", "superheat; trend it to spot charge loss"),
    ("sp_eev_suction_temp",      "ctEEVCoilSuctionTemperature",       "raw", "indoor coil suction temp"),
    ("sp_eev_liquid_temp",       "ctEEVCoilLiquidTemperature",        "raw", "indoor coil liquid temp"),
    ("sp_reversing_valve",       "ctReversingValve",                  "raw", "heat/cool direction"),

    ("sp_od_air_temp",           "ctOutdoorAirTemperature",           "raw", "outdoor unit's own air sensor, tenths F"),
    ("sp_hum_setpoint",          "humSP",                             "raw", "humidification setpoint, %"),
    ("sp_dehum_setpoint",        "dehumSP",                           "raw", "dehumidification setpoint, %"),
    ("sp_overcool_amount",       "overcoolAmount",                    "raw", "permitted overcool for dehum, C"),
    ("sp_zone1_damper",          "Zone1DamperPosition",               "raw", "zone 1 damper position, %"),
    ("sp_aq_outdoor_ozone",      "aqOutdoorOzone",                    "raw", "outdoor ozone, ppb"),
    ("sp_aq_outdoor_particles",  "aqOutdoorParticles",                "raw", "outdoor particulates, ug/m3"),

    # Dehumidification chain, added for the dehumidification analysis. The
    # question these answer is whether a dehum call is ever *requested*: if it
    # is always zero, the humidity target is misconfigured and no amount of
    # equipment-side airflow tuning can matter.
    ("sp_dehum_demand_pct",      "ctOutdoorDeHumidificationRequestedDemand", "pct2", "outdoor dehum demand, %"),
    ("sp_alg_dehum_demand",      "ctControlAlgorithmDehumDemand",     "pct2","control algorithm dehum demand, %"),
    ("sp_alg_overcool_demand",   "ctControlAlgorithmOvercoolDemand",  "pct2","overcool-to-dehumidify demand, %"),
    ("sp_alg_cool_demand",       "ctControlAlgorithmCoolDemand",      "pct2","control algorithm cool demand, %; context for the dehum figures"),
    ("sp_requested_airflow",     "ctOutdoorRequestedIndoorAirflow",   "raw", "commanded indoor CFM; compare against sp_indoor_airflow"),
    ("sp_fan_actual_pct",        "ctIFCCurrentFanActualStatus",       "pct2","actual indoor fan output, %"),
    ("sp_compressor_reduction",  "ctOutdoorCompressorReductionMode",  "raw", "compressor reduction mode, enum"),

    ("sp_fault_od_critical",     "ctOutdoorCriticalFault",            "raw", "0 = none"),
    ("sp_fault_od_minor",        "ctOutdoorMinorFault",               "raw", "0 = none"),
    ("sp_fault_ifc_critical",    "ctIFCCriticalFault",                "raw", "0 = none"),
    ("sp_fault_ifc_minor",       "ctIFCMinorFault",                   "raw", "0 = none"),
    ("sp_fault_stat_critical",   "ctStatCriticalFault",               "raw", "0 = none"),
    ("sp_fault_stat_minor",      "ctStatMinorFault",                  "raw", "0 = none"),

    # --- Added after diffing the probe dump against what was being captured.
    # The thermostat reports 1578 fields; these are the ones that carry live
    # telemetry we had no equivalent for.
    ("sp_eev_subcool",           "ctEEVCoilSubCoolValue",             "raw", "subcooling; the charge diagnostic that pairs with superheat"),
    ("sp_eev_coil_pressure",     "ctEEVCoilPressureSensor",           "raw", "indoor coil pressure; read equal to suction pressure when probed, so capture tells us whether they ever diverge"),
    ("sp_od_fan_demand_pct",     "ctOutdoorFanRequestedDemandPercentage", "raw", "commanded outdoor fan, %; pairs with the measured RPM"),
    ("sp_alg_raw_demand",        "ctControlAlgorithmRawDemand",       "raw", "demand before trimming, vs the trimmed cool/dehum demands"),
    ("sp_aq_outdoor_aqi",        "aqOutdoorValue",                    "raw", "outdoor AQI, the composite behind the particle and ozone figures"),
    ("sp_filter_days",           "alertMediaAirFilterDays",           "raw", "media filter days counted; rising means elapsed, falling means remaining"),
    ("sp_filter_days_limit",     "alertMediaAirFilterDaysLimit",      "raw", "media filter service interval, days"),
    # The thermostat applies a large calibration offset to its own sensor, so
    # tempIndoor is not what the sensor reads. Storing both makes the offset
    # visible instead of implicit -- it bears directly on humidity work, since
    # relative humidity is only meaningful against the temperature it was
    # measured at.
    ("sp_tstat_raw_temp",        "sensorRawTemperature",              "raw", "thermostat sensor before calibration, C"),
    ("sp_tstat_calc_temp",       "TstatCalculatedTemp",               "raw", "thermostat temperature after calibration, C"),
    ("sp_tstat_temp_offset",     "sensorDynamicAlgorithmTempOffset",  "raw", "calibration offset applied to the raw sensor"),
    # Only the most recent fault is stored per poll. The boolean fault flags say
    # something is wrong; the code says what, which is the part you act on.
    ("sp_fault1_code",           "fault1Code",                        "raw", "most recent fault code"),
    ("sp_fault1_equipment",      "fault1Equipment",                   "raw", "which unit raised it"),
    ("sp_fault1_level",          "fault1Level",                       "raw", "severity"),
]

# Static per-install config; belongs on devices, not repeated every 5 minutes.
DEVICE_FIELDS = [
    ("sp_tonnage",            "ctOutdoorTonnage",       "outdoor unit size code"),
    ("sp_cooling_rated_power","ctCoolingRatedPower",    "rated cooling power"),
    ("sp_heating_rated_power","ctHeatingRatedPower",    "rated heating power"),
    ("sp_od_unit_type",       "ctOutdoorUnitType",      "outdoor unit type code"),
    ("sp_ifc_unit_type",      "ctIFCUnitType",          "indoor unit type code"),
    ("sp_stat_model",         "statModel",              "thermostat model string"),
    ("sp_compressor_min_on",  "compressorMinOn",        "minimum compressor on time, ms"),
    ("sp_compressor_min_off", "compressorMinOff",       "minimum compressor off time, ms"),
    ("sp_blower_max_cfm",     "ctIFCBlowerMotorMaxCFM", "blower capability, CFM; lets airflow read as % of maximum"),
    ("sp_indoor_rated_cfm",   "ctIndoorRatedCFM",       "indoor rated CFM"),
    ("sp_cool_max_rps",       "ctOutdoorCoolMaxRPS",    "configured compressor ceiling, tenths RPS; 730 = 73.0, matching the brief"),
    ("sp_boost_mode",         "ctOutdoorBoostModeEnable", "boost enable; explains speeds observed above the ceiling"),
]

if __name__ == "__main__":
    import sys
    what = sys.argv[1] if len(sys.argv) > 1 else "sql"
    if what == "sql":
        print("-- Generated by scripts/gen_skyport_fields.py. Do not hand-edit.")
        print("-- Skyport metrics observed populated on real hardware.")
        print("-- Sentinels (255 / 32767 / 65535) are stored as NULL by the mapper.\n")
        for col, field, kind, note in FIELDS:
            print(f"ALTER TABLE readings ADD COLUMN {col:<26} REAL;  -- {field} ({note})")
        print()
        for col, field, note in DEVICE_FIELDS:
            t = "TEXT" if col == "sp_stat_model" else "REAL"
            print(f"ALTER TABLE devices  ADD COLUMN {col:<26} {t};  -- {field} ({note})")
    elif what == "cols":
        print("\n".join(c for c, *_ in FIELDS))
