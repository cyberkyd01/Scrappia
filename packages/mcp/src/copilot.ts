/**
 * Copilot sessions for the MCP server: an in-memory store shared by every McpServer instance
 * bound to the same ScrappiaApp (the HTTP transport creates one server per request), plus the
 * browser-less host that routes runs through the app so they show up in run history and events.
 */
import { randomUUID } from 'node:crypto';
import { CopilotSession, HttpCopilotHost, safeParseRecipe, type ActiveRun, type Recipe, type ScrappiaApp } from '@scrappia/core';

export interface CopilotStoreOptions {
  /** Idle time after which a session is dropped (default 60 minutes). */
  idleMs?: number;
  /** Max live sessions (default 20). */
  maxSessions?: number;
  now?: () => number;
}

export interface CopilotSessionRecord {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  provider: string;
  recipe: Recipe;
  session: CopilotSession;
  runIds: string[];
}

export class CopilotSessionStore {
  private sessions = new Map<string, CopilotSessionRecord>();
  private idleMs: number;
  private max: number;
  private now: () => number;

  constructor(opts: CopilotStoreOptions = {}) {
    this.idleMs = opts.idleMs ?? 60 * 60 * 1000;
    this.max = opts.maxSessions ?? 20;
    this.now = opts.now ?? Date.now;
  }

  get size() { this.sweep(); return this.sessions.size; }

  sweep() {
    const cutoff = this.now() - this.idleMs;
    for (const [id, s] of this.sessions) if (s.lastUsedAt < cutoff) this.sessions.delete(id);
  }

  add(rec: Omit<CopilotSessionRecord, 'id' | 'createdAt' | 'lastUsedAt' | 'runIds'>): CopilotSessionRecord {
    this.sweep();
    if (this.sessions.size >= this.max) throw new Error(`at most ${this.max} copilot sessions can be open; call copilot_end on one first`);
    const t = this.now();
    const full: CopilotSessionRecord = { ...rec, id: randomUUID(), createdAt: t, lastUsedAt: t, runIds: [] };
    this.sessions.set(full.id, full);
    return full;
  }

  /** Touches and returns the session; undefined when unknown or expired. */
  get(id: string): CopilotSessionRecord | undefined {
    this.sweep();
    const s = this.sessions.get(id);
    if (s) s.lastUsedAt = this.now();
    return s;
  }

  touch(s: CopilotSessionRecord) { s.lastUsedAt = this.now(); }
  delete(id: string): boolean { return this.sessions.delete(id); }
  list(): CopilotSessionRecord[] { this.sweep(); return Array.from(this.sessions.values()); }
}

const stores = new WeakMap<ScrappiaApp, CopilotSessionStore>();
/** One store per app (shared across McpServer instances, e.g. the stateless HTTP transport). */
export function copilotStoreFor(app: ScrappiaApp, opts?: CopilotStoreOptions): CopilotSessionStore {
  let s = stores.get(app);
  if (!s) { s = new CopilotSessionStore(opts); stores.set(app, s); }
  return s;
}

/** HTTP-only host whose runs go through `app.startRun` (run history, events, cancel all work). */
export class AppCopilotHost extends HttpCopilotHost {
  constructor(private app: ScrappiaApp, private trackRun: (a: ActiveRun) => void, startUrl?: string) {
    super({ storage: app.storage, outDir: app.settings.defaults.outDir ?? app.dataDir, startUrl, ai: app.ai(), logger: app.log.child('copilot-host'), secretNames: () => app.storage.listSecretNames() });
  }

  override async testRun(recipe: Recipe, maxRequests: number) {
    const active = await this.app.startRun(recipe, { trigger: 'copilot-test', maxRequests, dryRun: true });
    const { run, stats } = await active.promise;
    const rows = this.app.rows(run.id, undefined, { limit: 5 });
    const drift = this.app.storage.listDrift(run.id).map((d) => `${d.kind} ${d.template}.${d.field ?? ''}`);
    return { stats, rows, drift, status: run.status };
  }

  override async startRun(recipe: Recipe) {
    const active = await this.app.startRun(recipe, { trigger: 'copilot' });
    active.promise.catch(() => { /* surfaced via run status */ });
    this.trackRun(active);
    return { runId: active.run.id };
  }

  override async saveRecipe(recipe: Recipe) {
    const rec = this.app.saveRecipe(recipe, { id: recipe.id, note: 'saved by copilot' });
    return { id: rec.id };
  }
}

export function minimalRecipe(url: string): Recipe {
  const v = safeParseRecipe({ name: 'Untitled', entry: { urls: [url], template: 'main' }, templates: { main: {} } });
  if (!v.success) throw new Error(`cannot build a recipe for ${url}: ${v.errors.join('; ')}`);
  return v.recipe;
}

/** Create a copilot session bound to the app. Throws when no AI provider is configured. */
export function startCopilotSession(app: ScrappiaApp, store: CopilotSessionStore, opts: { url?: string; recipe?: Recipe; provider?: string; instructions?: string }): CopilotSessionRecord {
  const ai = app.ai();
  if (!ai) throw new Error('no AI provider configured: set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST or run `scrappia ai add`');
  const provider = ai.provider(opts.provider);
  if (opts.provider && provider.name !== opts.provider) throw new Error(`AI provider "${opts.provider}" is not configured`);
  if (!opts.url && !opts.recipe) throw new Error('provide url or recipe');
  const recipe = opts.recipe ?? minimalRecipe(opts.url!);
  const startUrl = opts.url ?? recipe.entry.urls[0];
  if (!startUrl) throw new Error('the recipe has no entry URL; pass url');
  let record: CopilotSessionRecord | undefined;
  const host = new AppCopilotHost(app, (a) => { record?.runIds.push(a.run.id); }, startUrl);
  const session = new CopilotSession({ provider, host, logger: app.log, extraInstructions: opts.instructions });
  record = store.add({ provider: provider.name, recipe, session });
  return record;
}
