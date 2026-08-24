import { describe, it, expect } from 'vitest';
import {
  MAX_GRAPH_REFERENCE,
  buildChannelPayload,
  buildDevicesConfig,
  buildGraphsConfig,
  buildVariablesConfig,
  graphRef,
} from '../src/constantgraph/publish';
import {
  CG_AGG_BY,
  CG_AGG_TYPE,
  CG_CHART_TYPE,
  CG_DATA_TYPE,
  CHANNEL_OFFSET,
  METRIC_KEYS,
} from '../src/config';
import { EQUIPMENT_STATUS } from '../src/daikin/types';
import type { DeviceRow, Reading } from '../src/db/repo';
import { EMPTY_SKYPORT } from '../src/skyport/map';

const device = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'dev-1',
  location_name: 'Home',
  name: 'Upstairs',
  model: 'ONE+',
  firmware_version: '1.0',
  channel_base: 1000,
  first_seen: 0,
  last_seen: 0,
  ...over,
});

const reading = (over: Partial<Reading> = {}): Reading => ({
  device_id: 'dev-1',
  ts: 1_700_000_000,
  temp_indoor_c: 21,
  hum_indoor: 45,
  temp_outdoor_c: 0,
  hum_outdoor: 80,
  heat_setpoint_c: 20,
  cool_setpoint_c: 24,
  setpoint_delta_c: 2.2,
  setpoint_min_c: 10,
  setpoint_max_c: 32,
  mode: 3,
  equipment_status: EQUIPMENT_STATUS.idle,
  fan_circulate: 0,
  fan_circulate_spd: 0,
  schedule_enabled: 1,
  raw: null,
  published: 0,
  ...EMPTY_SKYPORT,
  ...over,
});

const channel = (payload: ReturnType<typeof buildChannelPayload>, id: number) =>
  payload.find((c) => c.id === id);

describe('buildChannelPayload', () => {
  it('maps each metric onto its allocated channel id', () => {
    const payload = buildChannelPayload([reading()], [device()], 5);

    expect(channel(payload, 1000 + CHANNEL_OFFSET.tempIndoorF)?.values[0]?.v).toBe(69.8);
    expect(channel(payload, 1000 + CHANNEL_OFFSET.tempOutdoorF)?.values[0]?.v).toBe(32);
    expect(channel(payload, 1000 + CHANNEL_OFFSET.humIndoor)?.values[0]?.v).toBe(45);
    expect(channel(payload, 1000 + CHANNEL_OFFSET.deltaF)?.values[0]?.v).toBe(37.8);
  });

  it('carries the reading timestamp through, not the wall clock', () => {
    // This is what makes backfill work: a row captured during an outage is
    // published later at the moment it was actually measured.
    const payload = buildChannelPayload([reading({ ts: 1_600_000_000 })], [device()], 5);
    expect(channel(payload, 1000)?.values[0]?.t).toBe(1_600_000_000);
  });

  it('omits null metrics instead of sending zero', () => {
    const payload = buildChannelPayload(
      [reading({ temp_outdoor_c: null, hum_outdoor: null })],
      [device()],
      5,
    );
    expect(channel(payload, 1000 + CHANNEL_OFFSET.tempOutdoorF)).toBeUndefined();
    expect(channel(payload, 1000 + CHANNEL_OFFSET.humOutdoor)).toBeUndefined();
    expect(channel(payload, 1000 + CHANNEL_OFFSET.deltaF)).toBeUndefined();
    // The indoor sensor still reports.
    expect(channel(payload, 1000 + CHANNEL_OFFSET.tempIndoorF)?.values[0]?.v).toBe(69.8);
  });

  it('groups multiple samples under one channel, ascending by time', () => {
    const payload = buildChannelPayload(
      [reading({ ts: 300 }), reading({ ts: 100 }), reading({ ts: 200 })],
      [device()],
      5,
    );
    expect(channel(payload, 1000)?.values.map((v) => v.t)).toEqual([100, 200, 300]);
  });

  it('keeps two thermostats in separate channel blocks', () => {
    const payload = buildChannelPayload(
      [reading(), reading({ device_id: 'dev-2', temp_indoor_c: 25 })],
      [device(), device({ id: 'dev-2', name: 'Downstairs', channel_base: 1100 })],
      5,
    );
    expect(channel(payload, 1000)?.values[0]?.v).toBe(69.8);
    expect(channel(payload, 1100)?.values[0]?.v).toBe(77);
  });

  it('skips readings whose device is not registered', () => {
    const payload = buildChannelPayload(
      [reading({ device_id: 'unknown' })],
      [device()],
      5,
    );
    expect(payload).toEqual([]);
  });

  it('returns channels sorted by id', () => {
    const ids = buildChannelPayload([reading()], [device()], 5).map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('buildVariablesConfig', () => {
  it('names every channel for every device', () => {
    const vars = buildVariablesConfig([
      device(),
      device({ id: 'dev-2', name: 'Downstairs', channel_base: 1100 }),
    ]);
    expect(vars).toHaveLength(2 * METRIC_KEYS.length);

    const names = vars.map((v) => (v as { Name: string }).Name);
    expect(names.some((n) => n.includes('Upstairs') && n.includes('Indoor Temp'))).toBe(true);
    expect(names.some((n) => n.includes('Downstairs'))).toBe(true);
  });
});

describe('device grouping', () => {
  const devices = [
    device(),
    device({ id: 'dev-2', name: 'Downstairs', channel_base: 1100 }),
  ];

  it('numbers devices from 1 within the location', () => {
    const cfg = buildDevicesConfig(devices) as Array<{ Number: number; Name: string }>;
    expect(cfg.map((d) => d.Number)).toEqual([1, 2]);
    expect(cfg.map((d) => d.Name)).toEqual(['Upstairs', 'Downstairs']);
  });

  it('attaches every channel to its own device', () => {
    const vars = buildVariablesConfig(devices) as Array<{ Id: number; Device: number }>;
    for (const v of vars) {
      expect(v.Device).toBe(v.Id < 1100 ? 1 : 2);
    }
  });
});

describe('ConstantGraph data types', () => {
  const vars = buildVariablesConfig([device()]) as Array<{
    Id: number;
    DataType: number;
    Name: string;
  }>;
  const typeAt = (offset: number) => vars.find((v) => v.Id === 1000 + offset)?.DataType;

  it('tags each channel with its real type, not a generic one', () => {
    expect(typeAt(CHANNEL_OFFSET.tempIndoorF)).toBe(CG_DATA_TYPE.temperature);
    expect(typeAt(CHANNEL_OFFSET.tempOutdoorF)).toBe(CG_DATA_TYPE.temperature);
    expect(typeAt(CHANNEL_OFFSET.humIndoor)).toBe(CG_DATA_TYPE.humidity);
    expect(typeAt(CHANNEL_OFFSET.humOutdoor)).toBe(CG_DATA_TYPE.humidity);
    expect(typeAt(CHANNEL_OFFSET.mode)).toBe(CG_DATA_TYPE.hvacModeStatus);
    expect(typeAt(CHANNEL_OFFSET.equipmentStatus)).toBe(CG_DATA_TYPE.hvacOperatingState);
  });

  it('follows ConstantGraph High=heating / Low=cooling, not the deadband reading', () => {
    // Their reference states "High Setpoint - Heating high set point" and
    // "Low Setpoint - Cooling low set point". Reads backwards; it is correct.
    expect(typeAt(CHANNEL_OFFSET.heatSetpointF)).toBe(CG_DATA_TYPE.highSetpoint);
    expect(typeAt(CHANNEL_OFFSET.coolSetpointF)).toBe(CG_DATA_TYPE.lowSetpoint);
  });

  it('never falls back to the brightness type', () => {
    // Regression guard: every channel was once hardcoded to DataType 2.
    expect(vars.every((v) => v.DataType !== 2)).toBe(true);
    expect(vars).toHaveLength(METRIC_KEYS.length);
  });

  it('registers the thermostat as an HVAC device', () => {
    const cfg = buildDevicesConfig([device()]) as Array<{ Type: number }>;
    expect(cfg[0]?.Type).toBe(5);
  });
});

interface GraphCfg {
  Name: string;
  Reference: string;
  Period: number;
  Night: number;
  Channels: Array<{
    Id: number;
    Type: number;
    AggregateBy: number;
    AggregationType: number;
    yAxis: number;
  }>;
}

describe('buildGraphsConfig', () => {
  const devices = [
    device(),
    device({ id: 'dev-2', name: 'Downstairs', channel_base: 1100 }),
  ];
  const graphs = buildGraphsConfig(devices) as GraphCfg[];
  const byRef = (ref: string) => graphs.find((g) => g.Reference === ref);

  it('builds a graph set per thermostat', () => {
    expect(graphs).toHaveLength(8);
    expect(byRef('daikin-1-comfort')).toBeDefined();
    expect(byRef('daikin-2-comfort')).toBeDefined();
  });

  it('keeps references unique so re-running bootstrap updates instead of duplicating', () => {
    const refs = graphs.map((g) => g.Reference);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('keeps every reference within the length ConstantGraph accepts', () => {
    // A 22-char reference is rejected as InvalidSession, with nothing in the
    // error indicating length. Guard it here so it fails in CI, not live.
    for (const g of graphs) {
      expect(g.Reference.length).toBeLessThanOrEqual(MAX_GRAPH_REFERENCE);
    }
  });

  it('stays within the cap even with many thermostats', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      device({ id: `dev-${i + 1}`, name: `Zone ${i + 1}`, channel_base: 1000 + i * 100 }),
    );
    const refs = (buildGraphsConfig(many) as GraphCfg[]).map((g) => g.Reference);
    for (const r of refs) expect(r.length).toBeLessThanOrEqual(MAX_GRAPH_REFERENCE);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('graphRef truncates only when over the cap', () => {
    expect(graphRef('short')).toBe('short');
    expect(graphRef('a'.repeat(30))).toHaveLength(MAX_GRAPH_REFERENCE);
  });

  it('plots indoor temp against both setpoints and outdoor on one axis', () => {
    const comfort = byRef('daikin-1-comfort');
    expect(comfort?.Channels.map((c) => c.Id)).toEqual([
      1000 + CHANNEL_OFFSET.tempIndoorF,
      1000 + CHANNEL_OFFSET.heatSetpointF,
      1000 + CHANNEL_OFFSET.coolSetpointF,
      1000 + CHANNEL_OFFSET.tempOutdoorF,
    ]);
    // Shared axis is the point: comparing them is meaningless otherwise.
    expect(comfort?.Channels.every((c) => c.yAxis === 1)).toBe(true);
  });

  it('aggregates runtime by On Duration per day, not Sum', () => {
    // Sum (AggregationType 2) is rejected by ConstantGraph for these channels;
    // On Duration is what their own heating-hours example uses.
    const runtime = byRef('daikin-1-runtime');
    expect(runtime?.Channels.every((c) => c.AggregationType === CG_AGG_TYPE.onDuration)).toBe(
      true,
    );
    expect(runtime?.Channels.every((c) => c.AggregateBy === CG_AGG_BY.day)).toBe(true);
    expect(graphs.every((g) => g.Channels.every((c) => c.AggregationType !== CG_AGG_TYPE.sum))).toBe(
      true,
    );
  });

  it('omits the channel Type field by default', () => {
    // /data/config rejects payloads carrying fields the worked example omits.
    for (const g of graphs) {
      for (const c of g.Channels) {
        expect(c).not.toHaveProperty('Type');
        expect(c).toHaveProperty('Id');
        expect(c).toHaveProperty('AggregateBy');
        expect(c).toHaveProperty('AggregationType');
        expect(c).toHaveProperty('yAxis');
      }
    }
  });

  it('can still emit Type when explicitly asked', () => {
    const withType = buildGraphsConfig(devices, { withType: true }) as GraphCfg[];
    const runtime = withType.find((g) => g.Reference === 'daikin-1-runtime');
    expect(runtime?.Channels.every((c) => c.Type === CG_CHART_TYPE.column)).toBe(true);
  });

  it('honours a graph limit', () => {
    expect(buildGraphsConfig(devices, { limit: 1 })).toHaveLength(1);
  });

  it('averages the delta rather than summing it', () => {
    const delta = byRef('daikin-1-delta');
    expect(delta?.Channels[0]?.AggregationType).toBe(CG_AGG_TYPE.weightedAverage);
  });

  it('references only channels inside the owning device block', () => {
    for (const g of graphs) {
      const base = g.Reference.startsWith('daikin-1-') ? 1000 : 1100;
      for (const c of g.Channels) {
        expect(c.Id).toBeGreaterThanOrEqual(base);
        expect(c.Id).toBeLessThan(base + 100);
      }
    }
  });

  it('gives every graph a positive period', () => {
    expect(graphs.every((g) => g.Period > 0)).toBe(true);
  });
});
