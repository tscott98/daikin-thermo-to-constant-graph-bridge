/**
 * Types for the Daikin Skyport consumer API (api.daikinskyport.com).
 *
 * This is the API the phone app uses. It is undocumented and unsanctioned, and
 * can change without notice, so it is a supplementary source only: the
 * integrator API remains the system of record and this must never be able to
 * break it.
 *
 * Encoding conventions differ from the integrator API in ways that bite:
 *   - Percentages are 0-200 in 0.5% steps. Divide by 2.
 *   - ctOutdoorPower is deciwatts. Multiply by 10 for Watts.
 *   - ctOutdoorAirTemperature is tenths of Fahrenheit, while every other
 *     temperature in both APIs is Celsius.
 *   - Times are 15-minute units from midnight (1 = 00:15).
 */

export interface SkyportTokenResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken?: string;
  tokenType: string;
}

/** The response carries ~900 fields; only the ones we store are typed. */
export interface SkyportDeviceData {
  [key: string]: unknown;
}

export class SkyportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SkyportError';
  }
}

/**
 * Not-applicable markers, not values.
 *
 * A ONETOUCH probe returned 255 for air-handler fields it has no hardware for,
 * 32767 (int16 max) for unavailable temperatures, 65535 and 4294967295 for
 * unavailable airflow and runtime counters. Stored as NULL: 255 through a
 * half-percent conversion would otherwise become a confident 127.5%.
 */
export const SENTINELS = new Set([255, 32767, 65535, 4294967295, -32768]);

function usable(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return SENTINELS.has(v) ? null : v;
}

/** Store the wire value unchanged. */
export function plain(v: unknown): number | null {
  return usable(v);
}

/** 0-200 in half-percent steps -> 0-100. */
export function halfPercent(v: unknown): number | null {
  const n = usable(v);
  return n === null ? null : Math.round((n / 2) * 10) / 10;
}

/** Deciwatts -> Watts. */
export function deciwatts(v: unknown): number | null {
  const n = usable(v);
  return n === null ? null : n * 10;
}

/** Tenths of Fahrenheit -> Celsius. Unused for now: the fields whose unit is
 * only suspected are stored raw instead. */
export function tenthsFahrenheitToC(v: unknown): number | null {
  const n = usable(v);
  return n === null ? null : Math.round(((n / 10 - 32) * 5 / 9) * 100) / 100;
}
