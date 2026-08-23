/**
 * ConstantGraph Data API client (https://api.constantgraph.com).
 *
 * Three endpoints matter here: /data/timedata for backfill with real
 * timestamps, /data/data for a current-timestamp sample, and /data/config for
 * channel metadata. All three share the same auth header, the same envelope,
 * and the same quirk: failures are reported in the response body, not the
 * HTTP status.
 */

import type { Env } from '../config';
import { settingsFrom } from '../config';

const BASE_URL = 'https://api.constantgraph.com';

/** Payload schema version the API expects alongside `app`. */
export const CG_PAYLOAD_VERSION = '1.0.0';

const TIMEOUT_MS = 10_000;

/** Two retries. Length of this array is what ends the retry loop. */
const RETRY_DELAYS_MS = [1000, 3000];

export interface CgChannelValues {
  id: number;
  values: Array<{ t: number; v: number }>;
}

export interface CgResult {
  status: string;
  inserted?: number;
  ignored?: number;
  message?: string;
  error_code?: string;
}

export class ConstantGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'ConstantGraphError';
  }
}

export class ConstantGraphClient {
  private readonly apiKey: string;
  private readonly appName: string;

  constructor(env: Env) {
    this.apiKey = env.CG_API_KEY;
    this.appName = settingsFrom(env).appName;
  }

  /**
   * Historical values with explicit timestamps (premium tier).
   * The API caps a single call at 50,000 points per channel.
   */
  async postTimeData(channels: CgChannelValues[]): Promise<CgResult> {
    return this.post('/data/timedata', {
      app: this.appName,
      version: CG_PAYLOAD_VERSION,
      channels,
    });
  }

  /** Single sample per channel, stamped by the server at receipt. */
  async postCurrentData(
    channels: Array<{ id: number; v: number; Name?: string }>,
  ): Promise<CgResult> {
    return this.post('/data/data', {
      app: this.appName,
      version: CG_PAYLOAD_VERSION,
      channels,
    });
  }

  /** Channel/graph/device metadata. Sections are merged, not replaced. */
  async postConfig(config: {
    Variables?: unknown[];
    Graphs?: unknown[];
    Devices?: unknown[];
  }): Promise<CgResult> {
    // No app/version here. The general error section says every request needs
    // them, but the config examples omit them -- and sending them produced a
    // wrapped InvalidSession/"user not found" from the server even with a key
    // that /data/timedata accepts. The examples are authoritative for config.
    return this.post('/data/config', config);
  }

  private async post(path: string, body: unknown): Promise<CgResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postOnce(path, body);
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isRetryable(err)) throw err;
        await sleep(delay);
      }
    }
  }

  private async postOnce(path: string, body: unknown): Promise<CgResult> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Transport failure, or the 10 s timeout firing. Status 0 means the
      // request never reached the API, which is not one of the retryable cases.
      throw new ConstantGraphError(`ConstantGraph ${path} unreachable: ${String(err)}`, 0);
    }

    const text = await res.text();
    const result = parseResult(text);

    // A 200 proves nothing on its own: this API reports failures in the body,
    // setting error_code and a status other than 'success' while still
    // returning HTTP 200. The body is the source of truth, so check it too.
    if (!res.ok || !result || result.error_code || result.status !== 'success') {
      throw new ConstantGraphError(
        `ConstantGraph ${path} failed: ${result?.message ?? text.slice(0, 200)}`,
        res.status,
        result?.error_code,
      );
    }

    return result;
  }
}

/** Only transient server-side conditions are worth a second attempt. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof ConstantGraphError)) return false;
  return err.status === 429 || err.status >= 500 || err.errorCode === 'RateLimit';
}

function parseResult(text: string): CgResult | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CgResult) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
