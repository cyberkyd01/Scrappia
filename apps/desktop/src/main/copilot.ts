/**
 * Copilot integration for the desktop recorder.
 *
 * - `RecorderCopilotHost` implements core's `CopilotHost` on top of the live `RecorderSession`
 *   (page content, list detection, picking hand-off, selector tests, previews, navigation) and the
 *   `ScrappiaApp` (test runs, full runs, saving, secrets).
 * - `CopilotManager` owns one `CopilotSession` per recorder session, keeps the conversation log in
 *   memory (so the panel can be remounted, e.g. after visiting the run monitor), streams progress to
 *   the renderer, forwards the user's picks from the overlay to the copilot while it is waiting for
 *   them, and tells the copilot when a run it started has finished.
 */
import {
  CopilotSession, cleanHtml, htmlToMarkdown, sinkTypes, Logger,
  type CopilotHost, type CopilotPreview, type CopilotEvent, type CopilotProgress, type CopilotTurnResult, type CopilotMessage,
  type ScrappiaApp, type Recipe, type RecipeInput, type Template, type Action, type SelectorCandidate, type InspectorMode, type OverlayMessage, type RunEvent, type RunStats,
} from '@scrappia/core';
import type { IpcEvents, CopilotAvailable, CopilotLogItem, CopilotStartInput, CopilotState, CopilotStatus, CopilotTurnInput, DesktopSettings } from '../shared/ipc';
import type { RecorderSession } from './recorder';

const HIGHLIGHT_MS = 2000;

export interface RecorderCopilotHostOptions {
  app: ScrappiaApp;
  recorder: RecorderSession;
  /** Called after the picking mode changed (so the UI can show the instruction banner). */
  onPickMode: (mode: InspectorMode, instruction: string) => void;
  /** Called when the copilot started a full run. */
  onRunStarted: (runId: string) => void;
}

export class RecorderCopilotHost implements CopilotHost {
  private highlightTimer?: NodeJS.Timeout;
  constructor(private o: RecorderCopilotHostOptions) {}

  async page() {
    const { recorder } = this.o;
    if (!recorder.isOpen) return null;
    const url = recorder.currentUrl();
    if (!url || url === 'about:blank') return null;
    return { url, title: await recorder.pageTitle().catch(() => '') };
  }

  async pageContent(opts: { maxChars: number; format: 'markdown' | 'html' }) {
    const { recorder } = this.o;
    const html = await recorder.pageHtml();
    const url = recorder.currentUrl();
    return opts.format === 'html' ? cleanHtml(html, url, { maxChars: opts.maxChars }) : htmlToMarkdown(html, url, { maxChars: opts.maxChars });
  }

  detectLists() { return this.o.recorder.detectLists(); }

  async setPickMode(mode: InspectorMode, instruction: string) {
    if (mode !== 'off' && !this.o.recorder.isOpen) throw new Error('the recorder browser is not open; ask the user to open a page first');
    await this.o.recorder.setMode(mode);
    this.o.onPickMode(mode, mode === 'off' ? '' : instruction);
  }

  async testSelector(selectors: SelectorCandidate[], scope?: SelectorCandidate[]) {
    const r = await this.o.recorder.highlight(selectors, scope);
    clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => { void this.o.recorder.clearHighlights().catch(() => undefined); }, HIGHLIGHT_MS);
    return { count: r.count, samples: r.samples };
  }

  async previewExtract(template: Template): Promise<CopilotPreview> {
    const p = await this.o.recorder.extractPreview(template);
    return { records: p.records.slice(0, 50), page: p.page, listMatched: p.listMatch?.matched ?? 0, fieldMatches: p.fieldMatches };
  }

  async navigate(url: string) {
    const st = await this.o.recorder.navigate(url);
    return { url: st.url, title: await this.o.recorder.pageTitle().catch(() => '') };
  }

  async runActions(actions: Action[]) {
    const r = await this.o.recorder.runActions(actions);
    if (!r.ok) throw new Error(r.error ?? 'action failed');
  }

  /** Dry run through the real engine (separate headless browser when needed; never the recorder page). */
  async testRun(recipe: Recipe, maxRequests: number) {
    const { app } = this.o;
    const active = await app.startRun(recipe, { dryRun: true, maxRequests, headless: true, trigger: 'copilot-test' });
    const { run, stats } = await active.promise;
    const rows = Array.from(app.storage.iterRows(run.id, undefined, { limit: 5 })).map((r) => r.data);
    const drift = app.storage.listDrift(run.id).map((d) => `${d.kind} ${d.template}${d.field ? `.${d.field}` : ''}`);
    return { stats: stats as Partial<RunStats>, rows, drift, status: run.status };
  }

  async startRun(recipe: Recipe) {
    const active = await this.o.app.startRun(recipe, { trigger: 'copilot' });
    active.promise.catch(() => undefined);
    this.o.onRunStarted(active.run.id);
    return { runId: active.run.id };
  }

  async saveRecipe(recipe: Recipe) {
    const rec = this.o.app.saveRecipe(recipe, { id: recipe.id });
    return { id: rec.id };
  }

  async secretNames() { return this.o.app.storage.listSecretNames(); }
  sinkTypes() { return sinkTypes(); }
}

// ---------------------------------------------------------------------------------------------

export interface CopilotManagerOptions {
  app: ScrappiaApp;
  recorder: RecorderSession;
  send: <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]) => void;
  logger?: Logger;
}

export class CopilotManager {
  private session?: CopilotSession;
  private host: RecorderCopilotHost;
  private log: CopilotLogItem[] = [];
  private recipe?: Recipe | RecipeInput;
  private providerName?: string;
  private sessionKey?: string;
  private busy = false;
  private waitingForPicks = false;
  private mode: InspectorMode = 'off';
  private instruction = '';
  private turnSeq = 0;
  private cancelledUpTo = 0;
  private queue: CopilotEvent[] = [];
  private pendingRuns = new Set<string>();
  private lastPickAt = 0;
  private logger: Logger;

  constructor(private o: CopilotManagerOptions) {
    this.logger = (o.logger ?? new Logger('info')).child('copilot');
    this.host = new RecorderCopilotHost({
      app: o.app, recorder: o.recorder,
      onPickMode: (mode, instruction) => { this.mode = mode; this.instruction = instruction; this.pushStatus(); },
      onRunStarted: (runId) => { this.pendingRuns.add(runId); o.send('copilot:run', { runId }); },
    });
  }

  // ---------- state ----------

  private settings(): DesktopSettings { return this.o.app.settings as DesktopSettings; }

  status(): CopilotStatus {
    return { started: !!this.session, providerName: this.providerName, busy: this.busy, waitingForPicks: this.waitingForPicks, mode: this.mode, instruction: this.instruction };
  }

  private pushStatus() { this.o.send('copilot:status', this.status()); }

  private push(item: CopilotLogItem) {
    this.log.push(item);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.o.send('copilot:log', item);
  }

  private state(): CopilotState {
    return { status: this.status(), log: this.log, recipe: this.session?.currentRecipe, history: this.session?.history ?? [] };
  }

  available(): CopilotAvailable {
    const s = this.settings();
    const svc = this.o.app.ai();
    const configured = s.ai.providers.map((p) => p.name);
    if (!svc) return { ok: false, providers: configured, default: s.ai.default, reason: configured.length ? 'The configured AI provider could not be initialised. Check its API key secret in Settings > AI providers.' : 'No AI provider configured. Add one in Settings > AI providers (Anthropic or any OpenAI-compatible endpoint, including local models).' };
    const providers = configured.length ? configured : [svc.provider().name];
    return { ok: true, providers, default: s.ai.default ?? providers[0] };
  }

  // ---------- lifecycle ----------

  /**
   * Create (or reuse) the session for a recorder session. A different `sessionKey` starts a fresh
   * conversation; the same key with a different provider swaps the model but keeps the history.
   */
  start(input: CopilotStartInput): CopilotState {
    if (this.sessionKey !== input.sessionKey) { this.resetState(); this.sessionKey = input.sessionKey; }
    const wanted = input.providerName ?? this.providerName ?? this.settings().ai.default;
    if (!this.session || (input.providerName && input.providerName !== this.providerName)) this.createSession(wanted);
    this.recipe = input.recipe;
    this.pushStatus();
    return this.state();
  }

  private createSession(providerName?: string) {
    const svc = this.o.app.ai();
    if (!svc) { const a = this.available(); throw new Error(`ai_not_configured: ${a.reason}`); }
    const provider = svc.provider(providerName);
    const previous = this.session;
    const extra = this.settings().ai.copilotInstructions?.trim() || undefined;
    this.session = new CopilotSession({ provider, host: this.host, logger: this.logger, extraInstructions: extra, onProgress: (p) => this.onProgress(p) });
    if (previous) this.session.load(previous.history as CopilotMessage[]);
    this.providerName = provider.name;
  }

  history(): CopilotState { return this.state(); }

  reset() { this.resetState(); this.pushStatus(); }

  private resetState() {
    this.session = undefined; this.log = []; this.recipe = undefined; this.providerName = undefined; this.sessionKey = undefined;
    this.waitingForPicks = false; this.queue = []; this.pendingRuns.clear();
    this.cancelledUpTo = this.turnSeq;
    if (this.mode !== 'off') { this.mode = 'off'; this.instruction = ''; void this.o.recorder.setMode('off').catch(() => undefined); }
  }

  /** Abort the current turn: its result is ignored and picks stop being forwarded. */
  cancel() {
    if (!this.busy) return;
    this.cancelledUpTo = this.turnSeq;
    this.queue = [];
    this.push({ kind: 'error', text: 'Cancelled. The current step will be ignored when it finishes.', at: Date.now() });
  }

  // ---------- turns ----------

  private onProgress(p: CopilotProgress) {
    this.push({ kind: 'progress', progress: p, at: Date.now() });
    this.o.send('copilot:progress', p);
  }

  async turn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    if (!this.session) throw new Error('copilot is not started; call copilot.start first');
    if (this.busy) throw new Error('Copilot is still working on the previous step. Wait for it to finish or cancel it.');
    if (!input.message && !input.event) throw new Error('nothing to send');
    const seq = ++this.turnSeq;
    this.recipe = input.recipe;
    this.busy = true;
    this.pushStatus();
    const at = Date.now();
    if (input.event) this.push({ kind: 'event', event: input.event, at });
    if (input.message) this.push({ kind: 'user', text: input.message, at });
    try {
      const result = await this.session.turn({ recipe: input.recipe, message: input.message, event: input.event });
      if (seq <= this.cancelledUpTo) return result;
      this.recipe = result.recipe;
      this.waitingForPicks = result.waitingForPicks;
      this.o.send('copilot:recipe', result.recipe);
      return result;
    } catch (e) {
      if (seq > this.cancelledUpTo) this.push({ kind: 'error', text: (e as Error).message, at: Date.now() });
      throw e;
    } finally {
      this.busy = false;
      this.pushStatus();
      void this.drainQueue();
    }
  }

  /** Auto-turn driven by the recorder (picks) or the engine (run finished). Errors are logged, not thrown. */
  private async autoTurn(event: CopilotEvent) {
    if (!this.session || !this.recipe) return;
    if (this.busy) { this.queue.push(event); return; }
    try { await this.turn({ recipe: this.recipe, event }); }
    catch (e) { this.logger.warn('copilot auto turn failed', { error: (e as Error).message }); }
  }

  private async drainQueue() {
    if (this.busy || !this.queue.length) return;
    const next = this.queue.shift()!;
    // picks are only meaningful while the copilot still waits for them
    if ((next.type === 'picked' || next.type === 'list.detected') && !this.waitingForPicks) { void this.drainQueue(); return; }
    await this.autoTurn(next);
  }

  // ---------- inputs from the recorder / engine ----------

  /** Overlay messages from the recorder; picks are forwarded only while the copilot waits for them. */
  onOverlayMessage(msg: OverlayMessage) {
    if (!this.session || !this.waitingForPicks) return;
    if (msg.type === 'picked') {
      this.lastPickAt = Date.now();
      void this.autoTurn({ type: 'picked', element: msg.element });
    } else if (msg.type === 'list.detected') {
      // In pickList mode a click emits `picked` (with the record) AND `list.detected`; forward the latter
      // only when it did not come with a pick (e.g. host-side detection).
      if (Date.now() - this.lastPickAt < 500) return;
      void this.autoTurn({ type: 'list.detected', list: msg.list });
    }
  }

  /** Engine events: tell the copilot when a run it started has finished. */
  onRunEvent(e: RunEvent) {
    if (e.type !== 'run.done' || !this.pendingRuns.has(e.run.id)) return;
    this.pendingRuns.delete(e.run.id);
    void this.autoTurn({ type: 'run.finished', runId: e.run.id, status: e.run.status, rows: e.stats.rows });
  }
}
