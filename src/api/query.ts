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
  /** Electricity price in currency units per kWh; 0 disables the cost column. */
  ratePerKwh: number;
  /**
   * Output columns to compute, or undefined for all of them.
   *
   * A series row carries ~88 columns while a panel charts two or three, so
   * every dashboard query was computing and serialising roughly thirty times
   * the data it used. Naming the wanted columns cuts that without changing any
   * value: the columns returned are identical, there are simply fewer of them.
   */
  fields: Set<string> | undefined;
}

export const MAX_SERIES_ROWS = 20_000;

/**
 * Sanity ceiling on the electricity rate.
 *
 * Guards against a misplaced decimal or cents-instead-of-dollars turning every
 * cost figure into nonsense. US residential rates sit around 0.10-0.40; 100 is
 * far outside any plausible per-kWh price in any currency worth charting.
 */
export const MAX_RATE_PER_KWH = 100;
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

/**
 * Requested output columns, or undefined for all.
 *
 * Only identifier-shaped names survive, so the value can be matched against
 * SQL aliases without any chance of it becoming SQL itself. An empty or
 * entirely junk list means "everything", which keeps a malformed URL showing
 * too much data rather than none.
 */
export function toFields(raw: string | null): Set<string> | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const names = raw.split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s));
  return names.length > 0 ? new Set(names) : undefined;
}

/** Absent, unparseable, negative, or implausible rates all disable costing. */
export function toRate(raw: string | null): number {
  const n = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(n)) return 0;
  if (n < 0 || n > MAX_RATE_PER_KWH) return 0;
  return n;
}

/**
 * Seconds of history for a `last=` relative window, or 0 for none.
 *
 * Grafana's dashboard panels interpolate $__from/$__to, but the alerting
 * evaluator does not -- it sends the macros through literally, so the API sees
 * no range and falls back to 24 hours. An alert reducing to the latest value
 * does not need a day of history every five minutes, so rules ask for a window
 * in the form the alerting path can actually express.
 *
 * Capped at a year; anything larger is a typo rather than an intent.
 */
export function toLastSeconds(raw: string | null): number {
  const n = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 365 * 24 * 60 * 60);
}

export function parseSeriesQuery(q: URLSearchParams, nowSec: number): SeriesQuery {
  // `last` wins over from/to, so a rule cannot accidentally widen its own
  // window by leaving an uninterpolated macro in the URL.
  const last = toLastSeconds(q.get('last'));
  if (last > 0) {
    return {
      fromTs: nowSec - last,
      toTs: nowSec,
      bucketSec: toBucketSeconds(q.get('interval') ?? q.get('interval_ms')),
      deviceId: q.get('device') ?? undefined,
      limit: Math.min(Number(q.get('limit')) || DEFAULT_LIMIT, MAX_SERIES_ROWS),
      csv: q.get('format') === 'csv',
      ratePerKwh: toRate(q.get('rate')),
      fields: toFields(q.get('fields')),
    };
  }

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
    ratePerKwh: toRate(q.get('rate')),
    fields: toFields(q.get('fields')),
  };
}
