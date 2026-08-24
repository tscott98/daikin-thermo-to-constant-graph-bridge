/**
 * Query-parameter parsing for /api/series.
 *
 * Kept free of database imports so it can be unit tested directly. Grafana
 * sends its own units -- $__from/$__to in epoch milliseconds, $__interval_ms in
 * milliseconds -- while a human typing a URL will use seconds, so both are
 * accepted and normalised.
 */

export interface SeriesQuery {
  fromTs: number;
  toTs: number;
  bucketSec: number;
  deviceId: string | undefined;
  limit: number;
  csv: boolean;
}

export const MAX_SERIES_ROWS = 20_000;
const DEFAULT_LIMIT = 5_000;

/**
 * Epoch values above 1e12 are milliseconds.
 *
 * The boundary sits far from any plausible seconds value: 1e12 seconds is the
 * year 33658, while 1e12 milliseconds is 2001. Anything this project sees in
 * seconds (~1.7e9) or milliseconds (~1.7e12) lands unambiguously.
 */
export function toEpochSeconds(raw: string | null, fallback: number): number {
  const n = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(n)) return fallback;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * Bucket size in seconds. Values above 10,000 are treated as milliseconds,
 * since a 10,000-second bucket (~2.8 h) is plausible but Grafana's
 * $__interval_ms for any realistic panel is far larger in ms terms.
 * A bucket of 1 collapses to raw rows.
 */
export function toBucketSeconds(raw: string | null): number {
  const n = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(n) || n <= 0) return 1;
  return n > 10_000 ? Math.max(1, Math.floor(n / 1000)) : Math.max(1, Math.floor(n));
}

export function parseSeriesQuery(q: URLSearchParams, nowSec: number): SeriesQuery {
  const fromTs = toEpochSeconds(q.get('from'), nowSec - 24 * 60 * 60);
  const toTs = toEpochSeconds(q.get('to'), nowSec);

  const rawLimit = Number(q.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_SERIES_ROWS)
    : DEFAULT_LIMIT;

  return {
    // Tolerate a reversed range rather than silently returning nothing.
    fromTs: Math.min(fromTs, toTs),
    toTs: Math.max(fromTs, toTs),
    bucketSec: toBucketSeconds(q.get('interval') ?? q.get('interval_ms')),
    deviceId: q.get('device') ?? undefined,
    limit,
    csv: q.get('format') === 'csv',
  };
}
