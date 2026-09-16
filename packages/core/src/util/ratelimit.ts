import { sleep } from './misc.js';

/**
 * Per-key concurrency + minimum spacing limiter (e.g. per host).
 * Not a token bucket by design: scraping wants "at most N in flight and at least D ms apart".
 */
export class KeyedLimiter {
  private inFlight = new Map<string, number>();
  private lastStart = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  private penalties = new Map<string, number>(); // key -> not-before timestamp

  constructor(private maxConcurrent: number, private minSpacingMs: number, private jitterMs = 0) {}

  /** Tell the limiter a host asked us to slow down (429 / Retry-After). */
  penalize(key: string, ms: number) {
    const until = Date.now() + ms;
    this.penalties.set(key, Math.max(this.penalties.get(key) ?? 0, until));
  }

  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    // wait for a concurrency slot
    while ((this.inFlight.get(key) ?? 0) >= this.maxConcurrent) {
      if (signal?.aborted) throw new Error('aborted');
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(key) ?? [];
        list.push(resolve);
        this.waiters.set(key, list);
      });
    }
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    // enforce spacing and penalties
    const now = Date.now();
    const notBefore = Math.max(
      (this.lastStart.get(key) ?? 0) + this.minSpacingMs + Math.random() * this.jitterMs,
      this.penalties.get(key) ?? 0,
    );
    if (notBefore > now) await sleep(notBefore - now, signal);
    this.lastStart.set(key, Date.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(key, Math.max(0, (this.inFlight.get(key) ?? 1) - 1));
      const next = this.waiters.get(key)?.shift();
      next?.();
    };
  }
}

/** Simple global concurrency pool. */
export class Pool {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(public size: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  get pending() { return this.queue.length; }
  get running() { return this.active; }
}
