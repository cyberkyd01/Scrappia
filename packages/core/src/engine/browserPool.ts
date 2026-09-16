import type { EngineConfig } from '../recipe/schema.js';
import { PlaywrightProvider, type BrowserHandle, type BrowserProvider, type Page } from '../browser/provider.js';
import { ProxyPool } from '../fetch/proxies.js';
import { Logger } from '../util/logger.js';

/**
 * Lazily launches browser contexts. With a persistent profile only one context can exist,
 * so all workers share it; otherwise each worker slot gets its own context (own proxy).
 */
export class BrowserPool {
  private handles = new Map<string, Promise<BrowserHandle>>();
  private launched = 0;

  constructor(
    private engine: EngineConfig,
    private proxies: ProxyPool,
    private log: Logger,
    private opts: { provider?: BrowserProvider; profilesDir?: string; headless?: boolean; initScript?: string } = {},
  ) {}

  get count() { return this.launched; }

  private provider(): BrowserProvider {
    return this.opts.provider ?? new PlaywrightProvider(this.engine.browser);
  }

  private key(sessionId: string): string { return this.engine.session.persist ? 'persistent' : sessionId; }

  async handle(sessionId: string): Promise<BrowserHandle> {
    const key = this.key(sessionId);
    let h = this.handles.get(key);
    if (!h) {
      const proxy = this.proxies.acquire(sessionId);
      const proxyUrl = proxy ? ProxyPool.materialize(proxy.url, sessionId) : undefined;
      this.log.info('launching browser context', { session: key, proxy: !!proxyUrl, headless: this.opts.headless ?? this.engine.headless });
      h = this.provider().launch({ engine: this.engine, proxyUrl, profilesDir: this.opts.profilesDir, headless: this.opts.headless, initScript: this.opts.initScript });
      this.handles.set(key, h);
      this.launched++;
      h.catch(() => this.handles.delete(key));
    }
    return h;
  }

  async page(sessionId: string): Promise<Page> {
    const h = await this.handle(sessionId);
    return h.newPage();
  }

  /** Drop a context (e.g. after repeated blocks) so the next request gets a fresh one with a new proxy. */
  async recycle(sessionId: string) {
    const key = this.key(sessionId);
    const h = this.handles.get(key);
    this.handles.delete(key);
    this.proxies.rotateSession(sessionId);
    if (h) { try { await (await h).close(); } catch { /* ignore */ } }
  }

  async closeAll() {
    const all = Array.from(this.handles.values());
    this.handles.clear();
    await Promise.all(all.map(async (h) => { try { await (await h).close(); } catch { /* ignore */ } }));
  }
}
