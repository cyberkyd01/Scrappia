/**
 * Scrappia server entry point: REST API + scheduler running the core engine headlessly.
 *
 * Environment:
 *   PORT                 listen port (default 8788)
 *   HOST                 bind address (default 0.0.0.0)
 *   SCRAPPIA_HOME        data directory (SQLite db, exports, browser profiles); default ~/.scrappia
 *   SCRAPPIA_API_KEY     bootstrap API key, accepted only while no keys exist in storage
 *   SCRAPPIA_CORS        allowed origins ('*' or comma-separated); unset = no CORS headers
 *   SCRAPPIA_RATE_LIMIT  requests per minute per key (default 600, 0 = off)
 *   SCRAPPIA_LOG_JSON=1  emit core log entries as JSON lines
 *   SCRAPPIA_LOG_LEVEL   debug | info | warn | error (default info)
 *   SCRAPPIA_NO_SCHEDULER=1  do not start the cron scheduler in this process
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ScrappiaApp, rootLogger, type LogEntry } from '@scrappia/core';
import { createServer } from './server.js';
import { serverVersion, sleep } from './util.js';

export { createServer, type ServerOptions, type ScrappiaServer } from './server.js';
export type { AuthInfo, AppEnv } from './types.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

function attachLogOutput(json: boolean) {
  const write = (level: LogEntry['level'], line: string) => {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  rootLogger.on((e) => {
    if (json) { write(e.level, JSON.stringify({ time: new Date(e.time).toISOString(), level: e.level, scope: e.scope, msg: e.msg, data: e.data })); return; }
    const data = e.data ? ' ' + safeJson(e.data) : '';
    write(e.level, `[${new Date(e.time).toISOString()}] ${e.level.toUpperCase().padEnd(5)} ${e.scope ? `(${e.scope}) ` : ''}${e.msg}${data}`);
  });
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function main() {
  const env = process.env;
  const port = Number(env.PORT ?? 8788);
  const host = env.HOST ?? '0.0.0.0';
  const jsonLogs = env.SCRAPPIA_LOG_JSON === '1';
  attachLogOutput(jsonLogs);
  const log = rootLogger.child('server');

  const app = new ScrappiaApp({ dataDir: env.SCRAPPIA_HOME });
  const version = serverVersion();
  const hono = createServer(app, {
    bootstrapKey: env.SCRAPPIA_API_KEY || undefined,
    cors: env.SCRAPPIA_CORS || undefined,
    rateLimitPerMinute: env.SCRAPPIA_RATE_LIMIT !== undefined ? Number(env.SCRAPPIA_RATE_LIMIT) : undefined,
    version,
  });

  if (env.SCRAPPIA_NO_SCHEDULER !== '1') app.scheduler.start();
  else log.info('scheduler disabled (SCRAPPIA_NO_SCHEDULER=1)');

  const server = serve({ fetch: hono.fetch, port, hostname: host }, (info) => {
    log.info('scrappia server listening', { url: `http://${info.address}:${info.port}`, version, dataDir: app.dataDir, docs: '/docs' });
    if (!env.SCRAPPIA_API_KEY && app.storage.listApiKeys().length === 0) {
      log.warn('no API key configured: only loopback requests will be accepted. Set SCRAPPIA_API_KEY or create a key with POST /api/api-keys');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) { log.warn('forced exit', { signal }); process.exit(1); }
    shuttingDown = true;
    const active = app.activeRuns();
    log.info('shutting down', { signal, activeRuns: active.length });
    server.close();
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    for (const a of active) app.cancelRun(a.run.id);
    if (active.length) await Promise.race([Promise.allSettled(active.map((a) => a.promise)), sleep(SHUTDOWN_TIMEOUT_MS)]);
    try { app.close(); } catch (e) { log.error('error closing app', { error: (e as Error).message }); }
    log.info('bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (r) => log.error('unhandled rejection', { error: r instanceof Error ? r.stack ?? r.message : String(r) }));

  return { app, hono, server };
}

const isMain = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) main();
