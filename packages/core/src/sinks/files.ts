import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import type { Sink as SinkConfig } from '../recipe/schema.js';
import type { SinkContext, SinkWriter, SinkResult, Row } from './types.js';
import { flattenObject, hash } from '../util/misc.js';

type FileSink = Extract<SinkConfig, { path: string }>;

function resolvePath(cfg: { path: string }, ctx: SinkContext): string {
  const p = cfg.path.replace(/\{\{\s*run\s*\}\}/g, ctx.runId).replace(/\{\{\s*recipe\s*\}\}/g, ctx.recipeName.replace(/[^\w.-]+/g, '_')).replace(/\{\{\s*dataset\s*\}\}/g, ctx.dataset)
    .replace(/\{\{\s*date\s*\}\}/g, new Date().toISOString().slice(0, 10)).replace(/\{\{\s*datetime\s*\}\}/g, new Date().toISOString().replace(/[:.]/g, '-'));
  const abs = resolve(ctx.outDir, p);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

function keyOf(row: Row, key: string | string[] | undefined): string {
  if (!key) return hash(row);
  const keys = Array.isArray(key) ? key : [key];
  return keys.map((k) => String(row[k] ?? '')).join('');
}

function toTabular(row: Row, columns: string[]): Record<string, unknown> {
  const flat = flattenObject(row);
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = flat[c] ?? '';
  for (const k of Object.keys(flat)) if (!(k in out)) out[k] = flat[k];
  return out;
}

function cell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Merge existing file rows with new rows according to mode. Returns final ordered rows. */
async function mergeRows(existing: Row[], incoming: AsyncIterable<Row> | Iterable<Row>, cfg: { mode: 'append' | 'overwrite' | 'upsert'; key?: string | string[] }): Promise<{ rows: Row[]; inserted: number; updated: number }> {
  let inserted = 0, updated = 0;
  if (cfg.mode === 'overwrite') {
    const rows: Row[] = [];
    for await (const r of incoming) { rows.push(r); inserted++; }
    return { rows, inserted, updated };
  }
  if (cfg.mode === 'append') {
    const rows = [...existing];
    for await (const r of incoming) { rows.push(r); inserted++; }
    return { rows, inserted, updated };
  }
  const index = new Map<string, number>();
  const rows = [...existing];
  rows.forEach((r, i) => index.set(keyOf(r, cfg.key), i));
  for await (const r of incoming) {
    const k = keyOf(r, cfg.key);
    const i = index.get(k);
    if (i === undefined) { index.set(k, rows.length); rows.push(r); inserted++; }
    else { rows[i] = { ...rows[i], ...r }; updated++; }
  }
  return { rows, inserted, updated };
}

function columnsOf(rows: Row[], preferred: string[]): string[] {
  const cols = [...preferred];
  for (const r of rows) for (const k of Object.keys(flattenObject(r))) if (!cols.includes(k)) cols.push(k);
  return cols;
}

// ---------- CSV / TSV ----------

export function csvSink(cfg: Extract<SinkConfig, { type: 'csv' | 'tsv' }>, ctx: SinkContext): SinkWriter {
  const path = resolvePath(cfg, ctx);
  const delimiter = cfg.type === 'tsv' ? '\t' : (cfg as { delimiter?: string }).delimiter ?? ',';
  return {
    async write(rows) {
      let existing: Row[] = [];
      if (cfg.mode !== 'overwrite' && existsSync(path)) {
        const parsed = Papa.parse<Row>(readFileSync(path, 'utf8').replace(/^﻿/, ''), { header: true, delimiter, skipEmptyLines: true });
        existing = parsed.data;
      }
      const merged = await mergeRows(existing, rows, cfg);
      const columns = columnsOf(merged.rows, ctx.columns);
      const data = merged.rows.map((r) => { const t = toTabular(r, columns); const o: Record<string, string> = {}; for (const c of columns) o[c] = cell(t[c]); return o; });
      const csv = Papa.unparse({ fields: columns, data: data.map((d) => columns.map((c) => d[c])) }, { delimiter, newline: '\r\n' });
      const bom = cfg.type === 'csv' && (cfg as { bom?: boolean }).bom !== false ? '﻿' : '';
      const ws = createWriteStream(path);
      ws.write(bom + csv + '\r\n');
      ws.end();
      await once(ws, 'finish');
      return { type: cfg.type, rows: merged.rows.length, target: path, inserted: merged.inserted, updated: merged.updated, bytes: statSync(path).size };
    },
  };
}

// ---------- JSON / JSONL ----------

export function jsonSink(cfg: Extract<SinkConfig, { type: 'json' }>, ctx: SinkContext): SinkWriter {
  const path = resolvePath(cfg, ctx);
  return {
    async write(rows) {
      let existing: Row[] = [];
      if (cfg.mode !== 'overwrite' && existsSync(path)) { try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { existing = []; } }
      const merged = await mergeRows(existing, rows, cfg);
      const ws = createWriteStream(path);
      ws.write(cfg.pretty ? JSON.stringify(merged.rows, null, 2) : JSON.stringify(merged.rows));
      ws.end();
      await once(ws, 'finish');
      return { type: 'json', rows: merged.rows.length, target: path, inserted: merged.inserted, updated: merged.updated, bytes: statSync(path).size };
    },
  };
}

export function jsonlSink(cfg: Extract<SinkConfig, { type: 'jsonl' }>, ctx: SinkContext): SinkWriter {
  const path = resolvePath(cfg, ctx);
  return {
    async write(rows) {
      if (cfg.mode === 'upsert' && existsSync(path)) {
        const existing = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
        const merged = await mergeRows(existing, rows, cfg);
        const ws = createWriteStream(path);
        for (const r of merged.rows) ws.write(JSON.stringify(r) + '\n');
        ws.end(); await once(ws, 'finish');
        return { type: 'jsonl', rows: merged.rows.length, target: path, inserted: merged.inserted, updated: merged.updated, bytes: statSync(path).size };
      }
      // true streaming for append/overwrite
      const ws = createWriteStream(path, { flags: cfg.mode === 'append' ? 'a' : 'w' });
      let n = 0;
      for await (const r of rows) { if (!ws.write(JSON.stringify(r) + '\n')) await once(ws, 'drain'); n++; }
      ws.end(); await once(ws, 'finish');
      return { type: 'jsonl', rows: n, target: path, inserted: n, updated: 0, bytes: statSync(path).size };
    },
  };
}

// ---------- XLSX ----------

export function xlsxSink(cfg: Extract<SinkConfig, { type: 'xlsx' }>, ctx: SinkContext): SinkWriter {
  const path = resolvePath(cfg, ctx);
  const sheetName = cfg.sheet ?? ctx.dataset ?? 'Data';
  return {
    async write(rows) {
      let existing: Row[] = [];
      if (cfg.mode !== 'overwrite' && existsSync(path)) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path);
        const ws = wb.getWorksheet(sheetName);
        if (ws) {
          const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ''));
          ws.eachRow((row, i) => {
            if (i === 1) return;
            const vals = (row.values as unknown[]).slice(1);
            const o: Row = {};
            header.forEach((h, j) => { const v = vals[j]; o[h] = v && typeof v === 'object' && 'text' in (v as object) ? (v as { text: string }).text : v; });
            existing.push(o);
          });
        }
      }
      const merged = await mergeRows(existing, rows, cfg);
      const columns = columnsOf(merged.rows, ctx.columns);
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Scrappia';
      const ws = wb.addWorksheet(sheetName);
      ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(60, Math.max(12, c.length + 2)) }));
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      for (const r of merged.rows) {
        const t = toTabular(r, columns);
        const out: Record<string, unknown> = {};
        for (const c of columns) {
          let v = t[c];
          if (typeof v === 'string' && v.length > 32000) v = v.slice(0, 32000); // Excel cell limit
          else if (v && typeof v === 'object') v = JSON.stringify(v);
          else if (typeof v === 'string' && /^https?:\/\//.test(v) && v.length < 2000) v = { text: v, hyperlink: v };
          out[c] = v;
        }
        ws.addRow(out);
      }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, columns.length) } };
      await wb.xlsx.writeFile(path);
      return { type: 'xlsx', rows: merged.rows.length, target: path, inserted: merged.inserted, updated: merged.updated, bytes: statSync(path).size };
    },
  };
}

// ---------- XML ----------

function xmlEscape(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function xmlName(s: string): string { const n = s.replace(/[^A-Za-z0-9_.-]/g, '_'); return /^[A-Za-z_]/.test(n) ? n : `_${n}`; }
function toXml(v: unknown, name: string, indent: string): string {
  const tag = xmlName(name);
  if (v == null) return `${indent}<${tag}/>\n`;
  if (Array.isArray(v)) return v.map((x) => toXml(x, name, indent)).join('');
  if (typeof v === 'object') return `${indent}<${tag}>\n${Object.entries(v as Row).map(([k, x]) => toXml(x, k, indent + '  ')).join('')}${indent}</${tag}>\n`;
  return `${indent}<${tag}>${xmlEscape(String(v))}</${tag}>\n`;
}

export function xmlSink(cfg: Extract<SinkConfig, { type: 'xml' }>, ctx: SinkContext): SinkWriter {
  const path = resolvePath(cfg, ctx);
  return {
    async write(rows) {
      const all: Row[] = [];
      for await (const r of rows) all.push(r);
      const root = cfg.root ?? 'rows';
      const rowTag = cfg.row ?? 'row';
      const ws = createWriteStream(path);
      ws.write(`<?xml version="1.0" encoding="UTF-8"?>\n<${xmlName(root)}>\n`);
      for (const r of all) ws.write(toXml(r, rowTag, '  '));
      ws.write(`</${xmlName(root)}>\n`);
      ws.end(); await once(ws, 'finish');
      return { type: 'xml', rows: all.length, target: path, inserted: all.length, updated: 0, bytes: statSync(path).size };
    },
  };
}

// ---------- Parquet (optional dependency) ----------

export function parquetSink(cfg: Extract<SinkConfig, { type: 'parquet' }>, ctx: SinkContext): SinkWriter {
  const path = resolvePath(cfg, ctx);
  return {
    async write(rows) {
      let mod: { parquetWriteFile: (opts: { filename: string; columnData: Array<{ name: string; data: unknown[] }> }) => void };
      try { mod = await import('hyparquet-writer' as string); } catch { throw new Error('Parquet export needs the optional dependency "hyparquet-writer" (npm i hyparquet-writer)'); }
      const all: Row[] = [];
      for await (const r of rows) all.push(toTabular(r, ctx.columns));
      const columns = columnsOf(all, ctx.columns);
      const columnData = columns.map((name) => ({ name, data: all.map((r) => { const v = r[name]; return v == null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : v; }) }));
      mod.parquetWriteFile({ filename: path, columnData });
      return { type: 'parquet', rows: all.length, target: path, inserted: all.length, updated: 0, bytes: statSync(path).size };
    },
  };
}

// ---------- stdout ----------

export function stdoutSink(cfg: Extract<SinkConfig, { type: 'stdout' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const all: Row[] = [];
      let n = 0;
      if (cfg.format === 'jsonl') { for await (const r of rows) { process.stdout.write(JSON.stringify(r) + '\n'); n++; } return { type: 'stdout', rows: n, target: 'stdout' }; }
      for await (const r of rows) all.push(r);
      if (cfg.format === 'json') process.stdout.write(JSON.stringify(all, null, 2) + '\n');
      else if (cfg.format === 'csv') { const columns = columnsOf(all, ctx.columns); process.stdout.write(Papa.unparse({ fields: columns, data: all.map((r) => { const t = toTabular(r, columns); return columns.map((c) => cell(t[c])); }) }) + '\n'); }
      else { const columns = columnsOf(all, ctx.columns); console.table(all.map((r) => { const t = toTabular(r, columns); const o: Record<string, string> = {}; for (const c of columns) o[c] = cell(t[c]).slice(0, 40); return o; })); }
      return { type: 'stdout', rows: all.length, target: 'stdout' };
    },
  };
}

export { keyOf as sinkRowKey, toTabular, columnsOf, resolvePath as resolveSinkPath };
export type { FileSink };
