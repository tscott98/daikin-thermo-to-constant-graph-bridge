import { describe, it, expect } from 'vitest';
import { cToF, round2, runtimeMinutes, metricsFor } from '../src/derive';
import { EQUIPMENT_STATUS } from '../src/daikin/types';
import type { Reading } from '../src/db/repo';

const reading = (over: Partial<Reading> = {}): Reading => ({
  device_id: 'dev-1',
  ts: 1_700_000_000,
  temp_indoor_c: 21,
  hum_indoor: 45,
  temp_outdoor_c: 0,
  hum_outdoor: 80,
  heat_setpoint_c: 20,
  cool_setpoint_c: 24,
  mode: 3,
  equipment_status: EQUIPMENT_STATUS.idle,
  fan_circulate: 0,
  fan_circulate_spd: 0,
  schedule_enabled: 1,
  raw: null,
  published: 0,
  ...over,
});

describe('cToF', () => {
  it('converts the reference points', () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(cToF(-40)).toBe(-40);
    expect(cToF(21)).toBe(69.8);
  });

  it('passes null through rather than producing 32', () => {
    // A missing outdoor sensor must stay missing; coercing null to 0 C would
    // plot a plausible-looking 32 F line that never existed.
    expect(cToF(null)).toBeNull();
    expect(cToF(undefined)).toBeNull();
    expect(cToF(Number.NaN)).toBeNull();
  });

  it('rounds to two decimals', () => {
    expect(cToF(21.1234)).toBe(70.02);
    expect(cToF(21.111)).toBe(70);
    expect(round2(1.005)).toBe(1);
  });
});

describe('runtimeMinutes', () => {
  it('credits the interval to heating when heating', () => {
    expect(runtimeMinutes(EQUIPMENT_STATUS.heat, 5)).toEqual({ heat: 5, cool: 0 });
  });

  it('treats overcool as cooling', () => {
    expect(runtimeMinutes(EQUIPMENT_STATUS.cool, 5)).toEqual({ heat: 0, cool: 5 });
    expect(runtimeMinutes(EQUIPMENT_STATUS.overcool, 5)).toEqual({ heat: 0, cool: 5 });
  });

  it('credits nothing when idle or fan-only', () => {
    expect(runtimeMinutes(EQUIPMENT_STATUS.idle, 5)).toEqual({ heat: 0, cool: 0 });
    expect(runtimeMinutes(EQUIPMENT_STATUS.fan, 5)).toEqual({ heat: 0, cool: 0 });
    expect(runtimeMinutes(null, 5)).toEqual({ heat: 0, cool: 0 });
  });
});

describe('metricsFor', () => {
  it('projects a full reading into every channel metric', () => {
    const m = metricsFor(reading({ equipment_status: EQUIPMENT_STATUS.heat }), 5);
    expect(m.tempIndoorF).toBe(69.8);
    expect(m.tempOutdoorF).toBe(32);
    expect(m.deltaF).toBe(37.8);
    expect(m.runtimeHeatMin).toBe(5);
    expect(m.runtimeCoolMin).toBe(0);
    expect(m.humIndoor).toBe(45);
  });

  it('leaves delta null when the outdoor sensor is absent', () => {
    const m = metricsFor(reading({ temp_outdoor_c: null }), 5);
    expect(m.tempOutdoorF).toBeNull();
    expect(m.deltaF).toBeNull();
    expect(m.tempIndoorF).toBe(69.8);
  });
});
