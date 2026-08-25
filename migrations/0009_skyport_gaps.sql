-- Generated from scripts/gen_skyport_fields.py. Do not hand-edit.
-- Fields found by diffing the probe dump against what was being captured:
-- the thermostat reports 1578, the bridge was storing 44.
-- Sentinels (255 / 32767 / 65535) are stored as NULL by the mapper.

ALTER TABLE readings ADD COLUMN sp_eev_subcool           REAL;  -- ctEEVCoilSubCoolValue (subcooling; the charge diagnostic that pairs with superheat)
ALTER TABLE readings ADD COLUMN sp_eev_coil_pressure     REAL;  -- ctEEVCoilPressureSensor (indoor coil pressure; read equal to suction pressure when probed, so capture tells us whether they ever diverge)
ALTER TABLE readings ADD COLUMN sp_od_fan_demand_pct     REAL;  -- ctOutdoorFanRequestedDemandPercentage (commanded outdoor fan, %; pairs with the measured RPM)
ALTER TABLE readings ADD COLUMN sp_alg_raw_demand        REAL;  -- ctControlAlgorithmRawDemand (demand before trimming, vs the trimmed cool/dehum demands)
ALTER TABLE readings ADD COLUMN sp_aq_outdoor_aqi        REAL;  -- aqOutdoorValue (outdoor AQI, the composite behind the particle and ozone figures)
ALTER TABLE readings ADD COLUMN sp_filter_days           REAL;  -- alertMediaAirFilterDays (media filter days counted; rising means elapsed, falling means remaining)
ALTER TABLE readings ADD COLUMN sp_filter_days_limit     REAL;  -- alertMediaAirFilterDaysLimit (media filter service interval, days)
ALTER TABLE readings ADD COLUMN sp_tstat_raw_temp        REAL;  -- sensorRawTemperature (thermostat sensor before calibration, C)
ALTER TABLE readings ADD COLUMN sp_tstat_calc_temp       REAL;  -- TstatCalculatedTemp (thermostat temperature after calibration, C)
ALTER TABLE readings ADD COLUMN sp_tstat_temp_offset     REAL;  -- sensorDynamicAlgorithmTempOffset (calibration offset applied to the raw sensor)
ALTER TABLE readings ADD COLUMN sp_fault1_code           REAL;  -- fault1Code (most recent fault code)
ALTER TABLE readings ADD COLUMN sp_fault1_equipment      REAL;  -- fault1Equipment (which unit raised it)
ALTER TABLE readings ADD COLUMN sp_fault1_level          REAL;  -- fault1Level (severity)

ALTER TABLE devices  ADD COLUMN sp_blower_max_cfm        REAL;  -- ctIFCBlowerMotorMaxCFM (blower capability, CFM; lets airflow read as % of maximum)
ALTER TABLE devices  ADD COLUMN sp_indoor_rated_cfm      REAL;  -- ctIndoorRatedCFM (indoor rated CFM)
ALTER TABLE devices  ADD COLUMN sp_cool_max_rps          REAL;  -- ctOutdoorCoolMaxRPS (configured compressor ceiling, tenths RPS; 730 = 73.0, matching the brief)
ALTER TABLE devices  ADD COLUMN sp_boost_mode            REAL;  -- ctOutdoorBoostModeEnable (boost enable; explains speeds observed above the ceiling)
