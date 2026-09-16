import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Sink, parseRecipe, type Recipe, type RecipeInput, type RunRecord, type ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { ApiError, conflict, notFound } from '../errors.js';
import { parseBody, parseQuery, readJson } from '../util.js';
import { RowsQuery, sendRows } from './rows.js';
import { validateRecipeOrThrow } from './recipes.js';

const RUN_STATUS = z.enum(['running', 'succeeded', 'partial', 'failed', 'cancelled']);
const REQUEST_STATUS = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);

const ListRunsQuery = z.object({
  recipeId: z.string().min(1).optional(),
  status: RUN_STATUS.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});

const RequestsQuery = z.object({
  status: REQUEST_STATUS.optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(200),
});

const DiffQuery = z.object({
  against: z.string().min(1).optional(),
  dataset: z.string().min(1).optional(),
  fields: z.string().optional(),
  thresholdPercent: z.coerce.number().min(0).optional(),
});

const ExportBody = z.object({ sinks: z.array(Sink).min(1) });
const RetryBody = z.object({ trigger: z.string().min(1).max(64).optional() });

const AdHocOptions = z.object({
  trigger: z.string().min(1).max(64).optional(),
  maxRequests: z.number().int().min(1).optional(),
  dryRun: z.boolean().optional(),
});

export function requireRun(app: ScrappiaApp, id: string): RunRecord {
  const run = app.getRun(id);
  if (!run) throw notFound('run', id);
  return run;
}

function recipeOfRun(run: RunRecord): Recipe | undefined {
  if (!run.recipeJson) return undefined;
  try { return parseRecipe(run.recipeJson); } catch { return undefined; }
}

export function runRoutes(app: ScrappiaApp) {
  const r = new Hono<AppEnv>();

  /** Ad-hoc run. Body is a full recipe, or `{ recipe, trigger?, maxRequests?, dryRun? }`. */
  r.post('/runs', async (c) => {
    const raw = await readJson(c);
    let recipeRaw: unknown = raw;
    let opts: z.infer<typeof AdHocOptions> = {};
    if (raw && typeof raw === 'object' && 'recipe' in raw && !('templates' in raw)) {
      const { recipe, ...rest } = raw as { recipe: unknown } & Record<string, unknown>;
      recipeRaw = recipe;
      const o = AdHocOptions.safeParse(rest);
      if (!o.success) throw new ApiError(400, 'validation_error', 'Invalid run options', o.error.issues);
      opts = o.data;
    }
    const recipe = validateRecipeOrThrow(app, recipeRaw);
    const active = await app.startRun(recipe as RecipeInput, { trigger: opts.trigger ?? 'api', maxRequests: opts.maxRequests, dryRun: opts.dryRun });
    active.promise.catch(() => { /* surfaced via run status */ });
    return c.json({ runId: active.run.id, run: active.run }, 202);
  });

  r.get('/runs', (c) => {
    const q = parseQuery(c, ListRunsQuery);
    return c.json({ runs: app.listRuns(q) });
  });

  r.get('/runs/:id', (c) => {
    const id = c.req.param('id');
    const run = requireRun(app, id);
    const active = app.activeRuns().some((a) => a.run.id === id);
    return c.json({ run, active, stats: run.stats, queue: app.storage.queueCounts(id), datasets: app.storage.datasets(id) });
  });

  const control = (action: 'cancel' | 'pause' | 'resume') => (c: Context<AppEnv>) => {
    const id = c.req.param('id') as string;
    requireRun(app, id);
    const ok = action === 'cancel' ? app.cancelRun(id) : action === 'pause' ? app.pauseRun(id) : app.resumeRun(id);
    if (!ok) throw conflict(`run "${id}" is not active`, 'run_not_active');
    return c.json({ ok: true, runId: id, action });
  };
  r.post('/runs/:id/cancel', control('cancel'));
  r.post('/runs/:id/pause', control('pause'));
  r.post('/runs/:id/resume', control('resume'));

  /** Resume a stopped (failed / cancelled / partial) run: requeues unfinished requests. */
  r.post('/runs/:id/retry', async (c) => {
    const id = c.req.param('id');
    const run = requireRun(app, id);
    if (app.activeRuns().some((a) => a.run.id === id)) throw conflict(`run "${id}" is still running`, 'run_active');
    if (!run.recipeJson) throw conflict(`run "${id}" has no recipe snapshot to resume from`, 'no_recipe');
    const body = await parseBody(c, RetryBody, { optional: true });
    const active = await app.resumeStoppedRun(id, { trigger: body.trigger ?? 'retry' });
    active.promise.catch(() => { /* surfaced via run status */ });
    return c.json({ runId: active.run.id, run: active.run }, 202);
  });

  r.delete('/runs/:id', (c) => {
    const id = c.req.param('id');
    requireRun(app, id);
    if (app.activeRuns().some((a) => a.run.id === id)) throw conflict(`run "${id}" is still running; cancel it first`, 'run_active');
    app.storage.deleteRun(id);
    return c.json({ ok: true, id });
  });

  r.get('/runs/:id/rows', (c) => {
    const id = c.req.param('id');
    const run = requireRun(app, id);
    const q = parseQuery(c, RowsQuery);
    return sendRows(c, app, id, q, recipeOfRun(run));
  });

  r.get('/runs/:id/drift', (c) => {
    const id = c.req.param('id');
    requireRun(app, id);
    return c.json({ runId: id, drift: app.storage.listDrift(id) });
  });

  r.get('/runs/:id/requests', (c) => {
    const id = c.req.param('id');
    requireRun(app, id);
    const q = parseQuery(c, RequestsQuery);
    return c.json({ runId: id, counts: app.storage.queueCounts(id), requests: app.storage.listRequests(id, q) });
  });

  /** Diff against a previous run (default: previous run of the same recipe). */
  r.get('/runs/:id/diff', (c) => {
    const id = c.req.param('id');
    const run = requireRun(app, id);
    const q = parseQuery(c, DiffQuery);
    let prevId = q.against;
    if (prevId) requireRun(app, prevId);
    else {
      if (!run.recipeId) throw new ApiError(404, 'no_previous_run', `run "${id}" is ad-hoc; pass ?against=<runId>`);
      prevId = app.storage.previousRun(run.recipeId, id)?.id;
      if (!prevId) throw new ApiError(404, 'no_previous_run', `no previous run of recipe "${run.recipeId}" before "${id}"`);
    }
    const fields = q.fields ? q.fields.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const diff = app.diff(prevId, id, { fields, thresholdPercent: q.thresholdPercent, dataset: q.dataset });
    return c.json({
      runId: id, against: prevId, dataset: q.dataset ?? null,
      summary: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length, unchanged: diff.unchanged },
      ...diff,
    });
  });

  r.post('/runs/:id/export', async (c) => {
    const id = c.req.param('id');
    requireRun(app, id);
    const body = await parseBody(c, ExportBody);
    const results = await app.export(id, body.sinks);
    return c.json({ runId: id, exports: results });
  });

  return r;
}
