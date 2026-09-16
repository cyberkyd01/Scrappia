import type { MiddlewareHandler } from 'hono';
import { errorBody } from './errors.js';
import type { AppEnv } from './types.js';

export interface RateLimitOptions {
  /** Requests per minute per API key (bucket capacity = perMinute). 0 disables. */
  perMinute: number;
  now?: () => number;
}

interface Bucket { tokens: number; updatedAt: number }

/** In-memory token bucket keyed by the authenticated identity. Runs after auth. */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const capacity = Math.max(0, opts.perMinute);
  const perMs = capacity / 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let sinceSweep = 0;

  const sweep = (t: number) => {
    for (const [k, b] of buckets) if (t - b.updatedAt > 5 * 60_000) buckets.delete(k);
  };

  return async (c, next) => {
    if (capacity === 0) return next();
    const id = c.get('auth')?.id ?? 'anonymous';
    const t = now();
    let b = buckets.get(id);
    if (!b) { b = { tokens: capacity, updatedAt: t }; buckets.set(id, b); }
    else { b.tokens = Math.min(capacity, b.tokens + (t - b.updatedAt) * perMs); b.updatedAt = t; }
    if (++sinceSweep >= 1000) { sinceSweep = 0; sweep(t); }

    c.header('X-RateLimit-Limit', String(capacity));
    if (b.tokens < 1) {
      const retryMs = (1 - b.tokens) / perMs;
      const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
      c.header('X-RateLimit-Remaining', '0');
      c.header('Retry-After', String(retrySec));
      return c.json(errorBody('rate_limited', `Rate limit of ${capacity} requests/minute exceeded; retry in ${retrySec}s`), 429);
    }
    b.tokens -= 1;
    c.header('X-RateLimit-Remaining', String(Math.floor(b.tokens)));
    await next();
  };
}
