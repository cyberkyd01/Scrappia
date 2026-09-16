/**
 * Browser provider: wraps patchright (stealth Playwright fork) or plain Playwright behind one interface.
 * Both expose the Playwright API, so the engine only depends on the Playwright types.
 */
import type { Browser, BrowserContext, Page, LaunchOptions, BrowserContextOptions } from 'patchright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineConfig } from '../recipe/schema.js';
import { rootLogger } from '../util/logger.js';

export type { Browser, BrowserContext, Page, Frame, Locator, ElementHandle } from 'patchright';

export interface BrowserProviderOptions {
  engine: EngineConfig;
  headless?: boolean;
  /** Root directory for persistent profiles. */
  profilesDir?: string;
  proxyUrl?: string;
  /** Script injected into every page (inspector overlay in recording mode). */
  initScript?: string;
  /** Extra Chromium args. */
  args?: string[];
}

export interface BrowserProvider {
  readonly name: string;
  launch(opts: BrowserProviderOptions): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  context: BrowserContext;
  browser?: Browser;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

const log = rootLogger.child('browser');

async function loadDriver(kind: 'patchright' | 'playwright') {
  if (kind === 'playwright') {
    try {
      const mod = await import('playwright' as string);
      return mod as typeof import('patchright');
    } catch {
      log.warn('playwright not installed; falling back to patchright');
    }
  }
  return import('patchright');
}

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--password-store=basic',
  '--use-mock-keychain',
];

export class PlaywrightProvider implements BrowserProvider {
  constructor(public readonly kind: 'patchright' | 'playwright' = 'patchright') {}
  get name() { return this.kind; }

  async launch(opts: BrowserProviderOptions): Promise<BrowserHandle> {
    const pw = await loadDriver(this.kind);
    const e = opts.engine;
    const headless = opts.headless ?? e.headless;
    const args = [...(e.stealth ? STEALTH_ARGS : []), ...(opts.args ?? [])];
    const launchOptions: LaunchOptions = {
      headless,
      args,
      // full Chromium (new headless) instead of headless-shell: closer to a real browser fingerprint
      channel: e.channel ?? (headless ? 'chromium' : undefined),
      proxy: opts.proxyUrl ? parseProxy(opts.proxyUrl) : undefined,
      ignoreDefaultArgs: e.stealth ? ['--enable-automation'] : undefined,
    };
    const contextOptions: BrowserContextOptions = {
      viewport: e.viewport ?? { width: 1366, height: 768 },
      userAgent: e.userAgent,
      locale: e.locale ?? 'en-US',
      timezoneId: e.timezone,
      extraHTTPHeaders: Object.keys(e.headers).length ? e.headers : undefined,
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      bypassCSP: false,
      serviceWorkers: 'block',
    };

    let context: BrowserContext;
    let browser: Browser | undefined;
    if (e.session.persist) {
      const dir = join(opts.profilesDir ?? join(process.cwd(), '.scrappia', 'profiles'), safe(e.session.profile));
      mkdirSync(dir, { recursive: true });
      log.debug('launching persistent context', { dir, headless, driver: this.kind });
      context = await pw.chromium.launchPersistentContext(dir, { ...launchOptions, ...contextOptions });
    } else {
      log.debug('launching browser', { headless, driver: this.kind });
      browser = await pw.chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }
    context.setDefaultTimeout(e.timeoutMs);
    context.setDefaultNavigationTimeout(e.timeoutMs);

    if (e.cookies.length) {
      await context.addCookies(e.cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? '', path: c.path ?? '/' })).filter((c) => c.domain));
    }
    if (e.stealth && e.fingerprint) await context.addInitScript(FINGERPRINT_SCRIPT);
    if (opts.initScript) await context.addInitScript(opts.initScript);

    if (e.blockResources.length || e.blockUrlPatterns.length) {
      const blocked = new Set(e.blockResources);
      const patterns = e.blockUrlPatterns.map((p) => new RegExp(p));
      await context.route('**/*', (route) => {
        const req = route.request();
        const type = req.resourceType() as EngineConfig['blockResources'][number];
        if (blocked.has(type) || patterns.some((re) => re.test(req.url()))) return route.abort();
        return route.continue();
      });
    }

    return {
      context,
      browser,
      newPage: () => context.newPage(),
      close: async () => {
        try { await context.close(); } catch { /* ignore */ }
        try { await browser?.close(); } catch { /* ignore */ }
      },
    };
  }
}

function safe(s: string) { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }

export function parseProxy(url: string): { server: string; username?: string; password?: string } {
  const u = new URL(url);
  return { server: `${u.protocol}//${u.host}`, username: u.username ? decodeURIComponent(u.username) : undefined, password: u.password ? decodeURIComponent(u.password) : undefined };
}

/**
 * Light fingerprint consistency script. Patchright already hides the CDP/automation leaks;
 * this fills in the commonly-checked navigator gaps for the headless full-Chromium build.
 */
const FINGERPRINT_SCRIPT = `(() => {
  try {
    if (navigator.webdriver) Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!navigator.languages || !navigator.languages.length) Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const mk = (n, f, d) => ({ name: n, filename: f, description: d, length: 1 });
      const plugins = [mk('PDF Viewer','internal-pdf-viewer','Portable Document Format'), mk('Chrome PDF Viewer','internal-pdf-viewer','Portable Document Format'), mk('Chromium PDF Viewer','internal-pdf-viewer','Portable Document Format')];
      Object.defineProperty(navigator, 'plugins', { get: () => plugins });
    }
    if (window.chrome === undefined) window.chrome = { runtime: {}, loadTimes() {}, csi() {}, app: {} };
    const q = window.navigator.permissions && window.navigator.permissions.query;
    if (q) window.navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q.call(window.navigator.permissions, p));
    if (screen && (screen.width < 800 || screen.height < 600)) { /* leave */ }
  } catch (e) {}
})();`;
