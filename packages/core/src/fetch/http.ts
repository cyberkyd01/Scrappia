import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';

export interface HttpFetchOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  userAgent?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  cookies?: string;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface HttpFetchResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  contentType: string;
  setCookies: string[];
  durationMs: number;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const agents = new Map<string, Dispatcher>();
function dispatcherFor(proxyUrl?: string): Dispatcher {
  const key = proxyUrl ?? '';
  let d = agents.get(key);
  if (!d) {
    d = proxyUrl ? new ProxyAgent({ uri: proxyUrl, connect: { timeout: 20_000 } }) : new Agent({ connect: { timeout: 20_000 }, keepAliveTimeout: 10_000 });
    agents.set(key, d);
  }
  return d;
}

/** Browser-like header order/values so plain HTTP fetches look less like a script. */
export function browserHeaders(ua: string, extra: Record<string, string> = {}): Record<string, string> {
  const isChrome = /Chrome\//.test(ua);
  const base: Record<string, string> = {
    'user-agent': ua,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
  };
  if (isChrome) {
    const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? '141';
    base['sec-ch-ua'] = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`;
    base['sec-ch-ua-mobile'] = '?0';
    base['sec-ch-ua-platform'] = /Windows/.test(ua) ? '"Windows"' : /Mac/.test(ua) ? '"macOS"' : '"Linux"';
  }
  for (const [k, v] of Object.entries(extra)) base[k.toLowerCase()] = v;
  return base;
}

export async function httpFetch(url: string, opts: HttpFetchOptions = {}): Promise<HttpFetchResult> {
  const start = Date.now();
  const ua = opts.userAgent ?? DEFAULT_UA;
  const headers = browserHeaders(ua, opts.headers);
  if (opts.cookies) headers.cookie = opts.cookies;
  if (opts.method === 'POST' && opts.body && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';

  let current = url;
  const setCookies: string[] = [];
  const maxRedirects = opts.maxRedirects ?? 10;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, {
      method: opts.method ?? 'GET',
      body: opts.method === 'POST' ? opts.body : undefined,
      headers,
      dispatcher: dispatcherFor(opts.proxyUrl),
      headersTimeout: opts.timeoutMs ?? 30_000,
      bodyTimeout: opts.timeoutMs ?? 30_000,
      signal: opts.signal,
    });
    const sc = res.headers['set-cookie'];
    if (sc) setCookies.push(...(Array.isArray(sc) ? sc : [sc]));
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      await res.body.dump();
      current = new URL(String(res.headers.location), current).toString();
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && opts.method === 'POST')) { opts = { ...opts, method: 'GET', body: undefined }; }
      // carry cookies across redirects (same host)
      if (setCookies.length) headers.cookie = mergeCookieHeader(headers.cookie, setCookies);
      continue;
    }
    const raw = Buffer.from(await res.body.arrayBuffer());
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
    let buf = raw;
    try {
      if (enc.includes('br')) buf = brotliDecompressSync(raw);
      else if (enc.includes('gzip')) buf = gunzipSync(raw);
      else if (enc.includes('deflate')) buf = inflateSync(raw);
    } catch { buf = raw; }
    const contentType = String(res.headers['content-type'] ?? '');
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? sniffCharset(buf) ?? 'utf-8';
    let body: string;
    try { body = new TextDecoder(charset).decode(buf); } catch { body = buf.toString('utf8'); }
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    return { status: res.statusCode, url: current, headers: flat, body, bytes: raw.length, contentType, setCookies, durationMs: Date.now() - start };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

function sniffCharset(buf: Buffer): string | undefined {
  const head = buf.subarray(0, 4096).toString('latin1');
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
}

export function mergeCookieHeader(existing: string | undefined, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) jar.set(k, v.join('='));
  }
  for (const sc of setCookies) {
    const [kv] = sc.split(';');
    const [k, ...v] = kv.trim().split('=');
    if (k) jar.set(k, v.join('='));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Minimal per-host cookie jar for HTTP mode. */
export class CookieJar {
  private jars = new Map<string, Map<string, string>>();
  headerFor(url: string): string | undefined {
    const host = hostKey(url);
    const jar = this.jars.get(host);
    if (!jar?.size) return undefined;
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(url: string, setCookies: string[]) {
    if (!setCookies.length) return;
    const host = hostKey(url);
    const jar = this.jars.get(host) ?? new Map<string, string>();
    for (const sc of setCookies) {
      const [kv] = sc.split(';');
      const [k, ...v] = kv.trim().split('=');
      if (k) jar.set(k, v.join('='));
    }
    this.jars.set(host, jar);
  }
  set(url: string, name: string, value: string) {
    const host = hostKey(url);
    const jar = this.jars.get(host) ?? new Map<string, string>();
    jar.set(name, value);
    this.jars.set(host, jar);
  }
  clear() { this.jars.clear(); }
  /** Export as Playwright-style cookies for a browser context. */
  toPlaywright(): Array<{ name: string; value: string; domain: string; path: string }> {
    const out: Array<{ name: string; value: string; domain: string; path: string }> = [];
    for (const [host, jar] of this.jars) for (const [name, value] of jar) out.push({ name, value, domain: host, path: '/' });
    return out;
  }
}

function hostKey(url: string): string {
  try {
    const h = new URL(url).hostname;
    // group www + apex
    return h.replace(/^www\./, '');
  } catch { return url; }
}
