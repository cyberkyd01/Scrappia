/**
 * Local storage on node:sqlite (Node >= 22.13, no native build step).
 * Holds projects, recipes (versioned), runs, request queue, rows, drift events, schedules, secrets.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id as newId } from '../util/misc.js';
import type { Storage, RunRecord, RequestRecord, RowRecord, DriftEvent, RecipeRecord, RunStatus, RequestStatus, ScheduleRecord, AlertRecord, DatasetStats } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_versions (
  recipe_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (recipe_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT,
  recipe_name TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  stats_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS runs_recipe ON runs(recipe_id, started_at DESC);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  url TEXT NOT NULL,
  unique_key TEXT NOT NULL,
  template TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  body TEXT,
  status TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  http_status INTEGER,
  fetch_mode TEXT,
  UNIQUE(run_id, unique_key)
);
CREATE INDEX IF NOT EXISTS requests_claim ON requests(run_id, status, created_at);
CREATE TABLE IF NOT EXISTS rows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  row_key TEXT NOT NULL,
  json TEXT NOT NULL,
  hash TEXT NOT NULL,
  page_url TEXT,
  created_at INTEGER NOT NULL,
  flags TEXT,
  UNIQUE(run_id, dataset, row_key)
);
CREATE INDEX IF NOT EXISTS rows_run ON rows(run_id, dataset, created_at);
CREATE TABLE IF NOT EXISTS drift_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  recipe_id TEXT,
  template TEXT NOT NULL,
  field TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  page_url TEXT,
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS drift_run ON drift_events(run_id);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  tz TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  skip_if_running INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  recipe_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
`;

export class SqliteStorage implements Storage {
  readonly db: DatabaseSync;

  constructor(public readonly path: string = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  // ---------- recipes ----------
  saveRecipe(rec: { id?: string; name: string; json: unknown; note?: string }): RecipeRecord {
    const now = Date.now();
    const json = JSON.stringify(rec.json);
    const existing = rec.id ? this.getRecipe(rec.id) : undefined;
    if (existing) {
      const version = existing.version + 1;
      this.db.prepare('UPDATE recipes SET name=?, version=?, json=?, updated_at=? WHERE id=?').run(rec.name, version, json, now, rec.id!);
      this.db.prepare('INSERT INTO recipe_versions(recipe_id, version, json, created_at, note) VALUES (?,?,?,?,?)').run(rec.id!, version, json, now, rec.note ?? null);
      return { id: rec.id!, name: rec.name, version, json: rec.json, createdAt: existing.createdAt, updatedAt: now };
    }
    const id = rec.id ?? newId();
    this.db.prepare('INSERT INTO recipes(id, name, version, json, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, rec.name, 1, json, now, now);
    this.db.prepare('INSERT INTO recipe_versions(recipe_id, version, json, created_at, note) VALUES (?,?,?,?,?)').run(id, 1, json, now, rec.note ?? null);
    return { id, name: rec.name, version: 1, json: rec.json, createdAt: now, updatedAt: now };
  }

  getRecipe(id: string): RecipeRecord | undefined {
    const r = this.db.prepare('SELECT * FROM recipes WHERE id=?').get(id) as Record<string, SQLInputValue> | undefined;
    return r ? this.rowToRecipe(r) : undefined;
  }

  listRecipes(): RecipeRecord[] {
    return (this.db.prepare('SELECT * FROM recipes ORDER BY updated_at DESC').all() as Record<string, SQLInputValue>[]).map((r) => this.rowToRecipe(r));
  }

  listRecipeVersions(id: string): Array<{ version: number; createdAt: number; note?: string; json: unknown }> {
    return (this.db.prepare('SELECT * FROM recipe_versions WHERE recipe_id=? ORDER BY version DESC').all(id) as Record<string, SQLInputValue>[])
      .map((r) => ({ version: r.version as number, createdAt: r.created_at as number, note: (r.note as string) ?? undefined, json: JSON.parse(r.json as string) }));
  }

  deleteRecipe(id: string) {
    this.db.prepare('DELETE FROM recipe_versions WHERE recipe_id=?').run(id);
    this.db.prepare('DELETE FROM schedules WHERE recipe_id=?').run(id);
    this.db.prepare('DELETE FROM recipes WHERE id=?').run(id);
  }

  private rowToRecipe(r: Record<string, SQLInputValue>): RecipeRecord {
    return { id: r.id as string, name: r.name as string, version: r.version as number, json: JSON.parse(r.json as string), createdAt: r.created_at as number, updatedAt: r.updated_at as number };
  }

  // ---------- runs ----------
  createRun(run: { recipeId?: string; recipeName: string; recipeJson: unknown; trigger?: string }): RunRecord {
    const id = newId();
    const now = Date.now();
    this.db.prepare('INSERT INTO runs(id, recipe_id, recipe_name, recipe_json, status, started_at, trigger) VALUES (?,?,?,?,?,?,?)')
      .run(id, run.recipeId ?? null, run.recipeName, JSON.stringify(run.recipeJson), 'running', now, run.trigger ?? 'manual');
    return { id, recipeId: run.recipeId, recipeName: run.recipeName, status: 'running', startedAt: now, stats: {}, trigger: run.trigger ?? 'manual' };
  }

  updateRun(id: string, patch: { status?: RunStatus; stats?: Record<string, unknown>; error?: string | null; finishedAt?: number }) {
    const sets: string[] = []; const vals: SQLInputValue[] = [];
    if (patch.status) { sets.push('status=?'); vals.push(patch.status); }
    if (patch.stats) { sets.push('stats_json=?'); vals.push(JSON.stringify(patch.stats)); }
    if (patch.error !== undefined) { sets.push('error=?'); vals.push(patch.error); }
    if (patch.finishedAt !== undefined) { sets.push('finished_at=?'); vals.push(patch.finishedAt); }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  }

  getRun(id: string): RunRecord | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Record<string, SQLInputValue> | undefined;
    return r ? this.rowToRun(r) : undefined;
  }

  listRuns(opts: { recipeId?: string; limit?: number; status?: RunStatus } = {}): RunRecord[] {
    const where: string[] = []; const vals: SQLInputValue[] = [];
    if (opts.recipeId) { where.push('recipe_id=?'); vals.push(opts.recipeId); }
    if (opts.status) { where.push('status=?'); vals.push(opts.status); }
    const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`;
    vals.push(opts.limit ?? 50);
    return (this.db.prepare(sql).all(...vals) as Record<string, SQLInputValue>[]).map((r) => this.rowToRun(r));
  }

  /** The most recent finished run of a recipe before `beforeRunId` (used for change detection). */
  previousRun(recipeId: string, beforeRunId: string): RunRecord | undefined {
    const cur = this.getRun(beforeRunId);
    if (!cur) return undefined;
    // insertion order (rowid) rather than started_at so runs created in the same millisecond order correctly
    const r = this.db.prepare("SELECT * FROM runs WHERE recipe_id=? AND id<>? AND status IN ('succeeded','partial') AND rowid < (SELECT rowid FROM runs WHERE id=?) ORDER BY rowid DESC LIMIT 1").get(recipeId, beforeRunId, beforeRunId) as Record<string, SQLInputValue> | undefined;
    return r ? this.rowToRun(r) : undefined;
  }

  deleteRun(id: string) {
    this.db.prepare('DELETE FROM rows WHERE run_id=?').run(id);
    this.db.prepare('DELETE FROM requests WHERE run_id=?').run(id);
    this.db.prepare('DELETE FROM drift_events WHERE run_id=?').run(id);
    this.db.prepare('DELETE FROM runs WHERE id=?').run(id);
  }

  private rowToRun(r: Record<string, SQLInputValue>): RunRecord {
    return {
      id: r.id as string, recipeId: (r.recipe_id as string) ?? undefined, recipeName: r.recipe_name as string, status: r.status as RunStatus,
      startedAt: r.started_at as number, finishedAt: (r.finished_at as number) ?? undefined, stats: JSON.parse(r.stats_json as string), error: (r.error as string) ?? undefined, trigger: r.trigger as string,
      recipeJson: JSON.parse(r.recipe_json as string),
    };
  }

  // ---------- request queue ----------
  enqueue(req: Omit<RequestRecord, 'id' | 'status' | 'attempts' | 'createdAt'> & { id?: string }): RequestRecord | null {
    const id = req.id ?? newId();
    const now = Date.now();
    const res = this.db.prepare(
      'INSERT OR IGNORE INTO requests(id, run_id, url, unique_key, template, method, body, status, depth, attempts, parent_id, context_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, req.runId, req.url, req.uniqueKey, req.template, req.method ?? 'GET', req.body ?? null, 'pending', req.depth ?? 0, 0, req.parentId ?? null, JSON.stringify(req.context ?? {}), now);
    if (!res.changes) return null;
    return { ...req, id, status: 'pending', attempts: 0, createdAt: now, method: req.method ?? 'GET' };
  }

  claimNext(runId: string): RequestRecord | undefined {
    const now = Date.now();
    const r = this.db.prepare(
      "UPDATE requests SET status='running', claimed_at=?, attempts=attempts+1 WHERE id = (SELECT id FROM requests WHERE run_id=? AND status='pending' ORDER BY depth ASC, created_at ASC LIMIT 1) RETURNING *",
    ).get(now, runId) as Record<string, SQLInputValue> | undefined;
    return r ? this.rowToRequest(r) : undefined;
  }

  finishRequest(id: string, patch: { status: RequestStatus; error?: string; durationMs?: number; httpStatus?: number; fetchMode?: string; requeue?: boolean }) {
    if (patch.requeue) {
      this.db.prepare("UPDATE requests SET status='pending', error=?, claimed_at=NULL WHERE id=?").run(patch.error ?? null, id);
      return;
    }
    this.db.prepare('UPDATE requests SET status=?, error=?, finished_at=?, duration_ms=?, http_status=?, fetch_mode=? WHERE id=?')
      .run(patch.status, patch.error ?? null, Date.now(), patch.durationMs ?? null, patch.httpStatus ?? null, patch.fetchMode ?? null, id);
  }

  /** Reset requests left 'running' by a crashed process so a run can resume. */
  resetRunning(runId: string): number {
    return Number(this.db.prepare("UPDATE requests SET status='pending', claimed_at=NULL WHERE run_id=? AND status='running'").run(runId).changes);
  }

  queueCounts(runId: string): Record<RequestStatus, number> {
    const out: Record<RequestStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) as n FROM requests WHERE run_id=? GROUP BY status').all(runId) as Array<{ status: RequestStatus; n: number }>) out[r.status] = r.n;
    return out;
  }

  listRequests(runId: string, opts: { status?: RequestStatus; limit?: number } = {}): RequestRecord[] {
    const vals: SQLInputValue[] = [runId];
    let sql = 'SELECT * FROM requests WHERE run_id=?';
    if (opts.status) { sql += ' AND status=?'; vals.push(opts.status); }
    sql += ' ORDER BY created_at DESC LIMIT ?'; vals.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...vals) as Record<string, SQLInputValue>[]).map((r) => this.rowToRequest(r));
  }

  private rowToRequest(r: Record<string, SQLInputValue>): RequestRecord {
    return {
      id: r.id as string, runId: r.run_id as string, url: r.url as string, uniqueKey: r.unique_key as string, template: r.template as string, method: r.method as 'GET' | 'POST',
      body: (r.body as string) ?? undefined, status: r.status as RequestStatus, depth: r.depth as number, attempts: r.attempts as number, parentId: (r.parent_id as string) ?? undefined,
      context: JSON.parse(r.context_json as string), error: (r.error as string) ?? undefined, createdAt: r.created_at as number,
    };
  }

  // ---------- rows ----------
  upsertRow(row: Omit<RowRecord, 'id' | 'createdAt'>): { inserted: boolean; changed: boolean } {
    const existing = this.db.prepare('SELECT id, hash FROM rows WHERE run_id=? AND dataset=? AND row_key=?').get(row.runId, row.dataset, row.rowKey) as { id: string; hash: string } | undefined;
    const now = Date.now();
    if (existing) {
      if (existing.hash === row.hash) return { inserted: false, changed: false };
      this.db.prepare('UPDATE rows SET json=?, hash=?, page_url=?, flags=? WHERE id=?').run(JSON.stringify(row.data), row.hash, row.pageUrl ?? null, row.flags ? JSON.stringify(row.flags) : null, existing.id);
      return { inserted: false, changed: true };
    }
    this.db.prepare('INSERT INTO rows(id, run_id, dataset, row_key, json, hash, page_url, created_at, flags) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId(), row.runId, row.dataset, row.rowKey, JSON.stringify(row.data), row.hash, row.pageUrl ?? null, now, row.flags ? JSON.stringify(row.flags) : null);
    return { inserted: true, changed: true };
  }

  /** Merge fields into an existing row (used for follow-link "merge" mode). */
  mergeRow(runId: string, dataset: string, rowKey: string, patch: Record<string, unknown>, hash: string): boolean {
    const existing = this.db.prepare('SELECT id, json FROM rows WHERE run_id=? AND dataset=? AND row_key=?').get(runId, dataset, rowKey) as { id: string; json: string } | undefined;
    if (!existing) return false;
    const merged = { ...JSON.parse(existing.json), ...patch };
    this.db.prepare('UPDATE rows SET json=?, hash=? WHERE id=?').run(JSON.stringify(merged), hash, existing.id);
    return true;
  }

  getRow(runId: string, dataset: string, rowKey: string): RowRecord | undefined {
    const r = this.db.prepare('SELECT * FROM rows WHERE run_id=? AND dataset=? AND row_key=?').get(runId, dataset, rowKey) as Record<string, SQLInputValue> | undefined;
    return r ? this.rowToRow(r) : undefined;
  }

  *iterRows(runId: string, dataset?: string, opts: { limit?: number; offset?: number } = {}): IterableIterator<RowRecord> {
    const vals: SQLInputValue[] = [runId];
    let sql = 'SELECT * FROM rows WHERE run_id=?';
    if (dataset) { sql += ' AND dataset=?'; vals.push(dataset); }
    sql += ' ORDER BY created_at ASC, rowid ASC';
    if (opts.limit !== undefined) { sql += ' LIMIT ? OFFSET ?'; vals.push(opts.limit, opts.offset ?? 0); }
    for (const r of this.db.prepare(sql).iterate(...vals) as Iterable<Record<string, SQLInputValue>>) yield this.rowToRow(r);
  }

  countRows(runId: string, dataset?: string): number {
    const vals: SQLInputValue[] = [runId];
    let sql = 'SELECT COUNT(*) as n FROM rows WHERE run_id=?';
    if (dataset) { sql += ' AND dataset=?'; vals.push(dataset); }
    return (this.db.prepare(sql).get(...vals) as { n: number }).n;
  }

  datasets(runId: string): DatasetStats[] {
    return this.db.prepare('SELECT dataset, COUNT(*) as rows FROM rows WHERE run_id=? GROUP BY dataset').all(runId) as unknown as DatasetStats[];
  }

  private rowToRow(r: Record<string, SQLInputValue>): RowRecord {
    return { id: r.id as string, runId: r.run_id as string, dataset: r.dataset as string, rowKey: r.row_key as string, data: JSON.parse(r.json as string), hash: r.hash as string, pageUrl: (r.page_url as string) ?? undefined, createdAt: r.created_at as number, flags: r.flags ? JSON.parse(r.flags as string) : undefined };
  }

  // ---------- drift ----------
  addDrift(ev: Omit<DriftEvent, 'id' | 'createdAt'>): DriftEvent {
    const id = newId(); const now = Date.now();
    this.db.prepare('INSERT INTO drift_events(id, run_id, recipe_id, template, field, kind, detail_json, page_url, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, ev.runId, ev.recipeId ?? null, ev.template, ev.field ?? null, ev.kind, JSON.stringify(ev.detail ?? {}), ev.pageUrl ?? null, now);
    return { ...ev, id, createdAt: now };
  }

  listDrift(runId: string): DriftEvent[] {
    return (this.db.prepare('SELECT * FROM drift_events WHERE run_id=? ORDER BY created_at ASC').all(runId) as Record<string, SQLInputValue>[]).map((r) => ({
      id: r.id as string, runId: r.run_id as string, recipeId: (r.recipe_id as string) ?? undefined, template: r.template as string, field: (r.field as string) ?? undefined, kind: r.kind as DriftEvent['kind'],
      detail: JSON.parse(r.detail_json as string), pageUrl: (r.page_url as string) ?? undefined, createdAt: r.created_at as number,
    }));
  }

  // ---------- schedules ----------
  upsertSchedule(s: Omit<ScheduleRecord, 'id' | 'createdAt'> & { id?: string }): ScheduleRecord {
    const existing = this.db.prepare('SELECT id FROM schedules WHERE recipe_id=?').get(s.recipeId) as { id: string } | undefined;
    const id = s.id ?? existing?.id ?? newId();
    const now = Date.now();
    this.db.prepare('INSERT INTO schedules(id, recipe_id, cron, tz, enabled, skip_if_running, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cron=excluded.cron, tz=excluded.tz, enabled=excluded.enabled, skip_if_running=excluded.skip_if_running')
      .run(id, s.recipeId, s.cron, s.tz ?? null, s.enabled ? 1 : 0, s.skipIfRunning ? 1 : 0, now);
    return { ...s, id, createdAt: now };
  }

  listSchedules(): ScheduleRecord[] {
    return (this.db.prepare('SELECT * FROM schedules').all() as Record<string, SQLInputValue>[]).map((r) => ({
      id: r.id as string, recipeId: r.recipe_id as string, cron: r.cron as string, tz: (r.tz as string) ?? undefined, enabled: !!r.enabled, skipIfRunning: !!r.skip_if_running,
      lastRunAt: (r.last_run_at as number) ?? undefined, nextRunAt: (r.next_run_at as number) ?? undefined, createdAt: r.created_at as number,
    }));
  }

  touchSchedule(id: string, lastRunAt: number, nextRunAt?: number) {
    this.db.prepare('UPDATE schedules SET last_run_at=?, next_run_at=? WHERE id=?').run(lastRunAt, nextRunAt ?? null, id);
  }

  deleteSchedule(id: string) { this.db.prepare('DELETE FROM schedules WHERE id=?').run(id); }

  // ---------- alerts ----------
  addAlert(a: Omit<AlertRecord, 'id' | 'createdAt' | 'read'>): AlertRecord {
    const id = newId(); const now = Date.now();
    this.db.prepare('INSERT INTO alerts(id, run_id, recipe_id, kind, title, body, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, a.runId ?? null, a.recipeId ?? null, a.kind, a.title, a.body, JSON.stringify(a.detail ?? {}), now);
    return { ...a, id, createdAt: now, read: false };
  }

  listAlerts(opts: { unreadOnly?: boolean; limit?: number } = {}): AlertRecord[] {
    const sql = `SELECT * FROM alerts ${opts.unreadOnly ? 'WHERE read=0' : ''} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(opts.limit ?? 100) as Record<string, SQLInputValue>[]).map((r) => ({
      id: r.id as string, runId: (r.run_id as string) ?? undefined, recipeId: (r.recipe_id as string) ?? undefined, kind: r.kind as string, title: r.title as string, body: r.body as string,
      detail: JSON.parse(r.detail_json as string), createdAt: r.created_at as number, read: !!r.read,
    }));
  }

  markAlertsRead(ids?: string[]) {
    if (!ids) { this.db.exec('UPDATE alerts SET read=1'); return; }
    const stmt = this.db.prepare('UPDATE alerts SET read=1 WHERE id=?');
    for (const id of ids) stmt.run(id);
  }

  // ---------- secrets / kv ----------
  setSecret(name: string, value: string) { this.db.prepare('INSERT INTO secrets(name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(name, value, Date.now()); }
  getSecret(name: string): string | undefined { return (this.db.prepare('SELECT value FROM secrets WHERE name=?').get(name) as { value: string } | undefined)?.value; }
  deleteSecret(name: string) { this.db.prepare('DELETE FROM secrets WHERE name=?').run(name); }
  listSecretNames(): string[] { return (this.db.prepare('SELECT name FROM secrets ORDER BY name').all() as { name: string }[]).map((r) => r.name); }
  setKv(key: string, value: unknown) { this.db.prepare('INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  getKv<T = unknown>(key: string): T | undefined { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined; return r ? (JSON.parse(r.value) as T) : undefined; }

  // ---------- api keys ----------
  createApiKey(name: string, keyHash: string, scopes = 'read,write'): string {
    const id = newId();
    this.db.prepare('INSERT INTO api_keys(id, name, key_hash, scopes, created_at) VALUES (?,?,?,?,?)').run(id, name, keyHash, scopes, Date.now());
    return id;
  }
  findApiKey(keyHash: string): { id: string; name: string; scopes: string[] } | undefined {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(keyHash) as Record<string, SQLInputValue> | undefined;
    if (!r) return undefined;
    this.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(Date.now(), r.id as string);
    return { id: r.id as string, name: r.name as string, scopes: (r.scopes as string).split(',') };
  }
  listApiKeys(): Array<{ id: string; name: string; scopes: string[]; createdAt: number; lastUsedAt?: number }> {
    return (this.db.prepare('SELECT * FROM api_keys').all() as Record<string, SQLInputValue>[]).map((r) => ({ id: r.id as string, name: r.name as string, scopes: (r.scopes as string).split(','), createdAt: r.created_at as number, lastUsedAt: (r.last_used_at as number) ?? undefined }));
  }
  deleteApiKey(id: string) { this.db.prepare('DELETE FROM api_keys WHERE id=?').run(id); }
}
