import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { safeParseRecipe, type Recipe, type RunRecord } from '@scrappia/core';

/** Successful tool result: pretty JSON (or plain text when a string is given). */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }], ...(typeof data === 'object' && data !== null && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}) };
}

export function fail(message: string, extra?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: extra ? `${message}\n${JSON.stringify(extra, null, 2)}` : message }] };
}

/** Wrap a tool handler so thrown errors become MCP error results instead of protocol failures. */
export function guard<A>(fn: (args: A) => Promise<CallToolResult> | CallToolResult): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try { return await fn(args); }
    catch (e) { return fail((e as Error)?.message ?? String(e)); }
  };
}

/** Accept a recipe as an object or as a JSON string (LLMs often send both). */
export function asObject(v: unknown, what = 'recipe'): Record<string, unknown> {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Record<string, unknown>; }
    catch (e) { throw new Error(`${what} is not valid JSON: ${(e as Error).message}`); }
  }
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  throw new Error(`${what} must be a JSON object`);
}

export function parseRecipeOrFail(v: unknown): { recipe: Recipe } | { error: CallToolResult } {
  const input = asObject(v);
  const r = safeParseRecipe(input);
  if (!r.success) return { error: fail(`recipe is invalid (${r.errors.length} issue(s))`, { errors: r.errors }) };
  return { recipe: r.recipe };
}

export function runSummary(run: RunRecord) {
  const s = run.stats as { rows?: number; pages?: number; elapsedMs?: number; drift?: number; requests?: Record<string, number>; exports?: unknown; monitor?: unknown; rowsByDataset?: Record<string, number> };
  return {
    id: run.id, recipeId: run.recipeId, recipeName: run.recipeName, status: run.status, trigger: run.trigger,
    startedAt: new Date(run.startedAt).toISOString(), finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
    error: run.error ?? undefined,
    rows: s.rows ?? 0, rowsByDataset: s.rowsByDataset, pages: s.pages ?? 0, elapsedMs: s.elapsedMs, drift: s.drift ?? 0, requests: s.requests, exports: s.exports, monitor: s.monitor,
  };
}

/** `css:` / `xpath:` / leading `//` prefixes pick the selector kind; default css. */
export function selectorCandidate(sel: string): { kind: 'css' | 'xpath' | 'text'; value: string } {
  const m = /^(css|xpath|text):\s*/i.exec(sel);
  if (m) return { kind: m[1].toLowerCase() as 'css' | 'xpath' | 'text', value: sel.slice(m[0].length) };
  if (/^(\/\/|\.\/\/|\(\/\/)/.test(sel)) return { kind: 'xpath', value: sel };
  return { kind: 'css', value: sel };
}

export function truncateText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]` : s;
}
