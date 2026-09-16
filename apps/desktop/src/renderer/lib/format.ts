export function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtIn(ts?: number): string {
  if (!ts) return '';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s < 0) return 'now';
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtNum(n?: number): string { return n === undefined || Number.isNaN(n) ? '–' : n.toLocaleString(); }

export function fmtBytes(b?: number): string {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'accent' | undefined {
  switch (status) {
    case 'succeeded': return 'ok';
    case 'partial': return 'warn';
    case 'failed': return 'danger';
    case 'cancelled': return undefined;
    case 'running': return 'accent';
    default: return undefined;
  }
}

export function truncate(s: string, n: number) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
