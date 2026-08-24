/**
 * Turso (libSQL) access layer.
 *
 * Two limits drive the shape of everything here:
 *   - Workers free tier allows 50 outbound subrequests per invocation, and each
 *     libSQL call over HTTP is one. So multi-row writes go through batch(),
 *     which sends the whole statement group in a single round trip.
 *   - SQLite caps bound parameters per statement, so key lists are chunked.
 */

import type { InStatement, Row } from '@libsql/client/web';
import type { Db } from './client';
import type { DeviceDetail, DeviceSummary } from '../daikin/types';
import { EMPTY_SKYPORT, type SkyportFields } from '../skyport/map';

export interface Reading extends SkyportFields {
  device_id: string;
  ts: number;
  temp_indoor_c: number | null;
  hum_indoor: number | null;
  temp_outdoor_c: number | null;
  hum_outdoor: number | null;
  heat_setpoint_c: number | null;
  cool_setpoint_c: number | null;
  setpoint_delta_c: number | null;
  setpoint_min_c: number | null;
  setpoint_max_c: number | null;
  mode: number | null;
  equipment_status: number | null;
  fan_circulate: number | null;
  fan_circulate_spd: number | null;
  schedule_enabled: number | null;
  raw: string | null;
  published: number;
}

// Reading carries the Skyport columns too; they are null when that poll is
// skipped or fails, which must never block an integrator reading.
export type ReadingWithSkyport = Reading & SkyportFields;

export interface DeviceRow {
  id: string;
  location_name: string | null;
  name: string | null;
  model: string | null;
  firmware_version: string | null;
  channel_base: number;
  first_seen: number;
  last_seen: number;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const bool = (v: unknown): number | null =>
  typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? (v ? 1 : 0) : null;

/** libSQL returns column values as unknown; these coerce a Row into our shapes. */
const asNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const asStr = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function rowToReading(r: Row): Reading {
  return {
    device_id: String(r['device_id']),
    ts: asNum(r['ts']) ?? 0,
    temp_indoor_c: asNum(r['temp_indoor_c']),
    hum_indoor: asNum(r['hum_indoor']),
    temp_outdoor_c: asNum(r['temp_outdoor_c']),
    hum_outdoor: asNum(r['hum_outdoor']),
    heat_setpoint_c: asNum(r['heat_setpoint_c']),
    cool_setpoint_c: asNum(r['cool_setpoint_c']),
    setpoint_delta_c: asNum(r['setpoint_delta_c']),
    setpoint_min_c: asNum(r['setpoint_min_c']),
    setpoint_max_c: asNum(r['setpoint_max_c']),
    mode: asNum(r['mode']),
    equipment_status: asNum(r['equipment_status']),
    fan_circulate: asNum(r['fan_circulate']),
    fan_circulate_spd: asNum(r['fan_circulate_spd']),
    schedule_enabled: asNum(r['schedule_enabled']),
    sp_outdoor_power: asNum(r['sp_outdoor_power']),
    sp_indoor_power: asNum(r['sp_indoor_power']),
    sp_compressor_current: asNum(r['sp_compressor_current']),
    sp_inverter_current: asNum(r['sp_inverter_current']),
    sp_od_fan_current: asNum(r['sp_od_fan_current']),
    sp_compressor_runtime: asNum(r['sp_compressor_runtime']),
    sp_compressor_rps: asNum(r['sp_compressor_rps']),
    sp_target_compressor_rps: asNum(r['sp_target_compressor_rps']),
    sp_frequency_pct: asNum(r['sp_frequency_pct']),
    sp_cool_demand_pct: asNum(r['sp_cool_demand_pct']),
    sp_fan_demand_pct: asNum(r['sp_fan_demand_pct']),
    sp_indoor_airflow: asNum(r['sp_indoor_airflow']),
    sp_od_fan_rpm: asNum(r['sp_od_fan_rpm']),
    sp_od_fan_target: asNum(r['sp_od_fan_target']),
    sp_suction_temp: asNum(r['sp_suction_temp']),
    sp_discharge_temp: asNum(r['sp_discharge_temp']),
    sp_od_coil_temp: asNum(r['sp_od_coil_temp']),
    sp_od_liquid_temp: asNum(r['sp_od_liquid_temp']),
    sp_suction_pressure: asNum(r['sp_suction_pressure']),
    sp_eev_opening: asNum(r['sp_eev_opening']),
    sp_inverter_fin_temp: asNum(r['sp_inverter_fin_temp']),
    sp_eev_superheat: asNum(r['sp_eev_superheat']),
    sp_eev_suction_temp: asNum(r['sp_eev_suction_temp']),
    sp_eev_liquid_temp: asNum(r['sp_eev_liquid_temp']),
    sp_reversing_valve: asNum(r['sp_reversing_valve']),
    sp_od_air_temp: asNum(r['sp_od_air_temp']),
    sp_hum_setpoint: asNum(r['sp_hum_setpoint']),
    sp_dehum_setpoint: asNum(r['sp_dehum_setpoint']),
    sp_overcool_amount: asNum(r['sp_overcool_amount']),
    sp_zone1_damper: asNum(r['sp_zone1_damper']),
    sp_aq_outdoor_ozone: asNum(r['sp_aq_outdoor_ozone']),
    sp_aq_outdoor_particles: asNum(r['sp_aq_outdoor_particles']),
    sp_fault_od_critical: asNum(r['sp_fault_od_critical']),
    sp_fault_od_minor: asNum(r['sp_fault_od_minor']),
    sp_fault_ifc_critical: asNum(r['sp_fault_ifc_critical']),
    sp_fault_ifc_minor: asNum(r['sp_fault_ifc_minor']),
    sp_fault_stat_critical: asNum(r['sp_fault_stat_critical']),
    sp_fault_stat_minor: asNum(r['sp_fault_stat_minor']),
    raw: asStr(r['raw']),
    published: asNum(r['published']) ?? 0,
  };
}

function rowToDevice(r: Row): DeviceRow {
  return {
    id: String(r['id']),
    location_name: asStr(r['location_name']),
    name: asStr(r['name']),
    model: asStr(r['model']),
    firmware_version: asStr(r['firmware_version']),
    channel_base: asNum(r['channel_base']) ?? 0,
    first_seen: asNum(r['first_seen']) ?? 0,
    last_seen: asNum(r['last_seen']) ?? 0,
  };
}

/** Map a live API response into a storable row. Unknown fields survive in `raw`. */
export function toReading(
  deviceId: string,
  ts: number,
  detail: DeviceDetail,
  keepRaw: boolean,
): Reading {
  return {
    device_id: deviceId,
    ts,
    temp_indoor_c: num(detail.tempIndoor),
    hum_indoor: num(detail.humIndoor),
    temp_outdoor_c: num(detail.tempOutdoor),
    hum_outdoor: num(detail.humOutdoor),
    heat_setpoint_c: num(detail.heatSetpoint),
    cool_setpoint_c: num(detail.coolSetpoint),
    setpoint_delta_c: num(detail.setpointDelta),
    setpoint_min_c: num(detail.setpointMinimum),
    setpoint_max_c: num(detail.setpointMaximum),
    mode: num(detail.mode),
    equipment_status: num(detail.equipmentStatus),
    fan_circulate: num(detail.fanCirculate),
    fan_circulate_spd: num(detail.fanCirculateSpeed),
    schedule_enabled: bool(detail.scheduleEnabled),
    ...EMPTY_SKYPORT,
    raw: keepRaw ? JSON.stringify(detail) : null,
    published: 0,
  };
}

/**
 * Insert readings idempotently. INSERT OR IGNORE against the (device_id, ts)
 * primary key means a retried cron run can never duplicate a sample.
 */
export async function insertReadings(db: Db, rows: Reading[]): Promise<number> {
  if (rows.length === 0) return 0;

  const sql = `INSERT OR IGNORE INTO readings (
      device_id, ts, temp_indoor_c, hum_indoor, temp_outdoor_c, hum_outdoor,
      heat_setpoint_c, cool_setpoint_c, setpoint_delta_c, setpoint_min_c, setpoint_max_c,
      mode, equipment_status,
      fan_circulate, fan_circulate_spd, schedule_enabled,
      sp_outdoor_power, sp_indoor_power, sp_compressor_current, sp_inverter_current,
      sp_od_fan_current, sp_compressor_runtime, sp_compressor_rps, sp_target_compressor_rps,
      sp_frequency_pct, sp_cool_demand_pct, sp_fan_demand_pct, sp_indoor_airflow,
      sp_od_fan_rpm, sp_od_fan_target, sp_suction_temp, sp_discharge_temp,
      sp_od_coil_temp, sp_od_liquid_temp, sp_suction_pressure, sp_eev_opening,
      sp_inverter_fin_temp, sp_eev_superheat, sp_eev_suction_temp, sp_eev_liquid_temp,
      sp_reversing_valve, sp_od_air_temp, sp_hum_setpoint, sp_dehum_setpoint,
      sp_overcool_amount, sp_zone1_damper, sp_aq_outdoor_ozone, sp_aq_outdoor_particles,
      sp_fault_od_critical, sp_fault_od_minor, sp_fault_ifc_critical, sp_fault_ifc_minor,
      sp_fault_stat_critical, sp_fault_stat_minor,
      raw, published
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`;

  const statements: InStatement[] = rows.map((r) => ({
    sql,
    args: [
      r.device_id, r.ts, r.temp_indoor_c, r.hum_indoor, r.temp_outdoor_c, r.hum_outdoor,
      r.heat_setpoint_c, r.cool_setpoint_c,
      r.setpoint_delta_c, r.setpoint_min_c, r.setpoint_max_c,
      r.mode, r.equipment_status,
      r.fan_circulate, r.fan_circulate_spd, r.schedule_enabled,
      r.sp_outdoor_power, r.sp_indoor_power, r.sp_compressor_current, r.sp_inverter_current,
      r.sp_od_fan_current, r.sp_compressor_runtime, r.sp_compressor_rps, r.sp_target_compressor_rps,
      r.sp_frequency_pct, r.sp_cool_demand_pct, r.sp_fan_demand_pct, r.sp_indoor_airflow,
      r.sp_od_fan_rpm, r.sp_od_fan_target, r.sp_suction_temp, r.sp_discharge_temp,
      r.sp_od_coil_temp, r.sp_od_liquid_temp, r.sp_suction_pressure, r.sp_eev_opening,
      r.sp_inverter_fin_temp, r.sp_eev_superheat, r.sp_eev_suction_temp, r.sp_eev_liquid_temp,
      r.sp_reversing_valve, r.sp_od_air_temp, r.sp_hum_setpoint, r.sp_dehum_setpoint,
      r.sp_overcool_amount, r.sp_zone1_damper, r.sp_aq_outdoor_ozone, r.sp_aq_outdoor_particles,
      r.sp_fault_od_critical, r.sp_fault_od_minor, r.sp_fault_ifc_critical, r.sp_fault_ifc_minor,
      r.sp_fault_stat_critical, r.sp_fault_stat_minor,
      r.raw,
    ],
  }));

  const results = await db.batch(statements, 'write');
  return results.reduce((sum, r) => sum + Number(r.rowsAffected ?? 0), 0);
}

/** Oldest-first so a backlog drains in chronological order. */
export async function getUnpublished(db: Db, limit: number): Promise<Reading[]> {
  const res = await db.execute({
    sql: `SELECT * FROM readings WHERE published = 0 ORDER BY ts ASC LIMIT ?`,
    args: [limit],
  });
  return res.rows.map(rowToReading);
}

/** Mark rows published. Chunked to stay well inside SQLite's bound-parameter cap. */
export async function markPublished(
  db: Db,
  keys: Array<{ device_id: string; ts: number }>,
): Promise<void> {
  if (keys.length === 0) return;

  const CHUNK = 100; // 2 bound params per key
  const statements: InStatement[] = [];

  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const where = chunk.map(() => '(device_id = ? AND ts = ?)').join(' OR ');
    statements.push({
      sql: `UPDATE readings SET published = 1 WHERE ${where}`,
      args: chunk.flatMap((k) => [k.device_id, k.ts]),
    });
  }

  await db.batch(statements, 'write');
}

/** Batched so N thermostats still cost one subrequest, not N. */
export async function upsertDevices(
  db: Db,
  entries: Array<{ summary: DeviceSummary; channelBase: number }>,
  now: number,
): Promise<void> {
  if (entries.length === 0) return;

  const sql = `INSERT INTO devices (id, location_name, name, model, firmware_version,
                                    channel_base, first_seen, last_seen)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 location_name    = excluded.location_name,
                 name             = excluded.name,
                 model            = excluded.model,
                 firmware_version = excluded.firmware_version,
                 last_seen        = excluded.last_seen`;

  await db.batch(
    entries.map(({ summary, channelBase }) => ({
      sql,
      args: [
        summary.id,
        summary.locationName ?? null,
        summary.name ?? null,
        summary.model ?? null,
        summary.firmwareVersion ?? null,
        channelBase,
        now,
        now,
      ],
    })),
    'write',
  );
}

/**
 * Static per-install config from Skyport. Kept on devices rather than repeated
 * in every five-minute reading, since none of it changes.
 */
export async function updateDeviceSkyport(
  db: Db,
  deviceId: string,
  fields: Record<string, number | string | null>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== null);
  if (entries.length === 0) return;

  const set = entries.map(([k]) => `${k} = ?`).join(', ');
  await db.execute({
    sql: `UPDATE devices SET ${set} WHERE id = ?`,
    args: [...entries.map(([, v]) => v as number | string), deviceId],
  });
}

export async function listDevices(db: Db): Promise<DeviceRow[]> {
  const res = await db.execute(`SELECT * FROM devices ORDER BY channel_base ASC`);
  return res.rows.map(rowToDevice);
}

/**
 * Null out raw JSON beyond the retention window. Bounded via a rowid subquery
 * so a long-neglected database cannot blow the CPU budget in one run;
 * successive daily runs finish the job.
 */
export async function pruneRaw(db: Db, olderThanTs: number, limit = 500): Promise<number> {
  const res = await db.execute({
    sql: `UPDATE readings SET raw = NULL
          WHERE rowid IN (
            SELECT rowid FROM readings WHERE raw IS NOT NULL AND ts < ? LIMIT ?
          )`,
    args: [olderThanTs, limit],
  });
  return Number(res.rowsAffected ?? 0);
}

export interface Stats {
  devices: number;
  readings: number;
  unpublished: number;
  oldest_ts: number | null;
  newest_ts: number | null;
}

/** One round trip: the whole ops summary as a single row. */
export async function getStats(db: Db): Promise<Stats> {
  const res = await db.execute(
    `SELECT
       (SELECT COUNT(*) FROM devices)                      AS devices,
       (SELECT COUNT(*) FROM readings)                     AS readings,
       (SELECT COUNT(*) FROM readings WHERE published = 0) AS unpublished,
       (SELECT MIN(ts)  FROM readings)                     AS oldest_ts,
       (SELECT MAX(ts)  FROM readings)                     AS newest_ts`,
  );
  const r = res.rows[0];
  return {
    devices: asNum(r?.['devices']) ?? 0,
    readings: asNum(r?.['readings']) ?? 0,
    unpublished: asNum(r?.['unpublished']) ?? 0,
    oldest_ts: asNum(r?.['oldest_ts'] ?? null),
    newest_ts: asNum(r?.['newest_ts'] ?? null),
  };
}


export interface SeriesOptions {
  fromTs: number;
  toTs: number;
  bucketSec: number;
  deviceId?: string | undefined;
  limit: number;
}

/**
 * Time-bucketed rows for charting, converted to Fahrenheit on the way out.
 *
 * Aggregation is chosen per metric rather than averaging everything: sensor
 * readings average, runtime minutes sum (so a bucket reports real minutes), and
 * mode/equipment status take the max so a bucket shows the system ran at all
 * rather than a meaningless fractional state. `pct_running` is the useful
 * downsampled view of equipment status.
 *
 * bucketSec = 1 collapses to raw rows, since (ts / 1) * 1 = ts.
 */
export async function getSeries(db: Db, o: SeriesOptions): Promise<Row[]> {
  const bucket = Math.max(1, Math.floor(o.bucketSec));
  const where = ['ts >= ?', 'ts <= ?'];
  const args: Array<string | number> = [bucket, bucket, o.fromTs, o.toTs];

  if (o.deviceId) {
    where.push('device_id = ?');
    args.push(o.deviceId);
  }
  args.push(bucket, o.limit);

  const res = await db.execute({
    sql: `SELECT
            device_id,
            (ts / ?) * ?                                            AS ts,
            COUNT(*)                                                AS samples,
            ROUND(AVG(temp_indoor_c)   * 9 / 5 + 32, 2)             AS indoor_f,
            ROUND(AVG(temp_outdoor_c)  * 9 / 5 + 32, 2)             AS outdoor_f,
            ROUND(AVG(heat_setpoint_c) * 9 / 5 + 32, 2)             AS heat_setpoint_f,
            ROUND(AVG(cool_setpoint_c) * 9 / 5 + 32, 2)             AS cool_setpoint_f,
            ROUND(AVG(hum_indoor), 1)                               AS hum_indoor,
            ROUND(AVG(hum_outdoor), 1)                              AS hum_outdoor,
            ROUND((AVG(temp_indoor_c) - AVG(temp_outdoor_c)) * 9 / 5, 2) AS delta_f,
            MAX(mode)                                               AS mode,
            MAX(equipment_status)                                   AS equipment_status,
            SUM(CASE WHEN equipment_status = 3            THEN 5 ELSE 0 END) AS runtime_heat_min,
            SUM(CASE WHEN equipment_status IN (1, 2)      THEN 5 ELSE 0 END) AS runtime_cool_min,
            ROUND(AVG(CASE WHEN equipment_status IN (1,2,3) THEN 1.0 ELSE 0.0 END) * 100, 1)
                                                                    AS pct_running
          FROM readings
          WHERE ${where.join(' AND ')}
          GROUP BY device_id, (ts / ?)
          ORDER BY ts ASC
          LIMIT ?`,
    args,
  });
  return res.rows;
}

// --- kv_state: cached Daikin token, cached device list, last-prune marker ---

export async function kvGet(db: Db, key: string): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT value, expires_at FROM kv_state WHERE key = ?`,
    args: [key],
  });
  const row = res.rows[0];
  if (!row) return null;

  const expiresAt = asNum(row['expires_at']);
  if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return asStr(row['value']);
}

export async function kvSet(
  db: Db,
  key: string,
  value: string,
  expiresAt: number | null = null,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO kv_state (key, value, expires_at) VALUES (?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    args: [key, value, expiresAt],
  });
}
