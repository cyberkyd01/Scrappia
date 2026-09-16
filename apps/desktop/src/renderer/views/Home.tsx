import { useCallback, useEffect, useState } from 'react';
import type { Recipe, RunRecord, AlertRecord } from '@scrappia/core';
import type { RecipeSummary } from '@shared/ipc';
import { invoke, useIpcEvent } from '../api';
import { useApp, RunStatusBadge } from '../App';
import { Btn, Empty, Modal, PromptModal, Badge, useToast, useAsync } from '../components/ui';
import { fmtAgo, fmtIn, fmtDuration, fmtNum, truncate } from '../lib/format';

export function Home() {
  const { go, liveRuns } = useApp();
  const toast = useToast();
  const { run } = useAsync();
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [examples, setExamples] = useState<Array<{ key: string; recipe: Recipe }>>([]);
  const [confirmDelete, setConfirmDelete] = useState<RecipeSummary | undefined>();

  const reload = useCallback(async () => {
    const [r, h, a] = await Promise.all([invoke('recipes.list'), invoke('runs.list', { limit: 50 }), invoke('alerts.list', { limit: 30 })]);
    setRecipes(r);
    setRuns(h);
    setAlerts(a);
  }, []);
  const unread = alerts.filter((a) => !a.read).length;
  const markRead = (ids?: string[]) => run(async () => { await invoke('alerts.markRead', ids); setAlerts(await invoke('alerts.list', { limit: 30 })); });

  useEffect(() => { void reload().catch((e) => toast((e as Error).message, 'error')); }, [reload, toast]);
  useIpcEvent('run:event', (e) => { if (e.type === 'run.start' || e.type === 'run.done') void reload(); });

  const openRecipe = async (id: string) => {
    const r = await run(() => invoke('recipes.get', id));
    if (r?.recipe) go({ name: 'recorder', recipeId: id, recipe: r.recipe, key: 0 });
  };

  const startRun = async (id: string) => {
    const r = await run(() => invoke('runs.start', id), 'Run started');
    if (r) go({ name: 'run', runId: r.id });
  };

  const importJson = async () => {
    const path = await invoke('dialogs.open', { filters: [{ name: 'Recipe JSON', extensions: ['json'] }] });
    if (!path) return;
    await run(async () => {
      const text = await invoke('files.readText', path);
      const parsed = JSON.parse(text) as unknown;
      const v = await invoke('app.validateRecipe', parsed);
      if (!v.success) throw new Error(`Invalid recipe:\n${v.errors.join('\n')}`);
      go({ name: 'recorder', recipe: v.recipe, key: 0 });
    });
  };

  const openExamples = async () => {
    const ex = await run(() => invoke('recipes.examples'));
    if (ex) { setExamples(ex); setShowExamples(true); }
  };

  return (
    <div className="view">
      <div className="view-header">
        <h1>Recipes</h1>
        <div className="grow" />
        <Btn onClick={importJson} data-testid="home-import-json">Import JSON</Btn>
        <Btn onClick={openExamples} data-testid="home-templates">Templates gallery</Btn>
        <Btn variant="primary" onClick={() => setShowNew(true)} data-testid="home-new-recipe">New recipe</Btn>
      </div>
      <div className="view-body">
        <div className="home-grid">
          <div className="card pad-0" data-testid="home-recipes">
            {recipes.length === 0 ? (
              <Empty>No recipes yet. Click <b>New recipe</b> to open the recorder, or pick one from the templates gallery.</Empty>
            ) : (
              <table className="grid">
                <thead><tr><th>Name</th><th>Entry URL</th><th>Tags</th><th>Last run</th><th>Next schedule</th><th></th></tr></thead>
                <tbody>
                  {recipes.map((r) => {
                    const live = Object.values(liveRuns).find((l) => l.status === 'running' && l.recipeName === r.record.name);
                    return (
                      <tr key={r.record.id} className="clickable" onDoubleClick={() => void openRecipe(r.record.id)} data-testid="home-recipe-row" data-recipe-id={r.record.id}>
                        <td><b>{r.record.name}</b><span className="sub">v{r.record.version} · updated {fmtAgo(r.record.updatedAt)}</span></td>
                        <td className="ellipsis" title={r.entryUrl}>{r.entryUrl}</td>
                        <td>{r.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
                        <td data-testid="home-recipe-last-run">
                          {live ? <span className="row gap-4"><RunStatusBadge status="running" /> <span className="faint">{fmtNum(live.stats?.rows)} rows</span></span>
                            : r.lastRun ? <span className="row gap-4 clickable" onClick={() => go({ name: 'run', runId: r.lastRun!.id })}><RunStatusBadge status={r.lastRun.status} /><span className="faint">{fmtAgo(r.lastRun.finishedAt ?? r.lastRun.startedAt)}</span></span>
                              : <span className="faint">never</span>}
                        </td>
                        <td>{r.schedule ? (r.schedule.enabled ? <span title={r.schedule.cron}>{fmtIn(r.schedule.next)}</span> : <span className="faint">paused</span>) : <span className="faint">–</span>}</td>
                        <td className="row gap-4">
                          <Btn size="sm" onClick={() => void openRecipe(r.record.id)} data-testid="home-recipe-edit">Edit</Btn>
                          <Btn size="sm" variant="primary" onClick={() => void startRun(r.record.id)} disabled={!!live} data-testid="home-recipe-run">Run</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setConfirmDelete(r)} title="Delete" data-testid="home-recipe-delete">🗑</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div>
            {alerts.length > 0 && (
              <>
                <div className="section-title row"><h3 className="grow">Alerts {unread > 0 && <Badge tone="warn"><span data-testid="home-alerts-unread">{unread}</span></Badge>}</h3>{unread > 0 && <Btn size="sm" onClick={() => void markRead()} data-testid="home-alerts-read-all">Mark all read</Btn>}</div>
                <div className="card pad-0 mb-8" data-testid="home-alerts">
                  <table className="grid">
                    <thead><tr><th>Kind</th><th>Alert</th><th>When</th><th></th></tr></thead>
                    <tbody>
                      {alerts.map((a) => (
                        <tr key={a.id} className={a.read ? 'muted' : undefined} data-testid="home-alert-row" data-kind={a.kind} data-read={a.read ? 'true' : 'false'}>
                          <td><Badge tone={a.kind === 'failure' || a.kind === 'empty' ? 'danger' : a.kind === 'drift' ? 'warn' : 'accent'}>{a.kind}</Badge></td>
                          <td style={{ whiteSpace: 'normal' }}><b>{a.title}</b><div className="faint small" title={a.body}>{truncate(a.body, 160)}</div></td>
                          <td className="faint">{fmtAgo(a.createdAt)}</td>
                          <td className="row gap-4">
                            {a.runId && <Btn size="sm" onClick={() => go({ name: 'run', runId: a.runId! })}>Open run</Btn>}
                            {!a.read && <Btn size="sm" variant="ghost" onClick={() => void markRead([a.id])} data-testid="home-alert-read">Mark read</Btn>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="section-title"><h3>Run history</h3></div>
            <div className="card pad-0" data-testid="home-runs">
              {runs.length === 0 ? <Empty>No runs yet.</Empty> : (
                <table className="grid">
                  <thead><tr><th>Recipe</th><th>Status</th><th className="num">Rows</th><th className="num">Pages</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr></thead>
                  <tbody>
                    {runs.map((r) => {
                      const st = r.stats as { rows?: number; pages?: number; elapsedMs?: number };
                      return (
                        <tr key={r.id} className="clickable" onClick={() => go({ name: 'run', runId: r.id })} data-testid="home-run-row" data-run-id={r.id} data-status={liveRuns[r.id]?.status ?? r.status}>
                          <td>{r.recipeName}</td>
                          <td><RunStatusBadge status={liveRuns[r.id]?.status ?? r.status} /></td>
                          <td className="num">{fmtNum(liveRuns[r.id]?.stats?.rows ?? st.rows)}</td>
                          <td className="num">{fmtNum(liveRuns[r.id]?.stats?.pages ?? st.pages)}</td>
                          <td>{r.trigger}</td>
                          <td>{fmtAgo(r.startedAt)}</td>
                          <td>{fmtDuration(r.finishedAt ? r.finishedAt - r.startedAt : st.elapsedMs)}</td>
                          <td>{(r.status === 'failed' || r.status === 'cancelled' || r.status === 'partial') && <Btn size="sm" onClick={async (e) => { e.stopPropagation(); const a = await run(() => invoke('runs.resumeStopped', r.id), 'Resumed'); if (a) go({ name: 'run', runId: a.id }); }} data-testid="home-run-resume">Resume</Btn>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>

      {showNew && (
        <PromptModal title="New recipe" label="Start URL of the site to scrape" placeholder="https://example.com/products" submitLabel="Open recorder" onClose={() => setShowNew(false)} onSubmit={(url) => go({ name: 'recorder', url, key: 0 })} />
      )}
      {showExamples && (
        <Modal title="Templates gallery" onClose={() => setShowExamples(false)} wide>
          <table className="grid">
            <thead><tr><th>Name</th><th>Description</th><th>Tags</th><th></th></tr></thead>
            <tbody>
              {examples.map((ex) => (
                <tr key={ex.key} data-testid={`example-${ex.key}`}>
                  <td><b>{ex.recipe.name}</b><span className="sub mono">{ex.key}</span></td>
                  <td style={{ whiteSpace: 'normal' }}>{ex.recipe.description}</td>
                  <td>{ex.recipe.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
                  <td><Btn size="sm" variant="primary" onClick={() => { setShowExamples(false); go({ name: 'recorder', recipe: { ...ex.recipe, id: undefined }, key: 0 }); }} data-testid="example-use">Use</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {confirmDelete && (
        <Modal title="Delete recipe" onClose={() => setConfirmDelete(undefined)} footer={<><Btn onClick={() => setConfirmDelete(undefined)}>Cancel</Btn><Btn variant="danger" onClick={async () => { await run(() => invoke('recipes.delete', confirmDelete.record.id), 'Recipe deleted'); setConfirmDelete(undefined); void reload(); }}>Delete</Btn></>}>
          Delete <b>{confirmDelete.record.name}</b> and its schedule? Run history is kept.
        </Modal>
      )}
    </div>
  );
}
