/**
 * The capture -> publish -> prune cycle.
 *
 * Lives in its own module so both the cron entry point and the /admin/poll
 * route can call it without importing each other.
 */

import type { Env } from './config';
import { channelBaseFor, settingsFrom } from './config';
import type { Db } from './db/client';
import {
  insertReadings,
  kvGet,
  kvSet,
  pruneRaw,
  toReading,
  updateDeviceSkyport,
  upsertDevices,
  type Reading,
} from './db/repo';
import { DaikinClient } from './daikin/client';
import { SkyportClient } from './skyport/client';
import { skyportFields } from './skyport/map';
import { skyportDeviceFields } from './skyport/device';
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
  const devices = await daikin.getDevices();

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

  // Sequential on purpose: Daikin allows at most 3 concurrent requests, and a
  // handful of thermostats is nowhere near the Worker's wall-clock budget.
  // Supplementary consumer-API poll. Optional by design: without a refresh
  // token it is skipped entirely, and any failure degrades to null columns
  // rather than costing us the integrator reading.
  const skyportEnabled = Boolean(env.DAIKIN_SKYPORT_REFRESH_TOKEN);
  const skyport = skyportEnabled ? new SkyportClient(env, db) : null;
  const skyportStats = { attempted: 0, enriched: 0 };

  const rows: Reading[] = [];
  for (const device of devices) {
    try {
      const detail = await daikin.getDevice(device.id);
      const row = toReading(device.id, ts, detail, settings.rawRetentionDays > 0);

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

  const inserted = await insertReadings(db, rows);

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

  const pruned = await maybePrune(db, settings.rawRetentionDays, nowSec);

  return {
    ts,
    devices: devices.length,
    captured: rows.length,
    inserted,
    publish,
    pruned,
    errors,
    skyport: skyportStats,
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
