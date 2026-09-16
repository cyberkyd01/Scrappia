import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { safeParseRecipe, exampleRecipe, EXAMPLE_RECIPES, type Recipe, type Sink } from '@scrappia/core';
import { CliError } from './context.js';

export interface LoadedRecipe { input: unknown; source: string }

/**
 * Read a recipe from a JSON file. `example:<name>` loads a bundled example instead
 * (so `scrappia run example:books-toscrape` works without copying first).
 */
export function loadRecipeInput(file: string, saved?: (id: string) => unknown): LoadedRecipe {
  if (file.startsWith('recipe:')) {
    // `recipe:<id>` runs a recipe saved in the local store (what the desktop app's "Copy CLI" emits)
    const id = file.slice('recipe:'.length);
    const input = saved?.(id);
    if (!input) throw new CliError(`saved recipe "${id}" not found (see: scrappia recipes list)`);
    return { input, source: file };
  }
  if (file.startsWith('example:')) {
    const name = file.slice('example:'.length);
    if (!EXAMPLE_RECIPES[name]) throw new CliError(`unknown example "${name}". Available: ${Object.keys(EXAMPLE_RECIPES).join(', ')}`);
    return { input: exampleRecipe(name), source: file };
  }
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`recipe file not found: ${path}`);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new CliError(`cannot read ${path}: ${(e as Error).message}`); }
  try { return { input: JSON.parse(text), source: path }; }
  catch (e) { throw new CliError(`${path} is not valid JSON: ${(e as Error).message}`); }
}

/** Validate a recipe document; on failure the CliError message lists every zod issue. */
export function validateRecipe(input: unknown, source = 'recipe'): Recipe {
  const r = safeParseRecipe(input);
  if (!r.success) throw new CliError(formatValidationErrors(r.errors, source));
  return r.recipe;
}

export function formatValidationErrors(errors: string[], source: string): string {
  return `${source} is not a valid recipe (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n` + errors.map((e) => `  - ${e}`).join('\n');
}

export function loadRecipe(file: string, saved?: (id: string) => unknown): { recipe: Recipe; source: string } {
  const { input, source } = loadRecipeInput(file, saved);
  return { recipe: validateRecipe(input, source), source };
}

export type FileFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'xlsx' | 'xml' | 'parquet' | 'sqlite';
const FORMATS: FileFormat[] = ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xml', 'parquet', 'sqlite'];

export function formatFromPath(path: string, format?: string): FileFormat {
  const f = (format ?? extname(path).slice(1).toLowerCase() ?? '').replace(/^ndjson$/, 'jsonl');
  if (!f) throw new CliError(`cannot infer format from "${path}"; pass --format ${FORMATS.join('|')}`);
  if (!FORMATS.includes(f as FileFormat)) throw new CliError(`unsupported format "${f}" (${FORMATS.join('|')})`);
  return f as FileFormat;
}

/** Build a file sink for `--out <file>`; the path is made absolute so it lands relative to the cwd, not the data dir. */
export function fileSink(out: string, opts: { format?: string; mode?: string; key?: string; dataset?: string; table?: string } = {}): Sink {
  const path = resolve(out);
  const type = formatFromPath(path, opts.format);
  const mode = (opts.mode ?? 'overwrite') as 'append' | 'overwrite' | 'upsert';
  if (!['append', 'overwrite', 'upsert'].includes(mode)) throw new CliError(`--mode must be append|overwrite|upsert`);
  if (mode === 'upsert' && !opts.key) throw new CliError('--mode upsert needs --key <field>');
  const key = opts.key ? (opts.key.includes(',') ? opts.key.split(',').map((s) => s.trim()) : opts.key) : undefined;
  const base = { mode, key, dataset: opts.dataset, enabled: true as const };
  if (type === 'sqlite') return { type, path, table: opts.table ?? 'rows', ...base };
  return { type, path, ...base } as Sink;
}

export interface RunOverrides {
  pages?: number; maxRequests?: number; out?: string; format?: string; mode?: string; headed?: boolean; concurrency?: number; dryRun?: boolean;
}

/** Apply `scrappia run` flags to a parsed recipe (returns a modified copy). */
export function applyRunOverrides(recipe: Recipe, o: RunOverrides): Recipe {
  const r: Recipe = structuredClone(recipe);
  if (o.mode) {
    if (!['http', 'browser', 'auto'].includes(o.mode)) throw new CliError('--mode must be http|browser|auto');
    r.engine.mode = o.mode as Recipe['engine']['mode'];
  }
  if (o.headed) { r.engine.headless = false; if (r.engine.mode === 'http') r.engine.mode = 'browser'; }
  if (o.concurrency != null) r.engine.concurrency = Math.max(1, Math.min(64, o.concurrency));
  if (o.maxRequests != null) r.engine.maxRequests = o.maxRequests;
  if (o.pages != null) {
    const t = r.templates[r.entry.template];
    const p = t.pagination;
    if (!p) throw new CliError(`--pages given but entry template "${r.entry.template}" has no pagination`);
    if (p.type === 'loadMore') p.maxClicks = o.pages;
    else if (p.type === 'scroll') p.maxScrolls = o.pages;
    else if (p.type === 'urlList') p.urls = p.urls.slice(0, o.pages);
    else p.maxPages = o.pages;
  }
  if (o.out) r.sinks = [fileSink(o.out, { format: o.format })];
  return r;
}
