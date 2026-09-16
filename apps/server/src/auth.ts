import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Logger, ScrappiaApp } from '@scrappia/core';
import { ApiError } from './errors.js';
import type { AppEnv, AuthInfo } from './types.js';

export interface AuthOptions {
  /** SCRAPPIA_API_KEY: accepted only while no API keys exist in storage. */
  bootstrapKey?: string;
  log: Logger;
  /** Override how the peer address is resolved (tests). Default: @hono/node-server conninfo. */
  remoteAddress?: (c: Context) => string | undefined;
}

export type Scope = 'read' | 'write' | 'admin';
export const SCOPES: Scope[] = ['read', 'write', 'admin'];

const BOOTSTRAP: AuthInfo = { id: 'bootstrap', name: 'SCRAPPIA_API_KEY', scopes: ['read', 'write', 'admin'], kind: 'bootstrap' };
const LOOPBACK: AuthInfo = { id: 'loopback', name: 'loopback', scopes: ['read', 'write', 'admin'], kind: 'loopback' };

export function extractKey(c: Context): string | undefined {
  const auth = c.req.header('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const x = c.req.header('x-api-key');
  return x?.trim() || undefined;
}

export function hasScope(auth: AuthInfo, required: Scope): boolean {
  return auth.scopes.includes(required) || auth.scopes.includes('admin') || auth.scopes.includes('*');
}

export function requiredScope(method: string): Scope {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write';
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  return a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

function defaultRemoteAddress(c: Context): string | undefined {
  try { return getConnInfo(c).remote.address; } catch { return undefined; }
}

/**
 * API key authentication + scope enforcement.
 *  - `Authorization: Bearer <key>` or `x-api-key: <key>`, verified against storage (sha256 hashes).
 *  - Bootstrap: while storage holds no keys, SCRAPPIA_API_KEY is accepted (warning logged once).
 *  - Neither configured: unauthenticated requests are accepted from loopback only (warning logged once).
 *  - Scopes: `read` for GET/HEAD, `write` for everything else; `admin` implies both.
 */
export function authMiddleware(app: ScrappiaApp, opts: AuthOptions): MiddlewareHandler<AppEnv> {
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string, data?: Record<string, unknown>) => { if (!warned.has(key)) { warned.add(key); opts.log.warn(msg, data); } };
  const remote = opts.remoteAddress ?? defaultRemoteAddress;
  const keysExist = () => app.storage.listApiKeys().length > 0;

  return async (c, next) => {
    const key = extractKey(c);
    let auth: AuthInfo | undefined;

    if (key) {
      const found = app.verifyApiKey(key);
      if (found) auth = { id: found.id, name: found.name, scopes: found.scopes, kind: 'key' };
      else if (opts.bootstrapKey && safeEqual(key, opts.bootstrapKey)) {
        if (keysExist()) {
          warnOnce('bootstrap-disabled', 'bootstrap SCRAPPIA_API_KEY rejected: API keys exist in storage, use one of them');
          throw new ApiError(401, 'unauthorized', 'Bootstrap key is disabled because API keys exist; use a stored API key');
        }
        warnOnce('bootstrap', 'authenticated with bootstrap SCRAPPIA_API_KEY; create a real key with POST /api/api-keys');
        auth = BOOTSTRAP;
      } else throw new ApiError(401, 'unauthorized', 'Invalid API key');
    } else if (!opts.bootstrapKey && !keysExist()) {
      const addr = c.req.header('x-forwarded-for') ? undefined : remote(c);
      if (!isLoopbackAddress(addr)) throw new ApiError(401, 'unauthorized', 'No API key configured; only loopback requests are accepted without a key');
      warnOnce('no-key', 'no API key configured: accepting unauthenticated requests from loopback only. Set SCRAPPIA_API_KEY or create a key with POST /api/api-keys');
      auth = LOOPBACK;
    } else {
      throw new ApiError(401, 'unauthorized', 'Missing API key (use "Authorization: Bearer <key>" or "x-api-key")');
    }

    const scope = requiredScope(c.req.method);
    if (!hasScope(auth, scope)) throw new ApiError(403, 'forbidden', `API key "${auth.name}" lacks the "${scope}" scope`);
    c.set('auth', auth);
    await next();
  };
}
