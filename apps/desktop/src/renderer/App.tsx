import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Recipe, RunEvent, RunStats } from '@scrappia/core';
import { useIpcEvent } from './api';
import { ToastProvider, Badge } from './components/ui';
import { Home } from './views/Home';
import { Recorder } from './views/Recorder';
import { RunMonitor } from './views/RunMonitor';
import { Settings } from './views/Settings';

export type View =
  | { name: 'home' }
  | { name: 'recorder'; recipeId?: string; recipe?: Recipe; url?: string; key: number }
  | { name: 'run'; runId: string }
  | { name: 'settings' };

export interface LiveRun { runId: string; status: string; stats?: RunStats; recipeName?: string; captcha?: { url: string; kind: string } }

interface AppCtx {
  view: View;
  go: (v: View) => void;
  liveRuns: Record<string, LiveRun>;
}

const Ctx = createContext<AppCtx>({ view: { name: 'home' }, go: () => undefined, liveRuns: {} });
export function useApp() { return useContext(Ctx); }

export default function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({});
  const [recorderKey, setRecorderKey] = useState(1);

  const go = useCallback((v: View) => {
    if (v.name === 'recorder') { setRecorderKey((k) => k + 1); setView({ ...v, key: recorderKey + 1 }); }
    else setView(v);
  }, [recorderKey]);

  useIpcEvent('run:event', (e: RunEvent) => {
    setLiveRuns((prev) => {
      const next = { ...prev };
      const upd = (id: string, patch: Partial<LiveRun>) => { next[id] = { ...(next[id] ?? { runId: id, status: 'running' }), ...patch }; };
      switch (e.type) {
        case 'run.start': upd(e.run.id, { status: 'running', recipeName: e.run.recipeName }); break;
        case 'run.progress': upd(e.runId, { stats: e.stats }); break;
        case 'run.done': upd(e.run.id, { status: e.run.status, stats: e.stats }); setTimeout(() => setLiveRuns((p) => { const c = { ...p }; delete c[e.run.id]; return c; }), 30_000); break;
        case 'captcha.needed': upd(e.runId, { captcha: { url: e.url, kind: e.kind } }); break;
        default: break;
      }
      return next;
    });
  });

  useEffect(() => { document.title = 'Scrappia'; }, []);

  const running = Object.values(liveRuns).filter((r) => r.status === 'running').length;
  const ctx = useMemo(() => ({ view, go, liveRuns }), [view, go, liveRuns]);

  return (
    <ToastProvider>
      <Ctx.Provider value={ctx}>
        <div className="app">
          <nav className="sidebar">
            <div className="brand"><span className="dot" /> Scrappia</div>
            <button className={`nav-item${view.name === 'home' ? ' active' : ''}`} onClick={() => go({ name: 'home' })}>Recipes</button>
            <button className={`nav-item${view.name === 'recorder' ? ' active' : ''}`} onClick={() => { if (view.name !== 'recorder') go({ name: 'recorder', key: 0 }); }}>Recorder</button>
            <button className={`nav-item${view.name === 'run' ? ' active' : ''}`} onClick={() => { const first = Object.values(liveRuns)[0]; if (first) go({ name: 'run', runId: first.runId }); else go({ name: 'home' }); }}>
              Runs {running > 0 && <span className="badge accent">{running}</span>}
            </button>
            <div className="spacer" />
            <button className={`nav-item${view.name === 'settings' ? ' active' : ''}`} onClick={() => go({ name: 'settings' })}>Settings</button>
          </nav>
          <main className="main">
            {view.name === 'home' && <Home />}
            {view.name === 'recorder' && <Recorder key={view.key} recipeId={view.recipeId} initialRecipe={view.recipe} initialUrl={view.url} />}
            {view.name === 'run' && <RunMonitor key={view.runId} runId={view.runId} />}
            {view.name === 'settings' && <Settings />}
          </main>
        </div>
      </Ctx.Provider>
    </ToastProvider>
  );
}

export function RunStatusBadge({ status }: { status: string }) {
  const tone = status === 'succeeded' ? 'ok' : status === 'failed' ? 'danger' : status === 'partial' ? 'warn' : status === 'running' ? 'accent' : undefined;
  return <Badge tone={tone}>{status}</Badge>;
}
