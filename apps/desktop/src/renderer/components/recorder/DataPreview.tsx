/**
 * Bottom panel of the recorder: live extraction preview of the current template on the page
 * that is open in the recorder browser, plus a "Test run (5 pages)" dry run streaming rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Recipe, RunStats } from '@scrappia/core';
import type { PreviewResult } from '@shared/ipc';
import { invoke, useIpcEvent } from '../../api';
import { Btn, Badge, useToast } from '../ui';
import { cellText, fmtNum, truncate } from '../../lib/format';

export function DataPreview({ recipe, templateName, recorderOpen, refreshKey, collapsed, onToggle }: {
  recipe: Recipe; templateName: string; recorderOpen: boolean; refreshKey: string; collapsed: boolean; onToggle: () => void;
}) {
  const toast = useToast();
  const template = recipe.templates[templateName];
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'preview' | 'test'>('preview');
  const [testRun, setTestRun] = useState<{ runId: string; status: string; rows: Array<Record<string, unknown>>; stats?: RunStats; error?: string } | null>(null);
  const [testLog, setTestLog] = useState<Array<{ level: 'info' | 'error'; msg: string }>>([]);
  const testRunId = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);

  const fieldNames = useMemo(() => [...(template?.list?.fields ?? []), ...(template?.fields ?? [])].map((f) => f.name), [template]);
  const hasFields = fieldNames.length > 0;

  const refresh = useCallback(async () => {
    if (!recorderOpen || !template || !hasFields) { setPreview(null); return; }
    setLoading(true);
    try { setPreview(await invoke('recorder.extractPreview', template)); }
    catch (e) { toast(`Preview failed: ${(e as Error).message}`, 'error'); }
    finally { setLoading(false); }
  }, [recorderOpen, template, hasFields, toast]);

  useEffect(() => {
    if (collapsed) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void refresh(), 500);
    return () => window.clearTimeout(timer.current);
  }, [refreshKey, refresh, collapsed]);

  useIpcEvent('run:event', (e) => {
    const eventRunId = 'runId' in e ? e.runId : e.run.id;
    if (eventRunId === testRunId.current) {
      // keep a short, human-readable trail so a run that produces nothing explains itself
      if (e.type === 'request.done') {
        const http = e.httpStatus && e.httpStatus >= 400 ? ` (HTTP ${e.httpStatus}${e.httpStatus === 404 ? ': page not found, check the URL' : e.httpStatus === 403 || e.httpStatus === 429 || e.httpStatus === 503 ? ': the site refused the request' : ''})` : '';
        const level = e.status === 'failed' || (e.rows === 0 && !!http) ? 'error' as const : 'info' as const;
        setTestLog((l) => [...l, { level, msg: `${e.mode}${e.httpStatus ? ` ${e.httpStatus}` : ''} ${e.request.url} → ${e.status}, ${e.rows} rows${e.error ? `: ${e.error}` : ''}${http}` }].slice(-8));
      }
      else if (e.type === 'log' && e.level !== 'debug') setTestLog((l) => [...l, { level: e.level === 'error' ? 'error' as const : 'info' as const, msg: e.msg }].slice(-8));
      else if (e.type === 'captcha.needed') setTestLog((l) => [...l, { level: 'error' as const, msg: `CAPTCHA on ${e.url}: solve it in the browser window to continue` }].slice(-8));
      else if (e.type === 'run.done') {
        if (e.run.status !== 'succeeded') setTestLog((l) => [...l, { level: 'error' as const, msg: e.run.status === 'failed' ? `Run failed${e.run.error ? `: ${e.run.error}` : ''}` : `Run ${e.run.status}: ${e.stats.requests.failed} request(s) failed, see lines above` }].slice(-8));
        else if (e.stats.rows === 0) setTestLog((l) => [...l, { level: 'error' as const, msg: 'Run finished without rows: the list/field selectors matched nothing on the fetched page(s)' }].slice(-8));
        // Streamed rows are a live approximation (detail-page merges re-emit their parent row); the stored rows are authoritative.
        const id = e.run.id;
        void invoke('runs.rows', id, undefined, { limit: 500 }).then((rs) => setTestRun((t) => (t && t.runId === id ? { ...t, rows: rs } : t))).catch(() => undefined);
      }
    }
    setTestRun((t) => {
      if (!t) return t;
      const id = 'runId' in e ? e.runId : e.run.id;
      if (id !== t.runId) return t;
      switch (e.type) {
        case 'rows': return { ...t, rows: [...t.rows, ...e.rows].slice(-500) };
        case 'run.progress': return { ...t, stats: e.stats };
        case 'run.done': return { ...t, status: e.run.status, stats: e.stats, error: e.run.error };
        default: return t;
      }
    });
  });

  const startTest = async () => {
    try {
      const run = await invoke('runs.start', recipe, { dryRun: true, maxRequests: 5, trigger: 'test' });
      testRunId.current = run.id;
      setTestLog([]);
      setTestRun({ runId: run.id, status: 'running', rows: [] });
      setTab('test');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const rows = tab === 'preview' ? (preview ? previewRows(preview) : []) : testRun?.rows ?? [];
  const columns = useMemo(() => {
    const cols = new Set<string>(fieldNames);
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) cols.add(k);
    return Array.from(cols);
  }, [rows, fieldNames]);
  const empties = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of columns) out[c] = rows.filter((r) => { const v = r[c]; return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0); }).length;
    return out;
  }, [rows, columns]);

  return (
    <div className={`recorder-bottom${collapsed ? ' collapsed' : ''}`}>
      <div className="panel-head">
        <button type="button" className="btn ghost sm" onClick={onToggle}>{collapsed ? '▴' : '▾'}</button>
        <span>Data preview</span>
        <div className="btn-group">
          <Btn size="sm" active={tab === 'preview'} onClick={() => setTab('preview')} data-testid="preview-tab">Current page{preview ? ` (${preview.records.length || (Object.keys(preview.page).length ? 1 : 0)})` : ''}</Btn>
          <Btn size="sm" active={tab === 'test'} onClick={() => setTab('test')} data-testid="test-run-tab">Test run{testRun ? ` (${testRun.rows.length})` : ''}</Btn>
        </div>
        {tab === 'preview' && preview?.listMatch && <span className="faint tiny" data-testid="preview-list-match">list candidate #{preview.listMatch.candidate + 1}, {preview.listMatch.matched} records</span>}
        {tab === 'test' && testRun && (
          <span className="row gap-4 tiny">
            <Badge tone={testRun.status === 'running' ? 'accent' : testRun.status === 'succeeded' ? 'ok' : testRun.status === 'failed' ? 'danger' : 'warn'}><span data-testid="test-run-status">{testRun.status}</span></Badge>
            <span className="faint" data-testid="test-run-stats">{fmtNum(testRun.stats?.pages)} pages · {fmtNum(testRun.stats?.rows)} rows · {testRun.stats?.requests.failed ?? 0} failed</span>
            {testRun.error && <span className="danger">{truncate(testRun.error, 80)}</span>}
          </span>
        )}
        <div className="grow" />
        {tab === 'preview' && <Btn size="sm" onClick={() => void refresh()} disabled={!recorderOpen || loading || !hasFields} data-testid="preview-refresh">{loading ? 'Refreshing…' : 'Refresh'}</Btn>}
        {testRun?.status === 'running' ? <Btn size="sm" variant="danger" onClick={() => void invoke('runs.cancel', testRun.runId)} data-testid="test-run-stop">Stop</Btn> : <Btn size="sm" onClick={startTest} disabled={!hasFields || recipe.entry.urls.length === 0} title="Dry run: max 5 requests, no exports" data-testid="test-run-button">Test run (5 pages)</Btn>}
      </div>
      {!collapsed && tab === 'test' && testLog.length > 0 && (
        <div className="log tiny" data-testid="test-run-log" style={{ maxHeight: 96, overflow: 'auto', borderBottom: '1px solid var(--border)' }}>
          {testLog.map((l, i) => <div key={i} className={`line ${l.level}`}>{l.msg}</div>)}
        </div>
      )}
      {!collapsed && (
        <div className="panel-body pad-0" data-testid={tab === 'preview' ? 'preview-body' : 'test-run-body'}>
          {!hasFields ? <div className="empty">Capture at least one field to see a preview.</div>
            : !recorderOpen && tab === 'preview' ? <div className="empty">Open a page in the recorder browser to preview extraction.</div>
              : rows.length === 0 ? <div className="empty">{loading ? 'Extracting…' : tab === 'test' && testRun?.status === 'running' ? 'Waiting for rows…' : tab === 'test' && testRun ? 'The test run produced no rows. See the log above.' : 'No records matched. Check the list selector and field selectors.'}</div> : (
                <table className="grid" data-testid={tab === 'preview' ? 'preview-table' : 'test-run-table'}>
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      {columns.map((c) => {
                        const fm = tab === 'preview' ? preview?.fieldMatches[c] : undefined;
                        return (
                          <th key={c}>{c}
                            <span className="sub">
                              {fm ? (fm.candidate < 0 ? <span className="danger">no match</span> : `cand #${fm.candidate + 1} · ${fm.matched} hit(s)`) : ''}
                              {empties[c] > 0 && <span className="warn"> · {empties[c]} empty</span>}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 200).map((r, i) => (
                      <tr key={i}><td className="num faint">{i + 1}</td>{columns.map((c) => <td key={c} title={cellText(r[c])}>{truncate(cellText(r[c]), 120)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              )}
        </div>
      )}
    </div>
  );
}

function previewRows(p: PreviewResult): Array<Record<string, unknown>> {
  if (p.records.length) return p.records.map((r) => ({ ...p.page, ...r }));
  return Object.keys(p.page).length ? [p.page] : [];
}
