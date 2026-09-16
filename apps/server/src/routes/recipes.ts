import { Hono } from 'hono';
import { z } from 'zod';
import type { Recipe, RecipeInput, ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { ApiError, conflict, notFound } from '../errors.js';
import { parseBody, parseQuery, readJson } from '../util.js';
import { RowsQuery, sendRows } from './rows.js';

const RunBody = z.object({
  trigger: z.string().min(1).max(64).optional(),
  maxRequests: z.number().int().min(1).optional(),
  dryRun: z.boolean().optional(),
});

const PreviewBody = z.object({ url: z.string().url().optional() });

/** Validate an arbitrary body as a recipe; 400 with the core's error list on failure. */
export function validateRecipeOrThrow(app: ScrappiaApp, raw: unknown): Recipe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'invalid_recipe', 'Recipe must be a JSON object');
  const v = app.validateRecipe(raw);
  if (!v.success) throw new ApiError(400, 'invalid_recipe', 'Recipe validation failed', v.errors);
  return v.recipe;
}

export function requireRecipe(app: ScrappiaApp, id: string) {
  const r = app.getRecipe(id);
  if (!r.record || !r.recipe) throw notFound('recipe', id);
  return { record: r.record, recipe: r.recipe };
}

export function recipeRoutes(app: ScrappiaApp) {
  const r = new Hono<AppEnv>();

  r.get('/recipes', (c) => c.json({ recipes: app.listRecipes() }));

  r.post('/recipes/validate', async (c) => {
    const raw = await readJson(c);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ valid: false, errors: ['(root): recipe must be a JSON object'] });
    const v = app.validateRecipe(raw);
    return v.success ? c.json({ valid: true, errors: [], recipe: v.recipe }) : c.json({ valid: false, errors: v.errors });
  });

  r.post('/recipes', async (c) => {
    const raw = await readJson(c);
    const recipe = validateRecipeOrThrow(app, raw);
    if (recipe.id && app.storage.getRecipe(recipe.id)) throw conflict(`recipe "${recipe.id}" already exists; use PUT /api/recipes/${recipe.id}`, 'already_exists');
    const record = app.saveRecipe(recipe as RecipeInput, { id: recipe.id, note: c.req.query('note') ?? 'created via API' });
    return c.json({ recipe: record }, 201);
  });

  r.get('/recipes/:id', (c) => {
    const { record } = requireRecipe(app, c.req.param('id'));
    return c.json({ recipe: record });
  });

  r.put('/recipes/:id', async (c) => {
    const id = c.req.param('id');
    requireRecipe(app, id);
    const raw = await readJson(c);
    const recipe = validateRecipeOrThrow(app, raw);
    const record = app.saveRecipe({ ...recipe, id } as RecipeInput, { id, note: c.req.query('note') ?? 'updated via API' });
    return c.json({ recipe: record });
  });

  r.delete('/recipes/:id', (c) => {
    const id = c.req.param('id');
    requireRecipe(app, id);
    if (app.activeRuns().some((a) => a.recipeId === id)) throw conflict(`recipe "${id}" has an active run; cancel it first`, 'run_active');
    app.deleteRecipe(id);
    return c.json({ ok: true, id });
  });

  r.get('/recipes/:id/versions', (c) => {
    const id = c.req.param('id');
    requireRecipe(app, id);
    return c.json({ id, versions: app.storage.listRecipeVersions(id) });
  });

  r.post('/recipes/:id/run', async (c) => {
    const id = c.req.param('id');
    requireRecipe(app, id);
    const body = await parseBody(c, RunBody, { optional: true });
    const active = await app.startRun(id, { trigger: body.trigger ?? 'api', maxRequests: body.maxRequests, dryRun: body.dryRun });
    active.promise.catch(() => { /* surfaced via run status */ });
    return c.json({ runId: active.run.id, run: active.run }, 202);
  });

  r.post('/recipes/:id/preview', async (c) => {
    const { recipe } = requireRecipe(app, c.req.param('id'));
    const body = await parseBody(c, PreviewBody, { optional: true });
    const result = await app.preview(recipe, body.url);
    return c.json(result);
  });

  /** "Any scrape is an API endpoint": rows of the latest succeeded/partial run. */
  r.get('/recipes/:id/dataset/latest', (c) => {
    const id = c.req.param('id');
    const { recipe } = requireRecipe(app, id);
    const q = parseQuery(c, RowsQuery);
    const latest = app.listRuns({ recipeId: id, limit: 200 }).find((run) => run.status === 'succeeded' || run.status === 'partial');
    if (!latest) throw new ApiError(404, 'no_dataset', `recipe "${id}" has no succeeded or partial run yet`);
    c.header('X-Scrappia-Run', latest.id);
    c.header('X-Scrappia-Run-Status', latest.status);
    if (latest.finishedAt) c.header('X-Scrappia-Run-Finished', new Date(latest.finishedAt).toISOString());
    return sendRows(c, app, latest.id, q, recipe);
  });

  return r;
}
