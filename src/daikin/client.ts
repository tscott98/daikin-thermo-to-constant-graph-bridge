/**
 * Daikin One Open API client.
 *
 * Two API rules shape this module: never poll faster than once per three
 * minutes, and never keep more than three HTTP requests open at once. Both are
 * satisfied by making every call here strictly sequential and by caching the
 * two things that rarely change - the access token and the device list - in
 * kv_state, so a five-minute cron run costs one request per thermostat.
 */

import type { Env } from '../config';
import { kvGet, kvSet } from '../db/repo';
import type { Db } from '../db/client';
import { DaikinError } from './types';
import type { DeviceDetail, DeviceSummary, TokenResponse } from './types';

const BASE_URL = 'https://integrator-api.daikinskyport.com';

const TOKEN_KEY = 'daikin:token';
const DEVICES_KEY = 'daikin:devices';

/** Expire the cached token early so it cannot lapse mid-request. */
const TOKEN_MARGIN_SEC = 60;
const DEVICES_TTL_SEC = 24 * 60 * 60;

const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 500;

/** One initial attempt plus these delays, applied only to 429 and 5xx. */
const RETRY_DELAYS_MS = [1000, 3000];

const nowSec = (): number => Math.floor(Date.now() / 1000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DaikinClient {
  constructor(
    private readonly env: Env,
    private readonly db: Db,
  ) {}

  /**
   * The thermostat inventory, cached for 24 hours. Callers loop over the result
   * and call getDevice() one at a time; the API allows only three concurrent
   * requests, so this file never fans out with Promise.all.
   */
  async getDevices(forceRefresh = false): Promise<DeviceSummary[]> {
    if (!forceRefresh) {
      const cached = await kvGet(this.db, DEVICES_KEY);
      const devices = cached === null ? null : parseCachedDevices(cached);
      if (devices !== null) return devices;
    }

    const devices = normalizeDevices(await this.getJson('/v1/devices'));
    await kvSet(
      this.db,
      DEVICES_KEY,
      JSON.stringify(devices),
      nowSec() + DEVICES_TTL_SEC,
    );
    return devices;
  }

  async getDevice(id: string): Promise<DeviceDetail> {
    const detail = await this.getJson(`/v1/devices/${encodeURIComponent(id)}`);
    return detail as DeviceDetail;
  }

  /**
   * Authenticated GET. A 401 means the cached token died early - the API can
   * revoke ahead of accessTokenExpiresIn - so it is discarded and the request
   * is replayed once. The replay gets no second chance, which is what bounds
   * the recursion.
   */
  private async getJson(path: string): Promise<unknown> {
    let res = await this.send(path, await this.accessToken());

    if (res.status === 401) {
      await this.discardToken();
      res = await this.send(path, await this.accessToken());
    }

    if (!res.ok) throw await errorFrom(res, `GET ${path}`);
    return res.json();
  }

  private send(path: string, token: string): Promise<Response> {
    return fetchWithRetry(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { ...this.baseHeaders(), Authorization: `Bearer ${token}` },
    });
  }

  private async accessToken(): Promise<string> {
    const cached = await kvGet(this.db, TOKEN_KEY);
    if (cached !== null && cached !== '') return cached;

    const res = await fetchWithRetry(`${BASE_URL}/v1/token`, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify({
        email: this.env.DAIKIN_EMAIL,
        integratorToken: this.env.DAIKIN_INTEGRATOR_TOKEN,
      }),
    });

    if (!res.ok) throw await errorFrom(res, 'POST /v1/token');

    const token = (await res.json()) as TokenResponse;
    await kvSet(
      this.db,
      TOKEN_KEY,
      token.accessToken,
      nowSec() + token.accessTokenExpiresIn - TOKEN_MARGIN_SEC,
    );
    return token.accessToken;
  }

  /** Backdating the expiry is enough: kvGet treats an elapsed row as a miss. */
  private discardToken(): Promise<void> {
    return kvSet(this.db, TOKEN_KEY, '', nowSec() - 1);
  }

  private baseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.env.DAIKIN_API_KEY,
    };
  }
}

/**
 * Retry 429 and 5xx only. Every other 4xx is a fault in the request itself -
 * bad token, wrong api key, wrong content type - and repeating it only burns
 * rate limit.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let res = await fetchOnce(url, init);

  for (const fallbackDelay of RETRY_DELAYS_MS) {
    if (!isRetryable(res.status)) return res;
    await sleep(retryAfterMs(res) ?? fallbackDelay);
    res = await fetchOnce(url, init);
  }

  return res;
}

function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

const isRetryable = (status: number): boolean => status === 429 || status >= 500;

/** Honor Retry-After only when it is short; a long hint outlives the Worker. */
function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) return undefined;
  return seconds * 1000;
}

async function errorFrom(res: Response, what: string): Promise<DaikinError> {
  const body = await res.text().catch(() => '');
  return new DaikinError(
    `${what} failed: ${res.status} ${res.statusText}`.trim(),
    res.status,
    body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}...` : body,
  );
}

// --- device list normalization ---

/** Bounds the walk so a cyclic or absurdly nested payload cannot spin. */
const MAX_DEPTH = 6;

/**
 * GET /v1/devices is documented as "locations with their thermostats", but the
 * published examples disagree on whether the response is a bare array, an array
 * of locations each holding a `devices` array, or an object wrapping either
 * under `locations` / `devices`. Rather than bet on one shape and break on a
 * silent API change, walk whatever arrives, keep the entries carrying an id,
 * and inherit locationName from whichever container they were found in.
 */
export function normalizeDevices(payload: unknown): DeviceSummary[] {
  const out: DeviceSummary[] = [];
  collect(payload, undefined, out, 0);
  return out;
}

function collect(
  node: unknown,
  locationName: string | undefined,
  out: DeviceSummary[],
  depth: number,
): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const entry of node) collect(entry, locationName, out, depth + 1);
    return;
  }

  const obj = node as Record<string, unknown>;
  const here = str(obj.locationName) ?? locationName;
  let isContainer = false;

  if (Array.isArray(obj.locations)) {
    collect(obj.locations, here, out, depth + 1);
    isContainer = true;
  }
  if (Array.isArray(obj.devices)) {
    collect(obj.devices, here, out, depth + 1);
    isContainer = true;
  }

  if (!isContainer) pushDevice(obj, here, out);
}

function pushDevice(
  obj: Record<string, unknown>,
  locationName: string | undefined,
  out: DeviceSummary[],
): void {
  const id = str(obj.id);
  if (id === undefined) return; // nothing addressable, so nothing to poll

  out.push({
    id,
    name: str(obj.name),
    model: str(obj.model),
    firmwareVersion: str(obj.firmwareVersion),
    locationName,
  });
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/** A corrupt cache entry is treated as a miss rather than an error. */
function parseCachedDevices(raw: string): DeviceSummary[] | null {
  try {
    return normalizeDevices(JSON.parse(raw));
  } catch {
    return null;
  }
}
