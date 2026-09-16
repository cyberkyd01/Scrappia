import { stream } from 'hono/streaming';
import { z } from 'zod';
import { flattenObject, type Recipe, type ScrappiaApp } from '@scrappia/core';
import type { AppContext } from '../types.js';
import { csvLine, cellText } from '../util.js';

export const RowsQuery = z.object({
  dataset: z.string().min(1).optional(),
  format: z.enum(['json', 'csv', 'jsonl']).default('json'),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
export type RowsQuery = z.infer<typeof RowsQuery>;

const BATCH = 500;
const FLUSH_BYTES = 64 * 1024;

type Row = Record<string, unknown>;

/**
 * Yield rows in materialized batches so no SQLite statement stays open across an `await`
 * (a running job may be writing to the same database).
 */
function* batches(app: ScrappiaApp, runId: string, dataset: string | undefined, offset: number, limit?: number): Generator<Row[]> {
  let remaining = limit ?? Number.POSITIVE_INFINITY;
  let at = offset;
  while (remaining > 0) {
    const take = Math.min(BATCH, remaining);
    const rows = app.rows(runId, dataset, { limit: take, offset: at });
    if (!rows.length) return;
    yield rows;
    at += rows.length;
    remaining -= rows.length;
    if (rows.length < take) return;
  }
}

function discoverColumns(app: ScrappiaApp, runId: string, q: RowsQuery, recipe: Recipe | undefined, flatten: boolean): string[] {
  const cols: string[] = [...(recipe?.output?.columns ?? [])];
  for (const batch of batches(app, runId, q.dataset, q.offset, q.limit)) {
    for (const r of batch) for (const k of Object.keys(flatten ? flattenObject(r) : r)) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
}

/** Send rows of a run as JSON (paged), CSV or JSONL (streamed). Shared by runs and recipes routes. */
export function sendRows(c: AppContext, app: ScrappiaApp, runId: string, q: RowsQuery, recipe?: Recipe): Response | Promise<Response> {
  if (q.format === 'json') {
    const limit = q.limit ?? 1000;
    const rows = app.rows(runId, q.dataset, { limit, offset: q.offset });
    const total = app.storage.countRows(runId, q.dataset);
    return c.json({ runId, dataset: q.dataset ?? null, rows, total, offset: q.offset, limit });
  }

  const fileBase = `run-${runId}${q.dataset ? '-' + q.dataset : ''}`;
  if (q.format === 'jsonl') {
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', `inline; filename="${fileBase}.jsonl"`);
    return stream(c, async (s) => {
      for (const batch of batches(app, runId, q.dataset, q.offset, q.limit)) {
        await s.write(batch.map((r) => JSON.stringify(r)).join('\n') + '\n');
      }
    });
  }

  const flatten = recipe?.output?.flatten ?? true;
  const columns = discoverColumns(app, runId, q, recipe, flatten);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `inline; filename="${fileBase}.csv"`);
  return stream(c, async (s) => {
    let buf = csvLine(columns);
    for (const batch of batches(app, runId, q.dataset, q.offset, q.limit)) {
      for (const r of batch) {
        const flat = flatten ? flattenObject(r) : r;
        buf += csvLine(columns.map((col) => cellText(flat[col])));
        if (buf.length >= FLUSH_BYTES) { await s.write(buf); buf = ''; }
      }
    }
    if (buf) await s.write(buf);
  });
}
