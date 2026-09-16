/**
 * Scrappia Copilot over REST: conversational recipe building without a browser.
 *
 *   POST   /api/copilot/sessions            create a session (url or recipe, optional provider / instructions)
 *   POST   /api/copilot/sessions/:id/turn   send a message / event; `?stream=1` streams progress as SSE
 *   GET    /api/copilot/sessions/:id        current recipe + history
 *   DELETE /api/copilot/sessions/:id        end the session
 *
 * Sessions live in memory, are scoped to the API key that created them, expire after `idleMs`
 * without use (swept on access) and are capped per key. Element picking is not available here
 * (no browser); the copilot is told so by the host and falls back to detect_lists / test_selector.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  CopilotSession, HttpCopilotHost, safeParseRecipe,
  type ActiveRun, type CopilotEvent, type CopilotMessage, type CopilotProgress, type CopilotTurnResult, type Recipe, type ScrappiaApp,
} from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { ApiError, notFound } from '../errors.js';
import { parseBody } from '../util.js';
import { validateRecipeOrThrow } from './recipes.js';

export interface CopilotOptions {
  /** Idle time after which a session is dropped (default 60 minutes). */
  idleMs?: number;
  /** Max live sessions per API key (default 20). */
  maxPerKey?: number;
  /** Clock override (tests). */
  now?: () => number;
}

const EVENT_TYPES = ['picked', 'list.detected', 'navigated', 'run.finished'] as const;

const CreateBody = z.object({
  url: z.string().url().optional(),
  recipe: z.record(z.any()).optional(),
  provider: z.string().min(1).optional(),
  instructions: z.string().max(8000).optional(),
}).refine((b) => b.url || b.recipe, { message: 'url or recipe is required' });

const TurnBody = z.object({
  message: z.string().max(20_000).optional(),
  event: z.object({ type: z.enum(EVENT_TYPES) }).passthrough().optional(),
  recipe: z.record(z.any()).optional(),
}).refine((b) => (b.message && b.message.trim()) || b.event, { message: 'message or event is required' });

export interface CopilotSessionRecord {
  id: string;
  /** Owner (auth id); other keys get 404. */
  key: string;
  createdAt: number;
  lastUsedAt: number;
  provider: string;
  recipe: Recipe;
  session: CopilotSession;
  host: HttpCopilotHost;
  runIds: string[];
  /** Per-turn progress sink (set while a streaming turn is in flight). */
  progress?: (p: CopilotProgress) => void;
}

/** In-memory session store: per-key ownership, idle expiry swept on every access, per-key cap. */
export class CopilotSessionStore {
  private sessions = new Map<string, CopilotSessionRecord>();
  private idleMs: number;
  private maxPerKey: number;
  private now: () => number;

  constructor(opts: CopilotOptions = {}) {
    this.idleMs = opts.idleMs ?? 60 * 60 * 1000;
    this.maxPerKey = opts.maxPerKey ?? 20;
    this.now = opts.now ?? Date.now;
  }

  get size() { return this.sessions.size; }

  sweep() {
    const cutoff = this.now() - this.idleMs;
    for (const [id, s] of this.sessions) if (s.lastUsedAt < cutoff) this.sessions.delete(id);
  }

  countFor(key: string) { let n = 0; for (const s of this.sessions.values()) if (s.key === key) n++; return n; }

  add(rec: Omit<CopilotSessionRecord, 'id' | 'createdAt' | 'lastUsedAt' | 'runIds'>): CopilotSessionRecord {
    this.sweep();
    if (this.countFor(rec.key) >= this.maxPerKey) throw new ApiError(429, 'copilot_session_limit', `At most ${this.maxPerKey} copilot sessions per API key; DELETE one first`);
    const t = this.now();
    const full: CopilotSessionRecord = { ...rec, id: randomUUID(), createdAt: t, lastUsedAt: t, runIds: [] };
    this.sessions.set(full.id, full);
    return full;
  }

  /** Touches and returns the session; undefined when unknown, expired or owned by another key. */
  get(key: string, id: string): CopilotSessionRecord | undefined {
    this.sweep();
    const s = this.sessions.get(id);
    if (!s || s.key !== key) return undefined;
    s.lastUsedAt = this.now();
    return s;
  }

  touch(s: CopilotSessionRecord) { s.lastUsedAt = this.now(); }

  delete(key: string, id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.key !== key) return false;
    this.sessions.delete(id);
    return true;
  }
}

/**
 * Browser-less host wired into the app: full runs and test runs go through `app.startRun` so they
 * show up in `activeRuns()`, the SSE event streams and cancel/pause like any other run.
 */
export class AppCopilotHost extends HttpCopilotHost {
  constructor(private app: ScrappiaApp, private trackRun: (a: ActiveRun) => void, opts: { startUrl?: string }) {
    super({ storage: app.storage, outDir: app.settings.defaults.outDir ?? app.dataDir, startUrl: opts.startUrl, ai: app.ai(), logger: app.log.child('copilot-host'), secretNames: () => app.storage.listSecretNames() });
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
  if (!v.success) throw new ApiError(400, 'invalid_recipe', 'Recipe validation failed', v.errors);
  return v.recipe;
}

function serialize(r: CopilotSessionRecord) {
  return { id: r.id, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, provider: r.provider, recipe: r.recipe, runIds: r.runIds };
}

function historyOf(r: CopilotSessionRecord): CopilotMessage[] { return r.session.history.map((m) => ({ role: m.role, content: m.content })); }

export function copilotRoutes(app: ScrappiaApp, opts: CopilotOptions = {}) {
  const r = new Hono<AppEnv>();
  const store = new CopilotSessionStore(opts);

  const keyOf = (c: Context<AppEnv>) => c.get('auth').id;
  const requireSession = (c: Context<AppEnv>) => {
    const id = c.req.param('id') as string;
    const s = store.get(keyOf(c), id);
    if (!s) throw notFound('copilot session', id);
    return s;
  };

  r.post('/copilot/sessions', async (c) => {
    const body = await parseBody(c, CreateBody);
    const ai = app.ai();
    if (!ai) throw new ApiError(400, 'ai_not_configured', 'No AI provider configured. Add one via PUT /api/settings (ai.providers) or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST.');
    const provider = ai.provider(body.provider);
    if (body.provider && provider.name !== body.provider) throw new ApiError(400, 'unknown_provider', `AI provider "${body.provider}" is not configured`);
    const recipe = body.recipe ? validateRecipeOrThrow(app, body.recipe) : minimalRecipe(body.url!);
    const startUrl = body.url ?? recipe.entry.urls[0];
    if (!startUrl) throw new ApiError(400, 'validation_error', 'Provide a url or a recipe with at least one entry URL');

    let record: CopilotSessionRecord | undefined;
    const host = new AppCopilotHost(app, (a) => { record?.runIds.push(a.run.id); }, { startUrl });
    const session = new CopilotSession({ provider, host, logger: app.log, extraInstructions: body.instructions, onProgress: (p) => record?.progress?.(p) });
    record = store.add({ key: keyOf(c), provider: provider.name, recipe, session, host });
    return c.json({ id: record.id, recipe: record.recipe, createdAt: record.createdAt, provider: record.provider }, 201);
  });

  r.get('/copilot/sessions/:id', (c) => {
    const s = requireSession(c);
    return c.json({ ...serialize(s), history: historyOf(s) });
  });

  r.delete('/copilot/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!store.delete(keyOf(c), id)) throw notFound('copilot session', id);
    return c.json({ ok: true, id });
  });

  r.post('/copilot/sessions/:id/turn', async (c) => {
    const s = requireSession(c);
    const body = await parseBody(c, TurnBody);
    const recipe = body.recipe ? validateRecipeOrThrow(app, body.recipe) : s.recipe;
    const stream = /^(1|true|yes)$/i.test(c.req.query('stream') ?? '');

    const runTurn = async (): Promise<CopilotTurnResult> => {
      try {
        const result = await s.session.turn({ message: body.message, event: body.event as CopilotEvent | undefined, recipe });
        s.recipe = result.recipe;
        store.touch(s);
        return result;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (/busy with the previous turn/.test(msg)) throw new ApiError(409, 'copilot_busy', msg);
        if (/nothing to do/.test(msg)) throw new ApiError(400, 'validation_error', msg);
        throw new ApiError(502, 'copilot_failed', msg);
      }
    };

    if (!stream) return c.json(await runTurn());

    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async (sse) => {
      let seq = 0;
      let chain: Promise<void> = Promise.resolve();
      const write = (event: string, data: unknown) => { chain = chain.then(() => sse.writeSSE({ event, data: JSON.stringify(data), id: String(++seq) })).catch(() => { /* client gone */ }); return chain; };
      s.progress = (p) => { void write('progress', p); };
      try {
        const result = await runTurn();
        await write('result', result);
      } catch (e) {
        const err = e instanceof ApiError ? { code: e.code, message: e.message, status: e.status } : { code: 'copilot_failed', message: (e as Error).message, status: 502 };
        await write('error', err);
      } finally {
        s.progress = undefined;
        await chain;
      }
    });
  });

  return r;
}
