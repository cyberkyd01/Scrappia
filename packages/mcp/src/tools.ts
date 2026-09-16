import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  EXAMPLE_RECIPES, exampleRecipe, httpFetch, htmlToMarkdown, cleanHtml, safeParseRecipe, Scheduler, Sink as SinkSchema,
  type ScrappiaApp, type Recipe, type RecipeInput, type RunStatus, type Sink, type CopilotEvent, type CopilotTurnResult,
} from '@scrappia/core';
import { ok, fail, guard, asObject, parseRecipeOrFail, runSummary, selectorCandidate, truncateText } from './util.js';
import { copilotStoreFor, startCopilotSession, type CopilotStoreOptions } from './copilot.js';

export interface ToolOptions {
  /** Rows returned inline after a waited run_recipe / scrape_page (default 20). */
  rowsPreview?: number;
  /** Default wait timeout for run_recipe in seconds (default 300). */
  runTimeoutSeconds?: number;
  /** Copilot session store tuning (idle expiry, cap). Applied when the app's store is first created. */
  copilot?: CopilotStoreOptions;
}

const COPILOT_EVENT_TYPES = ['picked', 'list.detected', 'navigated', 'run.finished'] as const;

const recipeArg = z.union([z.record(z.any()), z.string()]).describe('A Scrappia recipe: JSON object (or a JSON string). Minimal shape: { "name", "entry": { "urls": [url], "template": "main" }, "templates": { "main": { "list": { "selector": [{"value": "css"}], "fields": [{ "name", "type": "text|href|src|attr|html|email|regex", "selector": [{"value": "css"}], "attr"? }] }, "pagination"? } } }. Use get_example / validate_recipe to learn the full schema.');

/** Which candidate matched each field, plus empty-value counts (the "did my selectors work" report). */
export function fieldReport(recipe: Recipe, res: { records: Array<Record<string, unknown>>; page: Record<string, unknown>; fieldMatches: Record<string, { candidate: number; matched: number }> }) {
  const t = recipe.templates[recipe.entry.template];
  const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const describe = (f: Recipe['templates'][string]['fields'][number], where: 'list' | 'page') => {
    const m = res.fieldMatches[f.name];
    const idx = m?.candidate ?? -1;
    const total = where === 'list' ? res.records.length : 1;
    const empty = where === 'list' ? res.records.filter((r) => isEmpty(r[f.name])).length : isEmpty(res.page[f.name]) ? 1 : 0;
    const status = !f.selector ? 'n/a' : !m || idx < 0 ? 'NO MATCH' : empty === total && total > 0 ? 'matched but empty' : idx > 0 ? `fallback candidate #${idx + 1}` : 'ok';
    return { field: f.name, where, type: f.type, matchedCandidate: f.selector?.[idx] ? `${f.selector[idx].kind}: ${f.selector[idx].value}` : null, matchedElements: m?.matched ?? 0, emptyValues: empty, status };
  };
  return [...(t.list?.fields ?? []).map((f) => describe(f, 'list')), ...t.fields.map((f) => describe(f, 'page'))];
}

export function registerTools(server: McpServer, app: ScrappiaApp, opts: ToolOptions = {}) {
  const rowsPreview = opts.rowsPreview ?? 20;
  const defaultTimeout = opts.runTimeoutSeconds ?? 300;
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  // ---------------- recipes ----------------
  server.registerTool('list_recipes', {
    title: 'List saved recipes',
    description: 'List recipes saved in the Scrappia store (id, name, version, timestamps, schedule). Use get_recipe for the full JSON.',
    inputSchema: {},
    annotations: ro,
  }, guard(async () => {
    const schedules = app.storage.listSchedules();
    return ok({ recipes: app.listRecipes().map((r) => ({ id: r.id, name: r.name, version: r.version, createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString(), schedule: schedules.find((s) => s.recipeId === r.id)?.cron ?? null })) });
  }));

  server.registerTool('get_recipe', {
    title: 'Get a saved recipe',
    description: 'Return the full JSON of a saved recipe by id (with schema defaults filled in).',
    inputSchema: { id: z.string().describe('recipe id from list_recipes') },
    annotations: ro,
  }, guard(async ({ id }) => {
    const { record, recipe } = app.getRecipe(id);
    if (!record || !recipe) return fail(`recipe "${id}" not found`);
    return ok({ id, version: record.version, updatedAt: new Date(record.updatedAt).toISOString(), recipe: { ...recipe, id } });
  }));

  server.registerTool('save_recipe', {
    title: 'Validate and save a recipe',
    description: 'Validate a recipe against the schema and save it to the store so it can be run by id, scheduled, monitored and exposed through the server. Saving under an existing id creates a new version. Returns validation errors instead of saving when the recipe is invalid.',
    inputSchema: {
      recipe: recipeArg,
      id: z.string().optional().describe('recipe id to create or update; default: recipe.id or a generated id'),
      note: z.string().optional().describe('version note'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ recipe, id, note }) => {
    const r = parseRecipeOrFail(recipe);
    if ('error' in r) return r.error;
    const rec = app.saveRecipe(r.recipe, { id, note });
    return ok({ saved: true, id: rec.id, name: rec.name, version: rec.version, schedule: r.recipe.schedule ?? null });
  }));

  server.registerTool('delete_recipe', {
    title: 'Delete a saved recipe',
    description: 'Delete a saved recipe and its schedule. Run history is kept.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ id }) => {
    if (!app.getRecipe(id).record) return fail(`recipe "${id}" not found`);
    app.deleteRecipe(id);
    return ok({ deleted: true, id });
  }));

  server.registerTool('validate_recipe', {
    title: 'Validate a recipe',
    description: 'Check a recipe against the Scrappia schema without saving or running it. Returns { valid, errors[] } and a short structural summary (templates, fields, pagination, sinks). Call this after editing a recipe and before run_recipe.',
    inputSchema: { recipe: recipeArg },
    annotations: ro,
  }, guard(async ({ recipe }) => {
    let input: Record<string, unknown>;
    try { input = asObject(recipe); } catch (e) { return ok({ valid: false, errors: [(e as Error).message] }); }
    const r = safeParseRecipe(input);
    if (!r.success) return ok({ valid: false, errors: r.errors });
    const templates = Object.fromEntries(Object.entries(r.recipe.templates).map(([n, t]) => [n, { listSelector: t.list?.selector.map((c) => c.value) ?? null, listFields: t.list?.fields.map((f) => f.name) ?? [], pageFields: t.fields.map((f) => f.name), pagination: t.pagination?.type ?? null, follows: [...t.follow, ...(t.list?.follow ?? [])].map((f) => f.template), actions: t.actions.length, needsBrowser: t.mode === 'browser' || t.actions.length > 0 || !!t.waitFor || ['loadMore', 'scroll', 'script'].includes(t.pagination?.type ?? '') }]));
    return ok({ valid: true, name: r.recipe.name, entry: r.recipe.entry, mode: r.recipe.engine.mode, templates, sinks: r.recipe.sinks.map((s) => s.type), schedule: r.recipe.schedule ?? null });
  }));

  // ---------------- runs ----------------
  server.registerTool('run_recipe', {
    title: 'Run a recipe',
    description: 'Start a scrape from a saved recipe id or an inline recipe. By default waits for completion (up to timeoutSeconds) and returns the run summary plus the first rows; if the run is still going when the timeout hits, it keeps running in the background and you can poll get_run / get_rows or cancel_run. Use maxRequests for a quick trial (e.g. 3) before a full run. Sinks in the recipe (files, databases, webhooks) are written unless dryRun is true.',
    inputSchema: {
      recipeId: z.string().optional().describe('id of a saved recipe'),
      recipe: recipeArg.optional().describe('inline recipe (alternative to recipeId)'),
      maxRequests: z.number().int().positive().optional().describe('hard cap on pages fetched (trial runs)'),
      dryRun: z.boolean().optional().describe('skip sinks, monitoring and alerts; rows are still stored and returned'),
      wait: z.boolean().default(true).describe('wait for the run to finish (default true)'),
      timeoutSeconds: z.number().positive().optional().describe(`max seconds to wait (default ${defaultTimeout})`),
      rowsPreview: z.number().int().min(0).max(200).optional().describe(`rows to include when waited (default ${rowsPreview})`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guard(async ({ recipeId, recipe, maxRequests, dryRun, wait, timeoutSeconds, rowsPreview: rp }) => {
    let target: string | Recipe;
    if (recipeId) { if (!app.getRecipe(recipeId).record) return fail(`recipe "${recipeId}" not found`); target = recipeId; }
    else if (recipe != null) { const r = parseRecipeOrFail(recipe); if ('error' in r) return r.error; target = r.recipe; }
    else return fail('provide recipeId or recipe');
    const active = await app.startRun(target, { maxRequests, dryRun, trigger: 'mcp' });
    const runId = active.run.id;
    if (!wait) return ok({ runId, status: 'running', hint: 'poll get_run(runId) or get_rows(runId); cancel_run(runId) to stop' });
    const timeoutMs = (timeoutSeconds ?? defaultTimeout) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
    const result = await Promise.race([active.promise.catch((e) => ({ error: (e as Error).message })), timeout]);
    if (timer) clearTimeout(timer);
    if (result === 'timeout') return ok({ runId, status: 'running', timedOut: true, stats: app.getRun(runId)?.stats, hint: 'still running; poll get_run / get_rows or cancel_run' });
    const run = app.getRun(runId)!;
    const limit = rp ?? rowsPreview;
    return ok({ run: runSummary(run), datasets: app.storage.datasets(runId), drift: app.storage.listDrift(runId).slice(0, 20).map((d) => ({ kind: d.kind, template: d.template, field: d.field, detail: d.detail })), rows: limit ? app.rows(runId, undefined, { limit }) : [], hint: run.status === 'succeeded' ? `get_rows(runId) pages through all ${(run.stats as { rows?: number }).rows ?? 0} rows; export_run writes them to a file` : run.status === 'failed' || run.status === 'partial' ? 'check drift and run.error; preview_extract helps fix selectors' : undefined });
  }));

  server.registerTool('get_run', {
    title: 'Get run status',
    description: 'Status, stats (rows, pages, failed requests, drift, exports), datasets and error of a run.',
    inputSchema: { runId: z.string() },
    annotations: ro,
  }, guard(async ({ runId }) => {
    const run = app.getRun(runId);
    if (!run) return fail(`run "${runId}" not found`);
    return ok({ run: runSummary(run), datasets: app.storage.datasets(runId), active: app.activeRuns().some((a) => a.run.id === runId) });
  }));

  server.registerTool('list_runs', {
    title: 'List runs',
    description: 'Run history, newest first. Filter by recipeId and/or status (running|succeeded|partial|failed|cancelled).',
    inputSchema: { recipeId: z.string().optional(), status: z.enum(['running', 'succeeded', 'partial', 'failed', 'cancelled']).optional(), limit: z.number().int().min(1).max(200).default(20) },
    annotations: ro,
  }, guard(async ({ recipeId, status, limit }) => ok({ runs: app.listRuns({ recipeId, status: status as RunStatus | undefined, limit }).map(runSummary) })));

  server.registerTool('cancel_run', {
    title: 'Cancel a running run',
    description: 'Cancel an active run gracefully (rows collected so far are kept; the run can be resumed later from the CLI).',
    inputSchema: { runId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ runId }) => {
    const found = app.cancelRun(runId);
    return found ? ok({ cancelled: true, runId }) : fail(`run "${runId}" is not active`);
  }));

  server.registerTool('get_rows', {
    title: 'Get rows of a run',
    description: 'Page through the rows a run produced. Multi-dataset recipes (follow mode "separate") need dataset; see get_run.datasets.',
    inputSchema: { runId: z.string(), dataset: z.string().optional(), limit: z.number().int().min(1).max(500).default(50), offset: z.number().int().min(0).default(0) },
    annotations: ro,
  }, guard(async ({ runId, dataset, limit, offset }) => {
    if (!app.getRun(runId)) return fail(`run "${runId}" not found`);
    const total = app.storage.countRows(runId, dataset);
    const rows = app.rows(runId, dataset, { limit, offset });
    return ok({ runId, dataset: dataset ?? null, total, offset, count: rows.length, hasMore: offset + rows.length < total, rows });
  }));

  server.registerTool('get_drift', {
    title: 'Get drift events',
    description: 'Selector drift telemetry of a run: fields that matched nothing (field-missing), empty lists (list-empty), fallback candidates used, AI repairs (healed / heal-failed) and validation flags. Use it to diagnose why rows are missing or empty.',
    inputSchema: { runId: z.string() },
    annotations: ro,
  }, guard(async ({ runId }) => {
    if (!app.getRun(runId)) return fail(`run "${runId}" not found`);
    return ok({ runId, events: app.storage.listDrift(runId).map((d) => ({ kind: d.kind, template: d.template, field: d.field, detail: d.detail, pageUrl: d.pageUrl, at: new Date(d.createdAt).toISOString() })) });
  }));

  server.registerTool('diff_runs', {
    title: 'Diff two runs',
    description: 'Compare rows of two runs of the same recipe keyed by output.keys: counts of added / removed / changed / unchanged plus samples. Useful for change monitoring ("what changed since yesterday").',
    inputSchema: { runIdA: z.string().describe('earlier run'), runIdB: z.string().describe('later run'), fields: z.array(z.string()).optional().describe('only compare these fields'), thresholdPercent: z.number().optional().describe('ignore numeric changes smaller than this percent'), dataset: z.string().optional(), sampleLimit: z.number().int().min(0).max(200).default(20) },
    annotations: ro,
  }, guard(async ({ runIdA, runIdB, fields, thresholdPercent, dataset, sampleLimit }) => {
    for (const id of [runIdA, runIdB]) if (!app.getRun(id)) return fail(`run "${id}" not found`);
    const d = app.diff(runIdA, runIdB, { fields, thresholdPercent, dataset });
    return ok({ added: d.added.length, removed: d.removed.length, changed: d.changed.length, unchanged: d.unchanged, samples: { added: d.added.slice(0, sampleLimit), removed: d.removed.slice(0, sampleLimit), changed: d.changed.slice(0, sampleLimit).map((c) => ({ key: c.key, fields: c.fields })) } });
  }));

  // ---------------- quick extraction ----------------
  server.registerTool('preview_extract', {
    title: 'Preview extraction (HTTP only, fast)',
    description: 'Fetch ONE page over plain HTTP (no browser) and run the entry template against it. Returns extracted records plus a per-field report (which selector candidate matched, how many elements, how many empty values). This is the fastest way to iterate on selectors: edit the recipe, call preview_extract, repeat until the report is all "ok", then save_recipe / run_recipe. Pages that need JavaScript will show few or no records; set engine.mode "browser" in the recipe and use run_recipe with maxRequests 1 instead.',
    inputSchema: { recipe: recipeArg, url: z.string().url().optional().describe('page to fetch (default: the first entry url)'), limit: z.number().int().min(1).max(200).default(20).describe('records to return') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ recipe, url, limit }) => {
    const r = parseRecipeOrFail(recipe);
    if ('error' in r) return r.error;
    const res = await app.preview(r.recipe, url);
    const t = r.recipe.templates[r.recipe.entry.template];
    return ok({ url: res.url, httpStatus: res.status, listMatched: t.list ? res.listMatched : null, totalRecords: res.records.length, records: res.records.slice(0, limit), pageFields: res.page, fields: fieldReport(r.recipe, res), hint: t.list && res.listMatched === 0 ? 'list selector matched nothing: check it with fetch_page_html, or the page may need a browser' : undefined });
  }));

  server.registerTool('scrape_page', {
    title: 'Scrape one page ad hoc',
    description: 'Extract fields from a single URL without writing a full recipe. Give a listSelector (CSS/XPath of each repeating record) plus fields relative to it to get one row per record, or omit listSelector to get one row of page-level fields. Selectors are CSS by default; prefix with "xpath:" for XPath. mode "http" is fastest; "browser" renders JavaScript; "auto" (default) tries HTTP and falls back to a browser when the list matches nothing. Returns rows, drift diagnostics and the run id (rows are also stored, so get_rows/export_run work).',
    inputSchema: {
      url: z.string().url(),
      fields: z.array(z.object({
        name: z.string(),
        selector: z.string().describe('CSS (default) or "xpath:..." selector, relative to the record when listSelector is set'),
        type: z.enum(['text', 'html', 'attr', 'href', 'src', 'email', 'phone', 'regex', 'count', 'exists', 'json', 'table']).default('text'),
        attr: z.string().optional().describe('attribute name for type "attr"'),
        pattern: z.string().optional().describe('regex for type "regex"'),
        multiple: z.boolean().optional().describe('capture all matches as an array'),
      })).min(1),
      listSelector: z.string().optional().describe('selector of each repeating record (e.g. "article.product", "tr.row")'),
      mode: z.enum(['http', 'browser', 'auto']).default('auto'),
      waitFor: z.string().optional().describe('browser mode: CSS selector to wait for before extracting'),
      limit: z.number().int().min(1).max(500).default(100).describe('max records'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ url, fields, listSelector, mode, waitFor, limit }) => {
    const mk = (f: (typeof fields)[number]) => ({ name: f.name, type: f.type, attr: f.attr, pattern: f.pattern, multiple: f.multiple ?? false, selector: [selectorCandidate(f.selector)] });
    const template: RecipeInput['templates'][string] = listSelector
      ? { list: { selector: [selectorCandidate(listSelector)], fields: fields.map(mk), limit }, waitFor: waitFor ? [{ kind: 'css', value: waitFor }] : undefined }
      : { fields: fields.map(mk), waitFor: waitFor ? [{ kind: 'css', value: waitFor }] : undefined };
    const input: RecipeInput = { name: `scrape_page ${new URL(url).hostname}`, entry: { urls: [url], template: 'main' }, engine: { mode, concurrency: 1, delayMs: 0, jitterMs: 0, retries: 1, maxRequests: 1 }, templates: { main: template }, output: { dedupe: false } };
    const r = safeParseRecipe(input);
    if (!r.success) return fail('could not build recipe', { errors: r.errors });
    const active = await app.startRun(r.recipe, { maxRequests: 1, dryRun: true, trigger: 'mcp-scrape' });
    const { run } = await active.promise;
    const rows = app.rows(run.id, undefined, { limit });
    const drift = app.storage.listDrift(run.id).map((d) => ({ kind: d.kind, field: d.field, detail: d.detail }));
    return ok({ runId: run.id, status: run.status, error: run.error ?? undefined, url, count: rows.length, rows, drift, hint: !rows.length ? 'no rows: check selectors with fetch_page_html / preview_extract, or try mode "browser"' : undefined });
  }));

  server.registerTool('fetch_page_markdown', {
    title: 'Fetch a page as Markdown',
    description: 'Fetch a URL over HTTP and convert the HTML to compact Markdown (scripts, styles, nav/footer removed; links kept). Best first step to understand a page\'s content before designing selectors. JavaScript-rendered content will be missing; use scrape_page with mode "browser" for that.',
    inputSchema: { url: z.string().url(), maxChars: z.number().int().min(500).max(200_000).default(20_000), mainContent: z.boolean().default(false).describe('keep only the main article (Readability); off by default so lists outside <main> are kept'), keepLinks: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ url, maxChars, mainContent, keepLinks }) => {
    const res = await httpFetch(url, { timeoutMs: 30_000 });
    const md = htmlToMarkdown(res.body, res.url, { maxChars, mainContent, keepLinks });
    return { content: [{ type: 'text', text: `URL: ${res.url}\nHTTP ${res.status} ${res.contentType} (${res.bytes} bytes)\n\n${md}` }] };
  }));

  server.registerTool('fetch_page_html', {
    title: 'Fetch a page as cleaned HTML',
    description: 'Fetch a URL over HTTP and return simplified HTML (scripts/styles/comments removed, attributes reduced to href/src/alt/title/itemprop/name/content...). Use it to see the actual element structure when writing CSS selectors. Note class and id attributes are stripped in the cleaned view; set raw=true to get the untouched HTML (truncated) when you need class names.',
    inputSchema: { url: z.string().url(), maxChars: z.number().int().min(500).max(400_000).default(40_000), raw: z.boolean().default(false).describe('return the original HTML instead of the cleaned version'), stripChrome: z.boolean().default(false).describe('also remove nav/header/footer/aside') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ url, maxChars, raw, stripChrome }) => {
    const res = await httpFetch(url, { timeoutMs: 30_000 });
    const html = raw ? truncateText(res.body, maxChars) : cleanHtml(res.body, res.url, { maxChars, stripChrome });
    return { content: [{ type: 'text', text: `URL: ${res.url}\nHTTP ${res.status} ${res.contentType} (${res.bytes} bytes)\n\n${html}` }] };
  }));

  // ---------------- AI ----------------
  server.registerTool('generate_recipe', {
    title: 'Generate a recipe with AI',
    description: 'Fetch a page and ask the configured LLM provider to draft a recipe from a natural-language instruction (e.g. "name, price and link of each product"). Returns the draft (validated, defaults filled) plus a preview of what it extracts; refine it with preview_extract and then save_recipe. Fails when Scrappia has no AI provider configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY or use the CLI: scrappia ai add).',
    inputSchema: { url: z.string().url(), instruction: z.string().min(3), provider: z.string().optional().describe('provider name from settings'), save: z.boolean().default(false).describe('save the draft to the store when valid') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guard(async ({ url, instruction, provider, save }) => {
    const svc = app.ai();
    if (!svc) return fail('no AI provider configured: set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST or run `scrappia ai add`');
    const page = await httpFetch(url, { timeoutMs: 30_000 });
    if (page.status >= 400) return fail(`fetch failed: HTTP ${page.status}`);
    const draft = await svc.generateRecipe({ url: page.url, html: page.body, instruction, providerName: provider });
    const v = safeParseRecipe(draft);
    if (!v.success) return ok({ valid: false, errors: v.errors, recipe: draft });
    const preview = await app.preview(v.recipe, page.url).catch((e) => ({ error: (e as Error).message }));
    const saved = save ? app.saveRecipe(v.recipe, { note: 'generated by AI' }) : undefined;
    return ok({ valid: true, recipe: v.recipe, savedId: saved?.id, preview: 'error' in preview ? preview : { totalRecords: preview.records.length, records: preview.records.slice(0, 5), fields: fieldReport(v.recipe, preview) } });
  }));

  server.registerTool('ask_page', {
    title: 'Ask a question about a page',
    description: 'Fetch a URL and answer a free-form question strictly from its content using the configured LLM (optionally as JSON matching a schema). Requires an AI provider.',
    inputSchema: { url: z.string().url(), question: z.string().min(1), schema: z.record(z.any()).optional().describe('JSON schema for a structured answer'), provider: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ url, question, schema, provider }) => {
    const svc = app.ai();
    if (!svc) return fail('no AI provider configured');
    const page = await httpFetch(url, { timeoutMs: 30_000 });
    const answer = await svc.ask({ html: page.body, url: page.url, question, schema, providerName: provider });
    return ok(typeof answer === 'string' ? answer : { answer });
  }));

  // ---------------- export / examples ----------------
  server.registerTool('export_run', {
    title: 'Export a run',
    description: `Write the rows of a finished run to one or more sinks. Sink examples: {"type":"csv","path":"/abs/out.csv"}, {"type":"xlsx","path":"out.xlsx"}, {"type":"jsonl","path":"out.jsonl"}, {"type":"json","path":"out.json","pretty":true}, {"type":"sqlite","path":"data.db","table":"rows"}, {"type":"postgres","connectionRef":"PG_URL","table":"rows","mode":"upsert","key":"url"}, {"type":"webhook","url":"https://..."}. Relative file paths resolve against the Scrappia data directory (${app.dataDir}); prefer absolute paths.`,
    inputSchema: { runId: z.string(), sinks: z.array(z.record(z.any())).min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ runId, sinks }) => {
    if (!app.getRun(runId)) return fail(`run "${runId}" not found`);
    const parsed: Sink[] = [];
    for (const s of sinks) { const r = SinkSchema.safeParse(s); if (!r.success) return fail('invalid sink', { sink: s, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }); parsed.push(r.data); }
    const results = await app.export(runId, parsed);
    return ok({ runId, results });
  }));

  server.registerTool('list_examples', {
    title: 'List example recipes',
    description: 'Bundled example recipes demonstrating pagination, detail-page follow, infinite scroll, keyword search and monitoring. Use get_example to read one as a template.',
    inputSchema: {},
    annotations: ro,
  }, guard(async () => ok({ examples: Object.entries(EXAMPLE_RECIPES).map(([name, r]) => ({ name, title: r.name, description: r.description, mode: r.engine?.mode ?? 'auto', tags: r.tags ?? [] })) })));

  server.registerTool('get_example', {
    title: 'Get an example recipe',
    description: 'Return an example recipe JSON (see list_examples).',
    inputSchema: { name: z.string() },
    annotations: ro,
  }, guard(async ({ name }) => {
    if (!EXAMPLE_RECIPES[name]) return fail(`unknown example "${name}"; available: ${Object.keys(EXAMPLE_RECIPES).join(', ')}`);
    return ok({ name, recipe: exampleRecipe(name) });
  }));

  // ---------------- schedules / alerts ----------------
  server.registerTool('list_schedules', {
    title: 'List schedules',
    description: 'Cron schedules attached to saved recipes with next/last run times. Schedules execute while `scrappia serve-scheduler`, the server or the desktop app is running.',
    inputSchema: {},
    annotations: ro,
  }, guard(async () => ok({ schedules: app.storage.listSchedules().map((s) => { let next: Date | undefined; try { next = Scheduler.preview(s.cron, s.tz, 1)[0]; } catch { next = undefined; } return { id: s.id, recipeId: s.recipeId, recipeName: app.getRecipe(s.recipeId).record?.name, cron: s.cron, tz: s.tz ?? null, enabled: s.enabled, skipIfRunning: s.skipIfRunning, nextRunAt: s.enabled && next ? next.toISOString() : null, lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null }; }) })));

  server.registerTool('set_schedule', {
    title: 'Set a recipe schedule',
    description: 'Create, replace, disable or remove the cron schedule of a saved recipe. cron uses 5 fields ("0 */6 * * *" = every 6 hours) or nicknames (@hourly, @daily). Set enabled=false to pause, remove=true to delete.',
    inputSchema: { recipeId: z.string(), cron: z.string().optional(), tz: z.string().optional().describe('IANA time zone, e.g. Europe/Berlin'), enabled: z.boolean().default(true), skipIfRunning: z.boolean().default(true), remove: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ recipeId, cron, tz, enabled, skipIfRunning, remove }) => {
    if (!app.getRecipe(recipeId).record) return fail(`recipe "${recipeId}" not found (save_recipe first)`);
    const existing = app.storage.listSchedules().find((s) => s.recipeId === recipeId);
    if (remove) { if (existing) app.storage.deleteSchedule(existing.id); app.scheduler.reload(); return ok({ removed: !!existing, recipeId }); }
    const expr = cron ?? existing?.cron;
    if (!expr) return fail('cron is required');
    let next: Date[];
    try { next = Scheduler.preview(expr, tz ?? existing?.tz, 3); } catch (e) { return fail(`invalid cron "${expr}": ${(e as Error).message}`); }
    const rec = app.storage.upsertSchedule({ id: existing?.id, recipeId, cron: expr, tz: tz ?? existing?.tz, enabled, skipIfRunning });
    app.scheduler.reload();
    return ok({ schedule: { id: rec.id, recipeId, cron: expr, tz: rec.tz ?? null, enabled }, nextRuns: next.map((d) => d.toISOString()) });
  }));

  // ---------------- copilot ----------------
  const copilot = copilotStoreFor(app, opts.copilot);
  const turnView = (sessionId: string, r: CopilotTurnResult) => ({ sessionId, reply: r.reply, recipe: r.recipe, actions: r.actions, waitingForPicks: r.waitingForPicks, runId: r.runId, done: r.done, usage: r.usage });

  server.registerTool('copilot_start', {
    title: 'Start a copilot session',
    description: 'Open a Scrappia Copilot session: a conversational scraper builder that inspects the page, writes the recipe (list, fields, pagination, detail pages, exports), verifies it with previews and test runs, and starts the run for you. Give a url (a blank recipe is created) or an existing recipe to continue. Then call copilot_turn with what you want in plain language. Needs an AI provider. No browser here: element picking is unavailable, everything else works.',
    inputSchema: {
      url: z.string().url().optional().describe('page to start from (listing page)'),
      recipe: recipeArg.optional().describe('existing recipe to continue working on'),
      provider: z.string().optional().describe('AI provider name from settings (default: the default provider)'),
      instructions: z.string().max(8000).optional().describe('extra guidance for the copilot (preferences, constraints)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guard(async ({ url, recipe, provider, instructions }) => {
    let parsed: Recipe | undefined;
    if (recipe != null) { const r = parseRecipeOrFail(recipe); if ('error' in r) return r.error; parsed = r.recipe; }
    const rec = startCopilotSession(app, copilot, { url, recipe: parsed, provider, instructions });
    return ok({ sessionId: rec.id, provider: rec.provider, recipe: rec.recipe, hint: 'Call copilot_turn(sessionId, message) with the goal, e.g. "scrape all products with name, price and link, all pages, export to xlsx, then run".' });
  }));

  server.registerTool('copilot_turn', {
    title: 'Talk to the copilot',
    description: 'Send a message (or a client event) to a copilot session. The copilot may run many of its own tools in one turn (detect_lists, set_list, preview, set_pagination, add_follow, add_sink, test_run, start_run...); `actions` lists what it did and whether each step succeeded, `recipe` is the updated working recipe, `runId` is set when a full run was started (then use get_run / get_rows), `done` when it considers the job complete. Pass `recipe` to replace the working recipe before the turn.',
    inputSchema: {
      sessionId: z.string().describe('from copilot_start'),
      message: z.string().max(20_000).optional().describe('what the user wants, or the answer to the copilot question'),
      event: z.object({ type: z.enum(COPILOT_EVENT_TYPES) }).passthrough().optional().describe('client-side event (picked, list.detected, navigated, run.finished)'),
      recipe: recipeArg.optional().describe('replace the working recipe first'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guard(async ({ sessionId, message, event, recipe }) => {
    const s = copilot.get(sessionId);
    if (!s) return fail(`copilot session "${sessionId}" not found (expired or ended); call copilot_start`);
    if (!message?.trim() && !event) return fail('message or event is required');
    let working = s.recipe;
    if (recipe != null) { const r = parseRecipeOrFail(recipe); if ('error' in r) return r.error; working = r.recipe; }
    const result = await s.session.turn({ message, event: event as CopilotEvent | undefined, recipe: working });
    s.recipe = result.recipe;
    copilot.touch(s);
    return ok(turnView(sessionId, result));
  }));

  server.registerTool('copilot_end', {
    title: 'End a copilot session',
    description: 'Close a copilot session and return its final recipe and the runs it started. Sessions also expire after 60 minutes idle.',
    inputSchema: { sessionId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ sessionId }) => {
    const s = copilot.get(sessionId);
    if (!s) return fail(`copilot session "${sessionId}" not found`);
    copilot.delete(sessionId);
    return ok({ ended: true, sessionId, recipe: s.recipe, runIds: s.runIds });
  }));

  server.registerTool('list_alerts', {
    title: 'List alerts',
    description: 'Monitoring alerts raised by runs (changes detected, layout drift, failures, empty results). Set markRead to acknowledge them.',
    inputSchema: { unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50), markRead: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ unreadOnly, limit, markRead }) => {
    const alerts = app.storage.listAlerts({ unreadOnly, limit });
    if (markRead && alerts.length) app.storage.markAlertsRead(alerts.map((a) => a.id));
    return ok({ alerts: alerts.map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, runId: a.runId, recipeId: a.recipeId, read: a.read, at: new Date(a.createdAt).toISOString(), detail: a.detail })) });
  }));
}
