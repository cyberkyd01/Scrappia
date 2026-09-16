/**
 * Editors for recipe building blocks shown in the recorder's right panel:
 * selector candidates, fields, lists, actions, pagination, follows and templates.
 */
import { useState, type ReactNode } from 'react';
import type { SelectorCandidate, Field, Action, Pagination, Follow, Template, Recipe, ListSpec } from '@scrappia/core';
import { invoke } from '../../api';
import { Btn, Input, Select, Check, FieldRow, Textarea, Badge, useToast } from '../ui';
import { FIELD_TYPES, paginationFor, slugName } from '../../state/recipe';
import { TransformEditor } from './TransformEditor';

// ---------- selectors ----------

export function SelectorEditor({ value, onChange, scope, label = 'Selectors' }: { value: SelectorCandidate[]; onChange: (v: SelectorCandidate[]) => void; scope?: SelectorCandidate[]; label?: string }) {
  const toast = useToast();
  const [counts, setCounts] = useState<Record<number, { count: number; samples: string[] }>>({});
  const update = (i: number, patch: Partial<SelectorCandidate>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const test = async (i: number) => {
    try {
      const r = await invoke('recorder.highlight', [value[i]], scope);
      setCounts((c) => ({ ...c, [i]: { count: r.count, samples: r.samples } }));
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const testAll = async () => {
    try { const r = await invoke('recorder.highlight', value, scope); toast(`Using candidate #${r.candidate + 1}: ${r.count} match(es)`, r.count ? 'ok' : 'warn'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="col gap-4">
      <div className="row"><h4 className="grow">{label}</h4><span className="faint tiny">first = primary, others = fallbacks</span><Btn size="sm" onClick={testAll} disabled={!value.length}>Test all</Btn></div>
      <div className="candidates">
        {value.map((c, i) => (
          <div className="candidate" key={i}>
            <span className="faint tiny">{i + 1}</span>
            <span className="row gap-4">
              <Select value={c.kind} onChange={(e) => update(i, { kind: e.target.value as SelectorCandidate['kind'] })} title="selector kind">
                <option value="css">css</option><option value="xpath">xpath</option><option value="text">text</option><option value="role">role</option><option value="auto">auto</option>
              </Select>
              <Input full mono value={c.value} onChange={(e) => update(i, { value: e.target.value })} title={c.note} />
            </span>
            <span className="tiny faint" title={counts[i]?.samples.join('\n')}>{counts[i] ? `${counts[i].count}×` : c.score !== undefined ? `s${c.score.toFixed(2)}` : ''}</span>
            <span className="row gap-4">
              <Btn size="sm" onClick={() => test(i)} title="highlight matches in the browser">Test</Btn>
              <Btn size="sm" variant="ghost" disabled={i === 0} onClick={() => { const v = value.slice(); const [x] = v.splice(i, 1); v.unshift(x); onChange(v); }} title="make primary">↑</Btn>
              <Btn size="sm" variant="ghost" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, j) => j !== i))} title="remove">✕</Btn>
            </span>
          </div>
        ))}
      </div>
      <div><Btn size="sm" onClick={() => onChange([...value, { kind: 'css', value: '' }])}>+ candidate</Btn></div>
    </div>
  );
}

// ---------- field ----------

export function FieldEditor({ field, onChange, scope, children }: { field: Field; onChange: (f: Field) => void; scope?: SelectorCandidate[]; children?: ReactNode }) {
  const set = (patch: Partial<Field>) => onChange({ ...field, ...patch });
  const needsSelector = !['constant', 'pageUrl', 'pageTitle', 'timestamp'].includes(field.type);
  return (
    <div className="col">
      <div className="row">
        <Input className="grow" value={field.name} onChange={(e) => set({ name: e.target.value })} onBlur={(e) => set({ name: slugName(e.target.value) })} placeholder="field name" />
        <Select value={field.type} onChange={(e) => set({ type: e.target.value as Field['type'] })}>{FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
      </div>
      {field.type === 'attr' && <FieldRow label="Attribute"><Input mono value={field.attr ?? ''} onChange={(e) => set({ attr: e.target.value })} placeholder="data-id" /></FieldRow>}
      {field.type === 'regex' && (
        <>
          <FieldRow label="Pattern"><Input full mono value={field.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })} /></FieldRow>
          <FieldRow label="Flags"><Input mono value={field.flags ?? ''} onChange={(e) => set({ flags: e.target.value || undefined })} /></FieldRow>
        </>
      )}
      {field.type === 'constant' && <FieldRow label="Value"><Input full value={field.value ?? ''} onChange={(e) => set({ value: e.target.value })} /></FieldRow>}
      {field.type === 'ai' && (
        <>
          <FieldRow label="Prompt" stack><Textarea full value={field.prompt ?? ''} onChange={(e) => set({ prompt: e.target.value })} placeholder="What to extract from the element (or page when no selector)" /></FieldRow>
          <FieldRow label="JSON schema" stack><Textarea full value={field.schema ? JSON.stringify(field.schema, null, 2) : ''} onChange={(e) => { try { set({ schema: e.target.value ? JSON.parse(e.target.value) : undefined }); } catch { /* typing */ } }} /></FieldRow>
        </>
      )}
      {(field.type === 'regex' || field.type === 'ai') && <FieldRow label="Source"><Select value={field.source ?? 'text'} onChange={(e) => set({ source: e.target.value as 'text' | 'html' })}><option value="text">text</option><option value="html">html</option></Select></FieldRow>}
      {(field.type === 'image' || field.type === 'screenshot') && (
        <>
          <FieldRow label="Download dir"><Input full value={field.downloadDir ?? ''} placeholder="downloads/{{run}}" onChange={(e) => set({ downloadDir: e.target.value || undefined })} /></FieldRow>
          <FieldRow label="File name"><Input full value={field.fileName ?? ''} placeholder="url or {{field:sku}}" onChange={(e) => set({ fileName: e.target.value || undefined })} /></FieldRow>
        </>
      )}
      <div className="row wrap gap-12">
        <Check label="multiple (array)" checked={field.multiple} onChange={(v) => set({ multiple: v })} />
        <Check label="required" checked={field.required} onChange={(v) => set({ required: v })} />
        <Check label="following text" checked={!!field.following} onChange={(v) => set({ following: v || undefined })} />
        <span className="row gap-4"><span className="muted small">ancestor</span><Input type="number" min={0} style={{ width: 56 }} value={field.ancestor ?? 0} onChange={(e) => set({ ancestor: Number(e.target.value) || undefined })} /></span>
        <span className="row gap-4"><span className="muted small">scope</span><Select value={field.scope} onChange={(e) => set({ scope: e.target.value as Field['scope'] })}><option value="record">record</option><option value="document">document</option></Select></span>
      </div>
      {needsSelector && <SelectorEditor value={field.selector ?? []} onChange={(selector) => set({ selector: selector.length ? selector : undefined })} scope={field.scope === 'record' ? scope : undefined} />}
      <div><h4>Transforms</h4><TransformEditor value={field.transforms} onChange={(transforms) => set({ transforms })} /></div>
      {children}
    </div>
  );
}

// ---------- list ----------

export function ListEditor({ list, onChange, onClear, onDetect }: { list: ListSpec; onChange: (l: ListSpec) => void; onClear: () => void; onDetect: () => void }) {
  return (
    <div className="col">
      <div className="row"><h3 className="grow">List (repeating records)</h3><Badge>{list.fields.length} fields</Badge></div>
      <SelectorEditor value={list.selector} onChange={(selector) => onChange({ ...list, selector })} label="Record selector" />
      <div className="row wrap gap-12">
        <span className="row gap-4"><span className="muted small">min items</span><Input type="number" style={{ width: 64 }} value={list.minItems} onChange={(e) => onChange({ ...list, minItems: Number(e.target.value) })} /></span>
        <span className="row gap-4"><span className="muted small">limit</span><Input type="number" style={{ width: 64 }} value={list.limit ?? ''} onChange={(e) => onChange({ ...list, limit: e.target.value === '' ? undefined : Number(e.target.value) })} /></span>
      </div>
      <FieldRow label="Filter (JS)" hint="return false to skip a record; `record` in scope"><Input full mono value={list.filter ?? ''} onChange={(e) => onChange({ ...list, filter: e.target.value || undefined })} /></FieldRow>
      <div className="row"><Btn size="sm" onClick={onDetect}>Auto-detect lists</Btn><Btn size="sm" variant="danger" onClick={onClear}>Remove list</Btn></div>
    </div>
  );
}

// ---------- actions ----------

const ACTION_TYPES: Action['type'][] = ['click', 'type', 'select', 'hover', 'scroll', 'wait', 'waitFor', 'waitForNetworkIdle', 'script', 'press', 'frame', 'goBack', 'reload', 'screenshot', 'setCookie', 'solveCaptcha'];

export function blankAction(type: Action['type'], selector?: SelectorCandidate[]): Action {
  const sel = selector ?? [{ kind: 'css', value: '' }];
  switch (type) {
    case 'click': return { type, selector: sel };
    case 'type': return { type, selector: sel, text: '' };
    case 'select': return { type, selector: sel, value: '' };
    case 'hover': return { type, selector: sel };
    case 'scroll': return { type, times: 3, delayMs: 800 };
    case 'wait': return { type, ms: 1000 };
    case 'waitFor': return { type, selector: sel, state: 'visible' };
    case 'waitForNetworkIdle': return { type };
    case 'script': return { type, code: '' };
    case 'press': return { type, key: 'Enter' };
    case 'frame': return { type, selector: sel };
    case 'goBack': return { type };
    case 'reload': return { type };
    case 'screenshot': return { type };
    case 'setCookie': return { type, name: '', value: '' };
    case 'solveCaptcha': return { type, kind: 'auto' };
    case 'repeat': return { type, actions: [], max: 10 };
  }
}

export function describeAction(a: Action): string {
  const sel = 'selector' in a && a.selector ? a.selector[0]?.value ?? '' : '';
  switch (a.type) {
    case 'click': return `click ${sel}`;
    case 'type': return `type "${a.text}" into ${sel}`;
    case 'select': return `select "${a.value}" in ${sel}`;
    case 'wait': return `wait ${a.ms}ms`;
    case 'waitFor': return `waitFor ${sel}`;
    case 'press': return `press ${a.key}`;
    case 'script': return 'script';
    case 'scroll': return `scroll ×${a.times ?? 1}`;
    default: return `${a.type}${sel ? ' ' + sel : ''}`;
  }
}

export function ActionEditor({ action, onChange, onTest, onRemove }: { action: Action; onChange: (a: Action) => void; onTest: () => void; onRemove: () => void }) {
  const set = (patch: Record<string, unknown>) => onChange({ ...action, ...patch } as Action);
  const hasSelector = 'selector' in action;
  return (
    <div className="col">
      <div className="row"><h3 className="grow">Action</h3>
        <Select value={action.type} onChange={(e) => onChange(blankAction(e.target.value as Action['type'], hasSelector ? action.selector : undefined))}>{ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
      </div>
      {action.type === 'type' && <><FieldRow label="Text" hint="{{keyword}} tokens are substituted"><Input full value={action.text} onChange={(e) => set({ text: e.target.value })} /></FieldRow><div className="row gap-12"><Check label="press Enter after" checked={!!action.submit} onChange={(v) => set({ submit: v || undefined })} /><Check label="clear first" checked={action.clear !== false} onChange={(v) => set({ clear: v ? undefined : false })} /></div></>}
      {action.type === 'select' && <FieldRow label="Value / label"><Input full value={action.value} onChange={(e) => set({ value: e.target.value })} /></FieldRow>}
      {action.type === 'click' && <div className="row gap-12"><Check label="optional (skip if missing)" checked={!!action.optional} onChange={(v) => set({ optional: v || undefined })} /><Check label="click all matches" checked={!!action.all} onChange={(v) => set({ all: v || undefined })} /></div>}
      {action.type === 'wait' && <FieldRow label="Milliseconds"><Input type="number" value={action.ms} onChange={(e) => set({ ms: Number(e.target.value) })} /></FieldRow>}
      {action.type === 'waitFor' && <FieldRow label="State"><Select value={action.state ?? 'attached'} onChange={(e) => set({ state: e.target.value })}><option value="attached">attached</option><option value="visible">visible</option><option value="hidden">hidden</option></Select></FieldRow>}
      {action.type === 'scroll' && <div className="row gap-12"><span className="row gap-4"><span className="muted small">times</span><Input type="number" style={{ width: 64 }} value={action.times ?? 1} onChange={(e) => set({ times: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">delay ms</span><Input type="number" style={{ width: 72 }} value={action.delayMs ?? 800} onChange={(e) => set({ delayMs: Number(e.target.value) })} /></span><Check label="until no change" checked={!!action.untilNoChange} onChange={(v) => set({ untilNoChange: v || undefined })} /></div>}
      {action.type === 'script' && <FieldRow label="JS code" stack><Textarea full value={action.code} onChange={(e) => set({ code: e.target.value })} /></FieldRow>}
      {action.type === 'press' && <FieldRow label="Key"><Input value={action.key} onChange={(e) => set({ key: e.target.value })} placeholder="Enter, Escape, ArrowDown…" /></FieldRow>}
      {action.type === 'setCookie' && <><FieldRow label="Name"><Input value={action.name} onChange={(e) => set({ name: e.target.value })} /></FieldRow><FieldRow label="Value"><Input full value={action.value} onChange={(e) => set({ value: e.target.value })} /></FieldRow></>}
      {action.type === 'solveCaptcha' && <FieldRow label="Kind"><Select value={action.kind ?? 'auto'} onChange={(e) => set({ kind: e.target.value })}>{['auto', 'turnstile', 'recaptchaV2', 'recaptchaV3', 'hcaptcha', 'image'].map((k) => <option key={k}>{k}</option>)}</Select></FieldRow>}
      {action.type === 'screenshot' && <div className="row gap-12"><Input full value={action.path ?? ''} placeholder="path (optional)" onChange={(e) => set({ path: e.target.value || undefined })} /><Check label="full page" checked={!!action.fullPage} onChange={(v) => set({ fullPage: v || undefined })} /></div>}
      {hasSelector && (action.type !== 'press' && action.type !== 'scroll' || action.selector) && <SelectorEditor value={action.selector ?? []} onChange={(selector) => set({ selector })} label="Target" />}
      <div className="row"><Btn size="sm" variant="primary" onClick={onTest}>Run this action in browser</Btn><Btn size="sm" variant="danger" onClick={onRemove}>Remove</Btn></div>
    </div>
  );
}

// ---------- pagination ----------

export function PaginationEditor({ pagination, onChange }: { pagination: Pagination | undefined; onChange: (p: Pagination | undefined) => void }) {
  const set = (patch: Record<string, unknown>) => pagination && onChange({ ...pagination, ...patch } as Pagination);
  const kinds: Array<Pagination['type']> = ['next', 'loadMore', 'scroll', 'urlPattern', 'urlList', 'pageLinks', 'script'];
  const switchKind = (k: Pagination['type']) => {
    const sel = pagination && 'selector' in pagination ? pagination.selector : undefined;
    switch (k) {
      case 'next': case 'loadMore': case 'scroll': onChange(paginationFor(k, sel)); break;
      case 'urlPattern': onChange({ type: 'urlPattern', template: 'https://example.com/list?page={{page}}', start: 1, step: 1, maxPages: -1, stopWhenNoNewRows: true }); break;
      case 'urlList': onChange({ type: 'urlList', urls: [] }); break;
      case 'pageLinks': onChange({ type: 'pageLinks', selector: sel ?? [{ kind: 'css', value: '.pagination a' }], maxPages: -1 }); break;
      case 'script': onChange({ type: 'script', code: 'return false', maxPages: -1, delayMs: 1000 }); break;
    }
  };
  return (
    <div className="col">
      <div className="row"><h3 className="grow">Pagination</h3>
        <Select value={pagination?.type ?? ''} onChange={(e) => (e.target.value ? switchKind(e.target.value as Pagination['type']) : onChange(undefined))}>
          <option value="">none</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </Select>
      </div>
      {!pagination && <div className="muted small">No pagination. Pick a "next" link or "load more" button in the browser, or choose a type above.</div>}
      {pagination && 'selector' in pagination && pagination.selector && <SelectorEditor value={pagination.selector} onChange={(selector) => set({ selector })} label={pagination.type === 'scroll' ? 'Scroll container (optional)' : 'Selector'} />}
      {pagination?.type === 'scroll' && !pagination.selector && <div><Btn size="sm" onClick={() => set({ selector: [{ kind: 'css', value: '' }] })}>+ scroll container selector</Btn></div>}
      {pagination?.type === 'next' && <div className="row wrap gap-12"><span className="row gap-4"><span className="muted small">max pages</span><Input type="number" style={{ width: 64 }} value={pagination.maxPages} onChange={(e) => set({ maxPages: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">method</span><Select value={pagination.method} onChange={(e) => set({ method: e.target.value })}><option value="auto">auto</option><option value="href">href (HTTP)</option><option value="click">click (JS)</option></Select></span><Check label="stop when no new rows" checked={pagination.stopWhenNoNewRows} onChange={(v) => set({ stopWhenNoNewRows: v })} /></div>}
      {pagination?.type === 'loadMore' && <div className="row wrap gap-12"><span className="row gap-4"><span className="muted small">max clicks</span><Input type="number" style={{ width: 64 }} value={pagination.maxClicks} onChange={(e) => set({ maxClicks: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">delay ms</span><Input type="number" style={{ width: 72 }} value={pagination.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} /></span><Check label="stop when no new rows" checked={pagination.stopWhenNoNewRows} onChange={(v) => set({ stopWhenNoNewRows: v })} /></div>}
      {pagination?.type === 'scroll' && <div className="row wrap gap-12"><span className="row gap-4"><span className="muted small">max scrolls</span><Input type="number" style={{ width: 64 }} value={pagination.maxScrolls} onChange={(e) => set({ maxScrolls: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">delay ms</span><Input type="number" style={{ width: 72 }} value={pagination.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} /></span><Check label="stop when no new rows" checked={pagination.stopWhenNoNewRows} onChange={(v) => set({ stopWhenNoNewRows: v })} /></div>}
      {pagination?.type === 'urlPattern' && <><FieldRow label="URL template" hint="{{page}} is replaced by the page number"><Input full mono value={pagination.template} onChange={(e) => set({ template: e.target.value })} /></FieldRow><div className="row wrap gap-12"><span className="row gap-4"><span className="muted small">start</span><Input type="number" style={{ width: 56 }} value={pagination.start} onChange={(e) => set({ start: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">step</span><Input type="number" style={{ width: 56 }} value={pagination.step} onChange={(e) => set({ step: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">max pages</span><Input type="number" style={{ width: 64 }} value={pagination.maxPages} onChange={(e) => set({ maxPages: Number(e.target.value) })} /></span></div></>}
      {pagination?.type === 'urlList' && <FieldRow label="URLs" stack><Textarea full value={pagination.urls.join('\n')} onChange={(e) => set({ urls: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} /></FieldRow>}
      {pagination?.type === 'pageLinks' && <FieldRow label="Max pages"><Input type="number" style={{ width: 64 }} value={pagination.maxPages} onChange={(e) => set({ maxPages: Number(e.target.value) })} /></FieldRow>}
      {pagination?.type === 'script' && <><FieldRow label="JS code" stack hint="return true when a next page was loaded"><Textarea full value={pagination.code} onChange={(e) => set({ code: e.target.value })} /></FieldRow><div className="row gap-12"><span className="row gap-4"><span className="muted small">max pages</span><Input type="number" style={{ width: 64 }} value={pagination.maxPages} onChange={(e) => set({ maxPages: Number(e.target.value) })} /></span><span className="row gap-4"><span className="muted small">delay ms</span><Input type="number" style={{ width: 72 }} value={pagination.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} /></span></div></>}
    </div>
  );
}

// ---------- follow ----------

export function FollowEditor({ follow, recipe, fields, onChange, onRemove, onOpenTemplate }: { follow: Follow; recipe: Recipe; fields: Field[]; onChange: (f: Follow) => void; onRemove: () => void; onOpenTemplate: (name: string) => void }) {
  const set = (patch: Partial<Follow>) => onChange({ ...follow, ...patch });
  const linkFields = fields.filter((f) => ['href', 'src', 'attr', 'text'].includes(f.type));
  return (
    <div className="col">
      <h3>Follow link</h3>
      <FieldRow label="Target template">
        <span className="row"><Select value={follow.template} onChange={(e) => set({ template: e.target.value })}>{Object.keys(recipe.templates).map((t) => <option key={t}>{t}</option>)}</Select><Btn size="sm" onClick={() => onOpenTemplate(follow.template)}>Open</Btn></span>
      </FieldRow>
      <FieldRow label="URL from field"><Select value={follow.field ?? ''} onChange={(e) => set({ field: e.target.value || undefined })}><option value="">(use selector)</option>{linkFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}</Select></FieldRow>
      {!follow.field && <SelectorEditor value={follow.selector ?? [{ kind: 'css', value: '' }]} onChange={(selector) => set({ selector })} label="Link selector" />}
      <FieldRow label="Mode"><Select value={follow.mode} onChange={(e) => set({ mode: e.target.value as Follow['mode'] })}><option value="merge">merge (extra columns)</option><option value="nest">nest (object)</option><option value="separate">separate dataset</option></Select></FieldRow>
      <FieldRow label="Method"><Select value={follow.method} onChange={(e) => set({ method: e.target.value as Follow['method'] })}><option value="navigate">navigate (open URL)</option><option value="click">click and go back</option></Select></FieldRow>
      <FieldRow label="Limit per page"><Input type="number" style={{ width: 72 }} value={follow.limit ?? ''} placeholder="all" onChange={(e) => set({ limit: e.target.value === '' ? undefined : Number(e.target.value) })} /></FieldRow>
      <div><Btn size="sm" variant="danger" onClick={onRemove}>Remove follow</Btn></div>
    </div>
  );
}

// ---------- template ----------

export function TemplateEditor({ name, template, recipe, onChange, onRename, onRemove }: { name: string; template: Template; recipe: Recipe; onChange: (t: Template) => void; onRename: (to: string) => void; onRemove: () => void }) {
  const [newName, setNewName] = useState(name);
  const set = (patch: Partial<Template>) => onChange({ ...template, ...patch });
  const isEntry = recipe.entry.template === name;
  return (
    <div className="col">
      <div className="row"><h3 className="grow">Template</h3>{isEntry && <Badge tone="accent">entry</Badge>}</div>
      <FieldRow label="Name"><span className="row"><Input value={newName} onChange={(e) => setNewName(e.target.value)} onBlur={() => { const n = slugName(newName); if (n && n !== name) onRename(n); }} /></span></FieldRow>
      <FieldRow label="Description"><Input full value={template.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} /></FieldRow>
      <FieldRow label="Fetch mode"><Select value={template.mode ?? ''} onChange={(e) => set({ mode: (e.target.value || undefined) as Template['mode'] })}><option value="">auto (engine)</option><option value="http">http</option><option value="browser">browser</option></Select></FieldRow>
      <FieldRow label="Dataset"><Input value={template.dataset ?? ''} placeholder="default" onChange={(e) => set({ dataset: e.target.value || undefined })} /></FieldRow>
      <div>
        <div className="row"><h4 className="grow">Wait for selector (browser)</h4>{!template.waitFor && <Btn size="sm" onClick={() => set({ waitFor: [{ kind: 'css', value: '' }] })}>+ add</Btn>}</div>
        {template.waitFor && <SelectorEditor value={template.waitFor} onChange={(w) => set({ waitFor: w.length ? w : undefined })} label="" />}
        {template.waitFor && <Btn size="sm" variant="ghost" onClick={() => set({ waitFor: undefined })}>clear</Btn>}
      </div>
      {!isEntry && <div><Btn size="sm" variant="danger" onClick={onRemove}>Remove template</Btn></div>}
    </div>
  );
}
