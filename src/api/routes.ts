/**
 * Ops and chart endpoints.
 *
 * Ad-hoc analysis is done by connecting to Turso directly with a libSQL driver,
 * so there is no general-purpose export API here. The routes are the things a
 * SQL client cannot do: check liveness, force a poll, register ConstantGraph
 * config, and serve /api/series for hosted dashboards such as Grafana, which
 * cannot reach Turso themselves.
 */

import type { Env } from '../config';
import { settingsFrom } from '../config';
import { createDb } from '../db/client';
import { getSeries, getStats, listDevices } from '../db/repo';
import { parseSeriesQuery } from './query';
import { ConstantGraphClient } from '../constantgraph/client';
import {
  buildDevicesConfig,
  buildGraphsConfig,
  buildVariablesConfig,
} from '../constantgraph/publish';
import { runCycle } from '../cycle';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Length-invariant comparison. The keys here are not high-value secrets, but
 * an early-exit compare leaks length and prefix for free, so avoid it.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const provided = request.headers.get('X-Api-Key');
  return (
    typeof env.READ_API_KEY === 'string' &&
    env.READ_API_KEY.length > 0 &&
    provided !== null &&
    safeEqual(provided, env.READ_API_KEY)
  );
}

/**
 * All routes run inside one try/catch.
 *
 * Without it, a throw from a downstream client surfaces as Cloudflare's opaque
 * 1101 "Worker threw an exception" page, which hides the very message needed to
 * diagnose it. Surfacing the error as JSON costs nothing and is behind the API
 * key anyway.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env);
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): Response {
  const e = err as { message?: string; name?: string; status?: number; errorCode?: string };
  return json(
    {
      error: e?.message ?? String(err),
      type: e?.name ?? 'Error',
      // ConstantGraphError and DaikinError carry these; they are what actually
      // identify the failure (AccessDenied, BadRequest, InvalidSession, ...).
      upstreamStatus: e?.status,
      errorCode: e?.errorCode,
    },
    500,
  );
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Collapse repeated slashes as well as trailing ones: a client with a
  // trailing-slash base URL joined to a leading-slash path yields '//api/...'.
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

  // Unauthenticated liveness probe. Reports counts and lag, never readings.
  if (path === '/health' && request.method === 'GET') {
    try {
      const db = createDb(env);
      const stats = await getStats(db);
      const nowSec = Math.floor(Date.now() / 1000);
      return json({
        ok: true,
        devices: stats.devices,
        readings: stats.readings,
        unpublished: stats.unpublished,
        newest_ts: stats.newest_ts,
        seconds_since_last_reading: stats.newest_ts === null ? null : nowSec - stats.newest_ts,
      });
    } catch {
      // Unauthenticated route: no error detail, just liveness. Check
      // /api/stats (behind the API key) for diagnostics.
      return json({ ok: false }, 503);
    }
  }

  if (!authorized(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (path === '/api/stats' && request.method === 'GET') {
    const db = createDb(env);
    const [stats, devices] = [await getStats(db), await listDevices(db)];
    const settings = settingsFrom(env);
    return json({
      ...stats,
      dry_run: settings.dryRun,
      poll_interval_min: settings.pollIntervalMin,
      devices_detail: devices.map((d) => ({
        id: d.id,
        name: d.name,
        model: d.model,
        location: d.location_name,
        channel_base: d.channel_base,
        channels: `${d.channel_base}-${d.channel_base + 10}`,
      })),
    });
  }

  if (path === '/admin/poll' && request.method === 'POST') {
    const db = createDb(env);
    try {
      const result = await runCycle(env, db);
      return json(result, result.errors.length > 0 ? 207 : 200);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // GET /api/series -- time-bucketed rows for Grafana's Infinity data source.
  //
  // Grafana sends $__from/$__to as epoch milliseconds and $__interval_ms for the
  // panel's resolution, so both units are accepted and normalised to seconds.
  if (path === '/api/series' && request.method === 'GET') {
    const opts = parseSeriesQuery(url.searchParams, Math.floor(Date.now() / 1000));

    const db = createDb(env);
    const rows = await getSeries(db, opts);

    const out = rows.map((r) => {
      const ts = Number(r['ts']);
      return {
        // Both forms so Infinity can use whichever it parses more happily.
        time: new Date(ts * 1000).toISOString(),
        ts_ms: ts * 1000,
        ...Object.fromEntries(
          Object.entries(r).filter(([k]) => k !== 'ts'),
        ),
      };
    });

    if (opts.csv) {
      const cols = out.length > 0 ? Object.keys(out[0] as object) : [];
      const csv = [
        cols.join(','),
        ...out.map((row) =>
          cols.map((c) => String((row as Record<string, unknown>)[c] ?? '')).join(','),
        ),
      ].join('\n');
      return new Response(csv, {
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      });
    }

    return json(out);
  }

  // POST /admin/config -- forwards a raw JSON body straight to /data/config.
  // Escape hatch for experimenting with ConstantGraph configuration.
  // Can rewrite channel and graph setup, so it sits behind the API key.
  if (path === '/admin/config' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    const cg = new ConstantGraphClient(env);
    try {
      return json({ sent: body, result: await cg.postConfig(body) });
    } catch (err) {
      const e = err as { message?: string; errorCode?: string };
      return json({ sent: body, failed: true, errorCode: e?.errorCode, error: e?.message }, 207);
    }
  }

  // POST /admin/bootstrap[/<sections>[/<limit>]]
  //   /admin/bootstrap                 all three sections
  //   /admin/bootstrap/graphs          graphs only
  //   /admin/bootstrap/graphs/2        graphs only, first 2
  // Path segments rather than query params so nothing needs shell quoting.
  if (path.startsWith('/admin/bootstrap') && request.method === 'POST') {
    const [, , , sectionArg, limitArg] = path.split('/');
    const requested = (sectionArg ?? 'variables,devices,graphs')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const limit = limitArg ? Number(limitArg) : undefined;

    const db = createDb(env);
    const devices = await listDevices(db);
    if (devices.length === 0) {
      return json({ error: 'no devices known yet; run POST /admin/poll first' }, 409);
    }

    const withType = url.searchParams.get('graphStyle') === 'withType';
    const payloads: Array<[string, Record<string, unknown>]> = [];
    if (requested.includes('variables')) {
      payloads.push(['variables', { Variables: buildVariablesConfig(devices) }]);
    }
    if (requested.includes('devices')) {
      payloads.push(['devices', { Devices: buildDevicesConfig(devices) }]);
    }
    if (requested.includes('graphs')) {
      // One call per graph: /data/config accepts a single graph but rejects
      // two in the same request. Each reports its own result.
      const graphs = buildGraphsConfig(devices, { withType, limit }) as Array<{
        Reference?: string;
      }>;
      graphs.forEach((g, i) => {
        payloads.push([`graph:${g.Reference ?? i + 1}`, { Graphs: [g] }]);
      });
    }

    if (settingsFrom(env).dryRun) {
      return json({ dryRun: true, payloads: Object.fromEntries(payloads) });
    }

    // One /data/config call per section. Sending all three in a single request
    // returns a wrapped InvalidSession from ConstantGraph even though each
    // section succeeds on its own, so they are posted separately.
    const cg = new ConstantGraphClient(env);
    const results: Record<string, unknown> = {};
    for (const [name, body] of payloads) {
      try {
        results[name] = await cg.postConfig(body);
      } catch (err) {
        const e = err as { message?: string; errorCode?: string };
        results[name] = { failed: true, errorCode: e?.errorCode, error: e?.message };
      }
    }

    const failed = Object.values(results).some(
      (r) => (r as { failed?: boolean })?.failed === true,
    );
    return json({ sections: requested, results }, failed ? 207 : 200);
  }

  return json({ error: 'not found' }, 404);
}
