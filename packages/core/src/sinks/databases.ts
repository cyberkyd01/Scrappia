import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Sink as SinkConfig } from '../recipe/schema.js';
import type { SinkContext, SinkWriter, Row } from './types.js';
import { toTabular, columnsOf, sinkRowKey } from './files.js';
import { chunk } from '../util/misc.js';

function keysOf(cfg: { key?: string | string[] }): string[] { return !cfg.key ? [] : Array.isArray(cfg.key) ? cfg.key : [cfg.key]; }

function sqlIdent(name: string, quote: string): string {
  const safe = name.replace(/[^\w.]/g, '_');
  return quote === '`' ? `\`${safe}\`` : `"${safe}"`;
}

function cellValue(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  if (v && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** node:sqlite binds every JS number as REAL ("1.0" in TEXT columns); bind integers as INTEGER. */
function sqliteValue(v: unknown): string | number | bigint | null {
  const c = cellValue(v);
  if (c === null) return null;
  if (typeof c === 'number') return Number.isInteger(c) && Math.abs(c) < Number.MAX_SAFE_INTEGER ? BigInt(c) : c;
  return String(c);
}

// ---------- SQLite ----------

export function sqliteSink(cfg: Extract<SinkConfig, { type: 'sqlite' }>, ctx: SinkContext): SinkWriter {
  const path = resolve(ctx.outDir, cfg.path);
  mkdirSync(dirname(path), { recursive: true });
  return {
    async write(rows) {
      const all: Row[] = [];
      for await (const r of rows) all.push(toTabular(r, ctx.columns));
      const columns = columnsOf(all, ctx.columns);
      const keys = keysOf(cfg);
      const table = sqlIdent(cfg.table, '"');
      const db = new DatabaseSync(path);
      try {
        if (cfg.mode === 'overwrite') db.exec(`DROP TABLE IF EXISTS ${table}`);
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${columns.map((c) => `${sqlIdent(c, '"')} TEXT`).join(', ')}${keys.length && cfg.mode === 'upsert' ? `, UNIQUE(${keys.map((k) => sqlIdent(k, '"')).join(', ')})` : ''})`);
        // add missing columns
        const existingCols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
        for (const c of columns) if (!existingCols.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sqlIdent(c, '"')} TEXT`);
        if (cfg.mode === 'upsert' && keys.length) {
          db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${sqlIdent(cfg.table + '_key', '"')} ON ${table} (${keys.map((k) => sqlIdent(k, '"')).join(', ')})`);
        }
        const cols = columns.map((c) => sqlIdent(c, '"')).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const conflict = cfg.mode === 'upsert' && keys.length ? ` ON CONFLICT(${keys.map((k) => sqlIdent(k, '"')).join(', ')}) DO UPDATE SET ${columns.filter((c) => !keys.includes(c)).map((c) => `${sqlIdent(c, '"')}=excluded.${sqlIdent(c, '"')}`).join(', ') || `${sqlIdent(columns[0], '"')}=excluded.${sqlIdent(columns[0], '"')}`}` : '';
        const stmt = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})${conflict}`);
        db.exec('BEGIN');
        let inserted = 0, updated = 0;
        for (const r of all) {
          const res = stmt.run(...columns.map((c) => sqliteValue(r[c])));
          if (res.changes) inserted++; else updated++;
        }
        db.exec('COMMIT');
        return { type: 'sqlite', rows: all.length, target: `${path}#${cfg.table}`, inserted, updated };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* not in tx */ }
        throw e;
      } finally { db.close(); }
    },
  };
}

// ---------- Postgres ----------

export function postgresSink(cfg: Extract<SinkConfig, { type: 'postgres' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const conn = ctx.secret(cfg.connectionRef);
      if (!conn) throw new Error(`Postgres connection "${cfg.connectionRef}" not found in secrets`);
      let pg: typeof import('pg');
      try { pg = await import('pg'); } catch { throw new Error('Postgres export needs the optional dependency "pg" (npm i pg)'); }
      const client = new pg.default.Client({ connectionString: conn });
      await client.connect();
      try {
        const all: Row[] = [];
        for await (const r of rows) all.push(toTabular(r, ctx.columns));
        const columns = columnsOf(all, ctx.columns);
        const keys = keysOf(cfg);
        const q = (s: string) => sqlIdent(s, '"');
        const table = `${cfg.schema ? q(cfg.schema) + '.' : ''}${q(cfg.table)}`;
        if (cfg.mode === 'overwrite') await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${table} (${columns.map((c) => `${q(c)} TEXT`).join(', ')})`);
        const existing = new Set((await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1${cfg.schema ? ' AND table_schema=$2' : ''}`, cfg.schema ? [cfg.table, cfg.schema] : [cfg.table])).rows.map((r: { column_name: string }) => r.column_name));
        for (const c of columns) if (!existing.has(c.replace(/[^\w.]/g, '_'))) await client.query(`ALTER TABLE ${table} ADD COLUMN ${q(c)} TEXT`);
        if (cfg.mode === 'upsert' && keys.length) await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(cfg.table + '_key')} ON ${table} (${keys.map(q).join(', ')})`);
        let inserted = 0;
        await client.query('BEGIN');
        for (const batch of chunk(all, 500)) {
          const values: unknown[] = [];
          const tuples = batch.map((r, i) => `(${columns.map((c, j) => { values.push(cellValue(r[c])); return `$${i * columns.length + j + 1}`; }).join(', ')})`);
          const conflict = cfg.mode === 'upsert' && keys.length ? ` ON CONFLICT (${keys.map(q).join(', ')}) DO UPDATE SET ${columns.filter((c) => !keys.includes(c)).map((c) => `${q(c)}=EXCLUDED.${q(c)}`).join(', ') || `${q(columns[0])}=EXCLUDED.${q(columns[0])}`}` : '';
          const res = await client.query(`INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES ${tuples.join(', ')}${conflict}`, values);
          inserted += res.rowCount ?? 0;
        }
        await client.query('COMMIT');
        return { type: 'postgres', rows: all.length, target: `${cfg.connectionRef}/${cfg.table}`, inserted };
      } catch (e) { await client.query('ROLLBACK').catch(() => { }); throw e; } finally { await client.end(); }
    },
  };
}

// ---------- MySQL ----------

export function mysqlSink(cfg: Extract<SinkConfig, { type: 'mysql' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const conn = ctx.secret(cfg.connectionRef);
      if (!conn) throw new Error(`MySQL connection "${cfg.connectionRef}" not found in secrets`);
      let mysql: typeof import('mysql2/promise');
      try { mysql = await import('mysql2/promise'); } catch { throw new Error('MySQL export needs the optional dependency "mysql2" (npm i mysql2)'); }
      const c = await mysql.createConnection(conn);
      try {
        const all: Row[] = [];
        for await (const r of rows) all.push(toTabular(r, ctx.columns));
        const columns = columnsOf(all, ctx.columns);
        const keys = keysOf(cfg);
        const q = (s: string) => sqlIdent(s, '`');
        const table = q(cfg.table);
        if (cfg.mode === 'overwrite') await c.query(`DROP TABLE IF EXISTS ${table}`);
        await c.query(`CREATE TABLE IF NOT EXISTS ${table} (${columns.map((cn) => `${q(cn)} TEXT`).join(', ')}${keys.length && cfg.mode === 'upsert' ? `, UNIQUE KEY ${q(cfg.table + '_key')} (${keys.map((k) => `${q(k)}(191)`).join(', ')})` : ''})`);
        const [colsRes] = await c.query(`SHOW COLUMNS FROM ${table}`);
        const existing = new Set((colsRes as Array<{ Field: string }>).map((r) => r.Field));
        for (const cn of columns) if (!existing.has(cn.replace(/[^\w.]/g, '_'))) await c.query(`ALTER TABLE ${table} ADD COLUMN ${q(cn)} TEXT`);
        let inserted = 0;
        await c.beginTransaction();
        for (const batch of chunk(all, 500)) {
          const values = batch.map((r) => columns.map((cn) => cellValue(r[cn])));
          const dup = cfg.mode === 'upsert' && keys.length ? ` ON DUPLICATE KEY UPDATE ${columns.filter((cn) => !keys.includes(cn)).map((cn) => `${q(cn)}=VALUES(${q(cn)})`).join(', ') || `${q(columns[0])}=VALUES(${q(columns[0])})`}` : '';
          const [res] = await c.query(`INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES ?${dup}`, [values]);
          inserted += (res as { affectedRows: number }).affectedRows;
        }
        await c.commit();
        return { type: 'mysql', rows: all.length, target: `${cfg.connectionRef}/${cfg.table}`, inserted };
      } catch (e) { await c.rollback().catch(() => { }); throw e; } finally { await c.end(); }
    },
  };
}

// ---------- MongoDB ----------

export function mongoSink(cfg: Extract<SinkConfig, { type: 'mongodb' }>, ctx: SinkContext): SinkWriter {
  return {
    async write(rows) {
      const conn = ctx.secret(cfg.connectionRef);
      if (!conn) throw new Error(`MongoDB connection "${cfg.connectionRef}" not found in secrets`);
      let mongo: typeof import('mongodb');
      try { mongo = await import('mongodb'); } catch { throw new Error('MongoDB export needs the optional dependency "mongodb" (npm i mongodb)'); }
      const client = new mongo.MongoClient(conn);
      await client.connect();
      try {
        const col = client.db(cfg.database).collection(cfg.collection);
        if (cfg.mode === 'overwrite') await col.deleteMany({});
        const keys = keysOf(cfg);
        let inserted = 0, updated = 0;
        const buffer: Row[] = [];
        const flush = async () => {
          if (!buffer.length) return;
          if (cfg.mode === 'upsert' && keys.length) {
            const res = await col.bulkWrite(buffer.map((r) => ({ updateOne: { filter: Object.fromEntries(keys.map((k) => [k, r[k]])), update: { $set: r }, upsert: true } })));
            inserted += res.upsertedCount; updated += res.modifiedCount;
          } else { const res = await col.insertMany(buffer.map((r) => ({ ...r }))); inserted += res.insertedCount; }
          buffer.length = 0;
        };
        let n = 0;
        for await (const r of rows) { buffer.push(r); n++; if (buffer.length >= 500) await flush(); }
        await flush();
        return { type: 'mongodb', rows: n, target: `${cfg.database}.${cfg.collection}`, inserted, updated };
      } finally { await client.close(); }
    },
  };
}

export { sinkRowKey };
