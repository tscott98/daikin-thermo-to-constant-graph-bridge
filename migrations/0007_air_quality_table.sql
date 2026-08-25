-- Air quality gets its own table.
--
-- The readings table is keyed (device_id, ts) because a reading belongs to a
-- thermostat. Air quality belongs to the house, not to any thermostat, and its
-- history extends further back than the bridge has been running. Storing it on
-- readings meant it could only exist where a thermostat reading already did,
-- and backfilling it would have required inventing reading rows with no
-- thermostat data -- which would then be counted by samples and pct_running as
-- though the equipment had been observed and found idle.
--
-- Keyed on ts alone, so INSERT OR REPLACE makes backfill idempotent.
--   source: 'api' for live polls, 'csv' for backfilled export rows

CREATE TABLE IF NOT EXISTS air_quality (
  ts          INTEGER PRIMARY KEY,
  temp_c      REAL,
  rh          REAL,
  co2         REAL,
  pm02        REAL,
  pm01        REAL,
  pm10        REAL,
  pm003_count REAL,
  tvoc_index  REAL,
  nox_index   REAL,
  source      TEXT NOT NULL DEFAULT 'api'
);

CREATE INDEX IF NOT EXISTS idx_air_quality_ts ON air_quality(ts);
