/**
 * Recorder view: drives the headed recorder browser (via main-process IPC), reacts to inspector
 * overlay messages, and edits the working Recipe.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Recipe, PickedElement, DetectedList, InspectorMode, Field, Action, SelectorCandidate } from '@scrappia/core';
import type { RecorderStatus, SuggestFieldsResult } from '@shared/ipc';
import { invoke, useIpcEvent } from '../api';
import { useApp } from '../App';
import { Btn, Input, Badge, Modal, PromptModal, Check, useToast, useAsync } from '../components/ui';
import { recipeReducer, blankRecipe, uniqueTemplateName, paginationFor, makeField, slugName, type FieldTarget } from '../state/recipe';
import { TemplateTree, type Selection } from '../components/recorder/TemplateTree';
import { CapturePanel, DetectedListPicker } from '../components/recorder/CapturePanel';
import { FieldEditor, ListEditor, ActionEditor, PaginationEditor, FollowEditor, TemplateEditor } from '../components/recorder/Editors';
import { DataPreview } from '../components/recorder/DataPreview';
import { RecipeSettings } from '../components/recorder/RecipeSettings';
import { CopilotPanel } from '../components/recorder/CopilotPanel';

const LS_COPILOT_OPEN = 'scrappia.copilot.open';

export function Recorder({ recipeId: initialId, initialRecipe, initialUrl, copilotSessionKey, restoreCopilot }: { recipeId?: string; initialRecipe?: Recipe; initialUrl?: string; copilotSessionKey?: string; restoreCopilot?: boolean }) {
  const { go } = useApp();
  const toast = useToast();
  const { run, busy } = useAsync();
  const [recipe, dispatch] = useReducer(recipeReducer, undefined, () => initialRecipe ?? blankRecipe(initialUrl ? hostName(initialUrl) : 'New recipe', initialUrl ?? ''));
  const [recipeId, setRecipeId] = useState<string | undefined>(initialId);
  const [current, setCurrent] = useState<string>(recipe.entry.template);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [detected, setDetected] = useState<DetectedList[] | null>(null);
  const [status, setStatus] = useState<RecorderStatus>({ open: false, url: '', mode: 'off', overlayReady: false });
  const [urlInput, setUrlInput] = useState(initialUrl ?? recipe.entry.urls[0] ?? '');
  const [drawer, setDrawer] = useState<'settings' | 'json' | null>(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveAs, setSaveAs] = useState(false);
  const [aiSuggest, setAiSuggest] = useState<SuggestFieldsResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(() => { try { return localStorage.getItem(LS_COPILOT_OPEN) !== 'false'; } catch { return true; } });
  const [copilotFocus, setCopilotFocus] = useState(0);
  const [copilotSession] = useState(() => copilotSessionKey ?? `copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const copilotWaiting = useRef(false);
  const recipeRef = useRef(recipe); recipeRef.current = recipe;
  const recipeIdRef = useRef(recipeId); recipeIdRef.current = recipeId;
  const firstRun = useRef(true);
  const template = recipe.templates[current] ?? recipe.templates[recipe.entry.template];
  const templateName = recipe.templates[current] ? current : recipe.entry.template;

  const dispatchDirty = useCallback((a: Parameters<typeof dispatch>[0]) => { dispatch(a); setDirty(true); }, []);

  // ---- recorder browser lifecycle ----
  useEffect(() => {
    void invoke('recorder.status').then(setStatus).catch(() => undefined);
    if (firstRun.current && initialUrl) {
      firstRun.current = false;
      void run(async () => { setStatus(await invoke('recorder.open', initialUrl)); await invoke('recorder.setMode', 'pick'); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useIpcEvent('recorder:status', (s) => { setStatus(s); if (s.url && s.url !== 'about:blank') setUrlInput(s.url); });
  useIpcEvent('inspector:message', (m) => {
    switch (m.type) {
      // while the copilot waits for picks it consumes them (main forwards them); keep the capture panel quiet
      case 'picked': if (copilotWaiting.current) break; setPicked(m.element); setSelection({ kind: 'pick' }); setDetected(null); break;
      case 'list.detected': if (copilotWaiting.current) break; setDetected([m.list]); setPicked(null); setSelection({ kind: 'list', template: templateName }); break;
      case 'error': toast(m.message, 'error'); break;
      case 'navigated': if (m.url && m.url !== 'about:blank') setUrlInput(m.url); break;
      default: break;
    }
  });

  // ---- copilot ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); setCopilotOpen(true); setCopilotFocus((n) => n + 1); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const toggleCopilot = () => setCopilotOpen((v) => { try { localStorage.setItem(LS_COPILOT_OPEN, String(!v)); } catch { /* ignore */ } return !v; });
  const onCopilotRecipe = useCallback((r: Recipe) => {
    dispatch({ type: 'replaceRecipe', recipe: r });
    setDirty(true);
    if (r.id && r.id !== recipeIdRef.current) setRecipeId(r.id);
    setCurrent((c) => (r.templates[c] ? c : r.entry.template));
  }, []);
  const onCopilotRun = useCallback((runId: string) => {
    go({ name: 'run', runId, back: { name: 'recorder', recipeId: recipeIdRef.current, recipe: recipeRef.current, key: 0, copilotSessionKey: copilotSession, restoreCopilot: true } });
  }, [go, copilotSession]);

  const openUrl = (url: string) => run(async () => { setStatus(await invoke('recorder.open', url)); if (status.mode === 'off') await invoke('recorder.setMode', 'pick'); });
  const setMode = (mode: InspectorMode) => run(async () => { if (!status.open) setStatus(await invoke('recorder.open', urlInput)); await invoke('recorder.setMode', mode); });

  const detectLists = () => run(async () => {
    const lists = await invoke('recorder.detectLists');
    if (!lists.length) { toast('No repeating lists detected on this page', 'warn'); return; }
    setDetected(lists); setPicked(null); setSelection({ kind: 'list', template: templateName });
  });

  const aiSuggestFields = () => {
    setAiBusy(true);
    void run(async () => {
      const avail = await invoke('ai.available');
      if (!avail.configured) { toast('No AI provider configured. Add one in Settings > AI providers (Anthropic or any OpenAI-compatible endpoint).', 'warn'); return; }
      const url = await invoke('recorder.currentUrl');
      if (!url) { toast('Open a page in the recorder browser first', 'warn'); return; }
      const listSel = template.list?.selector ?? picked?.record?.selector;
      const html = listSel ? await invoke('recorder.regionHtml', listSel, 60_000) : (await invoke('recorder.pageHtml')).slice(0, 200_000);
      const res = await invoke('ai.suggestFields', { html, url });
      setAiSuggest(res);
    }).finally(() => setAiBusy(false));
  };

  // ---- capture handlers ----
  const capture = (field: Field, target: FieldTarget) => {
    dispatchDirty({ type: 'addField', template: templateName, target, field });
    toast(`Captured "${field.name}"`, 'ok');
    setPicked(null); setSelection(null);
  };
  const setList = (selector: SelectorCandidate[], fields: Field[]) => {
    dispatchDirty({ type: 'setList', template: templateName, selector, fields: fields.length ? [...(template.list?.fields ?? []), ...fields] : undefined });
    setDetected(null); setPicked(null); setSelection({ kind: 'list', template: templateName });
    toast(`List set: ${selector[0]?.value}${fields.length ? ` (+${fields.length} fields)` : ''}`, 'ok');
  };
  const expand = (levels: number) => run(async () => {
    if (!picked) return;
    const sel = picked.selectors[0]?.value;
    if (!sel) return;
    const parent = await invoke('recorder.expand', sel, levels);
    if (parent) setPicked(parent); else toast('Cannot expand further', 'warn');
  });
  const follow = (field: Field) => {
    const name = uniqueTemplateName(recipe, 'detail');
    const target: FieldTarget = field.scope === 'record' && (template.list || picked?.record) ? 'list' : 'page';
    if (target === 'list' && !template.list && picked?.record) dispatchDirty({ type: 'setList', template: templateName, selector: picked.record.selector });
    dispatchDirty({ type: 'addField', template: templateName, target, field });
    dispatchDirty({ type: 'addTemplate', name, template: { description: `Detail pages linked from ${templateName}` } });
    dispatchDirty({ type: 'addFollow', template: templateName, target, follow: { field: field.name, template: name, mode: 'merge', method: 'navigate' } });
    setPicked(null);
    setCurrent(name);
    setSelection({ kind: 'template', template: name });
    toast(`Follow added: ${field.name} → ${name}. Navigate to a detail page and pick its fields.`, 'ok');
    if (picked?.href) void openUrl(picked.href);
  };
  const setPagination = (kind: 'next' | 'loadMore' | 'scroll', selector?: SelectorCandidate[]) => {
    dispatchDirty({ type: 'setPagination', template: templateName, pagination: paginationFor(kind, selector) });
    setPicked(null); setSelection({ kind: 'pagination', template: templateName });
    toast(`Pagination set: ${kind}`, 'ok');
  };
  const addAction = (action: Action) => {
    dispatchDirty({ type: 'addAction', template: templateName, action });
    setSelection({ kind: 'action', template: templateName, index: template.actions.length });
    setPicked(null);
    toast(`Action added: ${action.type}`, 'ok');
  };
  const testAction = (a: Action) => run(async () => { const r = await invoke('recorder.runActions', [a]); if (!r.ok) throw new Error(r.error); toast('Action ran', 'ok'); });

  // ---- save / export ----
  const validateAndSave = (opts: { id?: string; name?: string }) => run(async () => {
    const toSave: Recipe = { ...recipe, name: opts.name ?? recipe.name, id: undefined };
    const v = await invoke('app.validateRecipe', toSave);
    if (!v.success) throw new Error(`Recipe is not valid:\n${v.errors.join('\n')}`);
    const rec = await invoke('recipes.save', toSave, { id: opts.id });
    setRecipeId(rec.id);
    if (opts.name) dispatch({ type: 'patch', patch: { name: opts.name } });
    setDirty(false);
    toast(`Saved "${rec.name}" (v${rec.version})`, 'ok');
    return rec;
  });
  const exportJson = () => run(async () => {
    const path = await invoke('dialogs.save', { defaultPath: `${slugName(recipe.name)}.json`, filters: [{ name: 'Recipe JSON', extensions: ['json'] }] });
    if (!path) return;
    await invoke('files.writeText', path, JSON.stringify({ ...recipe, id: undefined }, null, 2));
    toast(`Exported to ${path}`, 'ok');
  });
  const copyCli = () => {
    const cmd = recipeId ? `scrappia run recipe:${recipeId}` : `scrappia run ./${slugName(recipe.name)}.json`;
    void navigator.clipboard.writeText(cmd).then(() => toast(`Copied: ${cmd}`, 'ok'));
  };
  const startRun = () => run(async () => {
    const rec = recipeId && !dirty ? undefined : await validateAndSave({ id: recipeId });
    const id = rec?.id ?? recipeId;
    if (!id) return;
    const r = await invoke('runs.start', id);
    go({ name: 'run', runId: r.id });
  });

  const modeBtn = (mode: InspectorMode, label: string) => <Btn size="sm" active={status.open && status.mode === mode} onClick={() => void setMode(mode)}>{label}</Btn>;
  const refreshKey = JSON.stringify(template) + status.url;

  return (
    <div className="recorder">
      <div className="recorder-top">
        <div className="row">
          <Btn size="sm" onClick={() => void invoke('recorder.back').then(setStatus)} disabled={!status.open} title="Back">◀</Btn>
          <Btn size="sm" onClick={() => void invoke('recorder.reload').then(setStatus)} disabled={!status.open} title="Reload">↻</Btn>
          <Input className="grow" mono value={urlInput} placeholder="https://…" onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void openUrl(urlInput); }} />
          <Btn size="sm" variant="primary" onClick={() => void openUrl(urlInput)} disabled={!urlInput || busy}>{status.open ? 'Go' : 'Open browser'}</Btn>
          {status.open && <Btn size="sm" onClick={() => void invoke('recorder.close')} title="Close the recorder browser">Close</Btn>}
          <span className="faint tiny">{status.open ? (status.overlayReady ? 'overlay ready' : 'overlay loading…') : 'browser closed'}</span>
        </div>
        <div className="row wrap">
          <span className="muted small">Mode</span>
          <div className="btn-group">{modeBtn('pick', 'Pick field')}{modeBtn('pickList', 'Pick list')}{modeBtn('pickAction', 'Pick action')}{modeBtn('off', 'Off')}</div>
          <Btn size="sm" onClick={detectLists} disabled={!status.open}>Auto-detect lists</Btn>
          <Btn size="sm" onClick={aiSuggestFields} disabled={!status.open || aiBusy}>{aiBusy ? 'Asking AI…' : 'AI suggest'}</Btn>
          <Btn size="sm" active={copilotOpen} onClick={toggleCopilot} title="Show or hide the Copilot chat (Ctrl+/ focuses it)" data-testid="copilot-toggle">Copilot</Btn>
          <div className="grow" />
          <Input value={recipe.name} style={{ width: 180 }} onChange={(e) => dispatchDirty({ type: 'patch', patch: { name: e.target.value } })} title="recipe name" />
          {dirty && <Badge tone="warn">unsaved</Badge>}
          <Btn size="sm" onClick={() => setDrawer('settings')}>Settings</Btn>
          <Btn size="sm" onClick={() => setDrawer('json')}>JSON</Btn>
          <Btn size="sm" onClick={exportJson}>Export JSON</Btn>
          <Btn size="sm" onClick={copyCli} title="Copy a CLI command that runs this recipe">Copy CLI</Btn>
          <Btn size="sm" onClick={() => setSaveAs(true)}>Save as…</Btn>
          <Btn size="sm" variant="primary" onClick={() => void validateAndSave({ id: recipeId })} disabled={busy}>Save</Btn>
          <Btn size="sm" variant="primary" onClick={startRun} disabled={busy || recipe.entry.urls.length === 0} title="Save and start a full run">Run ▶</Btn>
        </div>
      </div>

      <div className="recorder-mid">
        <div className="panel">
          <div className="panel-head"><span className="grow">Template tree</span><span className="faint tiny">{Object.keys(recipe.templates).length} template(s)</span></div>
          <div className="panel-body">
            <TemplateTree recipe={recipe} current={templateName} selection={selection} onSelect={(s) => { setSelection(s); if (s.kind !== 'pick') setPicked(null); }} onSetCurrent={(n) => { setCurrent(n); setDetected(null); }} onAddTemplate={() => { const name = uniqueTemplateName(recipe, 'template'); dispatchDirty({ type: 'addTemplate', name }); setCurrent(name); setSelection({ kind: 'template', template: name }); }} />
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="grow">{picked ? 'Capture' : selection ? selectionTitle(selection) : 'Inspector'}</span>
            <Badge>{templateName}</Badge>
          </div>
          <div className="panel-body">
            {picked && selection?.kind === 'pick' ? (
              <CapturePanel picked={picked} template={template} onCapture={capture} onSetList={setList} onExpand={(l) => void expand(l)} onFollow={follow} onPagination={setPagination} onAddAction={addAction} onDismiss={() => { setPicked(null); setSelection(null); }} />
            ) : selection?.kind === 'field' && fieldAt(recipe, selection) ? (
              <div className="col">
                <div className="row"><h3 className="grow">Field</h3><Badge>{selection.target === 'list' ? 'list field' : 'page field'}</Badge></div>
                <FieldEditor field={fieldAt(recipe, selection)!} scope={recipe.templates[selection.template]?.list?.selector} onChange={(f) => dispatchDirty({ type: 'updateField', template: selection.template, target: selection.target, index: selection.index, patch: f })}>
                  <div className="row">
                    <Btn size="sm" onClick={() => dispatchDirty({ type: 'moveField', template: selection.template, target: selection.target, index: selection.index, to: selection.index - 1 })} disabled={selection.index === 0}>Move up</Btn>
                    <Btn size="sm" onClick={() => dispatchDirty({ type: 'moveField', template: selection.template, target: selection.target, index: selection.index, to: selection.index + 1 })}>Move down</Btn>
                    <Btn size="sm" variant="danger" onClick={() => { dispatchDirty({ type: 'removeField', template: selection.template, target: selection.target, index: selection.index }); setSelection(null); }}>Remove field</Btn>
                  </div>
                </FieldEditor>
              </div>
            ) : selection?.kind === 'list' ? (
              <div className="col">
                {detected && <div className="card"><h4>Detected lists</h4><DetectedListPicker lists={detected} onUse={setList} /></div>}
                {template.list ? (
                  <ListEditor list={template.list} onChange={(l) => dispatchDirty({ type: 'updateTemplate', name: templateName, patch: { list: l } })} onClear={() => { dispatchDirty({ type: 'clearList', template: templateName }); setSelection(null); }} onDetect={detectLists} />
                ) : !detected && <div className="muted small">No list on this template. Switch to <b>Pick list</b> mode and click one of the repeating items in the browser, or use <b>Auto-detect lists</b>.</div>}
              </div>
            ) : selection?.kind === 'action' && recipe.templates[selection.template]?.actions[selection.index] ? (
              <ActionEditor action={recipe.templates[selection.template].actions[selection.index]} onChange={(a) => dispatchDirty({ type: 'updateAction', template: selection.template, index: selection.index, action: a })} onTest={() => void testAction(recipe.templates[selection.template].actions[selection.index])} onRemove={() => { dispatchDirty({ type: 'removeAction', template: selection.template, index: selection.index }); setSelection(null); }} />
            ) : selection?.kind === 'pagination' ? (
              <PaginationEditor pagination={recipe.templates[selection.template]?.pagination} onChange={(p) => dispatchDirty({ type: 'setPagination', template: selection.template, pagination: p })} />
            ) : selection?.kind === 'follow' && followAt(recipe, selection) ? (
              <FollowEditor follow={followAt(recipe, selection)!} recipe={recipe} fields={selection.target === 'list' ? recipe.templates[selection.template].list?.fields ?? [] : recipe.templates[selection.template].fields} onChange={(f) => dispatchDirty({ type: 'updateFollow', template: selection.template, target: selection.target, index: selection.index, patch: f })} onRemove={() => { dispatchDirty({ type: 'removeFollow', template: selection.template, target: selection.target, index: selection.index }); setSelection(null); }} onOpenTemplate={(n) => { setCurrent(n); setSelection({ kind: 'template', template: n }); }} />
            ) : selection?.kind === 'template' && recipe.templates[selection.template] ? (
              <TemplateEditor name={selection.template} template={recipe.templates[selection.template]} recipe={recipe} onChange={(t) => dispatchDirty({ type: 'updateTemplate', name: selection.template, patch: t })} onRename={(to) => { dispatchDirty({ type: 'renameTemplate', from: selection.template, to }); setCurrent(to); setSelection({ kind: 'template', template: to }); }} onRemove={() => { dispatchDirty({ type: 'removeTemplate', name: selection.template }); setCurrent(recipe.entry.template); setSelection(null); }} />
            ) : (
              <div className="col">
                <div className="muted">
                  <p><b>How to record</b></p>
                  <p>1. Open the page in the recorder browser (it opens next to this window). Log in if needed; the session persists.</p>
                  <p>2. In <b>Pick field</b> mode, click any element on the page. It appears here with selector candidates; name it and click <b>Capture as field</b>.</p>
                  <p>3. When the element is inside a repeating list, capture it as a list field (<b>Set as list</b> lets you pick suggested fields at once).</p>
                  <p>4. Click a "next" link or "load more" button to set pagination, or a product link to <b>Follow</b> into a detail template.</p>
                  <p>5. Check the <b>Data preview</b> below, then <b>Save</b> and <b>Run</b>.</p>
                </div>
                {!status.open && <Btn variant="primary" onClick={() => void openUrl(urlInput || recipe.entry.urls[0] || '')} disabled={!(urlInput || recipe.entry.urls[0])}>Open recorder browser</Btn>}
                {status.open && !status.overlayReady && <div className="banner warn small">The inspector overlay is not ready on this page yet. If the page finished loading and this persists, the inspector bundle may not be built (see README).</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      <DataPreview recipe={recipe} templateName={templateName} recorderOpen={status.open} refreshKey={refreshKey} collapsed={previewCollapsed} onToggle={() => setPreviewCollapsed((v) => !v)} />
      {copilotOpen && <CopilotPanel recipe={recipe} sessionKey={copilotSession} restore={restoreCopilot} onRecipe={onCopilotRecipe} onOpenRun={onCopilotRun} onWaiting={(w) => { copilotWaiting.current = w; }} focusSignal={copilotFocus} />}

      {drawer && <RecipeSettings recipe={recipe} dispatch={dispatchDirty} onClose={() => setDrawer(null)} initialTab={drawer === 'json' ? 'json' : 'general'} />}
      {saveAs && <PromptModal title="Save recipe as" label="New recipe name" defaultValue={`${recipe.name} copy`} submitLabel="Save" onClose={() => setSaveAs(false)} onSubmit={(name) => { setRecipeId(undefined); void validateAndSave({ name }); }} />}
      {aiSuggest && (
        <AiSuggestModal result={aiSuggest} hasList={!!template.list} onClose={() => setAiSuggest(null)} onApply={(res, keepList, keepPage, keepPagination) => {
          if (keepList && res.list) {
            const fields = res.list.fields.map((f) => makeField({ name: slugName(f.name), type: f.type, attr: f.attr ?? undefined, selector: [{ kind: 'css', value: f.selector }], scope: 'record' }));
            dispatchDirty({ type: 'setList', template: templateName, selector: [{ kind: 'css', value: res.list.selector }], fields: [...(template.list?.fields ?? []), ...fields] });
          }
          for (const f of keepPage ? res.pageFields : []) dispatchDirty({ type: 'addField', template: templateName, target: 'page', field: makeField({ name: slugName(f.name), type: f.type, attr: f.attr ?? undefined, selector: [{ kind: 'css', value: f.selector }], scope: 'document' }) });
          if (keepPagination && res.pagination) dispatchDirty({ type: 'setPagination', template: templateName, pagination: paginationFor(res.pagination.type, res.pagination.selector ? [{ kind: 'css', value: res.pagination.selector }] : undefined) });
          setAiSuggest(null);
          toast('AI suggestions applied', 'ok');
        }} />
      )}
    </div>
  );
}

function AiSuggestModal({ result, hasList, onClose, onApply }: { result: SuggestFieldsResult; hasList: boolean; onClose: () => void; onApply: (r: SuggestFieldsResult, list: boolean, page: boolean, pagination: boolean) => void }) {
  const [keepList, setKeepList] = useState(!!result.list);
  const [keepPage, setKeepPage] = useState(result.pageFields.length > 0);
  const [keepPagination, setKeepPagination] = useState(!!result.pagination);
  return (
    <Modal title="AI suggestions" onClose={onClose} wide footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={() => onApply(result, keepList, keepPage, keepPagination)}>Apply</Btn></>}>
      {result.notes && <div className="banner info small mb-8">{result.notes}</div>}
      {result.list && (
        <div className="card mb-8">
          <Check label={<span>List: <code>{result.list.selector}</code>{hasList && <span className="warn"> (replaces current list selector, keeps existing fields)</span>}</span>} checked={keepList} onChange={setKeepList} />
          <table className="grid mt-8"><thead><tr><th>Field</th><th>Type</th><th>Selector</th></tr></thead><tbody>{result.list.fields.map((f, i) => <tr key={i}><td>{f.name}</td><td>{f.type}{f.attr ? `[${f.attr}]` : ''}</td><td className="mono">{f.selector}</td></tr>)}</tbody></table>
        </div>
      )}
      {result.pageFields.length > 0 && (
        <div className="card mb-8">
          <Check label={`Page fields (${result.pageFields.length})`} checked={keepPage} onChange={setKeepPage} />
          <table className="grid mt-8"><thead><tr><th>Field</th><th>Type</th><th>Selector</th></tr></thead><tbody>{result.pageFields.map((f, i) => <tr key={i}><td>{f.name}</td><td>{f.type}{f.attr ? `[${f.attr}]` : ''}</td><td className="mono">{f.selector}</td></tr>)}</tbody></table>
        </div>
      )}
      {result.pagination && <div className="card"><Check label={<span>Pagination: {result.pagination.type} {result.pagination.selector && <code>{result.pagination.selector}</code>}</span>} checked={keepPagination} onChange={setKeepPagination} /></div>}
      {!result.list && result.pageFields.length === 0 && !result.pagination && <div className="empty">The model did not find anything to suggest.</div>}
    </Modal>
  );
}

function fieldAt(recipe: Recipe, s: Extract<Selection, { kind: 'field' }>) {
  const t = recipe.templates[s.template];
  return s.target === 'list' ? t?.list?.fields[s.index] : t?.fields[s.index];
}
function followAt(recipe: Recipe, s: Extract<Selection, { kind: 'follow' }>) {
  const t = recipe.templates[s.template];
  return s.target === 'list' ? t?.list?.follow[s.index] : t?.follow[s.index];
}
function selectionTitle(s: Selection): string {
  switch (s.kind) {
    case 'field': return 'Field';
    case 'list': return 'List';
    case 'action': return 'Action';
    case 'pagination': return 'Pagination';
    case 'follow': return 'Follow';
    case 'template': return 'Template';
    default: return 'Capture';
  }
}
function hostName(url: string): string {
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return 'New recipe'; }
}
