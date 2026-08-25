-- Daikin One -> ConstantGraph bridge, initial schema.

CREATE TABLE IF NOT EXISTS devices (
  id               TEXT PRIMARY KEY,
  location_name    TEXT,
  name             TEXT,
  model            TEXT,
  firmware_version TEXT,
  channel_base     INTEGER NOT NULL UNIQUE,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  sp_stat_model            TEXT,
  sp_compressor_min_off    REAL
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
  setpoint_delta_c  REAL,
  setpoint_min_c    REAL,
  setpoint_max_c    REAL,
  mode              INTEGER,
  equipment_status  INTEGER,
  fan_circulate     INTEGER,
  fan_circulate_spd INTEGER,
  schedule_enabled  INTEGER,
  sp_outdoor_power         REAL,
  sp_indoor_power          REAL,
  sp_compressor_current    REAL,
  sp_inverter_current      REAL,
  sp_od_fan_current        REAL,
  sp_compressor_runtime    REAL,
  sp_compressor_rps        REAL,
  sp_target_compressor_rps REAL,
  sp_frequency_pct         REAL,
  sp_cool_demand_pct       REAL,
  sp_fan_demand_pct        REAL,
  sp_indoor_airflow        REAL,
  sp_od_fan_rpm            REAL,
  sp_od_fan_target         REAL,
  sp_suction_temp          REAL,
  sp_discharge_temp        REAL,
  sp_od_coil_temp          REAL,
  sp_od_liquid_temp        REAL,
  sp_suction_pressure      REAL,
  sp_eev_opening           REAL,
  sp_inverter_fin_temp     REAL,
  sp_eev_superheat         REAL,
  sp_eev_suction_temp      REAL,
  sp_eev_liquid_temp       REAL,
  sp_reversing_valve       REAL,
  sp_od_air_temp           REAL,
  sp_hum_setpoint          REAL,
  sp_dehum_setpoint        REAL,
  sp_overcool_amount       REAL,
  sp_zone1_damper          REAL,
  sp_aq_outdoor_ozone      REAL,
  sp_aq_outdoor_particles  REAL,
  sp_dehum_demand_pct      REAL,
  sp_alg_dehum_demand      REAL,
  sp_alg_overcool_demand   REAL,
  sp_alg_cool_demand       REAL,
  sp_requested_airflow     REAL,
  sp_fan_actual_pct        REAL,
  sp_compressor_reduction  REAL,
  sp_fault_od_critical     REAL,
  sp_fault_od_minor        REAL,
  sp_fault_ifc_critical    REAL,
  sp_fault_ifc_minor       REAL,
  sp_fault_stat_critical   REAL,
  sp_fault_stat_minor      REAL,
  duct_return_temp_f       REAL,
  duct_return_rh           REAL,
  duct_supply_temp_f       REAL,
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
