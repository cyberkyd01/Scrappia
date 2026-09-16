/**
 * Renderer-side access to the preload bridge (`window.scrappia`), plus small React hooks.
 * The renderer never imports `@scrappia/core` at runtime; only types.
 */
import { useEffect, useRef } from 'react';
import type { IpcApi, IpcEvents, ScrappiaBridge } from '@shared/ipc';

declare global {
  interface Window { scrappia: ScrappiaBridge }
}

function cleanError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  // Electron wraps handler errors: "Error invoking remote method 'x': Error: message"
  const m = /^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
  return new Error(m ? m[1] : msg);
}

export function invoke<K extends keyof IpcApi>(channel: K, ...args: Parameters<IpcApi[K]>): ReturnType<IpcApi[K]> {
  if (!window.scrappia) return Promise.reject(new Error('preload bridge unavailable')) as ReturnType<IpcApi[K]>;
  return (window.scrappia.invoke(channel, ...args) as Promise<unknown>).catch((e) => { throw cleanError(e); }) as ReturnType<IpcApi[K]>;
}

export function subscribe<K extends keyof IpcEvents>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void {
  if (!window.scrappia) return () => undefined;
  return window.scrappia.on(channel, cb);
}

/** Subscribe to a main-process event for the lifetime of the component; the latest callback is always used. */
export function useIpcEvent<K extends keyof IpcEvents>(channel: K, cb: (payload: IpcEvents[K]) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => subscribe(channel, (p) => ref.current(p)), [channel]);
}
