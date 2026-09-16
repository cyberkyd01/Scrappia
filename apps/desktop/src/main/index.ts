/**
 * Electron main process: creates the ScrappiaApp (storage + scheduler), the recorder session,
 * the main window, and wires IPC + event forwarding.
 */
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScrappiaApp } from '@scrappia/core';
import { RecorderSession, recorderProfilesDir } from './recorder';
import { registerIpc, sendEvent } from './ipc';

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | undefined;
let core: ScrappiaApp | undefined;
let recorder: RecorderSession | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(bootstrap).catch((e: Error) => {
    console.error('[scrappia] failed to start', e);
    dialog.showErrorBox('Scrappia failed to start', e.stack ?? e.message);
    app.quit();
  });
}

async function bootstrap() {
  const dataDir = join(app.getPath('userData'), 'data');
  core = new ScrappiaApp({ dataDir });
  core.scheduler.start();
  const profilesDir = recorderProfilesDir(dataDir);

  recorder = new RecorderSession({
    profilesDir,
    anchor: () => mainWindow?.getBounds(),
    onMessage: (msg) => sendEvent(mainWindow, 'inspector:message', msg),
    onStatus: (s) => sendEvent(mainWindow, 'recorder:status', s),
  });

  core.on((e) => sendEvent(mainWindow, 'run:event', e));

  registerIpc({ app: core, recorder, window: () => mainWindow, profilesDir });

  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (ev) => { ev.preventDefault(); void shutdown(); });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Scrappia',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#15171b',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { mainWindow = undefined; });
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else void win.loadFile(join(here, '../renderer/index.html'));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (recorder) await Promise.race([recorder.close(), new Promise((r) => setTimeout(r, 4000))]);
    if (core) {
      for (const a of core.activeRuns()) core.cancelRun(a.run.id);
      await Promise.race([Promise.allSettled(core.activeRuns().map((a) => a.promise)), new Promise((r) => setTimeout(r, 4000))]);
      core.close();
    }
  } catch (e) { console.error('[scrappia] shutdown error', e); }
  app.exit(0);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Scrappia on GitHub', click: () => void shell.openExternal('https://github.com/scrappia/scrappia') }] },
  ]);
}
