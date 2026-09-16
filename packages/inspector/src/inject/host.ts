/**
 * Overlay -> host messaging. The host registers `window.__scrappiaHost` via Playwright's
 * exposeBinding, possibly AFTER the init script ran, so the binding is looked up at call time
 * and messages are queued until it appears.
 */
import type { OverlayMessage } from '@scrappia/core';

const BINDING = '__scrappiaHost';
const MAX_QUEUE = 200;

type HostFn = (msg: OverlayMessage) => unknown;

const queue: OverlayMessage[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function hostFn(): HostFn | null {
  const w = window as unknown as Record<string, unknown>;
  const fn = w[BINDING];
  return typeof fn === 'function' ? (fn as HostFn) : null;
}

function deliver(fn: HostFn, msg: OverlayMessage): boolean {
  try {
    const r = fn(msg);
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function flush(): void {
  const fn = hostFn();
  if (!fn) return;
  while (queue.length) {
    const msg = queue[0];
    if (!deliver(fn, msg)) break;
    queue.shift();
  }
  if (!queue.length && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function send(msg: OverlayMessage): void {
  const fn = hostFn();
  if (fn && !queue.length && deliver(fn, msg)) return;
  queue.push(msg);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (timer === null) timer = setInterval(flush, 250);
  flush();
}

export function hostAvailable(): boolean {
  return hostFn() !== null;
}

export function pendingCount(): number {
  return queue.length;
}

export function log(message: string): void {
  send({ type: 'log', message });
}

export function reportError(err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  send({ type: 'error', message });
}
