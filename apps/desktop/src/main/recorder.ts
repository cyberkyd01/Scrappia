/**
 * RecorderSession: owns the headed patchright Chromium used by the visual recorder.
 * The inspector overlay is injected into every page (initScript) and talks back through the
 * `__scrappiaHost` binding; the session forwards those messages to the renderer and drives the
 * overlay's `window.__scrappiaInspector` API from the host side.
 */
import { join } from 'node:path';
import {
  PlaywrightProvider, EngineConfig as EngineConfigSchema, Template as TemplateSchema, Action as ActionSchema,
  buildSpec, domExtract, runActions, INSPECTOR_BINDING, INSPECTOR_GLOBAL,
  type BrowserHandle, type Page, type OverlayMessage, type InspectorMode, type SelectorCandidate, type PickedElement, type DetectedList,
  type Template, type Action, type DomExtractResult, type DomExtractSpec,
} from '@scrappia/core';
import type { RecorderStatus, PreviewResult } from '../shared/ipc';
import { loadInspectorBundle } from './inspector';

export interface RecorderOptions {
  profilesDir: string;
  /** Where to place the browser window (next to the Electron window). */
  anchor: () => { x: number; y: number; width: number; height: number } | undefined;
  onMessage: (msg: OverlayMessage) => void;
  onStatus: (s: RecorderStatus) => void;
}

const BROWSER_W = 1200;
const BROWSER_H = 900;

export class RecorderSession {
  private handle?: BrowserHandle;
  private page?: Page;
  private mode: InspectorMode = 'off';
  private overlayReady = false;
  private launching?: Promise<void>;

  constructor(private opts: RecorderOptions) {}

  get isOpen() { return !!this.handle && !!this.page && !this.page.isClosed(); }

  status(): RecorderStatus {
    const url = this.isOpen ? this.page!.url() : '';
    return { open: this.isOpen, url, mode: this.mode, overlayReady: this.overlayReady };
  }

  private pushStatus() { this.opts.onStatus(this.status()); }

  private async ensureOpen(): Promise<void> {
    if (this.isOpen) return;
    if (this.launching) return this.launching;
    this.launching = this.launch().finally(() => { this.launching = undefined; });
    return this.launching;
  }

  private async launch(): Promise<void> {
    const bundle = await loadInspectorBundle();
    const engine = EngineConfigSchema.parse({
      headless: false,
      stealth: true,
      blockResources: [],
      session: { persist: true, profile: 'recorder' },
      timeoutMs: 30_000,
      viewport: { width: BROWSER_W - 16, height: BROWSER_H - 140 },
    });
    const a = this.opts.anchor();
    const args = [`--window-size=${BROWSER_W},${BROWSER_H}`];
    if (a) args.push(`--window-position=${Math.max(0, a.x + a.width + 8)},${Math.max(0, a.y)}`);
    const provider = new PlaywrightProvider('patchright');
    const handle = await provider.launch({ engine, headless: false, initScript: bundle.source, profilesDir: this.opts.profilesDir, args });
    this.handle = handle;
    const ctx = handle.context;
    await ctx.exposeBinding(INSPECTOR_BINDING, (source, msg: OverlayMessage) => {
      // only the active page's main frame drives the UI; other frames' messages are still forwarded
      if (source.page !== this.page) return;
      this.onOverlayMessage(msg);
    });
    ctx.on('page', (p) => this.attach(p));
    ctx.on('close', () => { this.handle = undefined; this.page = undefined; this.overlayReady = false; this.pushStatus(); });
    const first = ctx.pages()[0] ?? (await ctx.newPage());
    this.attach(first);
  }

  private attach(page: Page) {
    this.page = page;
    this.overlayReady = false;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) { this.overlayReady = false; this.opts.onMessage({ type: 'navigated', url: f.url() }); this.pushStatus(); } });
    page.on('domcontentloaded', () => { void this.applyMode(); });
    page.on('load', () => { void this.applyMode(); this.pushStatus(); });
    page.on('close', () => {
      if (this.page !== page) return;
      const remaining = this.handle?.context.pages().filter((p) => !p.isClosed()) ?? [];
      if (remaining.length) this.attach(remaining[remaining.length - 1]);
      else { this.page = undefined; this.overlayReady = false; this.pushStatus(); }
    });
    this.pushStatus();
  }

  private onOverlayMessage(msg: OverlayMessage) {
    if (msg.type === 'ready') { this.overlayReady = true; void this.applyMode(); this.pushStatus(); }
    this.opts.onMessage(msg);
  }

  /**
   * Re-apply the picking mode in the page. patchright evaluates in an ISOLATED world by default,
   * where the overlay's `window.__scrappiaInspector` is not visible: pass `isolatedContext=false`
   * (4th argument) to run in the main world. This evaluate also flushes overlay messages queued
   * before the host binding attached, so it runs after every navigation.
   */
  private async applyMode() {
    if (!this.isOpen) return;
    try {
      await this.page!.evaluate(([g, m]) => { const api = (window as unknown as Record<string, { setMode?: (m: string) => void }>)[g]; api?.setMode?.(m); }, [INSPECTOR_GLOBAL, this.mode] as const, {}, false);
    } catch { /* page navigating */ }
  }

  /** Evaluate a method on the overlay API in the active page's main frame (main world, see applyMode). */
  private async api<T>(method: keyof ApiShape, ...args: unknown[]): Promise<T> {
    if (!this.isOpen) throw new Error('recorder browser is not open');
    return this.page!.evaluate(([g, m, a]) => {
      const api = (window as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>)[g];
      if (!api) throw new Error('inspector overlay not loaded on this page');
      const fn = api[m];
      if (typeof fn !== 'function') throw new Error(`inspector API has no method ${m}`);
      return fn.apply(api, a) as T;
    }, [INSPECTOR_GLOBAL, method, args] as const, {}, false);
  }

  // ---------- navigation ----------

  async open(url: string): Promise<RecorderStatus> {
    await this.ensureOpen();
    if (url) await this.navigate(url);
    return this.status();
  }

  async navigate(url: string): Promise<RecorderStatus> {
    await this.ensureOpen();
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    try { await this.page!.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    catch (e) { this.opts.onMessage({ type: 'error', message: `navigation failed: ${(e as Error).message}` }); }
    this.pushStatus();
    return this.status();
  }

  async back(): Promise<RecorderStatus> {
    if (this.isOpen) await this.page!.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    return this.status();
  }

  async reload(): Promise<RecorderStatus> {
    if (this.isOpen) await this.page!.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    return this.status();
  }

  currentUrl(): string { return this.isOpen ? this.page!.url() : ''; }

  // ---------- overlay API ----------

  async setMode(mode: InspectorMode) { this.mode = mode; await this.applyMode(); this.pushStatus(); }
  highlight(selectors: SelectorCandidate[], scope?: SelectorCandidate[]) { return this.api<{ count: number; samples: string[]; candidate: number }>('highlight', selectors, scope); }
  clearHighlights() { return this.api<void>('clearHighlights'); }
  detectLists() { return this.api<DetectedList[]>('detectLists'); }
  describe(selector: string) { return this.api<PickedElement | null>('describe', selector); }
  expand(selector: string, levels?: number) { return this.api<PickedElement | null>('expand', selector, levels); }
  regionHtml(selectors: SelectorCandidate[], maxChars?: number) { return this.api<string>('regionHtml', selectors, maxChars); }

  async pageHtml(): Promise<string> {
    if (!this.isOpen) throw new Error('recorder browser is not open');
    return this.page!.content();
  }

  // ---------- engine helpers on the live page ----------

  async runActions(actions: Action[]): Promise<{ ok: boolean; error?: string; url: string }> {
    if (!this.isOpen) throw new Error('recorder browser is not open');
    const parsed = actions.map((a) => ActionSchema.parse(a));
    // The overlay intercepts clicks while picking; switch it off for the duration of the actions.
    const prevMode = this.mode;
    this.mode = 'off';
    await this.applyMode();
    try {
      await runActions(this.page!, parsed, { keywords: {}, timeoutMs: 15_000 });
      return { ok: true, url: this.page!.url() };
    } catch (e) { return { ok: false, error: (e as Error).message, url: this.page!.url() }; }
    finally { this.mode = prevMode; await this.applyMode(); this.pushStatus(); }
  }

  /** Same evaluate wrapper as core's pageRunner: ship domExtract's source and call it in the page. */
  async extractPreview(template: Template): Promise<PreviewResult> {
    if (!this.isOpen) throw new Error('recorder browser is not open');
    const t = TemplateSchema.parse(template);
    const page = this.page!;
    const spec = buildSpec(t, page.url());
    const result = await page.evaluate(
      ({ fn, spec }: { fn: string; spec: DomExtractSpec }) => (new Function(`return (${fn})`)() as (d: Document, s: DomExtractSpec) => DomExtractResult)(document, spec),
      { fn: domExtract.toString(), spec },
    );
    return { url: result.url, title: result.title, records: result.records, page: result.page, fieldMatches: result.fieldMatches, listMatch: result.listMatch };
  }

  async screenshot(): Promise<string> {
    if (!this.isOpen) throw new Error('recorder browser is not open');
    const buf = await this.page!.screenshot({ type: 'png' });
    return Buffer.from(buf).toString('base64');
  }

  async close() {
    const h = this.handle;
    this.handle = undefined; this.page = undefined; this.overlayReady = false; this.mode = 'off';
    if (h) await h.close().catch(() => undefined);
    this.pushStatus();
  }
}

type ApiShape = { highlight: 0; clearHighlights: 0; detectLists: 0; describe: 0; expand: 0; regionHtml: 0; setMode: 0 };

export function recorderProfilesDir(dataDir: string) { return join(dataDir, 'profiles'); }
