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
import { EMPTY_SKYPORT, SKYPORT_COLUMNS, type SkyportFields } from '../skyport/map';

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
  duct_return_temp_f: number | null;
  duct_return_rh: number | null;
  duct_supply_temp_f: number | null;
  raw: string | null;
  published: number;
}

/**
 * Every column insertReadings writes, in statement order.
 *
 * Derived rather than spelled out three times. The previous version listed the
 * columns, the values, and a hand-counted run of 65 question marks separately,
 * so adding a field meant editing all three in step and recounting -- and a
 * miscount binds every later value to the wrong column, which SQLite accepts
 * without complaint.
 */
export const READING_COLUMNS = [
  'device_id', 'ts', 'temp_indoor_c', 'hum_indoor', 'temp_outdoor_c', 'hum_outdoor',
  'heat_setpoint_c', 'cool_setpoint_c', 'setpoint_delta_c', 'setpoint_min_c', 'setpoint_max_c',
  'mode', 'equipment_status', 'fan_circulate', 'fan_circulate_spd', 'schedule_enabled',
  ...SKYPORT_COLUMNS,
  'duct_return_temp_f', 'duct_return_rh', 'duct_supply_temp_f',
  'raw',
] as const satisfies readonly (keyof Reading)[];

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
  // Derived from SKYPORT_COLUMNS rather than listed: the list is already the
  // source of truth for the schema and the insert, and a column named in one
  // place but forgotten here reads back as undefined rather than failing.
  const skyport = {} as SkyportFields;
  for (const c of SKYPORT_COLUMNS) skyport[c] = asNum(r[c]);
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
    ...skyport,
    duct_return_temp_f: asNum(r['duct_return_temp_f']),
    duct_return_rh: asNum(r['duct_return_rh']),
    duct_supply_temp_f: asNum(r['duct_supply_temp_f']),
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
    duct_return_temp_f: null,
    duct_return_rh: null,
    duct_supply_temp_f: null,
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

  const cols = READING_COLUMNS;
  const sql = `INSERT OR IGNORE INTO readings (${cols.join(', ')}, published)`
    + ` VALUES (${cols.map(() => '?').join(',')},0)`;

  const statements: InStatement[] = rows.map((r) => ({
    sql,
    args: cols.map((c) => (r[c] ?? null) as string | number | null),
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
  /** Currency per kWh. 0 omits the cost column. */
  ratePerKwh?: number | undefined;
  /** Seconds each sample represents, for the energy integral. */
  sampleIntervalSec?: number | undefined;
  /**
   * Output columns to compute, or undefined for all. Values are unchanged
   * either way; this only decides how many of them are worked out and sent.
   */
  fields?: Set<string> | undefined;
}

/**
 * Aggregation per Skyport column for /api/series.
 *
 * Most are continuous measurements and average sensibly. Three groups do not:
 *   - sp_compressor_runtime is a cumulative counter, not a level -- MAX gives
 *     the running total as of the end of the bucket, which is what a client
 *     needs to difference between buckets for true interval runtime.
 *   - fault codes should surface if ANY sample in the bucket faulted, which
 *     AVG would blur into a meaningless fraction.
 *   - sp_reversing_valve is a discrete heat/cool state, not a level.
 */
const SKYPORT_MAX_COLUMNS = new Set<string>([
  'sp_compressor_runtime',
  'sp_reversing_valve',
  // Discrete mode, not a level -- averaging it would invent states.
  'sp_compressor_reduction',
  'sp_fault_od_critical',
  'sp_fault_od_minor',
  'sp_fault_ifc_critical',
  'sp_fault_ifc_minor',
  'sp_fault_stat_critical',
  'sp_fault_stat_minor',
]);

/**
 * Columns the equipment reports in tenths of a degree Fahrenheit.
 *
 * Calibrated against live data rather than assumed: sp_od_air_temp ranged
 * 763-891 over a window when the integrator API's outdoor temperature ranged
 * 75.2-84.2 F. Dividing by ten makes them coincide, which fixes the scale for
 * the whole family -- and every other member then lands in a plausible range
 * (suction 38.9-76.8 F, discharge 102.5-150.6 F).
 *
 * Served as degrees F so a chart axis reads as a temperature, not as 1630.
 */
const SKYPORT_TENTHS_F = new Set<string>([
  'sp_od_air_temp',
  'sp_suction_temp',
  'sp_discharge_temp',
  'sp_od_coil_temp',
  'sp_od_liquid_temp',
  'sp_eev_suction_temp',
  'sp_eev_liquid_temp',
]);

/** Currents reported in deciamps; 0-93 becomes a believable 0-9.3 A. */
const SKYPORT_DECIAMPS = new Set<string>([
  'sp_compressor_current',
  'sp_inverter_current',
  'sp_od_fan_current',
]);

/**
 * Columns whose scale is still unresolved, exposed with a _raw suffix.
 *
 * sp_eev_superheat reads 271-846, which as tenths F would be 27-85 degrees of
 * superheat against a normal 8-15. sp_inverter_fin_temp sits in an implausibly
 * narrow 5.5-8.5. sp_indoor_power never drops below 842 even with the system
 * idle. Each could be given a conversion that makes the number look reasonable,
 * and each would then be confidently wrong -- the same failure as the 255
 * sentinel and the equipment-status enum. Renaming makes the uncertainty
 * visible at the point of use, in the chart legend.
 */
const SKYPORT_UNCALIBRATED = new Set<string>([
  'sp_eev_superheat',
  // Same unverified scale as its sibling: reads ~250 where superheat reads
  // ~354. Plausibly tenths F, which would make it 25 F of subcooling -- high
  // but not absurd -- though the same reasoning made superheat look like 35 F
  // and that has never been confirmed. A bare name would imply a unit we do
  // not have, so it ships suffixed like the others.
  'sp_eev_subcool',
  'sp_inverter_fin_temp',
  'sp_indoor_power',
]);

/**
 * Psychrometrics and derived superheat.
 *
 * Relative humidity is the wrong metric for a dehumidification question: the
 * same absolute moisture reads 60% at 70F and roughly 50% at 75F, so an RH
 * chart conflates "the air got wetter" with "the thermostat setpoint moved".
 * Humidity ratio (grains of water per pound of dry air) and dew point are
 * temperature-independent, which is what makes indoor and outdoor comparable
 * and makes an infiltration signal legible.
 *
 * Magnus formula for saturation vapour pressure, standard sea-level pressure.
 * The expressions sit inside AVG() so each row is converted before averaging;
 * averaging RH first and converting after would be a different, wrong number.
 */
function humidityRatioSql(tempC: string, rh: string): string {
  const psat = `610.94 * exp(17.625 * ${tempC} / (${tempC} + 243.04))`;
  const pv = `(${rh} / 100.0) * (${psat})`;
  return `0.62198 * (${pv}) / (101325.0 - (${pv})) * 7000.0`;
}

function dewPointFSql(tempC: string, rh: string): string {
  const g = `(ln(${rh} / 100.0) + 17.625 * ${tempC} / (243.04 + ${tempC}))`;
  return `(243.04 * ${g} / (17.625 - ${g})) * 9.0 / 5.0 + 32.0`;
}

/**
 * R-410A saturated-vapour temperature from suction pressure, piecewise linear.
 *
 * Superheat is what the brief needs before trimming airflow, and the stored
 * sp_eev_superheat field could not be calibrated -- regressing it against this
 * derivation over 178 samples gave R^2 of -8.6, so its scale is genuinely
 * unknown. Deriving from pressure and coil suction temperature instead gives a
 * number in real degrees F.
 *
 * Assumes the pressure sensor reports psig. If it is psia the whole curve
 * shifts about 5F; the derived values landing at a textbook 10-12F is the
 * evidence for psig, not a guarantee.
 */
function r410aSatFSql(psig: string): string {
  const pts: Array<[number, number]> = [
    [80, 20.8], [90, 25.9], [100, 30.8], [110, 35.5], [120, 40.0], [130, 44.1],
    [140, 48.0], [150, 51.6], [160, 55.1], [170, 58.4], [180, 61.6], [190, 64.6],
    [200, 67.5],
  ];
  const arms = pts.slice(0, -1).map(([p0, t0], i) => {
    const [p1, t1] = pts[i + 1] as [number, number];
    const slope = (t1 - t0) / (p1 - p0);
    return `WHEN ${psig} < ${p1} THEN ${t0} + ${slope.toFixed(4)} * (${psig} - ${p0})`;
  });
  // Outside the tabulated range the curve is not trustworthy, so return NULL
  // rather than extrapolating into a number someone might act on.
  return `CASE WHEN ${psig} < ${pts[0]![0]} THEN NULL ${arms.join(' ')} ELSE NULL END`;
}

/**
 * Capacity from the duct sensors.
 *
 * Sensible heat is exact: 1.08 x CFM x dry-bulb split, needing only the two
 * temperatures. Latent is not, because there is no humidity sensor at the
 * supply. Air leaving a wet coil sits near saturation, so supply humidity ratio
 * is estimated at 95% RH -- standard practice, usually within a few percent,
 * and named "_est" so the assumption travels with the number.
 *
 * The estimate is gated on a physical check: if supply dry bulb is at or above
 * the return dew point, no condensation is visible at the probe and latent is
 * reported as zero.
 *
 * IMPORTANT: with the probe at a register rather than the plenum, that gate is
 * conservative to the point of being wrong about latent. Air leaves the coil
 * around 45-48F, below the dew point and condensing, then warms through the
 * duct run; a register at the end of a branch can read above the dew point
 * while the coil is condensing hard. Observed here: supply 53.6F against a
 * return dew point of 52.0F, while dehumidification demand was 85% and indoor
 * humidity ratio sat at half of outdoor. So latent_btuh_est and shr_est are a
 * floor, not a measurement, and shr_est of 1.0 means "no condensation at the
 * probe", not "no dehumidification". condensing_margin_f is the honest version
 * of the same signal: how far the supply probe sits from the dew point.
 *
 * duct_split_f and sensible_btuh are trustworthy, subject to two biases: duct
 * gain makes the split read small, and CFM is the equipment's own figure rather
 * than measured airflow.
 */
function capacityClause(): string[] {
  const rtC = '(duct_return_temp_f - 32.0) * 5.0 / 9.0';
  const stC = '(duct_supply_temp_f - 32.0) * 5.0 / 9.0';
  const returnW = humidityRatioSql(`(${rtC})`, 'duct_return_rh');
  // Supply assumed at 95% RH: the coil is wet whenever it is condensing.
  const supplyW = humidityRatioSql(`(${stC})`, '95.0');
  const dewC = `(243.04 * (ln(duct_return_rh / 100.0) + 17.625 * (${rtC}) / (243.04 + (${rtC})))` +
               ` / (17.625 - (ln(duct_return_rh / 100.0) + 17.625 * (${rtC}) / (243.04 + (${rtC})))))`;
  const dewF = `((${dewC}) * 9.0 / 5.0 + 32.0)`;

  const split = '(duct_return_temp_f - duct_supply_temp_f)';
  const sensible = `1.08 * sp_indoor_airflow * ${split}`;
  // Only credit latent while the coil can actually condense.
  const latent = `CASE WHEN duct_supply_temp_f < ${dewF}
                       THEN 0.68 * sp_indoor_airflow * ((${returnW}) - (${supplyW}))
                       ELSE 0 END`;

  return [
    // The probes themselves, not just what is derived from them. The split
    // alone cannot say whether a change came from the return or the supply
    // side, and the dehumidification dashboard charts both against it.
    `ROUND(AVG(duct_return_temp_f), 1) AS duct_return_temp_f`,
    `ROUND(AVG(duct_supply_temp_f), 1) AS duct_supply_temp_f`,
    `ROUND(AVG(duct_return_rh), 1) AS duct_return_rh`,
    `ROUND(AVG(${split}), 1) AS duct_split_f`,
    `ROUND(AVG(${dewF}), 1) AS return_dewpoint_f`,
    // Negative means condensation is visible at the probe. Small positive is
    // the expected reading for a register at the end of a run while the coil
    // is still condensing, so treat the trend as the signal.
    `ROUND(AVG(duct_supply_temp_f - (${dewF})), 1) AS condensing_margin_f`,
    `ROUND(AVG(${sensible}), 0) AS sensible_btuh`,
    `ROUND(AVG(${latent}), 0) AS latent_btuh_est`,
    `ROUND(AVG(CASE WHEN (${sensible}) + (${latent}) > 0
                    THEN (${sensible}) / ((${sensible}) + (${latent})) END), 3) AS shr_est`,
    `ROUND(AVG(CASE WHEN sp_outdoor_power > 100
                    THEN ((${sensible}) + (${latent})) / sp_outdoor_power END), 2) AS eer_est`,
  ];
}

/**
 * AirGradient columns, plus its own humidity ratio.
 *
 * The monitor sits in a room rather than in the return, and rooms stratify:
 * measured here, it runs about 4F warmer than the thermostat while reporting
 * roughly the same absolute moisture. Serving ag_w_gr alongside indoor_w_gr
 * makes that comparison direct -- two sensors, one temperature-independent
 * quantity, so any disagreement is real rather than a thermometer artefact.
 */
/**
 * Pollutants where a bucket's peak matters as much as its mean.
 *
 * A five-minute cooking spike averaged across a fifteen-minute bucket is the
 * event disappearing into the number that made it interesting -- and the wider
 * the zoom, the more it vanishes. But the mean is still what air quality
 * standards are written against (PM2.5 over 24 hours, ozone over 8), so it is
 * not the wrong statistic, just an incomplete one.
 *
 * Both ship: AVG under the plain name, MAX under _max. Temperature, humidity
 * and CO2-derived moisture are not here because they physically cannot step
 * within a bucket the way a particle count can.
 */
const AIR_SPIKY: ReadonlyArray<readonly [col: string, alias: string, dp: number]> = [
  ['co2', 'ag_co2', 0],
  ['pm02', 'ag_pm02', 1],
  ['pm01', 'ag_pm01', 1],
  ['pm10', 'ag_pm10', 1],
  ['tvoc_index', 'ag_tvoc_index', 0],
  ['nox_index', 'ag_nox_index', 0],
];

/** Mean and peak for each spiky pollutant. `q` qualifies the table, if needed. */
function airSpikySelects(q = ''): string[] {
  return AIR_SPIKY.flatMap(([col, alias, dp]) => [
    `ROUND(AVG(${q}${col}), ${dp}) AS ${alias}`,
    `ROUND(MAX(${q}${col}), ${dp}) AS ${alias}_max`,
  ]);
}

function airGradientClause(): string[] {
  const w = humidityRatioSql('aq.temp_c', 'aq.rh');
  return [
    `ROUND(AVG(aq.temp_c) * 9.0 / 5.0 + 32.0, 1) AS ag_temp_f`,
    `ROUND(AVG(aq.rh), 1) AS ag_rh`,
    `ROUND(AVG(${w}), 1) AS ag_w_gr`,
    ...airSpikySelects('aq.'),
  ];
}

export function psychroClause(): string[] {
  const inW = humidityRatioSql('temp_indoor_c', 'hum_indoor');
  const outW = humidityRatioSql('temp_outdoor_c', 'hum_outdoor');
  const sat = r410aSatFSql('sp_suction_pressure');
  return [
    `ROUND(AVG(${inW}), 1) AS indoor_w_gr`,
    `ROUND(AVG(${outW}), 1) AS outdoor_w_gr`,
    `ROUND(AVG(${dewPointFSql('temp_indoor_c', 'hum_indoor')}), 1) AS indoor_dewpoint_f`,
    `ROUND(AVG(${dewPointFSql('temp_outdoor_c', 'hum_outdoor')}), 1) AS outdoor_dewpoint_f`,
    `ROUND(AVG(CASE WHEN sp_compressor_rps > 5
                    THEN sp_eev_suction_temp / 10.0 - (${sat}) END), 1) AS superheat_f`,
  ];
}

/**
 * Outdoor air quality, which spikes like its indoor counterpart. Gets the same
 * mean-and-peak treatment so the indoor/outdoor comparison is like for like:
 * charting an indoor peak against an outdoor average would make filtration
 * look worse than it is.
 */
const SKYPORT_SPIKY = new Set([
  'sp_aq_outdoor_ozone',
  'sp_aq_outdoor_particles',
  'sp_aq_outdoor_aqi',
]);

export function skyportSelectClause(): string[] {
  return SKYPORT_COLUMNS.flatMap((c) => {
    if (SKYPORT_MAX_COLUMNS.has(c)) return [`MAX(${c}) AS ${c}`];
    // Suffixes carry the unit into the column name, so a Grafana legend says
    // what it is showing without the reader consulting this file.
    if (SKYPORT_UNCALIBRATED.has(c)) return [`ROUND(AVG(${c}), 2) AS ${c}_raw`];
    if (SKYPORT_TENTHS_F.has(c)) return [`ROUND(AVG(${c}) / 10.0, 1) AS ${c}_f`];
    if (SKYPORT_DECIAMPS.has(c)) return [`ROUND(AVG(${c}) / 10.0, 2) AS ${c}_a`];
    if (SKYPORT_SPIKY.has(c)) {
      return [`ROUND(AVG(${c}), 2) AS ${c}`, `ROUND(MAX(${c}), 2) AS ${c}_max`];
    }
    return [`ROUND(AVG(${c}), 2) AS ${c}`];
  });
}

/**
 * Time-bucketed rows for charting, converted to Fahrenheit on the way out.
 *
 * Aggregation is chosen per metric rather than averaging everything: sensor
 * readings average, runtime minutes sum (so a bucket reports real minutes), and
 * mode/equipment status take the max so a bucket shows the system ran at all
 * rather than a meaningless fractional state. `pct_running` is the useful
 * downsampled view of equipment status. Skyport columns follow the same
 * principle via skyportSelectClause().
 *
 * bucketSec = 1 collapses to raw rows, since (ts / 1) * 1 = ts.
 */
/**
 * Energy and cost for a bucket.
 *
 * Hours come from the sample count, not the bucket width. That distinction
 * matters: if collection drops out for half an hour, a width-based integral
 * would bill that gap as though the system had been running at the average of
 * whatever samples did arrive. Counting samples means a gap contributes nothing,
 * which understates rather than invents consumption.
 *
 * Only the outdoor unit is counted. sp_indoor_power has an unresolved scale, so
 * including it would add a confident-looking number of unknown magnitude to
 * every cost figure. The blower is genuinely missing from these totals.
 */
function energyClause(sampleSec: number, rate: number): string[] {
  const hours = `(COUNT(sp_outdoor_power) * ${sampleSec} / 3600.0)`;
  const kwh = `ROUND(AVG(sp_outdoor_power) * ${hours} / 1000.0, 4)`;
  const cost = rate > 0 ? `ROUND(${kwh} * ${rate}, 4)` : 'NULL';
  return [`${kwh} AS energy_kwh`, `${cost} AS cost`];
}

/**
 * Measurements expressed as a fraction of what this equipment can do.
 *
 * "624 CFM" and "68 RPS" mean nothing without knowing the machine. Against a
 * 1760 CFM blower and a 73.0 RPS ceiling they become 35% and 93%, which is the
 * form the question is actually asked in -- is it loafing, or is it maxed?
 *
 * The capability figures live on devices, hence the join. Compressor percent
 * can legitimately exceed 100: the ceiling is a setting, and boost mode
 * overrides it, which is why speeds above it were observed.
 */
function capabilityClause(): string[] {
  return [
    `ROUND(AVG(CASE WHEN d.sp_blower_max_cfm > 0
                    THEN sp_indoor_airflow * 100.0 / d.sp_blower_max_cfm END), 1)
       AS airflow_pct_max`,
    `ROUND(AVG(CASE WHEN d.sp_cool_max_rps > 0
                    THEN sp_compressor_rps * 1000.0 / d.sp_cool_max_rps END), 1)
       AS compressor_pct_max`,
  ];
}

/** The output name a select expression binds to, i.e. its trailing alias. */
export function aliasOf(expr: string): string | null {
  return /\bAS\s+([A-Za-z_]\w*)\s*$/.exec(expr)?.[1] ?? null;
}

/**
 * Every optional column of a series row, one expression per element.
 *
 * Split out from getSeries so it can be filtered by alias and asserted against
 * directly. device_id, ts and samples are not here: they identify and time the
 * row and always ship, whatever the caller asked for.
 */
export function buildSelects(sampleSec = 300, rate = 0, bucket = 300): string[] {
  return [
    `ROUND(AVG(temp_indoor_c)   * 9 / 5 + 32, 2) AS indoor_f`,
    `ROUND(AVG(temp_outdoor_c)  * 9 / 5 + 32, 2) AS outdoor_f`,
    `ROUND(AVG(heat_setpoint_c) * 9 / 5 + 32, 2) AS heat_setpoint_f`,
    `ROUND(AVG(cool_setpoint_c) * 9 / 5 + 32, 2) AS cool_setpoint_f`,
    `ROUND(AVG(hum_indoor), 1) AS hum_indoor`,
    `ROUND(AVG(hum_outdoor), 1) AS hum_outdoor`,
    `ROUND((AVG(temp_indoor_c) - AVG(temp_outdoor_c)) * 9 / 5, 2) AS delta_f`,
    `MAX(mode) AS mode`,
    `MAX(equipment_status) AS equipment_status`,
    `SUM(CASE WHEN equipment_status = 3       THEN 5 ELSE 0 END) AS runtime_heat_min`,
    `SUM(CASE WHEN equipment_status IN (1, 2) THEN 5 ELSE 0 END) AS runtime_cool_min`,
    `ROUND(AVG(CASE WHEN equipment_status IN (1,2,3) THEN 1.0 ELSE 0.0 END) * 100, 1) AS pct_running`,
    ...skyportSelectClause(),
    `MAX(sp_compressor_runtime) - LAG(MAX(sp_compressor_runtime))`
      + ` OVER (PARTITION BY r.device_id ORDER BY (r.ts / ${bucket})) AS compressor_runtime_delta`,
    ...energyClause(sampleSec, rate),
    ...psychroClause(),
    ...capacityClause(),
    ...airGradientClause(),
    ...capabilityClause(),
  ];
}

export async function getSeries(db: Db, o: SeriesOptions): Promise<Row[]> {
  const bucket = Math.max(1, Math.floor(o.bucketSec));
  const sampleSec = Math.max(1, Math.floor(o.sampleIntervalSec ?? 300));
  const rate = Number.isFinite(o.ratePerKwh) && (o.ratePerKwh ?? 0) > 0 ? (o.ratePerKwh as number) : 0;
  const where = ['r.ts >= ?', 'r.ts <= ?'];

  // The bucket is interpolated rather than bound. It has already been forced to
  // a positive integer above, so it cannot carry SQL, and keeping it out of the
  // parameter list means the select list holds no placeholders at all. That
  // matters because parameters bind by position in the statement text: while
  // the bucket was bound, dropping a column from the select list would silently
  // shift every later argument onto the wrong slot.
  const args: Array<string | number> = [o.fromTs, o.toTs];
  if (o.deviceId) {
    where.push('r.device_id = ?');
    args.push(o.deviceId);
  }
  args.push(o.limit);

  const selects = buildSelects(sampleSec, rate, bucket);

  // device_id, ts and samples always ship: they identify and time the row, and
  // samples is how a panel tells "system off" from "collection broken".
  const wanted = o.fields
    ? selects.filter((e) => {
      const a = aliasOf(e);
      return a !== null && o.fields!.has(a);
    })
    : selects;

  const res = await db.execute({
    sql: `SELECT
            r.device_id,
            (r.ts / ${bucket}) * ${bucket} AS ts,
            COUNT(*) AS samples${wanted.length > 0 ? ',\n            ' : ''}${wanted.join(',\n            ')}
          FROM readings r
          LEFT JOIN air_quality aq ON aq.ts = r.ts
          LEFT JOIN devices d ON d.id = r.device_id
          WHERE ${where.join(' AND ')}
          GROUP BY r.device_id, (r.ts / ${bucket})
          ORDER BY r.ts ASC
          LIMIT ?`,
    args,
  });
  return res.rows;
}


export interface AirQualityRow {
  temp_c: number | null;
  rh: number | null;
  co2: number | null;
  pm02: number | null;
  pm01: number | null;
  pm10: number | null;
  tvoc_index: number | null;
  nox_index: number | null;
}

/**
 * Air quality is house-level, so it is keyed on time alone rather than on a
 * thermostat. INSERT OR REPLACE keeps a re-poll or a CSV backfill idempotent;
 * `source` distinguishes a live poll from backfilled export rows.
 */
export async function insertAirQuality(
  db: Db,
  ts: number,
  a: AirQualityRow,
): Promise<void> {
  const values = [a.temp_c, a.rh, a.co2, a.pm02, a.pm01, a.pm10, a.tvoc_index, a.nox_index];
  if (values.every((v) => v === null)) return;

  await db.execute({
    sql: `INSERT OR REPLACE INTO air_quality
            (ts, temp_c, rh, co2, pm02, pm01, pm10, tvoc_index, nox_index, source)
          VALUES (?,?,?,?,?,?,?,?,?,'api')`,
    args: [ts, ...values],
  });
}

export interface AirSeriesOptions {
  fromTs: number;
  toTs: number;
  bucketSec: number;
  limit: number;
  /** Output columns to compute, or undefined for all. Values are unchanged. */
  fields?: Set<string> | undefined;
}

/**
 * Air quality as its own series.
 *
 * Separate from getSeries because the history runs further back than the
 * thermostat readings do: joining onto readings would silently truncate it to
 * whatever the bridge happened to be running for.
 */
/** Every optional column of an air-quality row, one expression per element. */
export function buildAirSelects(): string[] {
  const w = humidityRatioSql('temp_c', 'rh');
  return [
    `ROUND(AVG(temp_c) * 9.0 / 5.0 + 32.0, 1) AS ag_temp_f`,
    `ROUND(AVG(rh), 1) AS ag_rh`,
    `ROUND(AVG(${w}), 1) AS ag_w_gr`,
    ...airSpikySelects(),
  ];
}

export async function getAirSeries(db: Db, o: AirSeriesOptions): Promise<Row[]> {
  const bucket = Math.max(1, Math.floor(o.bucketSec));
  // Interpolated, not bound, for the same reason as getSeries: the select list
  // holds no placeholders, so filtering columns cannot shift the arguments.
  const selects = buildAirSelects();
  const wanted = o.fields
    ? selects.filter((e) => {
      const a = aliasOf(e);
      return a !== null && o.fields!.has(a);
    })
    : selects;

  const res = await db.execute({
    sql: `SELECT (ts / ${bucket}) * ${bucket} AS ts,
                 COUNT(*) AS samples${wanted.length > 0 ? ',\n                 ' : ''}${wanted.join(',\n                 ')}
          FROM air_quality
          WHERE ts >= ? AND ts <= ?
          GROUP BY (ts / ${bucket})
          ORDER BY ts ASC
          LIMIT ?`,
    args: [o.fromTs, o.toTs, o.limit],
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
