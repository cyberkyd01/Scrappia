import { createHash, randomBytes } from 'node:crypto';

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class AbortError extends Error {
  constructor() { super('aborted'); this.name = 'AbortError'; }
}

export function jitter(base: number, spread: number): number {
  return base + Math.random() * spread;
}

export function backoffMs(attempt: number, baseMs = 500, capMs = 60_000): number {
  // full jitter exponential backoff
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * exp;
}

export function id(size = 12): string {
  return randomBytes(size).toString('base64url').slice(0, size);
}

export function hash(value: unknown, algorithm: 'md5' | 'sha1' | 'sha256' = 'sha256'): string {
  return createHash(algorithm).update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

/** Deterministic JSON: sorted keys, so row hashes are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** Replace {{name}} tokens using a resolver; unknown tokens are left intact. */
export function interpolate(template: string, vars: Record<string, unknown> | ((name: string) => unknown)): string {
  const get = typeof vars === 'function' ? vars : (n: string) => vars[n];
  return template.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (m, name: string) => {
    const v = get(name);
    return v === undefined || v === null ? m : String(v);
  });
}

export function flattenObject(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      flattenObject(v as Record<string, unknown>, key, out);
    } else if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      // array of objects -> index-keyed columns
      v.forEach((item, i) => flattenObject(item as Record<string, unknown>, `${key}[${i}]`, out));
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => (x == null ? '' : String(x))).join(' | ');
    } else {
      out[key] = v;
    }
  }
  return out;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((prefix) => list.map((x) => [...prefix, x])), [[]]);
}

export function safeFileName(name: string, max = 150): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max) || 'file';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}
