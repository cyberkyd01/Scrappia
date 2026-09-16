/**
 * Run monitor: live stats, event log, streaming rows, drift events, captcha banner, exports and
 * the post-run change summary against the previous run of the same recipe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunRecord, RunStats, DriftEvent, DiffResult, Sink } from '@scrappia/core';
import { invoke, useIpcEvent } from '../api';
import { useApp, RunStatusBadge } from '../App';
import { Btn, StatCard, Badge, Tabs, Empty, Select, useToast, useAsync } from '../components/ui';
import { cellText, fmtDuration, fmtNum, fmtTime, truncate, fmtBytes } from '../lib/format';
import { blankSink } from '../state/recipe';

interface LogLine { ts: number; level: string; msg: string }
const MAX_ROWS = 500;
const ROW_H = 26;

export function RunMonitor({ runId }: { runId: string }) {
  const { go } = useApp();
  const toast = useToast();
  const { run: act } = useAsync();
  const [record, setRecord] = useState<RunRecord | undefined>();
  const [stats, setStats] = useState<RunStats | undefined>();
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [drift, setDrift] = useState<DriftEvent[]>([]);
  const [captcha, setCaptcha] = useState<{ url: string; kind: string } | null>(null);
  const [exports, setExports] = useState<Array<{ type: string; rows: number; target: string; error?: string }>>([]);
  const [diff, setDiff] = useState<{ prevRunId: string; diff: DiffResult } | undefined>();
  const [tab, setTab] = useState<'rows' | 'log' | 'drift' | 'exports' | 'changes'>('rows');
  const [paused, setPaused] = useState(false);
  const [exportType, setExportType] = useState<Sink['type']>('xlsx');
  const [datasets, setDatasets] = useState<Array<{ dataset: string; rows: number }>>([]);
  const [dataset, setDataset] = useState<string | undefined>();

  const load = useCallback(async () => {
    const r = await invoke('runs.get', runId);
    setRecord(r);
    if (r) {
      setStats(r.stats as unknown as RunStats);
      const ds = await invoke('runs.datasets', runId);
      setDatasets(ds);
      const rs = await invoke('runs.rows', runId, dataset, { limit: MAX_ROWS });
      setRows(rs);
      setDrift(await invoke('runs.drift', runId));
      const st = r.stats as { exports?: typeof exports };
      if (st.exports) setExports(st.exports);
      if (r.status !== 'running') setDiff(await invoke('runs.diff', runId).catch(() => undefined));
    }
  }, [runId, dataset]);

  useEffect(() => { void load().catch((e) => toast((e as Error).message, 'error')); }, [load, toast]);

  useIpcEvent('run:event', (e) => {
    const id = 'runId' in e ? e.runId : e.run.id;
    if (id !== runId) return;
    switch (e.type) {
      case 'run.start': setRecord(e.run); break;
      case 'run.progress': setStats(e.stats); break;
      case 'run.done': setRecord(e.run); setStats(e.stats); setCaptcha(null); void invoke('runs.diff', runId).then(setDiff).catch(() => undefined); void invoke('runs.drift', runId).then(setDrift).catch(() => undefined); break;
      case 'rows': if (!dataset || e.dataset === dataset) setRows((r) => [...r, ...e.rows].slice(-MAX_ROWS)); break;
      case 'drift': setDrift((d) => [...d, e.event]); break;
      case 'log': setLogs((l) => [...l, { ts: Date.now(), level: e.level, msg: e.data ? `${e.msg} ${JSON.stringify(e.data)}` : e.msg }].slice(-400)); break;
      case 'request.done': setLogs((l) => [...l, { ts: Date.now(), level: e.status === 'failed' ? 'error' : 'debug', msg: `${e.mode} ${e.httpStatus ?? ''} ${e.request.url} → ${e.status} (${e.rows} rows, ${fmtDuration(e.durationMs)})${e.error ? `: ${e.error}` : ''}` }].slice(-400)); break;
      case 'alert': setLogs((l) => [...l, { ts: Date.now(), level: 'warn', msg: `[alert:${e.kind}] ${e.title} — ${e.body}` }].slice(-400)); break;
      case 'export.done': setExports((x) => [...x, e.result]); setLogs((l) => [...l, { ts: Date.now(), level: e.result.error ? 'error' : 'info', msg: `export ${e.result.type} → ${e.result.target} (${e.result.rows} rows)${e.result.error ? `: ${e.result.error}` : ''}` }]); break;
      case 'captcha.needed': setCaptcha({ url: e.url, kind: e.kind }); break;
      default: break;
    }
  });

  const status = record?.status ?? 'running';
  const running = status === 'running';
  const s = stats;
  const columns = useMemo(() => { const c = new Set<string>(); for (const r of rows.slice(0, 100)) for (const k of Object.keys(r)) c.add(k); return Array.from(c); }, [rows]);

  const exportNow = () => act(async () => {
    const ext = exportType === 'google-sheets' ? '' : exportType;
    const path = ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xml', 'parquet', 'sqlite'].includes(exportType)
      ? await invoke('dialogs.save', { defaultPath: `${(record?.recipeName ?? 'export').replace(/[^a-z0-9]+/gi, '-')}.${ext}`, filters: [{ name: exportType.toUpperCase(), extensions: [ext] }] })
      : undefined;
    if (['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xml', 'parquet', 'sqlite'].includes(exportType) && !path) return;
    const sink = blankSink(exportType, 'export');
    if (path && 'path' in sink) sink.path = path;
    const res = await invoke('runs.export', runId, [sink]);
    setExports((x) => [...x, ...res]);
    setTab('exports');
    const err = res.find((r) => r.error);
    if (err) throw new Error(err.error);
    toast(`Exported ${res[0]?.rows ?? 0} rows to ${res[0]?.target}`, 'ok');
  });

  const openRecipe = async () => {
    if (!record?.recipeId) return;
    const r = await invoke('recipes.get', record.recipeId);
    if (r.recipe) go({ name: 'recorder', recipeId: record.recipeId, recipe: r.recipe, key: 0 });
  };

  return (
    <div className="view">
      <div className="view-header">
        <Btn size="sm" variant="ghost" onClick={() => go({ name: 'home' })}>← Recipes</Btn>
        <h1>{record?.recipeName ?? 'Run'}</h1>
        <RunStatusBadge status={status} />
        <span className="faint small">{record ? `${record.trigger} · started ${fmtTime(record.startedAt)}` : ''}{record?.finishedAt ? ` · ${fmtDuration(record.finishedAt - record.startedAt)}` : ''}</span>
        <div className="grow" />
        {running && (paused ? <Btn size="sm" onClick={() => void invoke('runs.resume', runId).then(() => setPaused(false))}>Resume</Btn> : <Btn size="sm" onClick={() => void invoke('runs.pause', runId).then(() => setPaused(true))}>Pause</Btn>)}
        {running && <Btn size="sm" variant="danger" onClick={() => void invoke('runs.cancel', runId)}>Cancel</Btn>}
        {!running && (status === 'failed' || status === 'cancelled' || status === 'partial') && <Btn size="sm" onClick={async () => { const a = await act(() => invoke('runs.resumeStopped', runId), 'Resumed'); if (a) go({ name: 'run', runId: a.id }); }}>Resume run</Btn>}
        {record?.recipeId && <Btn size="sm" onClick={() => void openRecipe()}>Open recipe</Btn>}
        <span className="row gap-4">
          <Select value={exportType} onChange={(e) => setExportType(e.target.value as Sink['type'])}>{['xlsx', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'parquet', 'sqlite'].map((t) => <option key={t}>{t}</option>)}</Select>
          <Btn size="sm" variant="primary" onClick={exportNow} disabled={running && (s?.rows ?? 0) === 0}>Export…</Btn>
        </span>
      </div>
      <div className="view-body tight" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12 }} className="col">
          {captcha && <div className="banner warn"><b>CAPTCHA needed</b> ({captcha.kind}) on {truncate(captcha.url, 80)} — solve it in the browser window; the run continues automatically.</div>}
          {record?.error && <div className="banner danger"><b>Error:</b> {record.error}</div>}
          {paused && running && <div className="banner info">Run paused.</div>}
          <div className="stat-cards">
            <StatCard label="Rows" value={fmtNum(s?.rows)} sub={s?.rowsByDataset && Object.keys(s.rowsByDataset).length > 1 ? Object.entries(s.rowsByDataset).map(([k, v]) => `${k}: ${v}`).join(' · ') : undefined} />
            <StatCard label="Pages" value={fmtNum(s?.pages)} sub={fmtBytes(s?.bytes)} />
            <StatCard label="Rows / min" value={s ? Math.round(s.rowsPerMinute).toLocaleString() : '–'} sub={s ? fmtDuration(s.elapsedMs) : ''} />
            <StatCard label="Queue" value={`${fmtNum(s?.requests.done)} / ${fmtNum(s?.requests.total)}`} sub={s ? `${s.requests.pending} pending · ${s.requests.running} running · ${s.requests.failed} failed` : ''} />
            <StatCard label="Fetches" value={`${fmtNum(s?.httpFetches)} · ${fmtNum(s?.browserFetches)}`} sub="http · browser" />
            <StatCard label="Drift" value={fmtNum(s?.drift)} sub={s ? `${s.healed} healed` : ''} />
            <StatCard label="Validation" value={fmtNum(s?.validationFlags)} sub={s ? `${s.validationDrops} dropped` : 'flags'} />
            <StatCard label="AI" value={fmtNum(s?.aiCalls)} sub={s ? `${fmtNum(s.aiTokens)} tokens` : 'calls'} />
          </div>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rows', label: `Rows (${rows.length}${rows.length >= MAX_ROWS ? '+' : ''})` }, { id: 'log', label: `Log (${logs.length})` }, { id: 'drift', label: <span>Drift ({drift.length})</span> }, { id: 'exports', label: `Exports (${exports.length})` }, { id: 'changes', label: diff ? `Changes (+${diff.diff.added.length} −${diff.diff.removed.length} ~${diff.diff.changed.length})` : 'Changes' }]} />
        <div className="grow" style={{ minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'rows' && (
            <>
              {datasets.length > 1 && <div className="row" style={{ padding: '6px 12px' }}><span className="muted small">Dataset</span><Select value={dataset ?? ''} onChange={(e) => setDataset(e.target.value || undefined)}><option value="">all</option>{datasets.map((d) => <option key={d.dataset} value={d.dataset}>{d.dataset} ({d.rows})</option>)}</Select></div>}
              <RowsTable rows={rows} columns={columns} />
            </>
          )}
          {tab === 'log' && <div className="log grow" style={{ overflow: 'auto' }}>{logs.length === 0 ? <Empty>No log events yet.</Empty> : logs.map((l, i) => <div key={i} className={`line ${l.level}`}><span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>{l.msg}</div>)}</div>}
          {tab === 'drift' && (
            <div className="grow" style={{ overflow: 'auto' }}>
              {drift.length === 0 ? <Empty>No drift events. Selectors matched as expected.</Empty> : (
                <table className="grid">
                  <thead><tr><th>Kind</th><th>Template</th><th>Field</th><th>Detail</th><th>Page</th><th></th></tr></thead>
                  <tbody>{drift.map((d) => (
                    <tr key={d.id}><td><Badge tone={d.kind === 'healed' ? 'ok' : d.kind === 'heal-failed' || d.kind === 'list-empty' ? 'danger' : 'warn'}>{d.kind}</Badge></td><td>{d.template}</td><td>{d.field}</td><td title={JSON.stringify(d.detail)}>{truncate(JSON.stringify(d.detail), 100)}</td><td className="ellipsis" title={d.pageUrl}>{truncate(d.pageUrl ?? '', 60)}</td><td>{record?.recipeId && <Btn size="sm" onClick={() => void openRecipe()}>Open recipe to fix</Btn>}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}
          {tab === 'exports' && (
            <div className="grow" style={{ overflow: 'auto' }}>
              {exports.length === 0 ? <Empty>No exports yet. Configure outputs in the recipe or use Export… above.</Empty> : (
                <table className="grid">
                  <thead><tr><th>Type</th><th className="num">Rows</th><th>Target</th><th>Status</th><th></th></tr></thead>
                  <tbody>{exports.map((x, i) => (
                    <tr key={i}><td>{x.type}</td><td className="num">{fmtNum(x.rows)}</td><td className="ellipsis" title={x.target}>{x.target}</td><td>{x.error ? <span className="danger">{x.error}</span> : <Badge tone="ok">done</Badge>}</td>
                      <td className="row gap-4">{!x.error && /^[a-z]:\\|^\//i.test(x.target) && <><Btn size="sm" onClick={() => void invoke('shell.openPath', x.target)}>Open file</Btn><Btn size="sm" onClick={() => void invoke('shell.showItemInFolder', x.target)}>Show in folder</Btn></>}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}
          {tab === 'changes' && <ChangesPanel diff={diff} running={running} hasRecipe={!!record?.recipeId} />}
        </div>
      </div>
    </div>
  );
}

/** Simple windowed table (fixed row height) for up to MAX_ROWS rows. */
function RowsTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el); setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  if (rows.length === 0) return <Empty>No rows yet.</Empty>;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 5);
  return (
    <div ref={ref} className="rows-window grow" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <table className="grid" style={{ tableLayout: 'fixed' }}>
        <thead><tr><th className="num" style={{ width: 50 }}>#</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {start > 0 && <tr style={{ height: start * ROW_H }}><td colSpan={columns.length + 1} /></tr>}
          {rows.slice(start, end).map((r, i) => <tr key={start + i} style={{ height: ROW_H }}><td className="num faint">{start + i + 1}</td>{columns.map((c) => <td key={c} title={cellText(r[c])}>{truncate(cellText(r[c]), 100)}</td>)}</tr>)}
          {end < rows.length && <tr style={{ height: (rows.length - end) * ROW_H }}><td colSpan={columns.length + 1} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ChangesPanel({ diff, running, hasRecipe }: { diff?: { prevRunId: string; diff: DiffResult }; running: boolean; hasRecipe: boolean }) {
  if (running) return <Empty>The change summary is computed when the run completes.</Empty>;
  if (!hasRecipe) return <Empty>Ad-hoc runs have no previous run to compare with.</Empty>;
  if (!diff) return <Empty>No previous run of this recipe to compare with.</Empty>;
  const d = diff.diff;
  const list = (title: string, items: unknown[], tone: 'ok' | 'danger' | 'warn') => (
    <div className="card" style={{ minHeight: 0, overflow: 'auto' }}>
      <div className="row mb-8"><Badge tone={tone}>{items.length}</Badge><b>{title}</b></div>
      {items.slice(0, 200).map((it, i) => <div key={i} className="mono tiny ellipsis" title={JSON.stringify(it)}>{truncate(JSON.stringify(it), 160)}</div>)}
      {items.length > 200 && <div className="faint tiny">… {items.length - 200} more</div>}
    </div>
  );
  return (
    <div className="grow" style={{ overflow: 'auto', padding: 12 }}>
      <div className="muted small mb-8">Compared with run <code>{diff.prevRunId}</code> · {fmtNum(d.unchanged)} unchanged rows</div>
      <div className="diff-cols">{list('Added', d.added, 'ok')}{list('Removed', d.removed, 'danger')}{list('Changed', d.changed, 'warn')}</div>
    </div>
  );
}
