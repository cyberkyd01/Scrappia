import { useState } from 'react';
import type { Transform } from '@scrappia/core';
import { Btn, Chip, Input, Select, Textarea, Check, FieldRow } from '../ui';
import { TRANSFORM_TYPES, blankTransform, describeTransform } from '../../state/recipe';

export function TransformEditor({ value, onChange }: { value: Transform[]; onChange: (t: Transform[]) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [addType, setAddType] = useState<Transform['type']>('trim');

  const update = (i: number, t: Transform) => onChange(value.map((x, j) => (j === i ? t : x)));
  const remove = (i: number) => { onChange(value.filter((_, j) => j !== i)); setEditing(null); };
  const add = () => { onChange([...value, blankTransform(addType)]); setEditing(value.length); };

  return (
    <div className="col gap-4">
      <div className="transform-list">
        {value.map((t, i) => <Chip key={i} onClick={() => setEditing(editing === i ? null : i)} onRemove={() => remove(i)} title="click to edit">{describeTransform(t)}</Chip>)}
        <span className="row gap-4">
          <Select value={addType} onChange={(e) => setAddType(e.target.value as Transform['type'])}>{TRANSFORM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          <Btn size="sm" onClick={add}>+ add</Btn>
        </span>
      </div>
      {editing !== null && value[editing] && (
        <div className="card">
          <TransformForm t={value[editing]} onChange={(t) => update(editing, t)} />
          <div className="row mt-8"><Btn size="sm" onClick={() => setEditing(null)}>Done</Btn>{editing > 0 && <Btn size="sm" onClick={() => { const v = value.slice(); [v[editing - 1], v[editing]] = [v[editing], v[editing - 1]]; onChange(v); setEditing(editing - 1); }}>Move up</Btn>}</div>
        </div>
      )}
    </div>
  );
}

function TransformForm({ t, onChange }: { t: Transform; onChange: (t: Transform) => void }) {
  const set = (patch: Record<string, unknown>) => onChange({ ...t, ...patch } as Transform);
  switch (t.type) {
    case 'regex': return (
      <>
        <FieldRow label="Pattern"><Input full mono value={t.pattern} onChange={(e) => set({ pattern: e.target.value })} /></FieldRow>
        <FieldRow label="Flags"><Input mono value={t.flags ?? ''} onChange={(e) => set({ flags: e.target.value || undefined })} placeholder="i" /></FieldRow>
        <FieldRow label="Group"><Input mono value={t.group ?? ''} onChange={(e) => { const v = e.target.value; set({ group: v === '' ? undefined : /^\d+$/.test(v) ? Number(v) : v }); }} placeholder="1 or name" /></FieldRow>
        <FieldRow label="All matches"><span className="row"><Check label="capture all" checked={!!t.all} onChange={(v) => set({ all: v || undefined })} /><Input value={t.join ?? ''} placeholder="join with" onChange={(e) => set({ join: e.target.value || undefined })} /></span></FieldRow>
      </>
    );
    case 'replace': return (
      <>
        <FieldRow label="Pattern"><Input full mono value={t.pattern} onChange={(e) => set({ pattern: e.target.value })} /></FieldRow>
        <FieldRow label="Flags"><Input mono value={t.flags ?? ''} onChange={(e) => set({ flags: e.target.value || undefined })} placeholder="gi" /></FieldRow>
        <FieldRow label="Replacement"><Input full mono value={t.replacement} onChange={(e) => set({ replacement: e.target.value })} /></FieldRow>
      </>
    );
    case 'split': return (
      <>
        <FieldRow label="Separator"><Input mono value={t.separator} onChange={(e) => set({ separator: e.target.value })} /></FieldRow>
        <FieldRow label="Index"><Input type="number" value={t.index ?? ''} onChange={(e) => set({ index: e.target.value === '' ? undefined : Number(e.target.value) })} /></FieldRow>
      </>
    );
    case 'substring': return (
      <>
        <FieldRow label="Start"><Input type="number" value={t.start} onChange={(e) => set({ start: Number(e.target.value) })} /></FieldRow>
        <FieldRow label="End"><Input type="number" value={t.end ?? ''} onChange={(e) => set({ end: e.target.value === '' ? undefined : Number(e.target.value) })} /></FieldRow>
      </>
    );
    case 'prefix': case 'suffix': case 'default': return <FieldRow label="Value"><Input full value={t.value} onChange={(e) => set({ value: e.target.value })} /></FieldRow>;
    case 'number': return (
      <>
        <FieldRow label="Decimal sep."><Input value={t.decimal ?? ''} placeholder="." onChange={(e) => set({ decimal: e.target.value || undefined })} /></FieldRow>
        <FieldRow label="Thousands sep."><Input value={t.thousands ?? ''} placeholder="," onChange={(e) => set({ thousands: e.target.value || undefined })} /></FieldRow>
      </>
    );
    case 'boolean': return <FieldRow label="Truthy values" hint="comma separated"><Input full value={(t.truthy ?? []).join(', ')} onChange={(e) => set({ truthy: e.target.value ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined })} /></FieldRow>;
    case 'date': return (
      <>
        <FieldRow label="Input format" hint="e.g. DD/MM/YYYY (blank = auto)"><Input full value={t.inputFormat ?? ''} onChange={(e) => set({ inputFormat: e.target.value || undefined })} /></FieldRow>
        <FieldRow label="Output format" hint="blank = ISO 8601"><Input full value={t.outputFormat ?? ''} onChange={(e) => set({ outputFormat: e.target.value || undefined })} /></FieldRow>
      </>
    );
    case 'urlParam': return <FieldRow label="Param name"><Input value={t.name} onChange={(e) => set({ name: e.target.value })} /></FieldRow>;
    case 'template': return <FieldRow label="Template" hint="{{value}} = current value, {{field:name}} = other field"><Input full mono value={t.template} onChange={(e) => set({ template: e.target.value })} /></FieldRow>;
    case 'map': return (
      <>
        <FieldRow label="Mapping" stack hint="one per line: from=to">
          <Textarea full value={Object.entries(t.mapping).map(([k, v]) => `${k}=${v}`).join('\n')} onChange={(e) => { const m: Record<string, string> = {}; for (const line of e.target.value.split('\n')) { const i = line.indexOf('='); if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } set({ mapping: m }); }} />
        </FieldRow>
        <FieldRow label="Fallback"><Input value={t.fallback ?? ''} onChange={(e) => set({ fallback: e.target.value || undefined })} /></FieldRow>
      </>
    );
    case 'hash': return <FieldRow label="Algorithm"><Select value={t.algorithm} onChange={(e) => set({ algorithm: e.target.value })}><option>sha256</option><option>sha1</option><option>md5</option></Select></FieldRow>;
    case 'js': return <FieldRow label="Code" stack hint="JS body; `value` and `record` are in scope; return the new value"><Textarea full value={t.code} onChange={(e) => set({ code: e.target.value })} /></FieldRow>;
    case 'ai': return (
      <>
        <FieldRow label="Prompt" stack><Textarea full value={t.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="e.g. Extract the brand name from this product title" /></FieldRow>
        <FieldRow label="Provider"><Input value={t.provider ?? ''} placeholder="default" onChange={(e) => set({ provider: e.target.value || undefined })} /></FieldRow>
        <FieldRow label="JSON schema" stack hint="optional; leave blank for a string result">
          <Textarea full value={t.schema ? JSON.stringify(t.schema, null, 2) : ''} onChange={(e) => { try { set({ schema: e.target.value ? JSON.parse(e.target.value) : undefined }); } catch { /* keep typing */ } }} />
        </FieldRow>
      </>
    );
    default: return <div className="muted small">No options for <b>{t.type}</b>.</div>;
  }
}
