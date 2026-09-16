import type { Command } from 'commander';
import type { Recipe } from '@scrappia/core';
import type { CliContext } from '../context.js';
import { CliError, parseIntOpt } from '../context.js';
import { loadRecipe, loadRecipeInput, validateRecipe } from '../recipe.js';
import { safeParseRecipe } from '@scrappia/core';
import { json, table, kv, cell } from '../ui.js';

export interface FieldReport { field: string; where: 'list' | 'page'; candidate: string; matched: number; empty: number; status: string }

/** Build the per-field match report from a preview result. */
export function fieldReport(recipe: Recipe, res: { records: Array<Record<string, unknown>>; page: Record<string, unknown>; fieldMatches: Record<string, { candidate: number; matched: number }> }): FieldReport[] {
  const t = recipe.templates[recipe.entry.template];
  const out: FieldReport[] = [];
  const describe = (f: Recipe['templates'][string]['fields'][number], where: 'list' | 'page') => {
    const m = res.fieldMatches[f.name];
    const idx = m?.candidate ?? -1;
    const cand = f.selector?.[idx];
    const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
    const empty = where === 'list' ? res.records.filter((r) => isEmpty(r[f.name])).length : isEmpty(res.page[f.name]) ? 1 : 0;
    const total = where === 'list' ? res.records.length : 1;
    const needsSelector = !!f.selector;
    let status: string;
    if (!needsSelector) status = 'n/a';
    else if (!m || idx < 0) status = 'NO MATCH';
    else if (empty === total && total > 0) status = 'matched but empty';
    else if (idx > 0) status = `fallback #${idx + 1}`;
    else status = 'ok';
    out.push({ field: f.name, where, candidate: cand ? `${cand.kind}: ${cand.value}` : needsSelector ? `(${f.selector!.length} candidates)` : f.type, matched: m?.matched ?? 0, empty, status });
  };
  for (const f of t.list?.fields ?? []) describe(f, 'list');
  for (const f of t.fields) describe(f, 'page');
  return out;
}

export function registerPreviewCommands(program: Command, ctx: () => CliContext) {
  program
    .command('preview')
    .description('Fetch one page over HTTP (no browser) and show what the entry template extracts')
    .argument('<recipe>', 'recipe JSON file or example:<name>')
    .option('--url <url>', 'page to fetch instead of the first entry URL')
    .option('--limit <n>', 'records to show', parseIntOpt('--limit'), 10)
    .option('--json', 'print records and the field report as JSON')
    .addHelpText('after', `
The field report shows which selector candidate matched each field, how many elements it
matched and how many records came back empty. Use it to iterate on selectors quickly;
templates that need a browser (actions, scroll, load-more) will only show what static HTML contains.`)
    .action(async (file: string, opts: { url?: string; limit: number; json?: boolean }) => {
      const c = ctx();
      const { recipe } = loadRecipe(file);
      const res = await c.app.preview(recipe, opts.url);
      const report = fieldReport(recipe, res);
      const records = res.records.slice(0, opts.limit);
      if (opts.json) { c.out(json({ url: res.url, status: res.status, listMatched: res.listMatched, total: res.records.length, records, page: res.page, fields: report })); return; }
      const p = c.paint;
      c.out(kv([['url', res.url], ['http status', res.status >= 400 ? p.red(String(res.status)) : String(res.status)], ['list matched', recipe.templates[recipe.entry.template].list ? `${res.listMatched} element(s), ${res.records.length} record(s)` : '(no list in template)']], p));
      if (records.length) {
        c.out(`\nrecords (showing ${records.length} of ${res.records.length})\n`);
        console.table(records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v, 40)]))));
      }
      if (Object.keys(res.page).length) c.out('\npage fields\n' + kv(Object.entries(res.page), p));
      c.out('\nfield report\n' + table(report.map((r) => ({ ...r, status: r.status === 'ok' ? p.green(r.status) : r.status === 'n/a' ? p.dim(r.status) : r.status.startsWith('fallback') ? p.yellow(r.status) : p.red(r.status) })), ['field', 'where', 'candidate', 'matched', 'empty', 'status'], { painter: p, maxWidth: 70 }));
      if (recipe.templates[recipe.entry.template].list && res.listMatched === 0) { c.warn('the list selector matched nothing; check the selector or try `run --mode browser` if the page is JS-rendered'); c.exitCode = 2; }
    });

  program
    .command('validate')
    .description('Validate a recipe file against the schema and report its structure')
    .argument('<recipe>', 'recipe JSON file')
    .option('--json', 'machine-readable result')
    .action(async (file: string, opts: { json?: boolean }) => {
      const c = ctx();
      const { input, source } = loadRecipeInput(file);
      const r = safeParseRecipe(input);
      if (!r.success) {
        if (opts.json) { c.out(json({ valid: false, errors: r.errors })); c.exitCode = 1; return; }
        throw new CliError(`${source} is not a valid recipe (${r.errors.length} issue${r.errors.length === 1 ? '' : 's'}):\n` + r.errors.map((e) => `  - ${e}`).join('\n'));
      }
      const recipe = validateRecipe(input, source);
      const templates = Object.entries(recipe.templates).map(([name, t]) => ({ template: name, fields: t.fields.length + (t.list?.fields.length ?? 0), list: t.list ? t.list.selector[0].value : '', pagination: t.pagination?.type ?? '', follows: t.follow.length + (t.list?.follow.length ?? 0), actions: t.actions.length }));
      if (opts.json) { c.out(json({ valid: true, name: recipe.name, entry: recipe.entry, engine: { mode: recipe.engine.mode }, templates, sinks: recipe.sinks.map((s) => s.type), schedule: recipe.schedule ?? null })); return; }
      c.ok(`${source} is valid`);
      c.out(kv([['name', recipe.name], ['entry', `${recipe.entry.urls.length} url(s) -> template "${recipe.entry.template}"`], ['mode', recipe.engine.mode], ['sinks', recipe.sinks.length ? recipe.sinks.map((s) => s.type + ('path' in s ? ` (${s.path})` : '')).join(', ') : 'none'], ['schedule', recipe.schedule ? `${recipe.schedule.cron}${recipe.schedule.tz ? ' ' + recipe.schedule.tz : ''}` : 'none']], c.paint));
      c.out('\n' + table(templates, ['template', 'fields', 'list', 'pagination', 'follows', 'actions'], { painter: c.paint }));
    });
}
