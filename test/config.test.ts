import { describe, it, expect } from 'vitest';
import {
  channelBaseFor,
  channelIdFor,
  settingsFrom,
  CHANNEL_STRIDE,
  METRIC_KEYS,
  CHANNEL_META,
  type Env,
} from '../src/config';

describe('channel allocation', () => {
  it('gives each thermostat its own block', () => {
    expect(channelBaseFor(1000, 0)).toBe(1000);
    expect(channelBaseFor(1000, 1)).toBe(1100);
    expect(channelBaseFor(1000, 2)).toBe(1200);
  });

  it('keeps every metric inside its block', () => {
    const base = channelBaseFor(1000, 0);
    for (const key of METRIC_KEYS) {
      const id = channelIdFor(base, key);
      expect(id).toBeGreaterThanOrEqual(base);
      expect(id).toBeLessThan(base + CHANNEL_STRIDE);
    }
  });

  it('never collides across adjacent devices', () => {
    const ids = new Set<number>();
    for (let device = 0; device < 5; device++) {
      const base = channelBaseFor(1000, device);
      for (const key of METRIC_KEYS) ids.add(channelIdFor(base, key));
    }
    expect(ids.size).toBe(5 * METRIC_KEYS.length);
  });

  it('describes every metric it allocates', () => {
    for (const key of METRIC_KEYS) {
      expect(CHANNEL_META[key]?.label).toBeTruthy();
    }
  });
});

describe('settingsFrom', () => {
  const base = { CG_APP_NAME: 'daikin-one-bridge' } as unknown as Env;

  it('falls back to safe defaults on unparseable vars', () => {
    const s = settingsFrom({ ...base, CHANNEL_BASE: 'oops' } as Env);
    expect(s.channelBase).toBe(1000);
    expect(s.pollIntervalMin).toBe(5);
    expect(s.publishBatch).toBe(200);
  });

  it('treats DRY_RUN as true only for the literal string', () => {
    expect(settingsFrom({ ...base, DRY_RUN: 'true' } as Env).dryRun).toBe(true);
    expect(settingsFrom({ ...base, DRY_RUN: 'TRUE' } as Env).dryRun).toBe(true);
    expect(settingsFrom({ ...base, DRY_RUN: 'false' } as Env).dryRun).toBe(false);
    expect(settingsFrom({ ...base, DRY_RUN: '' } as Env).dryRun).toBe(false);
  });
});
