-- AirGradient indoor air quality monitor.
-- Temperature in Celsius as the API reports it, matching the thermostat columns.
-- Values are AirGradient's corrected figures where available, matching their
-- own CSV export so API and export data stay comparable.

ALTER TABLE readings ADD COLUMN ag_temp_c    REAL;
ALTER TABLE readings ADD COLUMN ag_rh        REAL;
ALTER TABLE readings ADD COLUMN ag_co2       REAL;
ALTER TABLE readings ADD COLUMN ag_pm02      REAL;
ALTER TABLE readings ADD COLUMN ag_pm01      REAL;
ALTER TABLE readings ADD COLUMN ag_pm10      REAL;
ALTER TABLE readings ADD COLUMN ag_tvoc_index REAL;
ALTER TABLE readings ADD COLUMN ag_nox_index REAL;
