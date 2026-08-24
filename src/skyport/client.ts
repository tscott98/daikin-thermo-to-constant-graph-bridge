/**
 * Daikin Skyport client.
 *
 * The account password is never stored anywhere. A refresh token is minted once
 * locally (scripts/get-refresh-token.sh) and kept as a Worker secret; this
 * exchanges it for short-lived access tokens.
 *
 * Refresh tokens may rotate. The live token therefore lives in kv_state, with
 * the secret acting only as the bootstrap value: read from the database first,
 * fall back to the secret, and persist any new token the API returns. That
 * works whether or not Daikin actually rotates them.
 */

import type { Env } from '../config';
import type { Db } from '../db/client';
import { kvGet, kvSet } from '../db/repo';
import type { SkyportDeviceData, SkyportTokenResponse } from './types';
import { SkyportError } from './types';

const BASE = 'https://api.daikinskyport.com';
const ACCESS_KEY = 'skyport:access';
const REFRESH_KEY = 'skyport:refresh';
const TIMEOUT_MS = 10_000;

const nowSec = () => Math.floor(Date.now() / 1000);

export class SkyportClient {
  constructor(
    private readonly env: Env,
    private readonly db: Db,
  ) {}

  /** Device data for one thermostat. Ids match the integrator API's device ids. */
  async getDeviceData(deviceId: string): Promise<SkyportDeviceData> {
    const token = await this.accessToken();
    const res = await this.get(`/deviceData/${encodeURIComponent(deviceId)}`, token);

    if (res.status === 401) {
      // Access token rejected: drop it, re-derive once, retry once. A second
      // 401 means the refresh token itself is dead and needs human action.
      await kvSet(this.db, ACCESS_KEY, '', nowSec() - 1);
      const retry = await this.get(
        `/deviceData/${encodeURIComponent(deviceId)}`,
        await this.accessToken(),
      );
      return this.json<SkyportDeviceData>(retry);
    }
    return this.json<SkyportDeviceData>(res);
  }

  private async accessToken(): Promise<string> {
    const cached = await kvGet(this.db, ACCESS_KEY);
    if (cached) return cached;

    const refresh = (await kvGet(this.db, REFRESH_KEY)) ?? this.env.DAIKIN_SKYPORT_REFRESH_TOKEN;
    if (!refresh) throw new SkyportError('no Skyport refresh token available', 0);

    const res = await fetch(`${BASE}/users/auth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.env.DAIKIN_SKYPORT_EMAIL || this.env.DAIKIN_EMAIL,
        refreshToken: refresh,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await this.json<SkyportTokenResponse>(res);
    if (!body.accessToken) throw new SkyportError('no accessToken in refresh response', res.status);

    // 60s safety margin, matching the integrator client.
    const ttl = Number(body.accessTokenExpiresIn) || 3600;
    await kvSet(this.db, ACCESS_KEY, body.accessToken, nowSec() + ttl - 60);

    // Persist a rotated refresh token so the next run uses the live one.
    if (body.refreshToken && body.refreshToken !== refresh) {
      await kvSet(this.db, REFRESH_KEY, body.refreshToken);
    }
    return body.accessToken;
  }

  private get(path: string, token: string): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** Never include the response body in errors: it can contain tokens. */
  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new SkyportError(`Skyport ${res.status} for ${res.url}`, res.status);
    try {
      return (await res.json()) as T;
    } catch {
      throw new SkyportError('Skyport response was not JSON', res.status);
    }
  }
}
