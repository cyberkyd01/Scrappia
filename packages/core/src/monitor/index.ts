/**
 * Change detection between the latest run and the previous successful run of the same recipe,
 * plus alert delivery (webhook, Slack, Discord, Telegram, ntfy, email, desktop).
 */
import { createHmac } from 'node:crypto';
import { fetch } from 'undici';
import microdiff from 'microdiff';
import type { AlertChannel, Recipe } from '../recipe/schema.js';
import type { RunRecord, RunStatus, Storage } from '../storage/types.js';
import type { Logger } from '../util/logger.js';

export interface DiffResult {
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  changed: Array<{ key: string; before: Record<string, unknown>; after: Record<string, unknown>; fields: Array<{ field: string; before: unknown; after: unknown; percent?: number }> }>;
  unchanged: number;
}

export function diffRuns(storage: Storage, prevRunId: string, curRunId: string, opts: { fields?: string[]; thresholdPercent?: number; dataset?: string } = {}): DiffResult {
  const prev = new Map<string, Record<string, unknown>>();
  for (const r of storage.iterRows(prevRunId, opts.dataset)) prev.set(r.rowKey, r.data);
  const out: DiffResult = { added: [], removed: [], changed: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const r of storage.iterRows(curRunId, opts.dataset)) {
    seen.add(r.rowKey);
    const before = prev.get(r.rowKey);
    if (!before) { out.added.push(r.data); continue; }
    const watch = opts.fields?.length ? opts.fields : undefined;
    const a = watch ? pick(before, watch) : stripMeta(before);
    const b = watch ? pick(r.data, watch) : stripMeta(r.data);
    const d = microdiff(a, b);
    if (!d.length) { out.unchanged++; continue; }
    const fields = d.map((x) => {
      const field = x.path.join('.');
      const bv = 'oldValue' in x ? x.oldValue : undefined; const av = 'value' in x ? x.value : undefined;
      const pb = num(bv), pa = num(av);
      const percent = pb != null && pa != null && pb !== 0 ? Math.abs((pa - pb) / pb) * 100 : undefined;
      return { field, before: bv, after: av, percent };
    }).filter((f) => opts.thresholdPercent == null || f.percent == null || f.percent >= opts.thresholdPercent);
    if (!fields.length) { out.unchanged++; continue; }
    out.changed.push({ key: r.rowKey, before, after: r.data, fields });
  }
  for (const [k, data] of prev) if (!seen.has(k)) out.removed.push(data);
  return out;
}

function pick(o: Record<string, unknown>, keys: string[]) { const out: Record<string, unknown> = {}; for (const k of keys) out[k] = o[k]; return out; }
function stripMeta(o: Record<string, unknown>) { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v; return out; }
function num(v: unknown): number | null { if (typeof v === 'number') return v; if (typeof v === 'string') { const n = parseFloat(v.replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; } return null; }

export interface MonitorOptions {
  recipe: Recipe; storage: Storage; run: RunRecord; recipeId?: string; secret: (n: string) => string | undefined; log: Logger; status: RunStatus;
  onAlert?: (a: { title: string; body: string; kind: string }) => void;
}

export async function runMonitor(o: MonitorOptions): Promise<{ added: number; removed: number; changed: number } | undefined> {
  const m = o.recipe.monitor;
  const alerts: Array<{ kind: string; title: string; body: string; detail: Record<string, unknown> }> = [];
  const drift = o.storage.listDrift(o.run.id);
  const rows = o.storage.countRows(o.run.id);
  if (m.enabled && m.on.includes('failure') && (o.status === 'failed' || o.status === 'partial')) alerts.push({ kind: 'failure', title: `Run ${o.status}: ${o.recipe.name}`, body: `Run ${o.run.id} finished with status ${o.status}.`, detail: { runId: o.run.id } });
  if (m.enabled && m.on.includes('empty') && rows === 0) alerts.push({ kind: 'empty', title: `No data: ${o.recipe.name}`, body: `Run ${o.run.id} produced no rows.`, detail: { runId: o.run.id } });
  const severe = drift.filter((d) => d.kind === 'list-empty' || d.kind === 'field-missing' || d.kind === 'heal-failed');
  const healed = drift.filter((d) => d.kind === 'healed');
  if (m.enabled && m.on.includes('drift') && (severe.length || healed.length)) {
    alerts.push({ kind: 'drift', title: `Layout drift detected: ${o.recipe.name}`, body: [...severe.map((d) => `${d.kind} ${d.template}.${d.field ?? ''}`), ...healed.map((d) => `healed ${d.template}.${d.field} -> ${(d.detail as { selector?: string }).selector}`)].join('\n'), detail: { events: drift.length } });
  }
  let summary: { added: number; removed: number; changed: number } | undefined;
  if (o.recipeId) {
    const prev = o.storage.previousRun(o.recipeId, o.run.id);
    if (prev) {
      const d = diffRuns(o.storage, prev.id, o.run.id, { fields: m.fields, thresholdPercent: m.thresholdPercent });
      summary = { added: d.added.length, removed: d.removed.length, changed: d.changed.length };
      const wants = (k: 'added' | 'removed' | 'changed') => m.enabled && m.on.includes(k) && d[k].length > 0;
      const lines: string[] = [];
      if (wants('added')) lines.push(`${d.added.length} new row(s): ` + d.added.slice(0, 5).map(preview).join('; '));
      if (wants('removed')) lines.push(`${d.removed.length} removed row(s): ` + d.removed.slice(0, 5).map(preview).join('; '));
      if (wants('changed')) lines.push(`${d.changed.length} changed row(s): ` + d.changed.slice(0, 5).map((c) => `${preview(c.after)} [${c.fields.map((f) => `${f.field}: ${str(f.before)} -> ${str(f.after)}`).join(', ')}]`).join('; '));
      if (lines.length) alerts.push({ kind: 'changes', title: `Changes detected: ${o.recipe.name}`, body: lines.join('\n'), detail: { added: d.added.slice(0, 50), removed: d.removed.slice(0, 50), changed: d.changed.slice(0, 50).map((c) => ({ key: c.key, fields: c.fields })) } });
    }
  }
  for (const a of alerts) {
    o.storage.addAlert({ runId: o.run.id, recipeId: o.recipeId, ...a });
    o.onAlert?.(a);
    for (const ch of m.channels) {
      try { await sendAlert(ch, a, o.secret, { recipe: o.recipe.name, runId: o.run.id }); }
      catch (e) { o.log.warn('alert delivery failed', { channel: ch.type, error: (e as Error).message }); }
    }
  }
  return summary;
}

function preview(r: Record<string, unknown>): string { return Object.entries(r).filter(([k]) => !k.startsWith('_')).slice(0, 3).map(([, v]) => str(v)).join(' | '); }
function str(v: unknown): string { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 60 ? s.slice(0, 57) + '...' : s; }

export async function sendAlert(ch: AlertChannel, a: { kind: string; title: string; body: string; detail: Record<string, unknown> }, secret: (n: string) => string | undefined, meta: { recipe: string; runId: string }) {
  const text = `*${a.title}*\n${a.body}`;
  switch (ch.type) {
    case 'webhook': {
      const payload = JSON.stringify({ event: 'alert', ...meta, ...a, at: new Date().toISOString() });
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Scrappia-Alert/1' };
      const s = ch.secretRef ? secret(ch.secretRef) : undefined;
      if (s) { const ts = Date.now().toString(); headers['x-scrappia-timestamp'] = ts; headers['x-scrappia-signature'] = 'sha256=' + createHmac('sha256', s).update(`${ts}.${payload}`).digest('hex'); }
      await post(ch.url, payload, headers); return;
    }
    case 'slack': { const url = secret(ch.webhookUrlRef); if (!url) throw new Error('slack webhook url missing'); await post(url, JSON.stringify({ text }), { 'content-type': 'application/json' }); return; }
    case 'discord': { const url = secret(ch.webhookUrlRef); if (!url) throw new Error('discord webhook url missing'); await post(url, JSON.stringify({ content: text.replace(/\*/g, '**').slice(0, 1900) }), { 'content-type': 'application/json' }); return; }
    case 'telegram': { const token = secret(ch.botTokenRef); if (!token) throw new Error('telegram bot token missing'); await post(`https://api.telegram.org/bot${token}/sendMessage`, JSON.stringify({ chat_id: ch.chatId, text: `${a.title}\n${a.body}`.slice(0, 4000) }), { 'content-type': 'application/json' }); return; }
    case 'ntfy': { await post(`${(ch.server ?? 'https://ntfy.sh').replace(/\/$/, '')}/${ch.topic}`, a.body, { title: a.title, tags: a.kind === 'failure' ? 'warning' : 'bell' }); return; }
    case 'email': { await sendEmail(ch, a, secret); return; }
    case 'desktop': return; // handled by the app via onAlert
  }
}

async function post(url: string, body: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Minimal SMTP client (STARTTLS/implicit TLS, AUTH LOGIN/PLAIN) so email alerts need no dependency. */
async function sendEmail(ch: Extract<AlertChannel, { type: 'email' }>, a: { title: string; body: string }, secret: (n: string) => string | undefined) {
  const raw = secret(ch.smtpRef);
  if (!raw) throw new Error(`smtp config "${ch.smtpRef}" missing`);
  const cfg = JSON.parse(raw) as { host: string; port?: number; user?: string; pass?: string; from: string; secure?: boolean };
  const net = await import('node:net'); const tls = await import('node:tls');
  const port = cfg.port ?? (cfg.secure ? 465 : 587);
  let sock: import('node:net').Socket = cfg.secure ? tls.connect({ host: cfg.host, port, servername: cfg.host }) : net.connect({ host: cfg.host, port });
  const read = () => new Promise<string>((resolve, reject) => { const onData = (d: Buffer) => { sock.off('error', reject); resolve(d.toString()); }; sock.once('data', onData); sock.once('error', reject); });
  const cmd = async (c: string, expect = /^2|^3/) => { sock.write(c + '\r\n'); const r = await read(); if (!expect.test(r)) throw new Error(`SMTP ${c.split(' ')[0]} failed: ${r.trim()}`); return r; };
  await read();
  await cmd(`EHLO scrappia`);
  if (!cfg.secure) { await cmd('STARTTLS'); sock = tls.connect({ socket: sock, servername: cfg.host }); await new Promise((r) => sock.once('secureConnect', r)); await cmd('EHLO scrappia'); }
  if (cfg.user) { await cmd('AUTH LOGIN', /^334/); await cmd(Buffer.from(cfg.user).toString('base64'), /^334/); await cmd(Buffer.from(cfg.pass ?? '').toString('base64')); }
  await cmd(`MAIL FROM:<${cfg.from}>`);
  for (const to of ch.to) await cmd(`RCPT TO:<${to}>`);
  await cmd('DATA', /^354/);
  const msg = [`From: ${cfg.from}`, `To: ${ch.to.join(', ')}`, `Subject: ${a.title}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', a.body.replace(/^\./gm, '..'), '.'].join('\r\n');
  await cmd(msg);
  await cmd('QUIT', /^2/).catch(() => { });
  sock.end();
}
