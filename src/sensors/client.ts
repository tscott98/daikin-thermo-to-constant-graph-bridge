/**
 * Duct sensor readings, via ConstantGraph's read API.
 *
 * The SmartThings sensors publish into ConstantGraph, so this reads them back
 * out rather than talking to SmartThings directly. That keeps one integration
 * instead of two, at the cost of reading values that have already been through
 * ConstantGraph's storage.
 *
 * Note this reads from a different location (node) than the one the bridge
 * writes to, and needs a *read* key, which is a separate credential from the
 * write key. Requests without a valid read key fail as InvalidSession -- the
 * same catch-all this API returns for most problems.
 */

import type { Env } from '../config';

const BASE = 'https://api.constantgraph.com/graph/graphdata';
const TIMEOUT_MS = 10_000;

/** Sensors report on change, so a window wide enough to catch a quiet one. */
const LOOKBACK_MIN = 30;

export interface DuctReading {
  returnTempF: number | null;
  returnRh: number | null;
  supplyTempF: number | null;
}

export const EMPTY_DUCT: DuctReading = {
  returnTempF: null,
  returnRh: null,
  supplyTempF: null,
};

interface Point {
  time?: string;
  value?: number;
}

function isoMinute(d: Date): string {
  // The API wants YYYY-MM-DDTHH:MM with no seconds or zone suffix.
  return d.toISOString().slice(0, 16);
}

export class SensorClient {
  constructor(private readonly env: Env) {}

  /** Latest value for one channel, or null if nothing reported in the window. */
  private async latest(channel: number): Promise<number | null> {
    if (!channel) return null;

    const stop = new Date();
    const start = new Date(stop.getTime() - LOOKBACK_MIN * 60_000);
    const node = Number(this.env.CG_SENSOR_NODE) || 1;
    const url =
      `${BASE}?channel=${channel}&node=${node}` +
      `&start=${isoMinute(start)}&stop=${isoMinute(stop)}` +
      `&aggType=0&aggBy=1&compare=0`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Api-Key': this.env.CG_READ_API_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as Point[] | { error_code?: string };
    // The read API answers errors with an object rather than an array.
    if (!Array.isArray(body) || body.length === 0) return null;

    // Points arrive oldest first; the freshest is what we want to pair with
    // this cycle's reading.
    for (let i = body.length - 1; i >= 0; i--) {
      const v = body[i]?.value;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }

  async read(): Promise<DuctReading> {
    const [returnTempF, returnRh, supplyTempF] = await Promise.all([
      this.latest(Number(this.env.CG_CH_RETURN_TEMP)),
      this.latest(Number(this.env.CG_CH_RETURN_RH)),
      this.latest(Number(this.env.CG_CH_SUPPLY_TEMP)),
    ]);
    return { returnTempF, returnRh, supplyTempF };
  }
}
