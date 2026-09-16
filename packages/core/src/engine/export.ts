import type { Recipe, Sink as SinkConfig } from '../recipe/schema.js';
import type { Storage } from '../storage/types.js';
import { createSink, type SinkContext, type Row } from '../sinks/index.js';
import { flattenObject } from '../util/misc.js';
import type { Logger } from '../util/logger.js';

export interface ExportOptions {
  recipe: Recipe;
  storage: Storage;
  runId: string;
  outDir: string;
  secret: (name: string) => string | undefined;
  log: Logger;
  /** Override sinks (e.g. CLI --out). */
  sinks?: SinkConfig[];
  onResult?: (r: { type: string; rows: number; target: string; error?: string }) => void;
}

export function* rowsOf(storage: Storage, runId: string, dataset: string, flatten: boolean): IterableIterator<Row> {
  for (const r of storage.iterRows(runId, dataset)) yield flatten ? flattenObject(r.data) : r.data;
}

/** Column order: recipe.output.columns first, then fields in template order, then discovered keys. */
export function columnOrder(recipe: Recipe, storage: Storage, runId: string, dataset: string): string[] {
  const cols: string[] = [...(recipe.output.columns ?? [])];
  const push = (c: string) => { if (!cols.includes(c)) cols.push(c); };
  for (const t of Object.values(recipe.templates)) { for (const f of t.list?.fields ?? []) push(f.name); for (const f of t.fields) push(f.name); }
  let i = 0;
  for (const r of storage.iterRows(runId, dataset, { limit: 200 })) { for (const k of Object.keys(recipe.output.flatten ? flattenObject(r.data) : r.data)) push(k); if (++i > 200) break; }
  return cols;
}

export async function exportRun(o: ExportOptions): Promise<Array<{ type: string; rows: number; target: string; error?: string }>> {
  const sinks = (o.sinks ?? o.recipe.sinks).filter((s) => s.enabled !== false);
  const results: Array<{ type: string; rows: number; target: string; error?: string }> = [];
  if (!sinks.length) return results;
  const datasets = o.storage.datasets(o.runId).map((d) => d.dataset);
  for (const s of sinks) {
    const targets = s.dataset ? [s.dataset] : datasets.length ? datasets : ['default'];
    for (const ds of targets) {
      const ctx: SinkContext = { runId: o.runId, recipeName: o.recipe.name, dataset: ds, secret: o.secret, columns: columnOrder(o.recipe, o.storage, o.runId, ds), outDir: o.outDir, log: (m, d) => o.log.debug(m, d) };
      // multi-dataset file sinks: suffix path with dataset name unless a token is used
      let cfg = s;
      if ('path' in s && targets.length > 1 && !/\{\{\s*dataset\s*\}\}/.test(s.path)) cfg = { ...s, path: s.path.replace(/(\.[a-z0-9]+)?$/i, `.${ds}$1`) } as SinkConfig;
      try {
        const sink = await createSink(cfg, ctx);
        const r = await sink.write(rowsOf(o.storage, o.runId, ds, o.recipe.output.flatten));
        o.log.info('exported', { type: r.type, rows: r.rows, target: r.target });
        const out = { type: r.type, rows: r.rows, target: r.target };
        results.push(out); o.onResult?.(out);
      } catch (e) {
        const out = { type: s.type, rows: 0, target: 'path' in s ? s.path : s.type, error: (e as Error).message };
        o.log.error('export failed', { type: s.type, error: out.error });
        results.push(out); o.onResult?.(out);
      }
    }
  }
  return results;
}
