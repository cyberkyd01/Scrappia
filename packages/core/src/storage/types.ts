export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type RequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RecipeRecord { id: string; name: string; version: number; json: unknown; createdAt: number; updatedAt: number }

export interface RunRecord {
  id: string;
  recipeId?: string;
  recipeName: string;
  recipeJson?: unknown;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  stats: Record<string, unknown>;
  error?: string;
  trigger: string;
}

export interface RequestContext {
  /** keyword values used for this request */
  keywords?: Record<string, string>;
  /** category path accumulated through page-level follows */
  categoryPath?: string[];
  /** for follow requests: parent row key + dataset + follow mode */
  parent?: { rowKey: string; dataset: string; mode: 'merge' | 'nest' | 'separate'; field?: string; template: string };
  /** pagination page number */
  page?: number;
  /** rows seen on previous pages of this sequence (for stopWhenNoNewRows) */
  paginationSeen?: number;
  /** consecutive pages without new rows */
  emptyStreak?: number;
  /** a browser-only step chain id (loadMore/scroll executed in one page) */
  [k: string]: unknown;
}

export interface RequestRecord {
  id: string;
  runId: string;
  url: string;
  uniqueKey: string;
  template: string;
  method: 'GET' | 'POST';
  body?: string;
  status: RequestStatus;
  depth: number;
  attempts: number;
  parentId?: string;
  context: RequestContext;
  error?: string;
  createdAt: number;
}

export interface RowRecord {
  id: string;
  runId: string;
  dataset: string;
  rowKey: string;
  data: Record<string, unknown>;
  hash: string;
  pageUrl?: string;
  createdAt: number;
  flags?: string[];
}

export interface DriftEvent {
  id: string;
  runId: string;
  recipeId?: string;
  template: string;
  field?: string;
  kind: 'field-missing' | 'list-empty' | 'fallback-candidate' | 'healed' | 'heal-failed' | 'validation';
  detail: Record<string, unknown>;
  pageUrl?: string;
  createdAt: number;
}

export interface ScheduleRecord {
  id: string; recipeId: string; cron: string; tz?: string; enabled: boolean; skipIfRunning: boolean; lastRunAt?: number; nextRunAt?: number; createdAt: number;
}

export interface AlertRecord {
  id: string; runId?: string; recipeId?: string; kind: string; title: string; body: string; detail: Record<string, unknown>; createdAt: number; read: boolean;
}

export interface DatasetStats { dataset: string; rows: number }

export interface Storage {
  saveRecipe(rec: { id?: string; name: string; json: unknown; note?: string }): RecipeRecord;
  getRecipe(id: string): RecipeRecord | undefined;
  listRecipes(): RecipeRecord[];
  listRecipeVersions(id: string): Array<{ version: number; createdAt: number; note?: string; json: unknown }>;
  deleteRecipe(id: string): void;

  createRun(run: { recipeId?: string; recipeName: string; recipeJson: unknown; trigger?: string }): RunRecord;
  updateRun(id: string, patch: { status?: RunStatus; stats?: Record<string, unknown>; error?: string | null; finishedAt?: number }): void;
  getRun(id: string): RunRecord | undefined;
  listRuns(opts?: { recipeId?: string; limit?: number; status?: RunStatus }): RunRecord[];
  previousRun(recipeId: string, beforeRunId: string): RunRecord | undefined;
  deleteRun(id: string): void;

  enqueue(req: Omit<RequestRecord, 'id' | 'status' | 'attempts' | 'createdAt'> & { id?: string }): RequestRecord | null;
  claimNext(runId: string): RequestRecord | undefined;
  finishRequest(id: string, patch: { status: RequestStatus; error?: string; durationMs?: number; httpStatus?: number; fetchMode?: string; requeue?: boolean }): void;
  resetRunning(runId: string): number;
  queueCounts(runId: string): Record<RequestStatus, number>;
  listRequests(runId: string, opts?: { status?: RequestStatus; limit?: number }): RequestRecord[];

  upsertRow(row: Omit<RowRecord, 'id' | 'createdAt'>): { inserted: boolean; changed: boolean };
  mergeRow(runId: string, dataset: string, rowKey: string, patch: Record<string, unknown>, hash: string): boolean;
  getRow(runId: string, dataset: string, rowKey: string): RowRecord | undefined;
  iterRows(runId: string, dataset?: string, opts?: { limit?: number; offset?: number }): IterableIterator<RowRecord>;
  countRows(runId: string, dataset?: string): number;
  datasets(runId: string): DatasetStats[];

  addDrift(ev: Omit<DriftEvent, 'id' | 'createdAt'>): DriftEvent;
  listDrift(runId: string): DriftEvent[];

  upsertSchedule(s: Omit<ScheduleRecord, 'id' | 'createdAt'> & { id?: string }): ScheduleRecord;
  listSchedules(): ScheduleRecord[];
  touchSchedule(id: string, lastRunAt: number, nextRunAt?: number): void;
  deleteSchedule(id: string): void;

  addAlert(a: Omit<AlertRecord, 'id' | 'createdAt' | 'read'>): AlertRecord;
  listAlerts(opts?: { unreadOnly?: boolean; limit?: number }): AlertRecord[];
  markAlertsRead(ids?: string[]): void;

  setSecret(name: string, value: string): void;
  getSecret(name: string): string | undefined;
  deleteSecret(name: string): void;
  listSecretNames(): string[];
  setKv(key: string, value: unknown): void;
  getKv<T = unknown>(key: string): T | undefined;

  createApiKey(name: string, keyHash: string, scopes?: string): string;
  findApiKey(keyHash: string): { id: string; name: string; scopes: string[] } | undefined;
  listApiKeys(): Array<{ id: string; name: string; scopes: string[]; createdAt: number; lastUsedAt?: number }>;
  deleteApiKey(id: string): void;

  close(): void;
}
