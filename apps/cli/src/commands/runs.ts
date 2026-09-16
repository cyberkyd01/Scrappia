import type { Command } from 'commander';
import type { RunStatus } from '@scrappia/core';
import type { CliContext } from '../context.js';
import { CliError, parseIntOpt } from '../context.js';
import { fileSink } from '../recipe.js';
import { json, table, kv, fmtDate, fmtDuration, statusColor, toCsv, flattenRow, cell } from '../ui.js';

function runStats(r: { stats: Record<string, unknown> }) { return r.stats as { rows?: number; pages?: number; elapsedMs?: number; drift?: number; requests?: { failed?: number } }; }

export function registerRunsCommands(program: Command, ctx: () => CliContext) {
  const runs = program.command('runs').description('Inspect run history and the rows each run produced');

  runs.command('list').description('List runs, newest first')
    .option('--recipe <id>', 'only runs of this saved recipe')
    .option('--status <status>', 'running|succeeded|partial|failed|cancelled')
    .option('--limit <n>', 'max rows', parseIntOpt('--limit'), 20)
    .option('--json')
    .action((opts: { recipe?: string; status?: string; limit: number; json?: boolean }) => {
      const c = ctx();
      const list = c.app.listRuns({ recipeId: opts.recipe, status: opts.status as RunStatus | undefined, limit: opts.limit });
      if (opts.json) { c.out(json(list.map((r) => ({ ...r, recipeJson: undefined })))); return; }
      if (!list.length) { c.out('no runs yet\n'); return; }
      c.out(table(list.map((r) => { const s = runStats(r); return { id: r.id, recipe: r.recipeName, status: statusColor(c.paint, r.status), started: fmtDate(r.startedAt), duration: fmtDuration(s.elapsedMs ?? (r.finishedAt ? r.finishedAt - r.startedAt : undefined)), rows: s.rows ?? 0, pages: s.pages ?? 0, failed: s.requests?.failed ?? 0, trigger: r.trigger }; }), ['id', 'recipe', 'status', 'started', 'duration', 'rows', 'pages', 'failed', 'trigger'], { painter: c.paint }));
    });

  runs.command('show').description('Run details, stats, datasets and exports').argument('<runId>').option('--json').action((runId: string, opts: { json?: boolean }) => {
    const c = ctx();
    const run = c.app.getRun(runId);
    if (!run) throw new CliError(`run ${runId} not found`);
    const datasets = c.app.storage.datasets(runId);
    const drift = c.app.storage.listDrift(runId);
    if (opts.json) { c.out(json({ ...run, recipeJson: undefined, datasets, drift: drift.length })); return; }
    const s = run.stats as Record<string, unknown>;
    c.out(kv([['run', run.id], ['recipe', `${run.recipeName}${run.recipeId ? ` (${run.recipeId})` : ''}`], ['status', statusColor(c.paint, run.status)], ['trigger', run.trigger], ['started', fmtDate(run.startedAt)], ['finished', fmtDate(run.finishedAt)], ['duration', fmtDuration(s.elapsedMs as number)], ['rows', datasets.map((d) => `${d.dataset}: ${d.rows}`).join(', ') || String(s.rows ?? 0)], ['pages', s.pages ?? 0], ['requests', s.requests ? JSON.stringify(s.requests) : '-'], ['drift', drift.length], ['error', run.error ?? '']], c.paint));
    const exports = s.exports as Array<{ type: string; rows: number; target: string; error?: string }> | undefined;
    if (exports?.length) c.out('\nexports\n' + table(exports.map((e) => ({ type: e.type, rows: e.rows, target: e.target, error: e.error ?? '' })), ['type', 'rows', 'target', 'error'], { painter: c.paint, maxWidth: 100 }));
    if (run.status !== 'running' && run.status !== 'succeeded') c.out(`\nresume with: scrappia resume ${run.id}\n`);
  });

  runs.command('rows').description('Print rows from a run')
    .argument('<runId>')
    .option('--dataset <name>', 'dataset name (multi-dataset recipes)')
    .option('--limit <n>', 'max rows', parseIntOpt('--limit'), 50)
    .option('--offset <n>', 'skip rows', parseIntOpt('--offset'), 0)
    .option('--format <fmt>', 'table|json|jsonl|csv', 'table')
    .option('--columns <a,b>', 'only these columns')
    .action((runId: string, opts: { dataset?: string; limit: number; offset: number; format: string; columns?: string }) => {
      const c = ctx();
      if (!c.app.getRun(runId)) throw new CliError(`run ${runId} not found`);
      const rows = c.app.rows(runId, opts.dataset, { limit: opts.limit, offset: opts.offset });
      const cols = opts.columns?.split(',').map((s) => s.trim()).filter(Boolean);
      const pick = (r: Record<string, unknown>) => (cols ? Object.fromEntries(cols.map((k) => [k, r[k]])) : r);
      switch (opts.format) {
        case 'json': c.out(json(rows.map(pick))); break;
        case 'jsonl': c.out(rows.map((r) => JSON.stringify(pick(r))).join('\n') + (rows.length ? '\n' : '')); break;
        case 'csv': c.out(toCsv(rows.map((r) => flattenRow(pick(r))), cols)); break;
        case 'table': {
          if (!rows.length) { c.out('(no rows)\n'); break; }
          console.table(rows.map((r) => Object.fromEntries(Object.entries(flattenRow(pick(r))).map(([k, v]) => [k, cell(v, 40)]))));
          const total = c.app.storage.countRows(runId, opts.dataset);
          if (total > opts.offset + rows.length) c.out(`… ${total - opts.offset - rows.length} more (use --limit/--offset)\n`);
          break;
        }
        default: throw new CliError('--format must be table|json|jsonl|csv');
      }
    });

  runs.command('drift').description('Selector drift events recorded during a run (fallbacks, missing fields, AI repairs)').argument('<runId>').option('--json').action((runId: string, opts: { json?: boolean }) => {
    const c = ctx();
    if (!c.app.getRun(runId)) throw new CliError(`run ${runId} not found`);
    const drift = c.app.storage.listDrift(runId);
    if (opts.json) { c.out(json(drift)); return; }
    if (!drift.length) { c.out('no drift events\n'); return; }
    c.out(table(drift.map((d) => ({ kind: d.kind, template: d.template, field: d.field ?? '', detail: d.detail, page: d.pageUrl ?? '', at: fmtDate(d.createdAt) })), ['kind', 'template', 'field', 'detail', 'page', 'at'], { painter: c.paint, maxWidth: 70 }));
  });

  runs.command('rm').description('Delete a run and its rows').argument('<runId>').action((runId: string) => {
    const c = ctx();
    if (!c.app.getRun(runId)) throw new CliError(`run ${runId} not found`);
    if (c.app.activeRuns().some((a) => a.run.id === runId)) throw new CliError('run is still active');
    c.app.storage.deleteRun(runId);
    c.ok(`deleted run ${runId}`);
  });

  program.command('export').description('Export the rows of a finished run to a file')
    .argument('<runId>')
    .requiredOption('--out <file>', 'target file; format inferred from the extension')
    .option('--format <fmt>', 'csv|tsv|json|jsonl|xlsx|xml|parquet|sqlite')
    .option('--mode <mode>', 'append|overwrite|upsert', 'overwrite')
    .option('--key <field>', 'row key for --mode upsert (comma-separated for composite keys)')
    .option('--dataset <name>', 'only this dataset')
    .option('--table <name>', 'table name for sqlite')
    .option('--json')
    .addHelpText('after', `
Examples:
  scrappia export abc123 --out data.xlsx
  scrappia export abc123 --out data.csv --mode upsert --key url`)
    .action(async (runId: string, opts: { out: string; format?: string; mode: string; key?: string; dataset?: string; table?: string; json?: boolean }) => {
      const c = ctx();
      if (!c.app.getRun(runId)) throw new CliError(`run ${runId} not found`);
      const sink = fileSink(opts.out, opts);
      const results = await c.app.export(runId, [sink]);
      if (opts.json) { c.out(json(results)); }
      for (const r of results) {
        if (r.error) { c.fail(`${r.type} -> ${r.target}: ${r.error}`); c.exitCode = 1; }
        else if (!opts.json) c.ok(`${r.rows} rows -> ${r.target}`);
      }
    });

  program.command('diff').description('Compare the rows of two runs (added / removed / changed) keyed by the recipe output keys')
    .argument('<runIdA>', 'earlier run')
    .argument('<runIdB>', 'later run')
    .option('--fields <a,b>', 'only compare these fields')
    .option('--threshold <pct>', 'ignore numeric changes below this percent', (v: string) => Number(v))
    .option('--dataset <name>')
    .option('--limit <n>', 'sample rows to print per category', parseIntOpt('--limit'), 10)
    .option('--json', 'full diff as JSON')
    .action((a: string, b: string, opts: { fields?: string; threshold?: number; dataset?: string; limit: number; json?: boolean }) => {
      const c = ctx();
      for (const id of [a, b]) if (!c.app.getRun(id)) throw new CliError(`run ${id} not found`);
      const d = c.app.diff(a, b, { fields: opts.fields?.split(',').map((s) => s.trim()).filter(Boolean), thresholdPercent: opts.threshold, dataset: opts.dataset });
      if (opts.json) { c.out(json(d)); return; }
      const p = c.paint;
      c.out(kv([['added', p.green(String(d.added.length))], ['removed', p.red(String(d.removed.length))], ['changed', p.yellow(String(d.changed.length))], ['unchanged', String(d.unchanged)]], p));
      const show = (title: string, rows: Array<Record<string, unknown>>) => { if (rows.length) c.out(`\n${title} (${Math.min(rows.length, opts.limit)} of ${rows.length})\n` + table(rows.slice(0, opts.limit).map(flattenRow), undefined, { painter: p, maxWidth: 40 })); };
      show(p.green('added'), d.added);
      show(p.red('removed'), d.removed);
      if (d.changed.length) c.out(`\n${p.yellow('changed')} (${Math.min(d.changed.length, opts.limit)} of ${d.changed.length})\n` + table(d.changed.slice(0, opts.limit).flatMap((ch) => ch.fields.map((f) => ({ key: ch.key, field: f.field, before: f.before, after: f.after, percent: f.percent != null ? f.percent.toFixed(1) + '%' : '' }))), ['key', 'field', 'before', 'after', 'percent'], { painter: p, maxWidth: 40 }));
      if (d.added.length || d.removed.length || d.changed.length) c.exitCode = 0;
    });
}
