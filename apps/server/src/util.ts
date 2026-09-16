import { readFileSync } from 'node:fs';
import type { Context } from 'hono';
import type { ZodType, ZodTypeDef } from 'zod';
import type { RunEvent } from '@scrappia/core';
import { ApiError, formatZodIssues } from './errors.js';

/** Parse the JSON body; empty bodies yield `undefined`. */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON'); }
}

/** Parse + validate a JSON body against a zod schema. `optional` treats an empty body as `{}`. */
export async function parseBody<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>, opts: { optional?: boolean } = {}): Promise<T> {
  let raw = await readJson(c);
  if (raw === undefined && opts.optional) raw = {};
  if (raw === undefined) throw new ApiError(400, 'invalid_json', 'Request body is required');
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError(400, 'validation_error', 'Invalid request body', formatZodIssues(r.error));
  return r.data;
}

/** Validate query params against a zod schema (use `z.coerce` for numbers/booleans). */
export function parseQuery<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): T {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new ApiError(400, 'validation_error', 'Invalid query parameters', formatZodIssues(r.error));
  return r.data;
}

export function runIdOf(e: RunEvent): string {
  return 'runId' in e ? e.runId : e.run.id;
}

export function isoOrNull(d: Date | number | undefined | null): string | null {
  if (d === undefined || d === null) return null;
  return new Date(d).toISOString();
}

// ---------- CSV ----------

/** Render a cell for CSV/tabular output: objects become JSON, null/undefined become empty. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

export function csvEscape(v: unknown): string {
  const s = cellText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

// ---------- version ----------

let cachedVersion: string | undefined;
/** Version from apps/server/package.json (works from src/ and dist/). */
export function serverVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    cachedVersion = pkg.version ?? '0.0.0';
  } catch { cachedVersion = '0.0.0'; }
  return cachedVersion;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
