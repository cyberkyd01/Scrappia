import { useState } from 'react';
import type { Sink } from '@scrappia/core';
import { invoke } from '../../api';
import { Btn, Input, Select, Check, FieldRow, Badge } from '../ui';
import { blankSink } from '../../state/recipe';

const SINK_TYPES: Sink['type'][] = ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xml', 'parquet', 'sqlite', 'postgres', 'mysql', 'mongodb', 'google-sheets', 'airtable', 'notion', 's3', 'webhook', 'stdout'];

export function SinksEditor({ sinks, onChange, recipeName, secrets }: { sinks: Sink[]; onChange: (s: Sink[]) => void; recipeName: string; secrets: string[] }) {
  const [addType, setAddType] = useState<Sink['type']>('csv');
  const update = (i: number, s: Sink) => onChange(sinks.map((x, j) => (j === i ? s : x)));
  return (
    <div className="col">
      <div className="row"><span className="muted small">Add output</span><Select value={addType} onChange={(e) => setAddType(e.target.value as Sink['type'])}>{SINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select><Btn size="sm" onClick={() => onChange([...sinks, blankSink(addType, recipeName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'export')])}>+ add</Btn></div>
      {sinks.length === 0 && <div className="faint small">No outputs configured: rows are stored in the local database and can be exported later from the run page.</div>}
      {sinks.map((s, i) => (
        <div className="card" key={i}>
          <div className="row mb-8"><Badge tone="accent">{s.type}</Badge><Input value={s.name ?? ''} placeholder="name (optional)" onChange={(e) => update(i, { ...s, name: e.target.value || undefined })} /><div className="grow" /><Check label="enabled" checked={s.enabled} onChange={(v) => update(i, { ...s, enabled: v })} /><Btn size="sm" variant="ghost" onClick={() => onChange(sinks.filter((_, j) => j !== i))}>✕</Btn></div>
          <SinkForm sink={s} onChange={(n) => update(i, n)} secrets={secrets} />
          <div className="row wrap gap-12 mt-8">
            <span className="row gap-4"><span className="muted small">mode</span><Select value={s.mode} onChange={(e) => update(i, { ...s, mode: e.target.value as Sink['mode'] })}><option value="overwrite">overwrite</option><option value="append">append</option><option value="upsert">upsert</option></Select></span>
            <span className="row gap-4"><span className="muted small">key</span><Input value={Array.isArray(s.key) ? s.key.join(',') : s.key ?? ''} placeholder="output.keys" onChange={(e) => update(i, { ...s, key: e.target.value ? (e.target.value.includes(',') ? e.target.value.split(',').map((x) => x.trim()) : e.target.value) : undefined })} /></span>
            <span className="row gap-4"><span className="muted small">dataset</span><Input value={s.dataset ?? ''} placeholder="all" onChange={(e) => update(i, { ...s, dataset: e.target.value || undefined })} /></span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SinkForm({ sink: s, onChange, secrets }: { sink: Sink; onChange: (s: Sink) => void; secrets: string[] }) {
  const set = (patch: Record<string, unknown>) => onChange({ ...s, ...patch } as Sink);
  const pathRow = 'path' in s ? (
    <FieldRow label="Path" hint="relative paths resolve under the output directory; {{run}} / {{date}} tokens allowed">
      <span className="row"><Input full mono value={s.path} onChange={(e) => set({ path: e.target.value })} /><Btn size="sm" onClick={async () => { const p = await invoke('dialogs.save', { defaultPath: s.path }); if (p) set({ path: p }); }}>…</Btn></span>
    </FieldRow>
  ) : null;
  const refInput = (key: string, value: string | undefined, label: string) => (
    <FieldRow label={label} hint="secret name from Settings > Secrets">
      <Input full list="secret-names" value={value ?? ''} onChange={(e) => set({ [key]: e.target.value })} />
    </FieldRow>
  );
  return (
    <>
      <datalist id="secret-names">{secrets.map((n) => <option key={n} value={n} />)}</datalist>
      {pathRow}
      {s.type === 'csv' && <div className="row gap-12"><span className="row gap-4"><span className="muted small">delimiter</span><Input style={{ width: 48 }} value={s.delimiter ?? ''} placeholder="," onChange={(e) => set({ delimiter: e.target.value || undefined })} /></span><Check label="UTF-8 BOM (Excel)" checked={!!s.bom} onChange={(v) => set({ bom: v || undefined })} /></div>}
      {s.type === 'json' && <Check label="pretty print" checked={!!s.pretty} onChange={(v) => set({ pretty: v || undefined })} />}
      {s.type === 'xlsx' && <FieldRow label="Sheet"><Input value={s.sheet ?? ''} placeholder="Sheet1" onChange={(e) => set({ sheet: e.target.value || undefined })} /></FieldRow>}
      {s.type === 'xml' && <div className="row gap-12"><span className="row gap-4"><span className="muted small">root</span><Input value={s.root ?? ''} placeholder="rows" onChange={(e) => set({ root: e.target.value || undefined })} /></span><span className="row gap-4"><span className="muted small">row</span><Input value={s.row ?? ''} placeholder="row" onChange={(e) => set({ row: e.target.value || undefined })} /></span></div>}
      {s.type === 'sqlite' && <FieldRow label="Table"><Input value={s.table} onChange={(e) => set({ table: e.target.value })} /></FieldRow>}
      {s.type === 'postgres' && <>{refInput('connectionRef', s.connectionRef, 'Connection URL secret')}<FieldRow label="Table"><Input value={s.table} onChange={(e) => set({ table: e.target.value })} /></FieldRow><FieldRow label="Schema"><Input value={s.schema ?? ''} placeholder="public" onChange={(e) => set({ schema: e.target.value || undefined })} /></FieldRow></>}
      {s.type === 'mysql' && <>{refInput('connectionRef', s.connectionRef, 'Connection URL secret')}<FieldRow label="Table"><Input value={s.table} onChange={(e) => set({ table: e.target.value })} /></FieldRow></>}
      {s.type === 'mongodb' && <>{refInput('connectionRef', s.connectionRef, 'Connection URL secret')}<FieldRow label="Database"><Input value={s.database} onChange={(e) => set({ database: e.target.value })} /></FieldRow><FieldRow label="Collection"><Input value={s.collection} onChange={(e) => set({ collection: e.target.value })} /></FieldRow></>}
      {s.type === 'google-sheets' && <>{refInput('credentialRef', s.credentialRef, 'Service account JSON secret')}<FieldRow label="Spreadsheet ID"><Input full mono value={s.spreadsheetId} onChange={(e) => set({ spreadsheetId: e.target.value })} /></FieldRow><FieldRow label="Sheet"><Input value={s.sheet ?? ''} onChange={(e) => set({ sheet: e.target.value || undefined })} /></FieldRow></>}
      {s.type === 'airtable' && <>{refInput('credentialRef', s.credentialRef, 'API token secret')}<FieldRow label="Base ID"><Input mono value={s.baseId} onChange={(e) => set({ baseId: e.target.value })} /></FieldRow><FieldRow label="Table"><Input value={s.table} onChange={(e) => set({ table: e.target.value })} /></FieldRow></>}
      {s.type === 'notion' && <>{refInput('credentialRef', s.credentialRef, 'Integration token secret')}<FieldRow label="Database ID"><Input full mono value={s.databaseId} onChange={(e) => set({ databaseId: e.target.value })} /></FieldRow></>}
      {s.type === 's3' && <>{refInput('credentialRef', s.credentialRef, 'Credentials secret')}<FieldRow label="Bucket"><Input value={s.bucket} onChange={(e) => set({ bucket: e.target.value })} /></FieldRow><FieldRow label="Key template"><Input full mono value={s.keyTemplate} onChange={(e) => set({ keyTemplate: e.target.value })} /></FieldRow><div className="row gap-12"><span className="row gap-4"><span className="muted small">format</span><Select value={s.format} onChange={(e) => set({ format: e.target.value })}><option>jsonl</option><option>json</option><option>csv</option><option>parquet</option></Select></span><Input placeholder="endpoint (optional)" value={s.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value || undefined })} /><Input placeholder="region" style={{ width: 100 }} value={s.region ?? ''} onChange={(e) => set({ region: e.target.value || undefined })} /></div></>}
      {s.type === 'webhook' && <><FieldRow label="URL"><Input full mono value={s.url} onChange={(e) => set({ url: e.target.value })} /></FieldRow>{refInput('secretRef', s.secretRef, 'Signing secret')}<FieldRow label="Batch size"><Input type="number" style={{ width: 80 }} value={s.batchSize} onChange={(e) => set({ batchSize: Number(e.target.value) })} /></FieldRow></>}
      {s.type === 'stdout' && <FieldRow label="Format"><Select value={s.format} onChange={(e) => set({ format: e.target.value })}><option>jsonl</option><option>json</option><option>csv</option><option>table</option></Select></FieldRow>}
    </>
  );
}
