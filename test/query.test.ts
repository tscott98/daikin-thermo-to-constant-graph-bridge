import { describe, it, expect } from 'vitest';
import {
  MAX_RATE_PER_KWH,
  MAX_SERIES_ROWS,
  parseSeriesQuery,
  toBucketSeconds,
  toEpochSeconds,
  toRate,
} from '../src/api/query';

const NOW = 1_787_529_300;
const q = (s: string) => new URLSearchParams(s);

describe('toEpochSeconds', () => {
  it('passes seconds through', () => {
    expect(toEpochSeconds('1787529300', 0)).toBe(1_787_529_300);
  });

  it('converts Grafana milliseconds', () => {
    // $__from arrives as epoch ms; without this the range lands in the year 58000.
    expect(toEpochSeconds('1787529300000', 0)).toBe(1_787_529_300);
  });

  it('falls back on missing or unparseable input', () => {
    expect(toEpochSeconds(null, 42)).toBe(42);
    expect(toEpochSeconds('', 42)).toBe(42);
    expect(toEpochSeconds('not-a-number', 42)).toBe(42);
  });
});

describe('toBucketSeconds', () => {
  it('treats small values as seconds', () => {
    expect(toBucketSeconds('300')).toBe(300);
    expect(toBucketSeconds('3600')).toBe(3600);
  });

  it('treats large values as Grafana milliseconds', () => {
    expect(toBucketSeconds('86400000')).toBe(86_400);
  });

  it('collapses to raw rows when absent or non-positive', () => {
    expect(toBucketSeconds(null)).toBe(1);
    expect(toBucketSeconds('0')).toBe(1);
    expect(toBucketSeconds('-5')).toBe(1);
  });
});

describe('parseSeriesQuery', () => {
  it('defaults to the last 24 hours of raw rows', () => {
    const p = parseSeriesQuery(q(''), NOW);
    expect(p.toTs).toBe(NOW);
    expect(p.fromTs).toBe(NOW - 86_400);
    expect(p.bucketSec).toBe(1);
    expect(p.csv).toBe(false);
  });

  it('handles a full Grafana-style query', () => {
    const p = parseSeriesQuery(
      q('from=1787442900000&to=1787529300000&interval=300000&device=dev-1'),
      NOW,
    );
    expect(p.fromTs).toBe(1_787_442_900);
    expect(p.toTs).toBe(1_787_529_300);
    expect(p.bucketSec).toBe(300);
    expect(p.deviceId).toBe('dev-1');
  });

  it('swaps a reversed range instead of returning nothing', () => {
    const p = parseSeriesQuery(q('from=1787529300&to=1787442900'), NOW);
    expect(p.fromTs).toBeLessThan(p.toTs);
  });

  it('caps limit and rejects nonsense', () => {
    expect(parseSeriesQuery(q('limit=999999'), NOW).limit).toBe(MAX_SERIES_ROWS);
    expect(parseSeriesQuery(q('limit=0'), NOW).limit).toBe(5000);
    expect(parseSeriesQuery(q('limit=abc'), NOW).limit).toBe(5000);
    expect(parseSeriesQuery(q('limit=10'), NOW).limit).toBe(10);
  });

  it('accepts interval_ms as an alias', () => {
    expect(parseSeriesQuery(q('interval_ms=3600000'), NOW).bucketSec).toBe(3600);
  });

  it('detects csv', () => {
    expect(parseSeriesQuery(q('format=csv'), NOW).csv).toBe(true);
    expect(parseSeriesQuery(q('format=json'), NOW).csv).toBe(false);
  });
});

describe('toRate', () => {
  it('accepts a normal residential rate', () => {
    expect(toRate('0.14')).toBe(0.14);
    expect(toRate('0.3891')).toBe(0.3891);
  });

  it('treats absent or unparseable input as no costing', () => {
    expect(toRate(null)).toBe(0);
    expect(toRate('')).toBe(0);
    expect(toRate('free')).toBe(0);
  });

  it('rejects negative and implausible rates rather than charting nonsense', () => {
    // A rate entered in cents instead of dollars would make every cost figure
    // wrong by 100x while still looking like a number.
    expect(toRate('-0.14')).toBe(0);
    expect(toRate('1000')).toBe(0);
    expect(toRate(String(MAX_RATE_PER_KWH + 1))).toBe(0);
  });

  it('is wired into parseSeriesQuery', () => {
    expect(parseSeriesQuery(new URLSearchParams('rate=0.14'), 0).ratePerKwh).toBe(0.14);
    expect(parseSeriesQuery(new URLSearchParams(''), 0).ratePerKwh).toBe(0);
  });
});
