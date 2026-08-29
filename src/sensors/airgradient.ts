/**
 * AirGradient indoor air quality monitor.
 *
 * Adds CO2, particulates and a second independent temperature/humidity pair to
 * every reading. CO2 is the valuable one: it is an occupancy proxy, which is
 * what separates "moisture is coming in through the envelope" from "moisture is
 * being generated inside" -- a distinction relative humidity alone cannot make.
 *
 * The API authenticates with a token in the *query string* rather than a
 * header, so the token ends up in the request URL. Errors here therefore never
 * include the URL, or the token would land in the logs.
 */

import type { Env } from '../config';

const BASE = 'https://api.airgradient.com/public/api/v1';
const TIMEOUT_MS = 10_000;

export interface AirGradientReading {
  tempC: number | null;
  rh: number | null;
  co2: number | null;
  pm02: number | null;
  pm01: number | null;
  pm10: number | null;
  tvocIndex: number | null;
  noxIndex: number | null;
}

export const EMPTY_AIRGRADIENT: AirGradientReading = {
  tempC: null, rh: null, co2: null, pm02: null,
  pm01: null, pm10: null, tvocIndex: null, noxIndex: null,
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Prefer the corrected value, fall back to raw.
 *
 * AirGradient's correction algorithms compensate for sensor self-heating and
 * drift, and the corrected figures are what their own CSV export ships, so
 * matching that keeps the API and export comparable.
 */
function corrected(d: Record<string, unknown>, base: string): number | null {
  return num(d[`${base}_corrected`]) ?? num(d[base]);
}

export class AirGradientClient {
  constructor(private readonly env: Env) {}

  async read(): Promise<AirGradientReading> {
    const id = this.env.AG_LOCATION_ID;
    const token = this.env.AG_TOKEN;
    if (!id || !token) return EMPTY_AIRGRADIENT;

    const res = await fetch(
      `${BASE}/locations/${encodeURIComponent(id)}/measures/current` +
        `?token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    // Deliberately no URL in the message: it carries the token.
    if (!res.ok) throw new Error(`AirGradient returned ${res.status}`);

    const d = (await res.json()) as Record<string, unknown>;
    return mapMeasure(d);
  }

  /**
   * Past measures for a window, in the API's own 5-minute buckets.
   *
   * The thermostat APIs report current state only, so a gap in readings is
   * permanent. AirGradient keeps history, which makes air quality the one
   * source that can be recovered after an outage. Buckets line up with the
   * bridge's own 5-minute grid, and rows are keyed on (ts), so replaying a
   * window that partly overlaps existing data is safe.
   */
  async readPast(fromSec: number, toSec: number): Promise<Array<{ ts: number } & AirGradientReading>> {
    const id = this.env.AG_LOCATION_ID;
    const token = this.env.AG_TOKEN;
    if (!id || !token) return [];

    const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const res = await fetch(
      `${BASE}/locations/${encodeURIComponent(id)}/measures/past` +
        `?from=${encodeURIComponent(iso(fromSec))}&to=${encodeURIComponent(iso(toSec))}` +
        `&token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`AirGradient past returned ${res.status}`);

    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return [];

    const out: Array<{ ts: number } & AirGradientReading> = [];
    for (const r of rows) {
      // The bucket timestamp field is named differently across their
      // responses; take whichever is present rather than guessing one.
      const raw = r['date'] ?? r['timestamp'] ?? r['from'] ?? r['dateTime'];
      const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (!Number.isFinite(ms)) continue;
      out.push({ ts: Math.floor(ms / 1000), ...mapMeasure(r) });
    }
    return out;
  }
}

function mapMeasure(d: Record<string, unknown>): AirGradientReading {
  return {
    tempC: corrected(d, 'atmp'),
    rh: corrected(d, 'rhum'),
    co2: corrected(d, 'rco2'),
    pm02: corrected(d, 'pm02'),
    pm01: corrected(d, 'pm01'),
    pm10: corrected(d, 'pm10'),
    tvocIndex: num(d['tvocIndex']),
    noxIndex: num(d['noxIndex']),
  };
}
