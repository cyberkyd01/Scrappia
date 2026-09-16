/**
 * Right-hand panel shown after the user clicks an element in the recorder browser.
 * Builds a Field from the PickedElement + user choices and offers the WebHarvy-style actions
 * (capture, capture more content, set as list, follow link, pagination, add action).
 */
import { useEffect, useState } from 'react';
import type { PickedElement, DetectedList, Field, Action, SelectorCandidate, Template } from '@scrappia/core';
import { Btn, Input, Badge, Check, Select } from '../ui';
import { pickToField, selectorsFor, suggestFieldName, suggestedToFields, defaultTransformsFor } from '../../lib/pickToField';
import { uniqueFieldName, makeField, type FieldTarget } from '../../state/recipe';
import { FieldEditor, ManualListSelector } from './Editors';
import { blankAction } from './Editors';
import { truncate } from '../../lib/format';

export interface CapturePanelProps {
  picked: PickedElement;
  template: Template;
  onCapture: (field: Field, target: FieldTarget) => void;
  onSetList: (selector: SelectorCandidate[], fields: Field[]) => void;
  onExpand: (levels: number) => void;
  onFollow: (field: Field) => void;
  onPagination: (kind: 'next' | 'loadMore' | 'scroll', selector?: SelectorCandidate[]) => void;
  onAddAction: (action: Action) => void;
  onDismiss: () => void;
}

export function CapturePanel({ picked, template, onCapture, onSetList, onExpand, onFollow, onPagination, onAddAction, onDismiss }: CapturePanelProps) {
  const inRecord = !!picked.record && !!picked.relativeSelectors?.length;
  const [scope, setScope] = useState<'record' | 'document'>(inRecord ? 'record' : 'document');
  const [draft, setDraft] = useState<Field>(() => initialDraft(picked, template, inRecord ? 'record' : 'document'));
  const [showList, setShowList] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [selectValue, setSelectValue] = useState('');

  useEffect(() => {
    const s: 'record' | 'document' = picked.record && picked.relativeSelectors?.length ? 'record' : 'document';
    setScope(s);
    setDraft(initialDraft(picked, template, s));
    setShowList(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const changeScope = (s: 'record' | 'document') => { setScope(s); setDraft((d) => ({ ...d, scope: s, selector: selectorsFor(picked, s) })); };
  const target: FieldTarget = scope === 'record' ? 'list' : 'page';
  const listMissing = target === 'list' && !template.list;
  const docSelectors = selectorsFor(picked, 'document');
  const attrsPreview = Object.entries(picked.attrs).filter(([k]) => k !== 'style').slice(0, 6);

  const capture = () => {
    if (listMissing && picked.record) onSetList(picked.record.selector, []);
    onCapture({ ...draft, name: uniqueFieldName(template, draft.name) }, target);
  };

  return (
    <div className="col" data-testid="capture-panel">
      <div className="row">
        <h3 className="grow">Captured element</h3>
        {picked.record && <Badge tone="accent"><span data-testid="capture-record-count">in list of {picked.record.count}</span></Badge>}
        <Btn size="sm" variant="ghost" onClick={onDismiss} data-testid="capture-dismiss">✕</Btn>
      </div>
      <div className="preview-el">
        <div><span className="tag">&lt;{picked.tag}&gt;</span> {truncate(picked.text || '(no text)', 160)}</div>
        {picked.href && <div className="attrs">href: {truncate(picked.href, 100)}</div>}
        {picked.src && <div className="attrs">src: {truncate(picked.src, 100)}</div>}
        {attrsPreview.length > 0 && <div className="attrs">{attrsPreview.map(([k, v]) => `${k}="${truncate(v, 40)}"`).join(' ')}</div>}
      </div>

      {inRecord && (
        <div className="row gap-12">
          <span className="muted small">Selector relative to</span>
          <div className="btn-group">
            <Btn size="sm" active={scope === 'record'} onClick={() => changeScope('record')} data-testid="capture-scope-record">list record</Btn>
            <Btn size="sm" active={scope === 'document'} onClick={() => changeScope('document')} data-testid="capture-scope-document">whole page</Btn>
          </div>
        </div>
      )}

      <FieldEditor field={draft} onChange={setDraft} scope={scope === 'record' ? (template.list?.selector ?? picked.record?.selector) : undefined} />

      <div className="row wrap">
        <Btn variant="primary" onClick={capture} data-testid="capture-field">Capture as field{listMissing ? ' (creates list)' : ''}</Btn>
        <Btn onClick={() => onExpand(1)} title="Select the parent element (capture more content)" data-testid="capture-expand">Capture more content ↑</Btn>
        {picked.href && <Btn onClick={() => onFollow({ ...makeField({ name: uniqueFieldName(template, draft.name === suggestFieldName(picked) ? `${draft.name}_url` : draft.name), type: 'href', selector: draft.selector, scope }) })} data-testid="capture-follow">Follow this link → new template</Btn>}
      </div>

      <div className="card">
        <div className="row"><h4 className="grow">List</h4>{picked.record && <Btn size="sm" onClick={() => setShowList((v) => !v)} data-testid="capture-set-list">{showList ? 'Hide' : 'Set as list…'}</Btn>}</div>
        {!picked.record && <div className="faint small">This element is not inside a detected repeating record. Use <b>Pick list</b> mode, <b>Auto-detect lists</b>, or type the record selector below.</div>}
        {picked.record && showList && <DetectedListPicker lists={[picked.record]} onUse={onSetList} />}
        <div className="mt-8"><ManualListSelector onApply={(selector) => onSetList(selector, [])} label={template.list ? 'Replace list selector manually' : 'Set list selector manually'} /></div>
      </div>

      <div className="card">
        <h4>Pagination</h4>
        <div className="row wrap mt-8">
          <Btn size="sm" onClick={() => onPagination('next', docSelectors)} data-testid="capture-pagination-next">Set as next page</Btn>
          <Btn size="sm" onClick={() => onPagination('loadMore', docSelectors)} data-testid="capture-pagination-loadmore">Set as load more</Btn>
          <Btn size="sm" onClick={() => onPagination('scroll')} data-testid="capture-pagination-scroll">Infinite scroll</Btn>
        </div>
      </div>

      <div className="card">
        <h4>Add action (runs before extraction)</h4>
        <div className="row wrap mt-8">
          <Btn size="sm" onClick={() => onAddAction(blankAction('click', docSelectors))}>Click</Btn>
          <Btn size="sm" onClick={() => onAddAction({ type: 'waitFor', selector: docSelectors, state: 'visible' })}>Wait for</Btn>
          <Btn size="sm" onClick={() => onAddAction(blankAction('hover', docSelectors))}>Hover</Btn>
        </div>
        <div className="row mt-8">
          <Input className="grow" placeholder="text to type ({{keyword}} ok)" value={typeText} onChange={(e) => setTypeText(e.target.value)} />
          <Btn size="sm" disabled={!typeText} onClick={() => { onAddAction({ type: 'type', selector: docSelectors, text: typeText, submit: false }); setTypeText(''); }}>Type</Btn>
        </div>
        <div className="row mt-8">
          <Input className="grow" placeholder="option value or label" value={selectValue} onChange={(e) => setSelectValue(e.target.value)} />
          <Btn size="sm" disabled={!selectValue} onClick={() => { onAddAction({ type: 'select', selector: docSelectors, value: selectValue }); setSelectValue(''); }}>Select</Btn>
          <Btn size="sm" onClick={() => onAddAction({ type: 'wait', ms: 1000 })}>Wait 1s</Btn>
        </div>
      </div>
    </div>
  );
}

function initialDraft(picked: PickedElement, template: Template, scope: 'record' | 'document'): Field {
  const type = picked.suggestedType ?? 'text';
  return pickToField(picked, { name: uniqueFieldName(template, suggestFieldName(picked)), type, scope, transforms: defaultTransformsFor(type, picked.text) });
}

/** Choose among detected lists (and their alternatives) with suggested-field checkboxes. */
export function DetectedListPicker({ lists, onUse }: { lists: DetectedList[]; onUse: (selector: SelectorCandidate[], fields: Field[]) => void }) {
  const [idx, setIdx] = useState(0);
  const [alt, setAlt] = useState<number>(-1);
  const list = lists[idx];
  const [keep, setKeep] = useState<Set<string>>(() => new Set(list?.fields.filter((f) => f.coverage >= 0.5).map((f) => f.name)));
  useEffect(() => { setKeep(new Set(lists[idx]?.fields.filter((f) => f.coverage >= 0.5).map((f) => f.name))); setAlt(-1); }, [idx, lists]);
  if (!list) return <div className="faint small">No lists detected on this page.</div>;
  const chosenSelector = alt >= 0 && list.alternatives?.[alt] ? list.alternatives[alt].selector : list.selector;
  const chosenCount = alt >= 0 && list.alternatives?.[alt] ? list.alternatives[alt].count : list.count;
  return (
    <div className="col mt-8">
      {lists.length > 1 && (
        <div className="row"><span className="muted small">Detected list</span>
          <Select value={idx} onChange={(e) => setIdx(Number(e.target.value))}>{lists.map((l, i) => <option key={i} value={i}>{l.selector[0]?.value} ({l.count})</option>)}</Select>
        </div>
      )}
      <div className="row"><span className="mono small ellipsis grow" title={chosenSelector[0]?.value} data-testid="list-picker-selector">{chosenSelector[0]?.value}</span><Badge><span data-testid="list-picker-count">{chosenCount} records</span></Badge></div>
      {list.alternatives && list.alternatives.length > 0 && (
        <div className="row"><span className="muted small">Try another list</span>
          <Select value={alt} onChange={(e) => setAlt(Number(e.target.value))}>
            <option value={-1}>detected ({list.count})</option>
            {list.alternatives.map((a, i) => <option key={i} value={i}>{truncate(a.selector[0]?.value ?? '', 40)} ({a.count}) — {truncate(a.sample, 30)}</option>)}
          </Select>
        </div>
      )}
      {alt < 0 && list.fields.length > 0 && (
        <div className="suggested">
          {list.fields.map((f) => (
            <FragmentRow key={f.name}>
              <Check label="" checked={keep.has(f.name)} onChange={(v) => setKeep((k) => { const n = new Set(k); if (v) n.add(f.name); else n.delete(f.name); return n; })} testId={`list-picker-field-${f.name}`} />
              <span className="ellipsis" title={f.selector[0]?.value}>{f.name}</span>
              <span className="faint">{f.type}{f.attr ? `[${f.attr}]` : ''}</span>
              <span className="samples" title={f.samples.join(' | ')}>{f.samples.slice(0, 2).join(' | ')} <span className="faint">({Math.round(f.coverage * 100)}%)</span></span>
            </FragmentRow>
          ))}
        </div>
      )}
      <div className="row"><Btn size="sm" variant="primary" onClick={() => onUse(chosenSelector, alt < 0 ? suggestedToFields(list, keep) : [])} data-testid="list-picker-use">Use this list{alt < 0 && keep.size ? ` with ${keep.size} field(s)` : ''}</Btn></div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }
