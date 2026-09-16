/**
 * ScrappiaApp: the high-level facade shared by the CLI, server, desktop app and MCP server.
 * Owns storage, settings (AI providers, secrets), running jobs, and the scheduler.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { parseRecipe, safeParseRecipe, type Recipe, type RecipeInput, type Sink as SinkConfig } from './recipe/schema.js';
import { SqliteStorage } from './storage/sqlite.js';
import type { Storage, RunRecord } from './storage/types.js';
import { Runner, type RunnerOptions } from './engine/runner.js';
import type { RunEvent, RunEventListener, RunStats } from './engine/events.js';
import { AiService } from './ai/service.js';
import { createProvider, type LlmProviderConfig } from './ai/provider.js';
import { Scheduler } from './scheduler/index.js';
import { Logger, rootLogger } from './util/logger.js';
import { exportRun } from './engine/export.js';
import { diffRuns } from './monitor/index.js';
import { httpFetch } from './fetch/http.js';
import { extractFromHtml } from './dom/jsdom.js';
import { buildSpec } from './engine/spec.js';

export interface AppSettings {
  ai: { providers: LlmProviderConfig[]; default?: string };
  defaults: { outDir?: string; headless?: boolean };
}

export interface AppOptions {
  /** Data directory (SQLite db, exports, profiles). Default ~/.scrappia */
  dataDir?: string;
  storage?: Storage;
  logger?: Logger;
}

export interface ActiveRun { runner: Runner; run: RunRecord; recipeId?: string; promise: Promise<{ run: RunRecord; stats: RunStats }> }

export class ScrappiaApp {
  readonly dataDir: string;
  readonly storage: Storage;
  readonly log: Logger;
  readonly scheduler: Scheduler;
  private active = new Map<string, ActiveRun>();
  private listeners = new Set<RunEventListener>();
  private aiCache?: AiService;

  constructor(opts: AppOptions = {}) {
    this.dataDir = opts.dataDir ?? process.env.SCRAPPIA_HOME ?? join(homedir(), '.scrappia');
    mkdirSync(this.dataDir, { recursive: true });
    this.log = opts.logger ?? rootLogger;
    this.storage = opts.storage ?? new SqliteStorage(join(this.dataDir, 'scrappia.db'));
    this.scheduler = new Scheduler({ storage: this.storage, logger: this.log, runRecipe: async (id, trigger) => { const a = await this.startRun(id, { trigger }); return a.promise; } });
  }

  close() { this.scheduler.stop(); this.storage.close(); }

  // ---------- events ----------
  on(l: RunEventListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(e: RunEvent) { for (const l of this.listeners) { try { l(e); } catch { /* ignore */ } } }

  // ---------- settings ----------
  get settings(): AppSettings {
    return this.storage.getKv<AppSettings>('settings') ?? { ai: { providers: [] }, defaults: {} };
  }
  saveSettings(s: AppSettings) { this.storage.setKv('settings', s); this.aiCache = undefined; }

  secret(name: string): string | undefined { return this.storage.getSecret(name) ?? process.env[name]; }
  setSecret(name: string, value: string) { this.storage.setSecret(name, value); this.aiCache = undefined; }

  /** Build the AI service from settings (undefined when no provider is configured). */
  ai(): AiService | undefined {
    if (this.aiCache) return this.aiCache;
    const s = this.settings;
    const cfgs = s.ai.providers.length ? s.ai.providers : autoDetectProviders();
    if (!cfgs.length) return undefined;
    const def = cfgs.find((p) => p.name === s.ai.default) ?? cfgs[0];
    try {
      const svc = new AiService(createProvider(def, (r) => this.secret(r)), this.log.child('ai'));
      for (const c of cfgs) if (c !== def) { try { svc.addProvider(createProvider(c, (r) => this.secret(r))); } catch { /* skip broken */ } }
      this.aiCache = svc;
      return svc;
    } catch (e) { this.log.warn('AI provider unavailable', { error: (e as Error).message }); return undefined; }
  }

  // ---------- recipes ----------
  saveRecipe(input: RecipeInput | Recipe, opts: { id?: string; note?: string } = {}) {
    const recipe = parseRecipe(input);
    const rec = this.storage.saveRecipe({ id: opts.id ?? recipe.id, name: recipe.name, json: { ...recipe, id: undefined }, note: opts.note });
    if (recipe.schedule) this.storage.upsertSchedule({ recipeId: rec.id, cron: recipe.schedule.cron, tz: recipe.schedule.tz, enabled: recipe.schedule.enabled, skipIfRunning: recipe.schedule.skipIfRunning });
    else { const s = this.storage.listSchedules().find((x) => x.recipeId === rec.id); if (s) this.storage.deleteSchedule(s.id); }
    this.scheduler.reload();
    return rec;
  }
  getRecipe(id: string): { record: ReturnType<Storage['getRecipe']>; recipe?: Recipe } {
    const record = this.storage.getRecipe(id);
    return { record, recipe: record ? parseRecipe({ ...(record.json as object), id }) : undefined };
  }
  listRecipes() { return this.storage.listRecipes(); }
  deleteRecipe(id: string) { this.storage.deleteRecipe(id); this.scheduler.reload(); }
  validateRecipe(input: unknown) { return safeParseRecipe(input); }

  // ---------- runs ----------
  async startRun(recipeOrId: string | Recipe | RecipeInput, opts: Partial<Omit<RunnerOptions, 'recipe' | 'storage'>> & { trigger?: string } = {}): Promise<ActiveRun> {
    let recipe: Recipe; let recipeId: string | undefined;
    if (typeof recipeOrId === 'string') {
      const r = this.getRecipe(recipeOrId);
      if (!r.recipe) throw new Error(`recipe ${recipeOrId} not found`);
      recipe = r.recipe; recipeId = recipeOrId;
    } else { recipe = parseRecipe(recipeOrId); recipeId = recipe.id; }
    const runner = new Runner({
      recipe, storage: this.storage, outDir: opts.outDir ?? this.settings.defaults.outDir ?? this.dataDir, recipeId, trigger: opts.trigger ?? 'manual',
      ai: opts.ai ?? this.ai(), logger: this.log, headless: opts.headless ?? this.settings.defaults.headless, browserProvider: opts.browserProvider,
      signal: opts.signal, resumeRunId: opts.resumeRunId, maxRequests: opts.maxRequests, dryRun: opts.dryRun, secrets: (n) => this.secret(n),
      onEvent: (e) => { this.emit(e); opts.onEvent?.(e); },
    });
    const promise = runner.start();
    // runner.start() creates the run synchronously before its first await, so id is available after a tick
    await new Promise((r) => setImmediate(r));
    const run = this.storage.getRun(runner.id)!;
    const active: ActiveRun = { runner, run, recipeId, promise };
    this.active.set(run.id, active);
    promise.finally(() => this.active.delete(run.id));
    return active;
  }
  activeRuns(): ActiveRun[] { return Array.from(this.active.values()); }
  cancelRun(runId: string) { const a = this.active.get(runId); if (!a) return false; a.runner.cancel(); return true; }
  pauseRun(runId: string) { const a = this.active.get(runId); if (!a) return false; a.runner.pause(); return true; }
  resumeRun(runId: string) { const a = this.active.get(runId); if (!a) return false; a.runner.resume(); return true; }
  async resumeStoppedRun(runId: string, opts: { trigger?: string } = {}) {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return this.startRun(parseRecipe(run.recipeJson), { ...opts, resumeRunId: runId });
  }
  listRuns(opts?: Parameters<Storage['listRuns']>[0]) { return this.storage.listRuns(opts); }
  getRun(id: string) { return this.storage.getRun(id); }
  rows(runId: string, dataset?: string, opts?: { limit?: number; offset?: number }) { return Array.from(this.storage.iterRows(runId, dataset, opts)).map((r) => r.data); }
  diff(prevRunId: string, curRunId: string, opts?: Parameters<typeof diffRuns>[3]) { return diffRuns(this.storage, prevRunId, curRunId, opts); }

  /** Export an existing run to ad-hoc sinks (e.g. CLI `export --out data.xlsx`). */
  async export(runId: string, sinks: SinkConfig[]) {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const recipe = parseRecipe(run.recipeJson);
    return exportRun({ recipe, storage: this.storage, runId, outDir: this.settings.defaults.outDir ?? this.dataDir, secret: (n) => this.secret(n), log: this.log, sinks });
  }

  // ---------- quick tools ----------
  /** Fetch one page over HTTP and extract with a template (fast preview, no browser). */
  async preview(recipe: RecipeInput | Recipe, url?: string) {
    const r = parseRecipe(recipe);
    const target = url ?? r.entry.urls[0];
    const template = r.templates[r.entry.template];
    const res = await httpFetch(target, { headers: r.engine.headers, userAgent: r.engine.userAgent, timeoutMs: r.engine.timeoutMs });
    const ex = extractFromHtml(res.body, res.url, buildSpec(template, res.url));
    return { url: res.url, status: res.status, records: ex.records, page: ex.page, listMatched: ex.listMatch?.matched ?? 0, fieldMatches: ex.fieldMatches };
  }

  // ---------- api keys ----------
  createApiKey(name: string, scopes = 'read,write'): string {
    const key = `sk_${randomBytes(24).toString('base64url')}`;
    this.storage.createApiKey(name, hashKey(key), scopes);
    return key;
  }
  verifyApiKey(key: string) { return this.storage.findApiKey(hashKey(key)); }
}

export function hashKey(key: string) { return createHash('sha256').update(key).digest('hex'); }

/** When nothing is configured, pick up ANTHROPIC_API_KEY / OPENAI_API_KEY / a local Ollama. */
export function autoDetectProviders(): LlmProviderConfig[] {
  const out: LlmProviderConfig[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push({ name: 'anthropic', kind: 'anthropic', model: process.env.SCRAPPIA_AI_MODEL ?? 'claude-sonnet-5', effort: 'low' });
  if (process.env.OPENAI_API_KEY) out.push({ name: 'openai', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: process.env.SCRAPPIA_AI_MODEL ?? 'gpt-4o-mini', apiKey: 'OPENAI_API_KEY' });
  if (process.env.OLLAMA_HOST || process.env.SCRAPPIA_OLLAMA) out.push({ name: 'ollama', kind: 'openai-compatible', baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434', model: process.env.SCRAPPIA_AI_MODEL ?? 'llama3.1' });
  return out;
}
