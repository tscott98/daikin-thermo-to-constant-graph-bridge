/**
 * The capture -> publish -> prune cycle.
 *
 * Lives in its own module so both the cron entry point and the /admin/poll
 * route can call it without importing each other.
 */

import type { Env } from './config';
import type { DeviceSummary } from './daikin/types';
import { channelBaseFor, settingsFrom } from './config';
import type { Db } from './db/client';
import {
  insertReadings,
  kvGet,
  kvSet,
  pruneRaw,
  toReading,
  updateDeviceSkyport,
  insertAirQuality,
  upsertDevices,
  type Reading,
} from './db/repo';
import { DaikinClient } from './daikin/client';
import { SkyportClient } from './skyport/client';
import { skyportFields } from './skyport/map';
import { skyportDeviceFields } from './skyport/device';
import { SensorClient } from './sensors/client';
import { AirGradientClient, EMPTY_AIRGRADIENT } from './sensors/airgradient';
import { publishPending, type PublishOutcome } from './constantgraph/publish';

const PRUNE_MARKER = 'prune:last';
const DAY_SECONDS = 86_400;

export interface CycleResult {
  ts: number;
  devices: number;
  captured: number;
  inserted: number;
  publish: PublishOutcome;
  pruned: number;
  errors: string[];
  skyport: { attempted: number; enriched: number };
  ductSensors: 'off' | 'ok' | 'failed';
  airGradient: 'off' | 'ok' | 'failed';
}

/**
 * Align the sample to its interval bucket.
 *
 * Two things fall out of this: the series is evenly spaced regardless of when
 * the cron actually fired, and a manual /admin/poll landing in the same window
 * as the scheduled run collapses onto the same (device_id, ts) key instead of
 * creating a near-duplicate sample.
 */
export function bucketTs(nowSec: number, intervalMin: number): number {
  const size = Math.max(1, intervalMin) * 60;
  return Math.round(nowSec / size) * size;
}

export async function runCycle(env: Env, db: Db): Promise<CycleResult> {
  const settings = settingsFrom(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const ts = bucketTs(nowSec, settings.pollIntervalMin);
  const errors: string[] = [];

  const daikin = new DaikinClient(env, db);

  // Guarded because this is the first await in the cycle, and an unguarded
  // throw here takes down everything downstream with it -- the AirGradient
  // read, both inserts, and the publish. That is not theoretical: a Daikin
  // outage on 2026-08-28 stopped readings AND air_quality for 6h40m with
  // identical gap boundaries in both tables, while /health kept answering
  // normally because it only touches Turso.
  //
  // The rule everywhere else in this cycle is that one source failing costs
  // its own columns and nothing more. This is that rule applied to the source
  // that had been exempt from it.
  let devices: DeviceSummary[] = [];
  try {
    devices = await daikin.getDevices();
    if (devices.length > 0) {
      await upsertDevices(
        db,
        devices.map((summary, i) => ({
          summary,
          channelBase: channelBaseFor(settings.channelBase, i),
        })),
        nowSec,
      );
    }
  } catch (err) {
    errors.push(`daikin devices: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Sequential on purpose: Daikin allows at most 3 concurrent requests, and a
  // handful of thermostats is nowhere near the Worker's wall-clock budget.
  // Supplementary consumer-API poll. Optional by design: without a refresh
  // token it is skipped entirely, and any failure degrades to null columns
  // rather than costing us the integrator reading.
  // Duct sensors are read once per cycle and shared across devices: they
  // describe the air handler, not any individual thermostat.
  let duct = { returnTempF: null as number | null, returnRh: null as number | null,
               supplyTempF: null as number | null };
  let ductStatus: 'off' | 'ok' | 'failed' = 'off';
  if (env.CG_READ_API_KEY) {
    try {
      duct = await new SensorClient(env).read();
      ductStatus = 'ok';
    } catch (err) {
      ductStatus = 'failed';
      errors.push(`duct sensors: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // AirGradient describes the room, not a thermostat, so it is read once and
  // shared across devices in the same way as the duct sensors.
  let ag = EMPTY_AIRGRADIENT;
  let agStatus: 'off' | 'ok' | 'failed' = 'off';
  if (env.AG_TOKEN) {
    try {
      ag = await new AirGradientClient(env).read();
      agStatus = 'ok';
    } catch (err) {
      agStatus = 'failed';
      errors.push(`airgradient: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const skyportEnabled = Boolean(env.DAIKIN_SKYPORT_REFRESH_TOKEN);
  const skyport = skyportEnabled ? new SkyportClient(env, db) : null;
  const skyportStats = { attempted: 0, enriched: 0 };

  const rows: Reading[] = [];
  for (const device of devices) {
    try {
      const detail = await daikin.getDevice(device.id);
      const row = toReading(device.id, ts, detail, settings.rawRetentionDays > 0);
      row.duct_return_temp_f = duct.returnTempF;
      row.duct_return_rh = duct.returnRh;
      row.duct_supply_temp_f = duct.supplyTempF;

      if (skyport) {
        skyportStats.attempted += 1;
        try {
          const data = await skyport.getDeviceData(device.id);
          Object.assign(row, skyportFields(data));
          // Static config lives on devices; refreshing it here is one extra
          // query and keeps the equipment description current.
          await updateDeviceSkyport(db, device.id, skyportDeviceFields(data));
          skyportStats.enriched += 1;
        } catch (err) {
          errors.push(
            `skyport ${device.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      rows.push(row);
    } catch (err) {
      // One unreachable thermostat must not cost us the others' samples.
      errors.push(`device ${device.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let inserted = 0;
  try {
    inserted = await insertReadings(db, rows);
  } catch (err) {
    errors.push(`insert readings: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Air quality is house-level, so it is stored once per cycle keyed on time
  // rather than copied onto every thermostat's row.
  if (agStatus === 'ok') {
    try {
      await insertAirQuality(db, ts, {
        temp_c: ag.tempC, rh: ag.rh, co2: ag.co2, pm02: ag.pm02,
        pm01: ag.pm01, pm10: ag.pm10,
        tvoc_index: ag.tvocIndex, nox_index: ag.noxIndex,
      });
    } catch (err) {
      errors.push(`air quality store: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let publish: PublishOutcome = {
    attempted: 0,
    published: 0,
    channels: 0,
    skipped: 0,
    dryRun: settings.dryRun,
  };
  try {
    publish = await publishPending(env, db);
  } catch (err) {
    // Rows stay published = 0, so the next run replays them at their original
    // timestamps. This is the backfill mechanism, not a failure to recover.
    errors.push(`publish: ${err instanceof Error ? err.message : String(err)}`);
  }

  let pruned = 0;
  try {
    pruned = await maybePrune(db, settings.rawRetentionDays, nowSec);
  } catch (err) {
    errors.push(`prune: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ts,
    devices: devices.length,
    captured: rows.length,
    inserted,
    publish,
    pruned,
    errors,
    skyport: skyportStats,
    ductSensors: ductStatus,
    airGradient: agStatus,
  };
}

/** Raw-JSON prune, at most once a day, so the steady-state run stays cheap. */
async function maybePrune(db: Db, retentionDays: number, nowSec: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const last = Number.parseInt((await kvGet(db, PRUNE_MARKER)) ?? '0', 10);
  if (Number.isFinite(last) && nowSec - last < DAY_SECONDS) return 0;

  const pruned = await pruneRaw(db, nowSec - retentionDays * DAY_SECONDS);
  await kvSet(db, PRUNE_MARKER, String(nowSec));
  return pruned;
}
