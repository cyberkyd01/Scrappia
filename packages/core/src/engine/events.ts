import type { DriftEvent, RequestRecord, RunRecord } from '../storage/types.js';

export interface RunStats {
  requests: { total: number; done: number; failed: number; pending: number; running: number; skipped: number };
  rows: number;
  rowsByDataset: Record<string, number>;
  pages: number;
  bytes: number;
  httpFetches: number;
  browserFetches: number;
  drift: number;
  healed: number;
  validationFlags: number;
  validationDrops: number;
  startedAt: number;
  finishedAt?: number;
  elapsedMs: number;
  rowsPerMinute: number;
  aiCalls: number;
  aiTokens: number;
  exports?: Array<{ type: string; rows: number; target: string; error?: string }>;
  monitor?: { added: number; removed: number; changed: number };
}

export type RunEvent =
  | { type: 'run.start'; run: RunRecord }
  | { type: 'run.progress'; runId: string; stats: RunStats }
  | { type: 'run.done'; run: RunRecord; stats: RunStats }
  | { type: 'request.start'; runId: string; request: RequestRecord; mode: 'http' | 'browser' }
  | { type: 'request.done'; runId: string; request: RequestRecord; status: string; durationMs: number; rows: number; error?: string; mode: 'http' | 'browser'; httpStatus?: number }
  | { type: 'rows'; runId: string; dataset: string; rows: Array<Record<string, unknown>>; pageUrl: string }
  | { type: 'drift'; runId: string; event: DriftEvent }
  | { type: 'alert'; runId: string; title: string; body: string; kind: string }
  | { type: 'log'; runId: string; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }
  | { type: 'export.done'; runId: string; result: { type: string; rows: number; target: string; error?: string } }
  | { type: 'captcha.needed'; runId: string; url: string; kind: string };

export type RunEventListener = (e: RunEvent) => void;
