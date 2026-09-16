import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { once } from 'node:events';
import { request } from 'undici';
import type { Field, OutputConfig, Recipe, Template, ValidationRule } from '../recipe/schema.js';
import { applyTransforms, compileJs, type TransformContext } from '../transform/index.js';
import { hash, interpolate, safeFileName } from '../util/misc.js';
import type { AiService } from '../ai/service.js';

export interface RowContext {
  recipe: Recipe;
  template: Template;
  templateName: string;
  pageUrl: string;
  runId: string;
  keywords: Record<string, string>;
  categoryPath: string[];
  outDir: string;
  ai?: AiService;
  screenshots: Record<string, string>;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface ProcessedRow {
  data: Record<string, unknown>;
  key: string;
  flags: string[];
  dropped: boolean;
  failed?: string;
}

/** Post-process raw DOM records: AI fields, transforms, downloads, provenance, validation, keys. */
export async function processRecords(records: Array<Record<string, unknown>>, fields: Field[], ctx: RowContext, isPageRow = false): Promise<ProcessedRow[]> {
  const rows: Array<Record<string, unknown>> = records.map((r) => ({ ...r }));
  // 1. AI fields (batched per page)
  const aiFields = fields.filter((f) => f.type === 'ai');
  for (const f of aiFields) {
    if (!ctx.ai) { ctx.onLog?.(`AI field "${f.name}" skipped: no AI provider configured`); rows.forEach((r) => { r[f.name] = null; }); continue; }
    const inputs = rows.map((r) => r[f.name]);
    try {
      const out = await ctx.ai.extractBatch(f.prompt!, inputs, f.schema, ctx.recipe.ai.provider);
      rows.forEach((r, i) => { r[f.name] = out[i] ?? null; });
    } catch (e) {
      ctx.onLog?.(`AI field "${f.name}" failed`, { error: (e as Error).message });
      rows.forEach((r) => { r[f.name] = null; });
    }
  }
  // 2. screenshots
  for (const f of fields.filter((x) => x.type === 'screenshot')) rows.forEach((r) => { r[f.name] = ctx.screenshots[f.name] ?? null; });

  const out: ProcessedRow[] = [];
  for (const raw of rows) {
    const row = raw;
    const tctx: TransformContext = { pageUrl: ctx.pageUrl, row, ai: ctx.ai ? (p, v, s, prov) => ctx.ai!.transform(p, v, s, prov ?? ctx.recipe.ai.provider) : undefined };
    // 3. transforms + image downloads
    for (const f of fields) {
      let v = row[f.name];
      if (f.type === 'image' && v) v = await downloadImages(v, f, ctx, row);
      if (f.transforms.length) { try { v = await applyTransforms(v, f.transforms, tctx); } catch (e) { ctx.onLog?.(`transform failed for ${f.name}`, { error: (e as Error).message }); } }
      if (typeof v === 'string') v = v.trim();
      row[f.name] = v === undefined ? null : v;
    }
    // 4. provenance
    const o = ctx.recipe.output;
    if (o.addPageUrl) row._pageUrl = ctx.pageUrl;
    if (o.addTimestamp) row._scrapedAt = new Date().toISOString();
    if (o.addKeyword) for (const [k, val] of Object.entries(ctx.keywords)) row[`_kw_${k}`] = val;
    if (o.addCategoryPath && ctx.categoryPath.length) row._category = ctx.categoryPath.join(' > ');
    // 5. validation
    const { flags, dropped, failed } = validate(row, o.validation, fields);
    // 6. key
    const key = rowKey(row, o, ctx, isPageRow);
    out.push({ data: row, key, flags, dropped, failed });
  }
  return out;
}

export function rowKey(row: Record<string, unknown>, o: OutputConfig, ctx: { pageUrl: string; templateName: string }, isPageRow: boolean): string {
  if (o.keys.length) {
    const vals = o.keys.map((k) => row[k]);
    if (vals.some((v) => v !== null && v !== undefined && v !== '')) return hash(vals.map((v) => (v == null ? '' : String(v))).join(''));
  }
  if (isPageRow) return hash(`${ctx.templateName}|${ctx.pageUrl}`);
  return hash(row);
}

function validate(row: Record<string, unknown>, rules: ValidationRule[], fields: Field[]): { flags: string[]; dropped: boolean; failed?: string } {
  const flags: string[] = [];
  let dropped = false; let failed: string | undefined;
  const all: ValidationRule[] = [...fields.filter((f) => f.required).map((f) => ({ field: f.name, rule: 'required' as const, action: 'flag' as const })), ...rules];
  for (const r of all) {
    const v = row[r.field];
    const s = v == null ? '' : String(v);
    let ok = true;
    switch (r.rule) {
      case 'required': ok = v !== null && v !== undefined && s !== '' && !(Array.isArray(v) && !v.length); break;
      case 'regex': ok = new RegExp(String(r.value)).test(s); break;
      case 'min': ok = typeof v === 'number' ? v >= Number(r.value) : parseFloat(s) >= Number(r.value); break;
      case 'max': ok = typeof v === 'number' ? v <= Number(r.value) : parseFloat(s) <= Number(r.value); break;
      case 'minLength': ok = s.length >= Number(r.value); break;
      case 'maxLength': ok = s.length <= Number(r.value); break;
      case 'url': ok = /^https?:\/\/\S+$/i.test(s); break;
      case 'email': ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); break;
      case 'number': ok = typeof v === 'number' || (s !== '' && !isNaN(Number(s))); break;
      case 'enum': ok = Array.isArray(r.value) ? r.value.map(String).includes(s) : true; break;
      case 'js': try { ok = !!compileJs(String(r.value))(v, row, { pageUrl: '' }); } catch { ok = false; } break;
    }
    if (ok) continue;
    const flag = `${r.field}:${r.rule}`;
    if (r.action === 'drop') dropped = true;
    else if (r.action === 'fail') failed = flag;
    flags.push(flag);
  }
  return { flags, dropped, failed };
}

async function downloadImages(v: unknown, f: Field, ctx: RowContext, row: Record<string, unknown>): Promise<unknown> {
  const urls = Array.isArray(v) ? v.map(String) : [String(v)];
  const dirTpl = f.downloadDir ?? join('downloads', '{{run}}', f.name);
  const dir = join(ctx.outDir, interpolate(dirTpl, (n) => (n === 'run' ? ctx.runId : n.startsWith('field:') ? safeFileName(String(row[n.slice(6)] ?? '')) : undefined)));
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      let name: string;
      if (f.fileName) name = safeFileName(interpolate(f.fileName, (n) => (n === 'index' ? String(i + 1) : n.startsWith('field:') ? String(row[n.slice(6)] ?? '') : undefined)));
      else { const u = new URL(url); name = safeFileName(decodeURIComponent(u.pathname.split('/').pop() || 'image')); }
      if (!extname(name)) name += guessExt(url);
      let file = join(dir, name);
      if (existsSync(file)) file = join(dir, `${hash(url).slice(0, 8)}-${name}`);
      await download(url, file, ctx.pageUrl);
      paths.push(file);
    } catch (e) { ctx.onLog?.('image download failed', { url, error: (e as Error).message }); paths.push(url); }
  }
  return Array.isArray(v) ? paths : paths[0];
}

function guessExt(url: string): string {
  const m = /\.(jpe?g|png|gif|webp|svg|avif|bmp)(\?|$)/i.exec(url);
  return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

export async function download(url: string, file: string, referer?: string): Promise<number> {
  const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', referer: referer ?? url, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
  let res = await request(url, { headers, headersTimeout: 30_000, bodyTimeout: 60_000 });
  for (let i = 0; i < 5 && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location; i++) {
    await res.body.dump();
    url = new URL(String(res.headers.location), url).toString();
    res = await request(url, { headers, headersTimeout: 30_000, bodyTimeout: 60_000 });
  }
  if (res.statusCode >= 400) { await res.body.dump(); throw new Error(`HTTP ${res.statusCode}`); }
  const ws = createWriteStream(file);
  let bytes = 0;
  for await (const chunk of res.body) { bytes += (chunk as Buffer).length; if (!ws.write(chunk)) await once(ws, 'drain'); }
  ws.end(); await once(ws, 'finish');
  return bytes;
}
