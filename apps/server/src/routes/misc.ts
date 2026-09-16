import { Hono } from 'hono';
import { z } from 'zod';
import { EXAMPLE_RECIPES, httpFetch, sinkTypes, type ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../util.js';

const GenerateBody = z.object({
  url: z.string().url(),
  instruction: z.string().min(1).max(4000),
  provider: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});

const AskBody = z.object({
  url: z.string().url(),
  question: z.string().min(1).max(4000),
  schema: z.record(z.any()).optional(),
  provider: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});

function requireAi(app: ScrappiaApp) {
  const ai = app.ai();
  if (!ai) throw new ApiError(400, 'ai_not_configured', 'No AI provider configured. Add one via PUT /api/settings (ai.providers) or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST.');
  return ai;
}

async function fetchPage(url: string, timeoutMs: number) {
  let res: Awaited<ReturnType<typeof httpFetch>>;
  try { res = await httpFetch(url, { timeoutMs }); }
  catch (e) { throw new ApiError(502, 'fetch_failed', `Could not fetch ${url}: ${(e as Error).message}`); }
  if (res.status >= 400) throw new ApiError(502, 'fetch_failed', `Fetching ${url} returned HTTP ${res.status}`);
  return res;
}

export function miscRoutes(app: ScrappiaApp) {
  const r = new Hono<AppEnv>();

  r.get('/examples', (c) => c.json({ examples: Object.entries(EXAMPLE_RECIPES).map(([name, recipe]) => ({ name, recipe })) }));

  r.get('/sink-types', (c) => c.json({ types: sinkTypes() }));

  /** Natural language -> recipe draft from a fetched sample page. */
  r.post('/ai/generate', async (c) => {
    const body = await parseBody(c, GenerateBody);
    const ai = requireAi(app);
    const page = await fetchPage(body.url, body.timeoutMs);
    const draft = await ai.generateRecipe({ url: page.url, html: page.body, instruction: body.instruction, providerName: body.provider });
    const v = app.validateRecipe(draft);
    return c.json({ recipe: v.success ? v.recipe : draft, valid: v.success, errors: v.success ? [] : v.errors, fetched: { url: page.url, status: page.status, bytes: page.bytes } });
  });

  /** Free-form question over a fetched page; optional JSON schema for structured output. */
  r.post('/ai/ask', async (c) => {
    const body = await parseBody(c, AskBody);
    const ai = requireAi(app);
    const page = await fetchPage(body.url, body.timeoutMs);
    const answer = await ai.ask({ url: page.url, html: page.body, question: body.question, schema: body.schema, providerName: body.provider });
    return c.json({ answer, fetched: { url: page.url, status: page.status, bytes: page.bytes }, usage: ai.usage });
  });

  return r;
}
