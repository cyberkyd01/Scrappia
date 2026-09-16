import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { RunEvent, RunStats, ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { runIdOf } from '../util.js';
import { requireRun } from './runs.js';

export interface EventsOptions {
  /** Interval between `: ping` heartbeat comments. Default 15s. */
  heartbeatMs?: number;
}

/**
 * Bridge `app.on(...)` to one SSE connection.
 * Each RunEvent is sent as `event: <type>` with the JSON event as data and an incrementing id.
 * Resolves (closing the stream) when `stop` is called: on client abort, or on `run.done` for per-run streams.
 */
async function pipeEvents(stream: SSEStreamingApi, app: ScrappiaApp, opts: { filter: (e: RunEvent) => boolean; closeOnDone: boolean; heartbeatMs: number; initial?: RunEvent[] }) {
  let seq = 0;
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const stop = () => { if (stopped) return; stopped = true; unsubscribe(); clearInterval(heartbeat); resolveDone(); };
  const send = async (e: RunEvent) => {
    if (stopped) return;
    try { await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(++seq) }); } catch { stop(); return; }
    if (opts.closeOnDone && e.type === 'run.done') stop();
  };

  // Serialize writes so events keep their order even though each write is async.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (e: RunEvent) => { chain = chain.then(() => send(e)); };

  const unsubscribe = app.on((e) => { if (opts.filter(e)) enqueue(e); });
  const heartbeat = setInterval(() => { if (!stopped) stream.write(': ping\n\n').catch(stop); }, opts.heartbeatMs);
  heartbeat.unref?.();
  stream.onAbort(stop);

  await stream.writeSSE({ event: 'ready', data: JSON.stringify({ time: Date.now() }), id: String(++seq) });
  for (const e of opts.initial ?? []) enqueue(e);
  await done;
  await chain.catch(() => { /* stream already closed */ });
}

export function eventRoutes(app: ScrappiaApp, opts: EventsOptions = {}) {
  const r = new Hono<AppEnv>();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const sseHeaders = (c: { header: (k: string, v: string) => void }) => { c.header('X-Accel-Buffering', 'no'); c.header('Cache-Control', 'no-cache, no-transform'); };

  /** Events for every run. Optional `?runId=` / `?types=rows,run.done` filters. Never closes on its own. */
  r.get('/events', (c) => {
    const runId = c.req.query('runId');
    const types = c.req.query('types')?.split(',').map((s) => s.trim()).filter(Boolean);
    sseHeaders(c);
    return streamSSE(c, (stream) => pipeEvents(stream, app, {
      heartbeatMs, closeOnDone: false,
      filter: (e) => (!runId || runIdOf(e) === runId) && (!types?.length || types.includes(e.type)),
    }));
  });

  /** Events for one run; closes after `run.done`. Already-finished runs receive a synthetic `run.done` immediately. */
  r.get('/runs/:id/events', (c) => {
    const id = c.req.param('id');
    const run = requireRun(app, id);
    const active = app.activeRuns().some((a) => a.run.id === id);
    const initial: RunEvent[] = [];
    if (!active && run.status !== 'running') initial.push({ type: 'run.done', run, stats: run.stats as unknown as RunStats });
    sseHeaders(c);
    return streamSSE(c, (stream) => pipeEvents(stream, app, { heartbeatMs, closeOnDone: true, filter: (e) => runIdOf(e) === id, initial }));
  });

  return r;
}
