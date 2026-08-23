import { describe, it, expect } from 'vitest';
import { bucketTs } from '../src/cycle';

describe('bucketTs', () => {
  it('snaps a sample to its interval boundary', () => {
    // 12:03:47 with a 5-minute interval rounds to 12:05:00.
    expect(bucketTs(1_700_000_627, 5)).toBe(1_700_000_700);
    expect(bucketTs(1_700_000_400, 5)).toBe(1_700_000_400);
  });

  it('collapses a manual poll onto the scheduled sample', () => {
    // A cron run and an /admin/poll seconds apart must share one (device, ts)
    // key so INSERT OR IGNORE dedupes them rather than storing a near-twin.
    const cron = bucketTs(1_700_000_400, 5);
    const manual = bucketTs(1_700_000_430, 5);
    expect(manual).toBe(cron);
  });

  it('produces evenly spaced buckets regardless of cron jitter', () => {
    const jittered = [1_700_000_401, 1_700_000_698, 1_700_001_005, 1_700_001_299];
    const buckets = jittered.map((t) => bucketTs(t, 5));
    const gaps = buckets.slice(1).map((t, i) => t - buckets[i]!);
    expect(new Set(gaps)).toEqual(new Set([300]));
  });

  it('falls back to 1-minute buckets on a zero or negative interval', () => {
    // Never divide by zero and never emit NaN as a primary-key component.
    expect(bucketTs(1_700_000_627, 0)).toBe(1_700_000_640);
    expect(bucketTs(1_700_000_627, -5)).toBe(1_700_000_640);
  });
});
