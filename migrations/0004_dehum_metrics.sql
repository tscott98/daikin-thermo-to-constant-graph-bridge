-- Dehumidification-analysis columns. Generated from
-- scripts/gen_skyport_fields.py; migration 0003 has already run, so
-- these are added separately rather than by editing it.

ALTER TABLE readings ADD COLUMN sp_dehum_demand_pct        REAL;  -- ctOutdoorDeHumidificationRequestedDemand (outdoor dehum demand, %)
ALTER TABLE readings ADD COLUMN sp_alg_dehum_demand        REAL;  -- ctControlAlgorithmDehumDemand (control algorithm dehum demand, %)
ALTER TABLE readings ADD COLUMN sp_alg_overcool_demand     REAL;  -- ctControlAlgorithmOvercoolDemand (overcool-to-dehumidify demand, %)
ALTER TABLE readings ADD COLUMN sp_alg_cool_demand         REAL;  -- ctControlAlgorithmCoolDemand (control algorithm cool demand, %; context for the dehum figures)
ALTER TABLE readings ADD COLUMN sp_requested_airflow       REAL;  -- ctOutdoorRequestedIndoorAirflow (commanded indoor CFM; compare against sp_indoor_airflow)
ALTER TABLE readings ADD COLUMN sp_fan_actual_pct          REAL;  -- ctIFCCurrentFanActualStatus (actual indoor fan output, %)
ALTER TABLE readings ADD COLUMN sp_compressor_reduction    REAL;  -- ctOutdoorCompressorReductionMode (compressor reduction mode, enum)
