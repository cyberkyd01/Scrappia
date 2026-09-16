/**
 * Typed IPC contract between the Electron main process and the renderer.
 * `IpcApi` maps invoke channels to their handler signatures; `IpcEvents` maps push channels
 * (main -> renderer) to their payloads. Both sides import only types from here.
 */
import type {
  Recipe, RecipeInput, RunRecord, RecipeRecord, DriftEvent, ScheduleRecord, AlertRecord, AppSettings, LlmProviderConfig,
  Sink, Action, Template, RunEvent, OverlayMessage, InspectorMode, SelectorCandidate, PickedElement, DetectedList, DiffResult,
  DatasetStats, FieldType,
} from '@scrappia/core';

export interface RecorderStatus { open: boolean; url: string; title?: string; mode: InspectorMode; overlayReady: boolean }

export interface PreviewResult {
  url: string;
  title: string;
  records: Array<Record<string, unknown>>;
  page: Record<string, unknown>;
  fieldMatches: Record<string, { candidate: number; matched: number }>;
  listMatch: { candidate: number; matched: number } | null;
}

export interface RecipeSummary {
  record: RecipeRecord;
  tags: string[];
  entryUrl?: string;
  lastRun?: RunRecord;
  schedule?: ScheduleRecord & { next?: number };
}

export interface AppInfo { version: string; electron: string; node: string; chrome: string; dataDir: string; platform: string; profilesDir: string }

export interface SuggestedAiField { name: string; selector: string; type: FieldType; attr?: string }
export interface SuggestFieldsResult {
  list?: { selector: string; fields: SuggestedAiField[] } | null;
  pageFields: SuggestedAiField[];
  pagination?: { type: 'next' | 'loadMore' | 'scroll'; selector?: string | null } | null;
  notes?: string;
}

export type ValidateResult = { success: true; recipe: Recipe } | { success: false; errors: string[] };

export interface IpcApi {
  // ---- app ----
  'app.info': () => Promise<AppInfo>;
  'app.validateRecipe': (input: unknown) => Promise<ValidateResult>;
  // ---- recipes ----
  'recipes.list': () => Promise<RecipeSummary[]>;
  'recipes.get': (id: string) => Promise<{ record?: RecipeRecord; recipe?: Recipe }>;
  'recipes.save': (recipe: RecipeInput | Recipe, opts?: { id?: string; note?: string }) => Promise<RecipeRecord>;
  'recipes.delete': (id: string) => Promise<void>;
  'recipes.versions': (id: string) => Promise<Array<{ version: number; createdAt: number; note?: string; json: unknown }>>;
  'recipes.examples': () => Promise<Array<{ key: string; recipe: Recipe }>>;
  // ---- runs ----
  'runs.start': (recipe: string | RecipeInput | Recipe, opts?: { dryRun?: boolean; maxRequests?: number; headless?: boolean; trigger?: string }) => Promise<RunRecord>;
  'runs.cancel': (runId: string) => Promise<boolean>;
  'runs.pause': (runId: string) => Promise<boolean>;
  'runs.resume': (runId: string) => Promise<boolean>;
  'runs.resumeStopped': (runId: string) => Promise<RunRecord>;
  'runs.list': (opts?: { recipeId?: string; limit?: number }) => Promise<RunRecord[]>;
  'runs.get': (runId: string) => Promise<RunRecord | undefined>;
  'runs.rows': (runId: string, dataset?: string, opts?: { limit?: number; offset?: number }) => Promise<Array<Record<string, unknown>>>;
  'runs.datasets': (runId: string) => Promise<DatasetStats[]>;
  'runs.drift': (runId: string) => Promise<DriftEvent[]>;
  'runs.diff': (runId: string) => Promise<{ prevRunId: string; diff: DiffResult } | undefined>;
  'runs.export': (runId: string, sinks: Sink[]) => Promise<Array<{ type: string; rows: number; target: string; error?: string }>>;
  'runs.active': () => Promise<string[]>;
  // ---- settings / secrets / ai ----
  'settings.get': () => Promise<AppSettings>;
  'settings.save': (s: AppSettings) => Promise<void>;
  'secrets.list': () => Promise<string[]>;
  'secrets.set': (name: string, value: string) => Promise<void>;
  'secrets.delete': (name: string) => Promise<void>;
  'ai.test': (cfg: LlmProviderConfig) => Promise<{ ok: boolean; error?: string; models?: string[] }>;
  'ai.available': () => Promise<{ configured: boolean; providers: string[] }>;
  'ai.suggestFields': (opts: { html: string; url: string; instruction?: string }) => Promise<SuggestFieldsResult>;
  // ---- schedules / alerts ----
  'schedules.list': () => Promise<Array<ScheduleRecord & { next?: number }>>;
  'schedules.preview': (cron: string, tz?: string) => Promise<{ ok: true; next: number[] } | { ok: false; error: string }>;
  'alerts.list': (opts?: { unreadOnly?: boolean; limit?: number }) => Promise<AlertRecord[]>;
  'alerts.markRead': (ids?: string[]) => Promise<void>;
  // ---- dialogs / shell / files ----
  'dialogs.save': (opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | undefined>;
  'dialogs.open': (opts: { filters?: Array<{ name: string; extensions: string[] }>; directory?: boolean }) => Promise<string | undefined>;
  'files.readText': (path: string) => Promise<string>;
  'files.writeText': (path: string, content: string) => Promise<void>;
  'shell.openPath': (path: string) => Promise<string>;
  'shell.showItemInFolder': (path: string) => Promise<void>;
  'shell.openExternal': (url: string) => Promise<void>;
  'browsers.install': () => Promise<void>;
  // ---- recorder ----
  'recorder.open': (url: string) => Promise<RecorderStatus>;
  'recorder.navigate': (url: string) => Promise<RecorderStatus>;
  'recorder.back': () => Promise<RecorderStatus>;
  'recorder.reload': () => Promise<RecorderStatus>;
  'recorder.status': () => Promise<RecorderStatus>;
  'recorder.setMode': (mode: InspectorMode) => Promise<void>;
  'recorder.highlight': (selectors: SelectorCandidate[], scope?: SelectorCandidate[]) => Promise<{ count: number; samples: string[]; candidate: number }>;
  'recorder.clearHighlights': () => Promise<void>;
  'recorder.detectLists': () => Promise<DetectedList[]>;
  'recorder.describe': (selector: string) => Promise<PickedElement | null>;
  'recorder.expand': (selector: string, levels?: number) => Promise<PickedElement | null>;
  'recorder.regionHtml': (selectors: SelectorCandidate[], maxChars?: number) => Promise<string>;
  'recorder.pageHtml': () => Promise<string>;
  'recorder.currentUrl': () => Promise<string>;
  'recorder.runActions': (actions: Action[]) => Promise<{ ok: boolean; error?: string; url: string }>;
  'recorder.extractPreview': (template: Template) => Promise<PreviewResult>;
  'recorder.screenshot': () => Promise<string>;
  'recorder.close': () => Promise<void>;
}

export interface IpcEvents {
  'run:event': RunEvent;
  'inspector:message': OverlayMessage;
  'recorder:status': RecorderStatus;
  'browsers:output': { line: string; done?: boolean; code?: number | null };
}

export const INVOKE_CHANNELS = [
  'app.info', 'app.validateRecipe',
  'recipes.list', 'recipes.get', 'recipes.save', 'recipes.delete', 'recipes.versions', 'recipes.examples',
  'runs.start', 'runs.cancel', 'runs.pause', 'runs.resume', 'runs.resumeStopped', 'runs.list', 'runs.get', 'runs.rows', 'runs.datasets', 'runs.drift', 'runs.diff', 'runs.export', 'runs.active',
  'settings.get', 'settings.save', 'secrets.list', 'secrets.set', 'secrets.delete', 'ai.test', 'ai.available', 'ai.suggestFields',
  'schedules.list', 'schedules.preview', 'alerts.list', 'alerts.markRead',
  'dialogs.save', 'dialogs.open', 'files.readText', 'files.writeText', 'shell.openPath', 'shell.showItemInFolder', 'shell.openExternal', 'browsers.install',
  'recorder.open', 'recorder.navigate', 'recorder.back', 'recorder.reload', 'recorder.status', 'recorder.setMode', 'recorder.highlight', 'recorder.clearHighlights',
  'recorder.detectLists', 'recorder.describe', 'recorder.expand', 'recorder.regionHtml', 'recorder.pageHtml', 'recorder.currentUrl', 'recorder.runActions',
  'recorder.extractPreview', 'recorder.screenshot', 'recorder.close',
] as const satisfies readonly (keyof IpcApi)[];

export const EVENT_CHANNELS = ['run:event', 'inspector:message', 'recorder:status', 'browsers:output'] as const satisfies readonly (keyof IpcEvents)[];

// Compile-time completeness checks: every IpcApi / IpcEvents key must be listed above.
type MissingInvoke = Exclude<keyof IpcApi, (typeof INVOKE_CHANNELS)[number]>;
type MissingEvent = Exclude<keyof IpcEvents, (typeof EVENT_CHANNELS)[number]>;
export const __ipcComplete: [MissingInvoke, MissingEvent] extends [never, never] ? true : never = true;

/** Shape exposed on `window.scrappia` by the preload script. */
export interface ScrappiaBridge {
  invoke<K extends keyof IpcApi>(channel: K, ...args: Parameters<IpcApi[K]>): ReturnType<IpcApi[K]>;
  on<K extends keyof IpcEvents>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void;
}
