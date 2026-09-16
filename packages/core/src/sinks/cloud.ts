/**
 * Cloud / SaaS sinks implemented over plain fetch so the core stays dependency-light:
 * Google Sheets (service account JWT), Airtable, Notion, S3 (SigV4), signed webhooks.
 */
import { createHmac, createHash, createSign } from 'node:crypto';
import { fetch } from 'undici';
import Papa from 'papaparse';
import type { Sink as SinkConfig } from '../recipe/schema.js';
import type { SinkContext, SinkWriter, Row } from './types.js';
import { toTabular, columnsOf } from './files.js';
import { chunk, sleep } from '../util/misc.js';

async function retry<T>(fn: () => Promise<T>, attempts = 4, label = 'request'): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(500 * 2 ** i); }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${(last as Error)?.message ?? last}`);
}

async function jsonFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }, label: string): Promise<unknown> {
  const res = await fetch(url, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function cellText(v: unknown): string { return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
function keysOf(cfg: { key?: string | string[] }): string[] { return !cfg.key ? [] : Array.isArray(cfg.key) ? cfg.key : [cfg.key]; }
function rowKey(r: Row, keys: string[]): string { return keys.map((k) => cellText(r[k])).join(''); }

// ---------- Google Sheets ----------

async function googleAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string; token_uri?: string };
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}` });
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`Google auth failed: ${j.error} ${j.error_description ?? ''}`);
  return j.access_token;
}

export function googleSheetsSink(cfg: Extract<SinkConfig, { type: 'google-sheets' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const cred = ctx.secret(cfg.credentialRef);
      if (!cred) throw new Error(`Google credential "${cfg.credentialRef}" not found in secrets`);
      // credential may be a service-account JSON or a raw OAuth access token
      const token = cred.trim().startsWith('{') ? await googleAccessToken(cred) : cred.trim();
      const h = { authorization: `Bearer ${token}` };
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}`;
      const sheet = cfg.sheet ?? 'Sheet1';
      const all: Row[] = [];
      for await (const r of rows) all.push(toTabular(r, ctx.columns));

      // ensure sheet exists
      const meta = (await jsonFetch(`${base}?fields=sheets.properties`, { headers: h }, 'sheets.get')) as { sheets?: Array<{ properties: { title: string } }> };
      if (!meta.sheets?.some((s) => s.properties.title === sheet)) {
        await jsonFetch(`${base}:batchUpdate`, { method: 'POST', headers: h, body: { requests: [{ addSheet: { properties: { title: sheet } } }] } }, 'sheets.addSheet');
      }
      const range = encodeURIComponent(`'${sheet}'`);
      let existing: string[][] = [];
      if (cfg.mode !== 'overwrite') {
        const got = (await jsonFetch(`${base}/values/${range}`, { headers: h }, 'sheets.values.get')) as { values?: string[][] };
        existing = got.values ?? [];
      }
      const header = existing[0] ?? [];
      const columns = columnsOf(all, header.length ? header : ctx.columns);
      const toCells = (r: Row) => columns.map((c) => cellText(r[c]));
      let inserted = 0, updated = 0;

      if (cfg.mode === 'overwrite' || !existing.length) {
        await jsonFetch(`${base}/values/${range}:clear`, { method: 'POST', headers: h, body: {} }, 'sheets.clear');
        const values = [columns, ...all.map(toCells)];
        for (const part of chunk(values, 5000)) {
          await retry(() => jsonFetch(`${base}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h, body: { values: part } }, 'sheets.append'));
        }
        inserted = all.length;
      } else if (cfg.mode === 'append') {
        if (columns.length > header.length) await jsonFetch(`${base}/values/${encodeURIComponent(`'${sheet}'!1:1`)}?valueInputOption=RAW`, { method: 'PUT', headers: h, body: { values: [columns] } }, 'sheets.header');
        for (const part of chunk(all.map(toCells), 5000)) await retry(() => jsonFetch(`${base}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h, body: { values: part } }, 'sheets.append'));
        inserted = all.length;
      } else {
        const keys = keysOf(cfg);
        const idx = new Map<string, number>();
        existing.slice(1).forEach((vals, i) => { const r: Row = {}; header.forEach((c, j) => { r[c] = vals[j] ?? ''; }); idx.set(rowKey(r, keys), i + 2); });
        const updates: Array<{ range: string; values: string[][] }> = [];
        const appends: string[][] = [];
        for (const r of all) {
          const rn = idx.get(rowKey(r, keys));
          if (rn) { updates.push({ range: `'${sheet}'!A${rn}`, values: [toCells(r)] }); updated++; } else { appends.push(toCells(r)); inserted++; }
        }
        if (columns.length > header.length) updates.push({ range: `'${sheet}'!1:1`, values: [columns] });
        for (const part of chunk(updates, 500)) await retry(() => jsonFetch(`${base}/values:batchUpdate`, { method: 'POST', headers: h, body: { valueInputOption: 'USER_ENTERED', data: part } }, 'sheets.batchUpdate'));
        for (const part of chunk(appends, 5000)) await retry(() => jsonFetch(`${base}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h, body: { values: part } }, 'sheets.append'));
      }
      return { type: 'google-sheets', rows: all.length, target: `${cfg.spreadsheetId}/${sheet}`, inserted, updated };
    },
  };
}

// ---------- Airtable ----------

export function airtableSink(cfg: Extract<SinkConfig, { type: 'airtable' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const token = ctx.secret(cfg.credentialRef);
      if (!token) throw new Error(`Airtable token "${cfg.credentialRef}" not found in secrets`);
      const h = { authorization: `Bearer ${token}` };
      const url = `https://api.airtable.com/v0/${cfg.baseId}/${encodeURIComponent(cfg.table)}`;
      const all: Row[] = [];
      for await (const r of rows) all.push(toTabular(r, ctx.columns));
      const keys = keysOf(cfg);
      let inserted = 0, updated = 0;
      if (cfg.mode === 'overwrite') {
        // delete all existing records (paged)
        let offset: string | undefined;
        do {
          const page = (await jsonFetch(`${url}?pageSize=100${offset ? `&offset=${offset}` : ''}`, { headers: h }, 'airtable.list')) as { records: Array<{ id: string }>; offset?: string };
          for (const part of chunk(page.records, 10)) await jsonFetch(`${url}?${part.map((r) => `records[]=${r.id}`).join('&')}`, { method: 'DELETE', headers: h }, 'airtable.delete');
          offset = page.offset;
        } while (offset);
      }
      for (const part of chunk(all, 10)) {
        const body: Record<string, unknown> = { records: part.map((r) => ({ fields: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v])) })), typecast: true };
        let method = 'POST';
        if (cfg.mode === 'upsert' && keys.length) { body.performUpsert = { fieldsToMergeOn: keys }; method = 'PATCH'; }
        const res = (await retry(() => jsonFetch(url, { method, headers: h, body }, 'airtable.write'))) as { records: unknown[]; createdRecords?: string[]; updatedRecords?: string[] };
        inserted += res.createdRecords?.length ?? (method === 'POST' ? part.length : 0);
        updated += res.updatedRecords?.length ?? 0;
        await sleep(220); // 5 rps limit
      }
      return { type: 'airtable', rows: all.length, target: `${cfg.baseId}/${cfg.table}`, inserted, updated };
    },
  };
}

// ---------- Notion ----------

export function notionSink(cfg: Extract<SinkConfig, { type: 'notion' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const token = ctx.secret(cfg.credentialRef);
      if (!token) throw new Error(`Notion token "${cfg.credentialRef}" not found in secrets`);
      const h = { authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' };
      const db = (await jsonFetch(`https://api.notion.com/v1/databases/${cfg.databaseId}`, { headers: h }, 'notion.database')) as { properties: Record<string, { type: string }> };
      const props = db.properties;
      const titleProp = Object.entries(props).find(([, p]) => p.type === 'title')?.[0];
      const all: Row[] = [];
      for await (const r of rows) all.push(toTabular(r, ctx.columns));
      const keys = keysOf(cfg);
      const toProps = (r: Row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          const p = props[k];
          if (!p) continue;
          const s = cellText(v);
          switch (p.type) {
            case 'title': out[k] = { title: [{ text: { content: s.slice(0, 2000) } }] }; break;
            case 'rich_text': out[k] = { rich_text: [{ text: { content: s.slice(0, 2000) } }] }; break;
            case 'number': { const n = typeof v === 'number' ? v : parseFloat(s.replace(/[^\d.-]/g, '')); if (Number.isFinite(n)) out[k] = { number: n }; break; }
            case 'url': if (s) out[k] = { url: s }; break;
            case 'email': if (s) out[k] = { email: s }; break;
            case 'phone_number': if (s) out[k] = { phone_number: s }; break;
            case 'checkbox': out[k] = { checkbox: v === true || /^(true|yes|1)$/i.test(s) }; break;
            case 'select': if (s) out[k] = { select: { name: s.slice(0, 100) } }; break;
            case 'multi_select': out[k] = { multi_select: s.split(/\s*\|\s*|,\s*/).filter(Boolean).map((n) => ({ name: n.slice(0, 100) })) }; break;
            case 'date': if (s) out[k] = { date: { start: s } }; break;
            default: break;
          }
        }
        if (titleProp && !out[titleProp]) out[titleProp] = { title: [{ text: { content: cellText(r[Object.keys(r)[0]]).slice(0, 2000) } }] };
        return out;
      };
      let inserted = 0, updated = 0;
      for (const r of all) {
        let pageId: string | undefined;
        if (cfg.mode === 'upsert' && keys.length) {
          const filter = keys.length === 1 ? filterFor(keys[0], props[keys[0]]?.type, cellText(r[keys[0]])) : { and: keys.map((k) => filterFor(k, props[k]?.type, cellText(r[k]))) };
          const q = (await jsonFetch(`https://api.notion.com/v1/databases/${cfg.databaseId}/query`, { method: 'POST', headers: h, body: { filter, page_size: 1 } }, 'notion.query')) as { results: Array<{ id: string }> };
          pageId = q.results[0]?.id;
        }
        if (pageId) { await retry(() => jsonFetch(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', headers: h, body: { properties: toProps(r) } }, 'notion.update')); updated++; }
        else { await retry(() => jsonFetch('https://api.notion.com/v1/pages', { method: 'POST', headers: h, body: { parent: { database_id: cfg.databaseId }, properties: toProps(r) } }, 'notion.create')); inserted++; }
        await sleep(340); // 3 rps
      }
      return { type: 'notion', rows: all.length, target: cfg.databaseId, inserted, updated };
    },
  };
}

function filterFor(prop: string, type: string | undefined, value: string) {
  switch (type) {
    case 'number': return { property: prop, number: { equals: parseFloat(value) } };
    case 'url': return { property: prop, url: { equals: value } };
    case 'email': return { property: prop, email: { equals: value } };
    case 'title': return { property: prop, title: { equals: value } };
    default: return { property: prop, rich_text: { equals: value } };
  }
}

// ---------- S3 (SigV4, works with R2/MinIO via endpoint) ----------

function hmac(key: Buffer | string, data: string) { return createHmac('sha256', key).update(data).digest(); }
function sha256Hex(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }

export async function s3Put(opts: { accessKeyId: string; secretAccessKey: string; region?: string; endpoint?: string; bucket: string; key: string; body: Buffer; contentType: string; sessionToken?: string }) {
  const region = opts.region ?? 'us-east-1';
  const endpoint = opts.endpoint ?? `https://s3.${region}.amazonaws.com`;
  const pathStyle = !!opts.endpoint;
  const host = pathStyle ? new URL(endpoint).host : `${opts.bucket}.s3.${region}.amazonaws.com`;
  const path = pathStyle ? `/${opts.bucket}/${opts.key.split('/').map(encodeURIComponent).join('/')}` : `/${opts.key.split('/').map(encodeURIComponent).join('/')}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(opts.body);
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'content-type': opts.contentType };
  if (opts.sessionToken) headers['x-amz-security-token'] = opts.sessionToken;
  const signed = Object.keys(headers).sort();
  const canonical = ['PUT', path, '', ...signed.map((k) => `${k}:${headers[k].trim()}`), '', signed.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(sts).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  const { host: _h, ...sendHeaders } = headers;
  const res = await fetch(`${pathStyle ? endpoint : `https://${host}`}${path}`, { method: 'PUT', headers: sendHeaders, body: opts.body });
  if (!res.ok) throw new Error(`S3 PUT failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export function s3Sink(cfg: Extract<SinkConfig, { type: 's3' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const cred = ctx.secret(cfg.credentialRef);
      if (!cred) throw new Error(`S3 credential "${cfg.credentialRef}" not found in secrets`);
      const c = JSON.parse(cred) as { accessKeyId: string; secretAccessKey: string; region?: string; endpoint?: string; sessionToken?: string };
      const all: Row[] = [];
      for await (const r of rows) all.push(r);
      const key = cfg.keyTemplate.replace(/\{\{\s*run\s*\}\}/g, ctx.runId).replace(/\{\{\s*recipe\s*\}\}/g, ctx.recipeName.replace(/[^\w.-]+/g, '_')).replace(/\{\{\s*dataset\s*\}\}/g, ctx.dataset).replace(/\{\{\s*date\s*\}\}/g, new Date().toISOString().slice(0, 10)).replace(/\{\{\s*datetime\s*\}\}/g, new Date().toISOString().replace(/[:.]/g, '-'));
      let body: Buffer; let contentType: string;
      if (cfg.format === 'json') { body = Buffer.from(JSON.stringify(all)); contentType = 'application/json'; }
      else if (cfg.format === 'csv') { const cols = columnsOf(all, ctx.columns); body = Buffer.from(Papa.unparse({ fields: cols, data: all.map((r) => { const t = toTabular(r, cols); return cols.map((c) => cellText(t[c])); }) })); contentType = 'text/csv'; }
      else { body = Buffer.from(all.map((r) => JSON.stringify(r)).join('\n') + '\n'); contentType = 'application/x-ndjson'; }
      await retry(() => s3Put({ ...c, region: cfg.region ?? c.region, endpoint: cfg.endpoint ?? c.endpoint, bucket: cfg.bucket, key, body, contentType }), 3, 's3.put');
      return { type: 's3', rows: all.length, target: `s3://${cfg.bucket}/${key}`, inserted: all.length, bytes: body.length };
    },
  };
}

// ---------- Webhook ----------

export function webhookSink(cfg: Extract<SinkConfig, { type: 'webhook' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const secret = cfg.secretRef ? ctx.secret(cfg.secretRef) : undefined;
      let n = 0, batchNo = 0;
      const buffer: Row[] = [];
      const send = async (last: boolean) => {
        const payload = JSON.stringify({ event: 'rows', runId: ctx.runId, recipe: ctx.recipeName, dataset: ctx.dataset, batch: batchNo++, last, rows: buffer });
        const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Scrappia-Webhook/1', 'x-scrappia-run': ctx.runId, ...(cfg.headers ?? {}) };
        if (secret) { const ts = Date.now().toString(); headers['x-scrappia-timestamp'] = ts; headers['x-scrappia-signature'] = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex'); }
        await retry(async () => { const res = await fetch(cfg.url, { method: 'POST', headers, body: payload }); if (!res.ok) throw new Error(`HTTP ${res.status}`); }, 4, 'webhook');
        buffer.length = 0;
      };
      for await (const r of rows) { buffer.push(r); n++; if (buffer.length >= cfg.batchSize) await send(false); }
      await send(true);
      return { type: 'webhook', rows: n, target: cfg.url, inserted: n };
    },
  };
}
