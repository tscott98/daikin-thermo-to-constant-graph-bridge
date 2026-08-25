-- Air quality moved to its own table in 0007. Carry across anything the live
-- poll wrote into readings before the move, then drop the now-redundant
-- columns so there is a single home for this data rather than two.
--
-- INSERT OR IGNORE, not REPLACE: backfilled CSV rows are authoritative where
-- they exist, and this must not overwrite them with a duplicate.

INSERT OR IGNORE INTO air_quality
  (ts, temp_c, rh, co2, pm02, pm01, pm10, tvoc_index, nox_index, source)
SELECT DISTINCT ts, ag_temp_c, ag_rh, ag_co2, ag_pm02, ag_pm01, ag_pm10,
       ag_tvoc_index, ag_nox_index, 'api'
FROM readings
WHERE ag_co2 IS NOT NULL OR ag_temp_c IS NOT NULL;

ALTER TABLE readings DROP COLUMN ag_temp_c;
ALTER TABLE readings DROP COLUMN ag_rh;
ALTER TABLE readings DROP COLUMN ag_co2;
ALTER TABLE readings DROP COLUMN ag_pm02;
ALTER TABLE readings DROP COLUMN ag_pm01;
ALTER TABLE readings DROP COLUMN ag_pm10;
ALTER TABLE readings DROP COLUMN ag_tvoc_index;
ALTER TABLE readings DROP COLUMN ag_nox_index;
