/**
 * Worker entry point.
 *
 * scheduled() runs the capture -> publish -> prune cycle every 5 minutes.
 * fetch() serves a small set of ops endpoints; analysis is done by connecting
 * to Turso directly, so there is deliberately no bulk data API here.
 */

import type { Env } from './config';
import { createDb } from './db/client';
import { runCycle } from './cycle';
import { handleRequest } from './api/routes';

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = createDb(env);
    ctx.waitUntil(
      runCycle(env, db)
        .then((result) => {
          if (result.errors.length > 0) {
            console.warn('cycle completed with errors', JSON.stringify(result));
          } else {
            console.log('cycle ok', JSON.stringify(result));
          }
        })
        .catch((err) => {
          console.error('cycle failed', err instanceof Error ? err.stack : String(err));
        }),
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },
};
