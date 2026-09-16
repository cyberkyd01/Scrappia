/**
 * IPC handlers: one `handle()` per channel in `IpcApi`, typed against the shared contract.
 */
import { app, dialog, ipcMain, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ScrappiaApp, Scheduler, createProvider, EXAMPLE_RECIPES, parseRecipe, type Recipe, type RecipeInput } from '@scrappia/core';
import type { IpcApi, IpcEvents, RecipeSummary } from '../shared/ipc';
import type { RecorderSession } from './recorder';
import type { CopilotManager } from './copilot';
import { withRecorderSession } from './session';

export interface IpcContext {
  app: ScrappiaApp;
  recorder: RecorderSession;
  copilot: CopilotManager;
  window: () => BrowserWindow | undefined;
  profilesDir: string;
}

export function sendEvent<K extends keyof IpcEvents>(win: BrowserWindow | undefined, channel: K, payload: IpcEvents[K]) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try { win.webContents.send(channel, payload); } catch { /* window closing */ }
}

/**
 * Test harnesses (scripts/e2e-*.mjs) cannot drive native file dialogs: `SCRAPPIA_E2E_DIALOGS` holds a
 * JSON object `{ open?, save?, directory? }` whose paths are returned instead of showing a dialog.
 */
function e2eDialogs(): { open?: string; save?: string; directory?: string } | undefined {
  const raw = process.env.SCRAPPIA_E2E_DIALOGS;
  if (!raw) return undefined;
  try { return JSON.parse(raw) as { open?: string; save?: string; directory?: string }; } catch { return undefined; }
}

function handle<K extends keyof IpcApi>(channel: K, fn: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]> | Awaited<ReturnType<IpcApi[K]>>) {
  ipcMain.handle(channel, (_e: IpcMainInvokeEvent, ...args: unknown[]) => fn(...(args as Parameters<IpcApi[K]>)));
}

export function registerIpc(ctx: IpcContext) {
  const { app: core, recorder, copilot } = ctx;

  // ---- app ----
  handle('app.info', () => ({
    version: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, chrome: process.versions.chrome ?? '',
    dataDir: core.dataDir, platform: process.platform, profilesDir: ctx.profilesDir,
  }));
  handle('app.validateRecipe', (input) => core.validateRecipe(input));

  // ---- recipes ----
  handle('recipes.list', () => {
    const schedules = core.storage.listSchedules();
    const next = new Map(core.scheduler.nextRuns().map((n) => [n.scheduleId, n.next ? +n.next : undefined]));
    return core.listRecipes().map((record): RecipeSummary => {
      const json = record.json as Partial<Recipe> | undefined;
      const sched = schedules.find((s) => s.recipeId === record.id);
      return {
        record,
        tags: Array.isArray(json?.tags) ? json!.tags : [],
        entryUrl: json?.entry?.urls?.[0],
        lastRun: core.listRuns({ recipeId: record.id, limit: 1 })[0],
        schedule: sched ? { ...sched, next: next.get(sched.id) ?? sched.nextRunAt } : undefined,
      };
    });
  });
  handle('recipes.get', (id) => core.getRecipe(id));
  handle('recipes.save', (recipe, opts) => core.saveRecipe(recipe as RecipeInput, opts));
  handle('recipes.delete', (id) => { core.deleteRecipe(id); });
  handle('recipes.versions', (id) => core.storage.listRecipeVersions(id));
  handle('recipes.examples', () => Object.entries(EXAMPLE_RECIPES).map(([key, r]) => ({ key, recipe: parseRecipe(r) })));

  // ---- runs ----
  handle('runs.start', async (recipe, opts = {}) => {
    // resolve ids so full runs get the recorder's cookies/user agent too (the parsed recipe keeps its id)
    const resolved: string | RecipeInput | Recipe = typeof recipe === 'string' ? (core.getRecipe(recipe).recipe ?? recipe) : recipe;
    const withSession = await withRecorderSession(recorder, resolved);
    const active = await core.startRun(withSession, { dryRun: opts.dryRun, maxRequests: opts.maxRequests, headless: opts.headless, trigger: opts.trigger ?? (opts.dryRun ? 'test' : 'manual') });
    active.promise.catch(() => undefined);
    return active.run;
  });
  handle('runs.cancel', (id) => core.cancelRun(id));
  handle('runs.pause', (id) => core.pauseRun(id));
  handle('runs.resume', (id) => core.resumeRun(id));
  handle('runs.resumeStopped', async (id) => { const a = await core.resumeStoppedRun(id); a.promise.catch(() => undefined); return a.run; });
  handle('runs.list', (opts) => core.listRuns(opts));
  handle('runs.get', (id) => core.getRun(id));
  handle('runs.rows', (id, dataset, opts) => core.rows(id, dataset, opts));
  handle('runs.datasets', (id) => core.storage.datasets(id));
  handle('runs.drift', (id) => core.storage.listDrift(id));
  handle('runs.diff', (id) => {
    const run = core.getRun(id);
    if (!run?.recipeId) return undefined;
    const prev = core.storage.previousRun(run.recipeId, id);
    if (!prev) return undefined;
    return { prevRunId: prev.id, diff: core.diff(prev.id, id) };
  });
  handle('runs.export', (id, sinks) => core.export(id, sinks));
  handle('runs.active', () => core.activeRuns().map((a) => a.run.id));

  // ---- settings / secrets / ai ----
  handle('settings.get', () => core.settings);
  handle('settings.save', (s) => { core.saveSettings(s); });
  handle('secrets.list', () => core.storage.listSecretNames());
  handle('secrets.set', (name, value) => { core.setSecret(name, value); });
  handle('secrets.delete', (name) => { core.storage.deleteSecret(name); });
  handle('ai.test', async (cfg) => {
    try { return await createProvider(cfg, (r) => core.secret(r)).test(); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  handle('ai.available', () => {
    const svc = core.ai();
    const names = core.settings.ai.providers.map((p) => p.name);
    return { configured: !!svc, providers: names };
  });
  handle('ai.suggestFields', async (opts) => {
    const svc = core.ai();
    if (!svc) throw new Error('No AI provider configured. Add one in Settings > AI providers.');
    return svc.suggestFields(opts);
  });

  // ---- schedules / alerts ----
  handle('schedules.list', () => {
    const next = new Map(core.scheduler.nextRuns().map((n) => [n.scheduleId, n.next ? +n.next : undefined]));
    return core.storage.listSchedules().map((s) => ({ ...s, next: next.get(s.id) ?? s.nextRunAt }));
  });
  handle('schedules.preview', (cron, tz) => {
    try { return { ok: true as const, next: Scheduler.preview(cron, tz || undefined, 5).map((d) => +d) }; }
    catch (e) { return { ok: false as const, error: (e as Error).message }; }
  });
  handle('alerts.list', (opts) => core.storage.listAlerts(opts));
  handle('alerts.markRead', (ids) => { core.storage.markAlertsRead(ids); });

  // ---- dialogs / shell / files ----
  handle('dialogs.save', async (opts) => {
    const stub = e2eDialogs();
    if (stub) return stub.save;
    const win = ctx.window();
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath, filters: opts.filters }) : await dialog.showSaveDialog({ defaultPath: opts.defaultPath, filters: opts.filters });
    return r.canceled ? undefined : r.filePath;
  });
  handle('dialogs.open', async (opts) => {
    const stub = e2eDialogs();
    if (stub) return opts.directory ? stub.directory : stub.open;
    const win = ctx.window();
    const o = { filters: opts.filters, properties: [opts.directory ? 'openDirectory' : 'openFile'] as Array<'openFile' | 'openDirectory'> };
    const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
    return r.canceled ? undefined : r.filePaths[0];
  });
  handle('files.readText', (p) => readFile(p, 'utf8'));
  handle('files.writeText', async (p, content) => { await writeFile(p, content, 'utf8'); });
  handle('shell.openPath', (p) => shell.openPath(p));
  handle('shell.showItemInFolder', (p) => { shell.showItemInFolder(p); });
  handle('shell.openExternal', (url) => shell.openExternal(url));
  handle('browsers.install', () => {
    const win = ctx.window();
    const send = (line: string, done?: boolean, code?: number | null) => sendEvent(win, 'browsers:output', { line, done, code });
    return new Promise<void>((resolve) => {
      const isWin = process.platform === 'win32';
      send('$ npx patchright install chromium\n');
      const child = spawn(isWin ? 'npx.cmd' : 'npx', ['patchright', 'install', 'chromium'], { shell: isWin, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
      child.stdout.on('data', (d: Buffer) => send(d.toString()));
      child.stderr.on('data', (d: Buffer) => send(d.toString()));
      child.on('error', (e) => { send(`error: ${e.message}\n`, true, -1); resolve(); });
      child.on('close', (code) => { send(`\nexited with code ${code}\n`, true, code); resolve(); });
    });
  });

  // ---- recorder ----
  handle('recorder.open', (url) => recorder.open(url));
  handle('recorder.navigate', (url) => recorder.navigate(url));
  handle('recorder.back', () => recorder.back());
  handle('recorder.reload', () => recorder.reload());
  handle('recorder.status', () => recorder.status());
  handle('recorder.setMode', (mode) => recorder.setMode(mode));
  handle('recorder.highlight', (selectors, scope) => recorder.highlight(selectors, scope));
  handle('recorder.clearHighlights', () => recorder.clearHighlights());
  handle('recorder.detectLists', () => recorder.detectLists());
  handle('recorder.describe', (selector) => recorder.describe(selector));
  handle('recorder.expand', (selector, levels) => recorder.expand(selector, levels));
  handle('recorder.regionHtml', (selectors, maxChars) => recorder.regionHtml(selectors, maxChars));
  handle('recorder.pageHtml', () => recorder.pageHtml());
  handle('recorder.currentUrl', () => recorder.currentUrl());
  handle('recorder.runActions', (actions) => recorder.runActions(actions));
  handle('recorder.extractPreview', (template) => recorder.extractPreview(template));
  handle('recorder.screenshot', () => recorder.screenshot());
  handle('recorder.close', () => recorder.close());

  // ---- copilot ----
  handle('copilot.available', () => copilot.available());
  handle('copilot.start', (input) => copilot.start(input));
  handle('copilot.turn', (input) => copilot.turn(input));
  handle('copilot.history', () => copilot.history());
  handle('copilot.reset', () => { copilot.reset(); });
  handle('copilot.cancel', () => { copilot.cancel(); });
}
