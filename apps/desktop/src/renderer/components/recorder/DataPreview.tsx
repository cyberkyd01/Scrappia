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
          <Btn size="sm" active={tab === 'preview'} onClick={() => setTab('preview')}>Current page{preview ? ` (${preview.records.length || (Object.keys(preview.page).length ? 1 : 0)})` : ''}</Btn>
          <Btn size="sm" active={tab === 'test'} onClick={() => setTab('test')}>Test run{testRun ? ` (${testRun.rows.length})` : ''}</Btn>
        </div>
        {tab === 'preview' && preview?.listMatch && <span className="faint tiny">list candidate #{preview.listMatch.candidate + 1}, {preview.listMatch.matched} records</span>}
        {tab === 'test' && testRun && (
          <span className="row gap-4 tiny">
            <Badge tone={testRun.status === 'running' ? 'accent' : testRun.status === 'succeeded' ? 'ok' : testRun.status === 'failed' ? 'danger' : 'warn'}>{testRun.status}</Badge>
            <span className="faint">{fmtNum(testRun.stats?.pages)} pages · {fmtNum(testRun.stats?.rows)} rows · {testRun.stats?.requests.failed ?? 0} failed</span>
            {testRun.error && <span className="danger">{truncate(testRun.error, 80)}</span>}
          </span>
        )}
        <div className="grow" />
        {tab === 'preview' && <Btn size="sm" onClick={() => void refresh()} disabled={!recorderOpen || loading || !hasFields}>{loading ? 'Refreshing…' : 'Refresh'}</Btn>}
        {testRun?.status === 'running' ? <Btn size="sm" variant="danger" onClick={() => void invoke('runs.cancel', testRun.runId)}>Stop</Btn> : <Btn size="sm" onClick={startTest} disabled={!hasFields || recipe.entry.urls.length === 0} title="Dry run: max 5 requests, no exports">Test run (5 pages)</Btn>}
      </div>
      {!collapsed && (
        <div className="panel-body pad-0">
          {!hasFields ? <div className="empty">Capture at least one field to see a preview.</div>
            : !recorderOpen && tab === 'preview' ? <div className="empty">Open a page in the recorder browser to preview extraction.</div>
              : rows.length === 0 ? <div className="empty">{loading ? 'Extracting…' : tab === 'test' && testRun?.status === 'running' ? 'Waiting for rows…' : 'No records matched. Check the list selector and field selectors.'}</div> : (
                <table className="grid">
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
