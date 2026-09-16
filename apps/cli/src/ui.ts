/**
 * Terminal helpers: ANSI colors (no chalk), tables, formatting, CSV.
 * All output goes through a CliIO so tests can capture it.
 */

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  /** stderr is an interactive terminal (progress line rewriting). */
  isTTY: boolean;
  /** stdin is interactive (prompts allowed). */
  stdinTTY: boolean;
  color: boolean;
}

export function processIO(): CliIO {
  const color = !process.env.NO_COLOR && !!process.stdout.isTTY && process.env.TERM !== 'dumb';
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isTTY: !!process.stderr.isTTY,
    stdinTTY: !!process.stdin.isTTY,
    color,
  };
}

const CODES = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 } as const;
type ColorName = Exclude<keyof typeof CODES, 'reset'>;
export type Painter = Record<ColorName, (s: string) => string>;

export function makePainter(enabled: boolean): Painter {
  const p = {} as Painter;
  for (const k of Object.keys(CODES) as Array<keyof typeof CODES>) {
    if (k === 'reset') continue;
    p[k] = enabled ? (s: string) => `\x1b[${CODES[k]}m${s}\x1b[0m` : (s: string) => s;
  }
  return p;
}

export function statusColor(p: Painter, status: string): string {
  switch (status) {
    case 'succeeded': return p.green(status);
    case 'partial': return p.yellow(status);
    case 'running': return p.cyan(status);
    case 'failed': case 'cancelled': return p.red(status);
    default: return status;
  }
}

export function fmtDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(s / 60); const sec = s % 60;
  if (m < 60) return `${m}m${String(sec).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtDate(ts: number | undefined): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function cell(v: unknown, max = 60): string {
  let s: string;
  if (v == null) s = '';
  else if (typeof v === 'object') { try { s = JSON.stringify(v); } catch { s = String(v); } }
  else s = String(v);
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Render rows as an aligned text table. Columns default to the union of keys in row order. */
export function table(rows: Array<Record<string, unknown>>, columns?: string[], opts: { maxWidth?: number; painter?: Painter } = {}): string {
  if (!rows.length) return '(no rows)\n';
  const cols = columns ?? Array.from(rows.reduce((set, r) => { for (const k of Object.keys(r)) set.add(k); return set; }, new Set<string>()));
  const max = opts.maxWidth ?? 60;
  const grid = rows.map((r) => cols.map((c) => cell(r[c], max)));
  const widths = cols.map((c, i) => Math.max(c.length, ...grid.map((g) => g[i].length)));
  const p = opts.painter;
  const line = (cells: string[], paint?: (s: string) => string) => cells.map((v, i) => (paint ? paint(v.padEnd(widths[i])) : v.padEnd(widths[i]))).join('  ').replace(/\s+$/, '') + '\n';
  return line(cols, p?.bold) + line(widths.map((w) => '-'.repeat(w)), p?.dim) + grid.map((g) => line(g)).join('');
}

/** Key/value block for "show" commands. */
export function kv(pairs: Array<[string, unknown]>, painter?: Painter): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${painter ? painter.dim(k.padEnd(w)) : k.padEnd(w)}  ${cell(v, 200)}\n`).join('');
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  const cols = columns ?? Array.from(rows.reduce((set, r) => { for (const k of Object.keys(r)) set.add(k); return set; }, new Set<string>()));
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export function json(v: unknown): string { return JSON.stringify(v, null, 2) + '\n'; }

export function flattenRow(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out[`${k}.${k2}`] = v2;
    else out[k] = v;
  }
  return out;
}
