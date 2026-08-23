-- Daikin One -> ConstantGraph bridge, initial schema.

CREATE TABLE IF NOT EXISTS devices (
  id               TEXT PRIMARY KEY,
  location_name    TEXT,
  name             TEXT,
  model            TEXT,
  firmware_version TEXT,
  channel_base     INTEGER NOT NULL UNIQUE,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  device_id         TEXT    NOT NULL,
  ts                INTEGER NOT NULL,
  temp_indoor_c     REAL,
  hum_indoor        REAL,
  temp_outdoor_c    REAL,
  hum_outdoor       REAL,
  heat_setpoint_c   REAL,
  cool_setpoint_c   REAL,
  mode              INTEGER,
  equipment_status  INTEGER,
  fan_circulate     INTEGER,
  fan_circulate_spd INTEGER,
  schedule_enabled  INTEGER,
  raw               TEXT,
  published         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, ts)
);

-- Partial index: the publisher's hot path only ever scans unpublished rows.
CREATE INDEX IF NOT EXISTS idx_readings_unpublished ON readings(ts) WHERE published = 0;
CREATE INDEX IF NOT EXISTS idx_readings_ts          ON readings(ts);
-- Supports the raw-JSON prune without a full table scan.
CREATE INDEX IF NOT EXISTS idx_readings_raw_prune   ON readings(ts) WHERE raw IS NOT NULL;

CREATE TABLE IF NOT EXISTS kv_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
