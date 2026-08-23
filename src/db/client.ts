/**
 * Turso (libSQL) connection factory.
 *
 * The `/web` entrypoint is the HTTP-only build: no node:net, no TCP, so it runs
 * inside a Worker. Every execute() is therefore an outbound HTTP subrequest,
 * and Workers' free tier allows 50 per invocation -- which is why writes below
 * go through batch(), sending many statements in a single round trip.
 */

import { createClient, type Client } from '@libsql/client/web';
import type { Env } from '../config';

export type Db = Client;

export function createDb(env: Env): Db {
  if (!env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is not set');
  }
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}
