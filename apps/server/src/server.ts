import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type { Logger, ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from './types.js';
import { errorBody, handleError } from './errors.js';
import { authMiddleware } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { buildOpenApi, docsHtml } from './openapi.js';
import { serverVersion } from './util.js';
import { recipeRoutes } from './routes/recipes.js';
import { runRoutes } from './routes/runs.js';
import { eventRoutes } from './routes/events.js';
import { settingsRoutes } from './routes/settings.js';
import { alertRoutes, scheduleRoutes } from './routes/schedules.js';
import { miscRoutes } from './routes/misc.js';

export interface ServerOptions {
  /** SCRAPPIA_API_KEY: accepted while storage has no API keys. */
  bootstrapKey?: string;
  /** Allowed CORS origins ('*' or a list). Omit to disable CORS headers. */
  cors?: string | string[];
  /** Requests per minute per API key (default 600, 0 disables). */
  rateLimitPerMinute?: number;
  logger?: Logger;
  version?: string;
  /** SSE heartbeat interval (default 15s). */
  heartbeatMs?: number;
  /** Override peer-address lookup for the loopback fallback (tests). */
  remoteAddress?: (c: Context) => string | undefined;
}

/** Build the Hono app. Does not listen; use `@hono/node-server` (see index.ts) or `hono.request()` in tests. */
export function createServer(app: ScrappiaApp, opts: ServerOptions = {}) {
  const hono = new Hono<AppEnv>();
  const log = (opts.logger ?? app.log).child('http');
  const version = opts.version ?? serverVersion();
  const startedAt = Date.now();

  hono.onError((err, c) => handleError(err, c, log));
  hono.notFound((c) => c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}`), 404));

  // Request log line: method, path, status, ms.
  hono.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    const auth = c.get('auth');
    log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms, ...(auth ? { key: auth.name } : {}) });
  });

  if (opts.cors) {
    const origin = opts.cors === '*' ? '*' : Array.isArray(opts.cors) ? opts.cors : opts.cors.split(',').map((s) => s.trim()).filter(Boolean);
    hono.use('/api/*', cors({
      origin, allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'x-api-key'],
      exposeHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-Scrappia-Run', 'X-Scrappia-Run-Status', 'X-Scrappia-Run-Finished', 'Content-Disposition'],
      maxAge: 600,
    }));
  }

  // ---------- public ----------
  hono.get('/health', (c) => c.json({ ok: true, version, uptime: Math.round((Date.now() - startedAt) / 1000), activeRuns: app.activeRuns().length }));
  hono.get('/docs', (c) => c.html(docsHtml('/api/openapi.json')));
  hono.get('/api/openapi.json', (c) => c.json(buildOpenApi({ version })));

  // ---------- protected ----------
  hono.use('/api/*', authMiddleware(app, { bootstrapKey: opts.bootstrapKey, log, remoteAddress: opts.remoteAddress }));
  hono.use('/api/*', rateLimit({ perMinute: opts.rateLimitPerMinute ?? 600 }));

  hono.route('/api', recipeRoutes(app));
  hono.route('/api', runRoutes(app));
  hono.route('/api', eventRoutes(app, { heartbeatMs: opts.heartbeatMs }));
  hono.route('/api', settingsRoutes(app));
  hono.route('/api', scheduleRoutes(app));
  hono.route('/api', alertRoutes(app));
  hono.route('/api', miscRoutes(app));

  return hono;
}

export type ScrappiaServer = ReturnType<typeof createServer>;
