import type { EngineConfig } from '../recipe/schema.js';

export interface ProxyEntry { url: string; errors: number; retired: boolean; lastUsed: number; uses: number }

/**
 * Proxy pool with sticky sessions and error-based retirement.
 * Providers' sticky-session conventions (session id in username) are supported by
 * expanding `{session}` in the URL, e.g. http://user-session-{session}:pass@gw:port.
 */
export class ProxyPool {
  private entries: ProxyEntry[];
  private sessions = new Map<string, ProxyEntry>();
  private cursor = 0;

  constructor(urls: string[], private opts: { rotate: EngineConfig['proxy']['rotate']; maxErrors: number } = { rotate: 'session', maxErrors: 3 }) {
    this.entries = urls.map((url) => ({ url, errors: 0, retired: false, lastUsed: 0, uses: 0 }));
  }

  get size() { return this.entries.filter((e) => !e.retired).length; }
  get enabled() { return this.entries.length > 0 && this.opts.rotate !== 'none' ? true : this.entries.length > 0; }

  /** Get a proxy for a session (sticky) or the next one (per request). */
  acquire(sessionId: string): ProxyEntry | undefined {
    if (!this.entries.length) return undefined;
    if (this.opts.rotate === 'none') return this.entries[0];
    if (this.opts.rotate === 'session') {
      const cur = this.sessions.get(sessionId);
      if (cur && !cur.retired) return cur;
    }
    const alive = this.entries.filter((e) => !e.retired);
    if (!alive.length) {
      // all retired: forgive the least-bad one so we keep going
      const best = [...this.entries].sort((a, b) => a.errors - b.errors)[0];
      best.retired = false; best.errors = 0;
      alive.push(best);
    }
    const entry = alive[this.cursor++ % alive.length];
    entry.lastUsed = Date.now(); entry.uses++;
    if (this.opts.rotate === 'session') this.sessions.set(sessionId, entry);
    return entry;
  }

  /** Expand provider session tokens; returns the concrete URL to use. */
  static materialize(url: string, sessionId: string): string {
    return url.replace(/\{session\}/g, sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16));
  }

  reportError(entry: ProxyEntry) {
    entry.errors++;
    if (entry.errors >= this.opts.maxErrors) {
      entry.retired = true;
      for (const [sid, e] of this.sessions) if (e === entry) this.sessions.delete(sid);
    }
  }

  reportSuccess(entry: ProxyEntry) { entry.errors = 0; }

  /** Drop the sticky binding so the next acquire rotates. */
  rotateSession(sessionId: string) { this.sessions.delete(sessionId); }

  snapshot() { return this.entries.map((e) => ({ ...e, url: redact(e.url) })); }
}

export function redact(url: string): string {
  try { const u = new URL(url); if (u.password) u.password = '***'; return u.toString(); } catch { return url; }
}
