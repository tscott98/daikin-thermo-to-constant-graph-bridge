/**
 * Publishing pipeline: unpublished readings -> ConstantGraph channels.
 *
 * Rows are only marked published after the API confirms the write, so a failed
 * run leaves them queued and the next cron pass resends them. Payload building
 * is kept pure and separate from the I/O so it can be unit-tested directly.
 */

import type { Env } from '../config';
import {
  CG_AGG_BY,
  CG_AGG_TYPE,
  CG_CHART_TYPE,
  CG_DEVICE_TYPE_HVAC,
  CHANNEL_META,
  DAY_SECONDS,
  METRIC_KEYS,
  channelIdFor,
  settingsFrom,
} from '../config';
import { metricsFor } from '../derive';
import type { Db } from '../db/client';
import type { DeviceRow, Reading } from '../db/repo';
import { getUnpublished, listDevices, markPublished } from '../db/repo';
import type { CgChannelValues } from './client';
import { ConstantGraphClient } from './client';

export interface PublishOutcome {
  attempted: number;
  published: number;
  channels: number;
  skipped: number;
  dryRun: boolean;
}

export async function publishPending(env: Env, db: Db): Promise<PublishOutcome> {
  const settings = settingsFrom(env);
  const readings = await getUnpublished(db, settings.publishBatch);

  if (readings.length === 0) {
    return { attempted: 0, published: 0, channels: 0, skipped: 0, dryRun: settings.dryRun };
  }

  const devices = await listDevices(db);
  const known = new Set(devices.map((d) => d.id));
  const included = readings.filter((r) => known.has(r.device_id));
  const channels = buildChannelPayload(readings, devices, settings.pollIntervalMin);

  const outcome: PublishOutcome = {
    attempted: readings.length,
    published: 0,
    channels: channels.length,
    skipped: readings.length - included.length,
    dryRun: settings.dryRun,
  };

  // Dry run and empty payload both stop short of the network, leaving every
  // row queued for a later run.
  if (settings.dryRun || channels.length === 0) return outcome;

  const client = new ConstantGraphClient(env);

  // Deliberately unguarded: a throw here leaves the rows unpublished, so the
  // next cron run picks them up again. That retry is the entire backfill
  // mechanism, and swallowing the error would silently drop the data.
  await client.postTimeData(channels);

  await markPublished(
    db,
    included.map((r) => ({ device_id: r.device_id, ts: r.ts })),
  );

  return { ...outcome, published: included.length };
}

/**
 * Project readings into per-channel value lists. Pure: no I/O, no clock.
 *
 * Null metrics are omitted rather than zeroed, because a thermostat without an
 * outdoor sensor should leave a gap in the graph instead of plotting a false
 * reading at 0.
 */
export function buildChannelPayload(
  readings: Reading[],
  devices: DeviceRow[],
  intervalMin: number,
): CgChannelValues[] {
  const baseFor = new Map(devices.map((d) => [d.id, d.channel_base]));
  const byChannel = new Map<number, Array<{ t: number; v: number }>>();

  for (const reading of readings) {
    const base = baseFor.get(reading.device_id);
    if (base === undefined) continue; // device not registered yet

    const metrics = metricsFor(reading, intervalMin);

    for (const metric of METRIC_KEYS) {
      const value = metrics[metric];
      if (value === null || value === undefined) continue;

      const id = channelIdFor(base, metric);
      const values = byChannel.get(id);
      if (values) values.push({ t: reading.ts, v: value });
      else byChannel.set(id, [{ t: reading.ts, v: value }]);
    }
  }

  return [...byChannel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, values]) => ({ id, values: values.sort((a, b) => a.t - b.t) }));
}

/**
 * ConstantGraph device number for a thermostat: 1, 2, 3...
 *
 * Distinct from the channel block. Device numbers are small ordinals scoped to
 * the location, and they are what groups a thermostat's channels together in
 * the UI rather than leaving eleven loose entries per unit.
 */
export function deviceNumberFor(devices: DeviceRow[], deviceId: string): number {
  return devices.findIndex((d) => d.id === deviceId) + 1;
}

/**
 * `Variables` entries for /data/config, naming every channel of every device.
 * The device name prefixes the metric label so two thermostats do not both
 * show up as plain "Indoor Temp".
 */
export function buildVariablesConfig(devices: DeviceRow[]): unknown[] {
  return devices.flatMap((device) =>
    METRIC_KEYS.map((metric) => {
      const meta = CHANNEL_META[metric];
      return {
        Id: channelIdFor(device.channel_base, metric),
        Name: `${device.name ?? device.id} ${meta.label}`,
        Units: meta.units,
        DataType: meta.dataType,
        Logging: 1,
        Device: deviceNumberFor(devices, device.id),
      };
    }),
  );
}

/**
 * The Devices section of /data/config. Which location these land in is decided
 * entirely by the API key -- there is no location field in the payload -- so
 * CG_API_KEY must be the key for the target location.
 */
export function buildDevicesConfig(devices: DeviceRow[]): unknown[] {
  return devices.map((device, i) => ({
    Number: i + 1,
    Name: device.name ?? device.id,
    Room: device.location_name ?? '',
    Type: CG_DEVICE_TYPE_HVAC,
  }));
}

/**
 * Dashboard graphs for each thermostat.
 *
 * `Reference` is documented as the graph's unique short name, so reusing a
 * stable slug per device makes re-running bootstrap an update rather than a
 * duplicate. Device index is baked into the slug to keep two thermostats apart.
 */
export function buildGraphsConfig(
  devices: DeviceRow[],
  opts: { withType?: boolean; limit?: number } = {},
): unknown[] {
  // Match the documented example's field set. `Type` appears in their channel
  // table but not in the example, and /data/config follows the example.
  const series = opts.withType ? seriesFull : seriesMinimal;
  const all = devices.flatMap((device, i) => {
    const n = i + 1;
    const label = device.name ?? device.id;
    const ch = (metric: Parameters<typeof channelIdFor>[1]) =>
      channelIdFor(device.channel_base, metric);

    return [
      {
        Name: `${label} - Comfort`,
        Reference: graphRef(`daikin-${n}-comfort`),
        Night: 1,
        Period: 7 * DAY_SECONDS,
        Channels: [
          // Indoor against its two setpoints, with outdoor for context. All are
          // degrees F, so they share one axis -- that is what makes the
          // comparison readable.
          series(ch('tempIndoorF'), CG_CHART_TYPE.spline),
          series(ch('heatSetpointF'), CG_CHART_TYPE.line),
          series(ch('coolSetpointF'), CG_CHART_TYPE.line),
          series(ch('tempOutdoorF'), CG_CHART_TYPE.spline),
        ],
      },
      {
        Name: `${label} - Runtime (Hours per Day)`,
        Reference: graphRef(`daikin-${n}-runtime`),
        Night: 0,
        Period: 30 * DAY_SECONDS,
        Channels: [
          // On Duration, not Sum. ConstantGraph rejects AggregationType 2 (Sum)
          // on these channels -- aggregation validity is data-type dependent,
          // and Sum appears reserved for energy types. On Duration counts hours
          // the value stayed at or above 1, which is what the runtime channels
          // encode, and it is exactly what their own worked example uses for a
          // "Heating Hours per Week" graph.
          series(
            ch('runtimeHeatMin'),
            CG_CHART_TYPE.column,
            CG_AGG_BY.day,
            CG_AGG_TYPE.onDuration,
          ),
          series(
            ch('runtimeCoolMin'),
            CG_CHART_TYPE.column,
            CG_AGG_BY.day,
            CG_AGG_TYPE.onDuration,
          ),
        ],
      },
      {
        Name: `${label} - Humidity`,
        Reference: graphRef(`daikin-${n}-humidity`),
        Night: 1,
        Period: 7 * DAY_SECONDS,
        Channels: [
          series(ch('humIndoor'), CG_CHART_TYPE.spline),
          series(ch('humOutdoor'), CG_CHART_TYPE.spline),
        ],
      },
      {
        Name: `${label} - Indoor vs Outdoor Delta`,
        Reference: graphRef(`daikin-${n}-delta`),
        Night: 0,
        Period: 30 * DAY_SECONDS,
        Channels: [
          // Daily average delta: how hard the envelope is working, smoothed.
          series(
            ch('deltaF'),
            CG_CHART_TYPE.area,
            CG_AGG_BY.day,
            CG_AGG_TYPE.weightedAverage,
          ),
        ],
      },
    ];
  });

  return typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all;
}

/**
 * ConstantGraph caps the graph `Reference` length. 22 characters is rejected,
 * 17 is accepted, and the rejection arrives as InvalidSession/"user not found"
 * with no hint that length is the cause.
 *
 * Truncating keeps references unique: the device ordinal sits near the front
 * and the metric slugs differ within their first few letters.
 */
export const MAX_GRAPH_REFERENCE = 17;

export function graphRef(reference: string): string {
  return reference.length <= MAX_GRAPH_REFERENCE
    ? reference
    : reference.slice(0, MAX_GRAPH_REFERENCE);
}

function seriesFull(
  Id: number,
  Type: number,
  AggregateBy: number = CG_AGG_BY.auto,
  AggregationType: number = CG_AGG_TYPE.sample,
) {
  return { Id, Type, AggregateBy, AggregationType, yAxis: 1 };
}

/** The field set shown in the documented Graphs example: no `Type`. */
function seriesMinimal(
  Id: number,
  _Type: number,
  AggregateBy: number = CG_AGG_BY.auto,
  AggregationType: number = CG_AGG_TYPE.sample,
) {
  return { Id, AggregateBy, AggregationType, yAxis: 1 };
}
