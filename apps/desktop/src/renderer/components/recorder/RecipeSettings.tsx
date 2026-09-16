/**
 * Recipe settings drawer: entry/keywords, engine, output, sinks, monitor, schedule, AI and raw JSON.
 */
import { useEffect, useState, type Dispatch } from 'react';
import type { Recipe, AlertChannel, ValidationRule, EngineConfig } from '@scrappia/core';
import { invoke } from '../../api';
import { Btn, Input, Select, Textarea, Check, FieldRow, Tabs, Badge, useToast } from '../ui';
import type { RecipeAction } from '../../state/recipe';
import { SinksEditor } from './SinksEditor';
import { fmtTime } from '../../lib/format';

type Tab = 'general' | 'engine' | 'output' | 'sinks' | 'monitor' | 'schedule' | 'ai' | 'json';

export function RecipeSettings({ recipe, dispatch, onClose, initialTab = 'general' }: { recipe: Recipe; dispatch: Dispatch<RecipeAction>; onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [secrets, setSecrets] = useState<string[]>([]);
  useEffect(() => { void invoke('secrets.list').then(setSecrets).catch(() => undefined); }, []);
  return (
    <div className="drawer" data-testid="recipe-settings">
      <div className="drawer-head"><span className="grow">Recipe settings</span><Btn size="sm" variant="ghost" onClick={onClose} data-testid="drawer-close">✕</Btn></div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'general', label: 'General' }, { id: 'engine', label: 'Engine' }, { id: 'output', label: 'Output' }, { id: 'sinks', label: `Outputs (${recipe.sinks.length})` }, { id: 'monitor', label: 'Monitor' }, { id: 'schedule', label: 'Schedule' }, { id: 'ai', label: 'AI' }, { id: 'json', label: 'JSON' }]} />
      <div className="drawer-body">
        {tab === 'general' && <GeneralTab recipe={recipe} dispatch={dispatch} />}
        {tab === 'engine' && <EngineTab recipe={recipe} dispatch={dispatch} secrets={secrets} />}
        {tab === 'output' && <OutputTab recipe={recipe} dispatch={dispatch} />}
        {tab === 'sinks' && <SinksEditor sinks={recipe.sinks} onChange={(sinks) => dispatch({ type: 'patch', patch: { sinks } })} recipeName={recipe.name} secrets={secrets} />}
        {tab === 'monitor' && <MonitorTab recipe={recipe} dispatch={dispatch} secrets={secrets} />}
        {tab === 'schedule' && <ScheduleTab recipe={recipe} dispatch={dispatch} />}
        {tab === 'ai' && <AiTab recipe={recipe} dispatch={dispatch} />}
        {tab === 'json' && <JsonTab recipe={recipe} dispatch={dispatch} />}
      </div>
    </div>
  );
}

function GeneralTab({ recipe, dispatch }: { recipe: Recipe; dispatch: Dispatch<RecipeAction> }) {
  const kw = Object.entries(recipe.keywords);
  const setKw = (entries: Array<[string, string[]]>) => dispatch({ type: 'setKeywords', keywords: Object.fromEntries(entries) });
  return (
    <div className="col">
      <FieldRow label="Name"><Input full value={recipe.name} onChange={(e) => dispatch({ type: 'patch', patch: { name: e.target.value } })} /></FieldRow>
      <FieldRow label="Description"><Input full value={recipe.description ?? ''} onChange={(e) => dispatch({ type: 'patch', patch: { description: e.target.value || undefined } })} /></FieldRow>
      <FieldRow label="Tags" hint="comma separated"><Input full value={recipe.tags.join(', ')} onChange={(e) => dispatch({ type: 'patch', patch: { tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} /></FieldRow>
      <FieldRow label="Entry URLs" stack hint="one per line; {{keyword}} tokens are expanded from the keyword lists below">
        <Textarea full rows={4} value={recipe.entry.urls.join('\n')} onChange={(e) => dispatch({ type: 'setEntry', patch: { urls: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) } })} data-testid="general-entry-urls" />
      </FieldRow>
      <div className="row gap-12">
        <FieldRow label="Entry template"><Select value={recipe.entry.template} onChange={(e) => dispatch({ type: 'setEntry', patch: { template: e.target.value } })}>{Object.keys(recipe.templates).map((t) => <option key={t}>{t}</option>)}</Select></FieldRow>
        <FieldRow label="Method"><Select value={recipe.entry.method} onChange={(e) => dispatch({ type: 'setEntry', patch: { method: e.target.value as 'GET' | 'POST' } })}><option>GET</option><option>POST</option></Select></FieldRow>
      </div>
      {recipe.entry.method === 'POST' && <FieldRow label="POST body" stack><Textarea full value={recipe.entry.body ?? ''} onChange={(e) => dispatch({ type: 'setEntry', patch: { body: e.target.value || undefined } })} /></FieldRow>}
      <div className="row"><h4 className="grow">Keywords</h4><Select value={recipe.keywordMode} onChange={(e) => dispatch({ type: 'setKeywords', keywords: recipe.keywords, mode: e.target.value as Recipe['keywordMode'] })}><option value="product">cartesian product</option><option value="zip">zip (row-wise)</option></Select><Btn size="sm" onClick={() => setKw([...kw, [`kw${kw.length + 1}`, []]])} data-testid="keywords-add">+ list</Btn></div>
      {kw.map(([name, values], i) => (
        <div className="row" key={i} style={{ alignItems: 'flex-start' }}>
          <Input value={name} style={{ width: 120 }} onChange={(e) => { const n = kw.slice(); n[i] = [e.target.value, values]; setKw(n); }} data-testid={`keyword-name-${i}`} />
          <Textarea className="grow" rows={3} value={values.join('\n')} placeholder="one value per line" onChange={(e) => { const n = kw.slice(); n[i] = [name, e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)]; setKw(n); }} data-testid={`keyword-values-${i}`} />
          <Btn size="sm" variant="ghost" onClick={() => setKw(kw.filter((_, j) => j !== i))} data-testid={`keyword-remove-${i}`}>✕</Btn>
        </div>
      ))}
    </div>
  );
}

function EngineTab({ recipe, dispatch, secrets }: { recipe: Recipe; dispatch: Dispatch<RecipeAction>; secrets: string[] }) {
  const e = recipe.engine;
  const set = (patch: Partial<EngineConfig>) => dispatch({ type: 'setEngine', patch });
  const resources: EngineConfig['blockResources'] = ['image', 'font', 'media', 'stylesheet', 'script', 'xhr', 'fetch', 'websocket', 'other'];
  return (
    <div className="col">
      <div className="row wrap gap-12">
        <FieldRow label="Mode"><Select value={e.mode} onChange={(ev) => set({ mode: ev.target.value as EngineConfig['mode'] })} data-testid="engine-mode"><option value="auto">auto (HTTP, browser fallback)</option><option value="http">http only</option><option value="browser">browser only</option></Select></FieldRow>
        <FieldRow label="Browser"><Select value={e.browser} onChange={(ev) => set({ browser: ev.target.value as EngineConfig['browser'] })}><option value="patchright">patchright (stealth)</option><option value="playwright">playwright</option></Select></FieldRow>
      </div>
      <div className="row wrap gap-12">
        <Check label="headless" checked={e.headless} onChange={(v) => set({ headless: v })} />
        <Check label="stealth" checked={e.stealth} onChange={(v) => set({ stealth: v })} />
        <Check label="fingerprint injection" checked={e.fingerprint} onChange={(v) => set({ fingerprint: v })} />
        <Check label="respect robots.txt" checked={e.respectRobots} onChange={(v) => set({ respectRobots: v })} />
      </div>
      <div className="row wrap gap-12">
        <span className="row gap-4"><span className="muted small">concurrency</span><Input type="number" min={1} max={64} style={{ width: 60 }} value={e.concurrency} onChange={(ev) => set({ concurrency: Number(ev.target.value) })} data-testid="engine-concurrency" /></span>
        <span className="row gap-4"><span className="muted small">per host</span><Input type="number" min={1} style={{ width: 60 }} value={e.perHostConcurrency} onChange={(ev) => set({ perHostConcurrency: Number(ev.target.value) })} /></span>
        <span className="row gap-4"><span className="muted small">delay ms</span><Input type="number" min={0} style={{ width: 72 }} value={e.delayMs} onChange={(ev) => set({ delayMs: Number(ev.target.value) })} data-testid="engine-delay" /></span>
        <span className="row gap-4"><span className="muted small">jitter ms</span><Input type="number" min={0} style={{ width: 72 }} value={e.jitterMs} onChange={(ev) => set({ jitterMs: Number(ev.target.value) })} /></span>
        <span className="row gap-4"><span className="muted small">timeout ms</span><Input type="number" min={1000} style={{ width: 80 }} value={e.timeoutMs} onChange={(ev) => set({ timeoutMs: Number(ev.target.value) })} /></span>
        <span className="row gap-4"><span className="muted small">retries</span><Input type="number" min={0} style={{ width: 56 }} value={e.retries} onChange={(ev) => set({ retries: Number(ev.target.value) })} /></span>
      </div>
      <div className="row wrap gap-12">
        <span className="row gap-4"><span className="muted small">max requests</span><Input type="number" style={{ width: 80 }} value={e.maxRequests ?? ''} placeholder="∞" onChange={(ev) => set({ maxRequests: ev.target.value === '' ? undefined : Number(ev.target.value) })} /></span>
        <span className="row gap-4"><span className="muted small">max rows</span><Input type="number" style={{ width: 80 }} value={e.maxRows ?? ''} placeholder="∞" onChange={(ev) => set({ maxRows: ev.target.value === '' ? undefined : Number(ev.target.value) })} /></span>
        <span className="row gap-4"><span className="muted small">wait until</span><Select value={e.navigationWaitUntil} onChange={(ev) => set({ navigationWaitUntil: ev.target.value as EngineConfig['navigationWaitUntil'] })}><option>domcontentloaded</option><option>load</option><option>networkidle</option><option>commit</option></Select></span>
      </div>
      <FieldRow label="User agent"><Input full value={e.userAgent ?? ''} placeholder="default" onChange={(ev) => set({ userAgent: ev.target.value || undefined })} /></FieldRow>
      <div className="row gap-12"><FieldRow label="Locale"><Input value={e.locale ?? ''} placeholder="en-US" onChange={(ev) => set({ locale: ev.target.value || undefined })} /></FieldRow><FieldRow label="Timezone"><Input value={e.timezone ?? ''} placeholder="system" onChange={(ev) => set({ timezone: ev.target.value || undefined })} /></FieldRow></div>
      <FieldRow label="Block resources" stack><div className="row wrap gap-12">{resources.map((r) => <Check key={r} label={r} checked={e.blockResources.includes(r)} onChange={(v) => set({ blockResources: v ? [...e.blockResources, r] : e.blockResources.filter((x) => x !== r) })} />)}</div></FieldRow>
      <FieldRow label="Block URL patterns" stack hint="regex, one per line"><Textarea full rows={2} value={e.blockUrlPatterns.join('\n')} onChange={(ev) => set({ blockUrlPatterns: ev.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} /></FieldRow>
      <FieldRow label="Extra headers" stack hint="Name: value, one per line"><Textarea full rows={2} value={Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`).join('\n')} onChange={(ev) => { const h: Record<string, string> = {}; for (const l of ev.target.value.split('\n')) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } set({ headers: h }); }} /></FieldRow>
      <h4>Proxies</h4>
      <FieldRow label="Proxy URLs" stack hint="http://user:pass@host:port, one per line"><Textarea full rows={3} value={e.proxy.urls.join('\n')} onChange={(ev) => set({ proxy: { ...e.proxy, urls: ev.target.value.split('\n').map((s) => s.trim()).filter(Boolean) } })} /></FieldRow>
      <div className="row wrap gap-12">
        <span className="row gap-4"><span className="muted small">rotate</span><Select value={e.proxy.rotate} onChange={(ev) => set({ proxy: { ...e.proxy, rotate: ev.target.value as EngineConfig['proxy']['rotate'] } })}><option value="session">per session</option><option value="request">per request</option><option value="none">none</option></Select></span>
        <span className="row gap-4"><span className="muted small">max errors</span><Input type="number" style={{ width: 56 }} value={e.proxy.maxErrors} onChange={(ev) => set({ proxy: { ...e.proxy, maxErrors: Number(ev.target.value) } })} /></span>
        <span className="row gap-4"><span className="muted small">pool</span><Input value={e.proxy.pool ?? ''} placeholder="settings pool name" onChange={(ev) => set({ proxy: { ...e.proxy, pool: ev.target.value || undefined } })} /></span>
      </div>
      <h4>Captcha</h4>
      <div className="row wrap gap-12">
        <span className="row gap-4"><span className="muted small">provider</span><Select value={e.captcha.provider} onChange={(ev) => set({ captcha: { ...e.captcha, provider: ev.target.value as EngineConfig['captcha']['provider'] } })}><option value="none">none</option><option value="manual">manual (solve in window)</option><option value="2captcha">2captcha</option><option value="capsolver">capsolver</option><option value="anticaptcha">anticaptcha</option></Select></span>
        <span className="row gap-4"><span className="muted small">API key secret</span><Input list="secret-names-engine" value={e.captcha.apiKeyRef ?? ''} onChange={(ev) => set({ captcha: { ...e.captcha, apiKeyRef: ev.target.value || undefined } })} /><datalist id="secret-names-engine">{secrets.map((s) => <option key={s} value={s} />)}</datalist></span>
        <Check label="auto-detect" checked={e.captcha.autoDetect} onChange={(v) => set({ captcha: { ...e.captcha, autoDetect: v } })} />
      </div>
      <h4>Session</h4>
      <div className="row wrap gap-12">
        <Check label="persist cookies/storage (login sessions)" checked={e.session.persist} onChange={(v) => set({ session: { ...e.session, persist: v } })} />
        <span className="row gap-4"><span className="muted small">profile</span><Input value={e.session.profile} onChange={(ev) => set({ session: { ...e.session, profile: ev.target.value } })} /></span>
        <span className="row gap-4"><span className="muted small">clear cookies every N req.</span><Input type="number" style={{ width: 64 }} value={e.session.clearEvery ?? ''} onChange={(ev) => set({ session: { ...e.session, clearEvery: ev.target.value === '' ? undefined : Number(ev.target.value) } })} /></span>
      </div>
      <div className="faint tiny">Tip: the recorder browser uses the persistent profile "recorder"; set profile to <code>recorder</code> with persist enabled to reuse logins you performed while recording.</div>
    </div>
  );
}

function OutputTab({ recipe, dispatch }: { recipe: Recipe; dispatch: Dispatch<RecipeAction> }) {
  const o = recipe.output;
  const set = (patch: Partial<Recipe['output']>) => dispatch({ type: 'setOutput', patch });
  const allFields = Object.values(recipe.templates).flatMap((t) => [...t.fields, ...(t.list?.fields ?? [])].map((f) => f.name));
  const rules: ValidationRule['rule'][] = ['required', 'regex', 'min', 'max', 'minLength', 'maxLength', 'url', 'email', 'number', 'enum', 'js'];
  return (
    <div className="col">
      <FieldRow label="Row keys" hint="fields that identify a row (dedupe, upsert, change monitoring); blank = hash of all fields"><Input full value={o.keys.join(', ')} list="all-fields" onChange={(e) => set({ keys: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /><datalist id="all-fields">{allFields.map((f) => <option key={f} value={f} />)}</datalist></FieldRow>
      <div className="row wrap gap-12">
        <Check label="dedupe rows" checked={o.dedupe} onChange={(v) => set({ dedupe: v })} />
        <Check label="flatten nested objects" checked={o.flatten} onChange={(v) => set({ flatten: v })} />
        <Check label="blank row when page is empty" checked={o.blankRowWhenEmpty} onChange={(v) => set({ blankRowWhenEmpty: v })} />
      </div>
      <h4>Provenance columns</h4>
      <div className="row wrap gap-12">
        <Check label="page URL" checked={o.addPageUrl} onChange={(v) => set({ addPageUrl: v })} />
        <Check label="timestamp" checked={o.addTimestamp} onChange={(v) => set({ addTimestamp: v })} />
        <Check label="keyword" checked={o.addKeyword} onChange={(v) => set({ addKeyword: v })} testId="output-add-keyword" />
        <Check label="category path" checked={o.addCategoryPath} onChange={(v) => set({ addCategoryPath: v })} />
      </div>
      <FieldRow label="Column order" hint="comma separated; others follow"><Input full value={(o.columns ?? []).join(', ')} onChange={(e) => set({ columns: e.target.value ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined })} /></FieldRow>
      <div className="row"><h4 className="grow">Validation rules</h4><Btn size="sm" onClick={() => set({ validation: [...o.validation, { field: allFields[0] ?? '', rule: 'required', action: 'flag' }] })}>+ rule</Btn></div>
      {o.validation.map((r, i) => (
        <div className="row" key={i}>
          <Input list="all-fields" value={r.field} style={{ width: 120 }} onChange={(e) => set({ validation: o.validation.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} />
          <Select value={r.rule} onChange={(e) => set({ validation: o.validation.map((x, j) => (j === i ? { ...x, rule: e.target.value as ValidationRule['rule'] } : x)) })}>{rules.map((k) => <option key={k}>{k}</option>)}</Select>
          <Input className="grow" placeholder="value (regex, number, enum a|b, js)" value={r.value === undefined ? '' : String(r.value)} onChange={(e) => set({ validation: o.validation.map((x, j) => (j === i ? { ...x, value: e.target.value || undefined } : x)) })} />
          <Select value={r.action} onChange={(e) => set({ validation: o.validation.map((x, j) => (j === i ? { ...x, action: e.target.value as ValidationRule['action'] } : x)) })}><option value="flag">flag</option><option value="drop">drop</option><option value="fail">fail run</option></Select>
          <Btn size="sm" variant="ghost" onClick={() => set({ validation: o.validation.filter((_, j) => j !== i) })}>✕</Btn>
        </div>
      ))}
    </div>
  );
}

function MonitorTab({ recipe, dispatch, secrets }: { recipe: Recipe; dispatch: Dispatch<RecipeAction>; secrets: string[] }) {
  const m = recipe.monitor;
  const set = (patch: Partial<Recipe['monitor']>) => dispatch({ type: 'setMonitor', patch });
  const events: Recipe['monitor']['on'] = ['added', 'removed', 'changed', 'drift', 'failure', 'empty'];
  const [addType, setAddType] = useState<AlertChannel['type']>('desktop');
  const blank = (t: AlertChannel['type']): AlertChannel => {
    switch (t) {
      case 'webhook': return { type: t, url: '' };
      case 'email': return { type: t, to: [], smtpRef: 'SMTP_URL' };
      case 'slack': return { type: t, webhookUrlRef: 'SLACK_WEBHOOK' };
      case 'discord': return { type: t, webhookUrlRef: 'DISCORD_WEBHOOK' };
      case 'telegram': return { type: t, botTokenRef: 'TELEGRAM_BOT_TOKEN', chatId: '' };
      case 'ntfy': return { type: t, topic: 'scrappia' };
      default: return { type: 'desktop' };
    }
  };
  const upd = (i: number, c: AlertChannel) => set({ channels: m.channels.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="col">
      <Check label="enable change monitoring (compare each run with the previous one)" checked={m.enabled} onChange={(v) => set({ enabled: v })} testId="monitor-enabled" />
      <FieldRow label="Watch fields" hint="comma separated; blank = all"><Input full value={m.fields.join(', ')} onChange={(e) => set({ fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></FieldRow>
      <FieldRow label="Threshold %" hint="only alert when a numeric field changes by more than this"><Input type="number" style={{ width: 80 }} value={m.thresholdPercent ?? ''} onChange={(e) => set({ thresholdPercent: e.target.value === '' ? undefined : Number(e.target.value) })} /></FieldRow>
      <FieldRow label="Alert on" stack><div className="row wrap gap-12">{events.map((ev) => <Check key={ev} label={ev} checked={m.on.includes(ev)} onChange={(v) => set({ on: v ? [...m.on, ev] : m.on.filter((x) => x !== ev) })} />)}</div></FieldRow>
      <div className="row"><h4 className="grow">Channels</h4><Select value={addType} onChange={(e) => setAddType(e.target.value as AlertChannel['type'])} data-testid="monitor-channel-type">{['desktop', 'webhook', 'slack', 'discord', 'telegram', 'ntfy', 'email'].map((t) => <option key={t}>{t}</option>)}</Select><Btn size="sm" onClick={() => set({ channels: [...m.channels, blank(addType)] })} data-testid="monitor-add-channel">+ add</Btn></div>
      <datalist id="secret-names-monitor">{secrets.map((s) => <option key={s} value={s} />)}</datalist>
      {m.channels.map((c, i) => (
        <div className="card row wrap" key={i}>
          <Badge tone="accent">{c.type}</Badge>
          {c.type === 'webhook' && <><Input className="grow" placeholder="https://…" value={c.url} onChange={(e) => upd(i, { ...c, url: e.target.value })} /><Input list="secret-names-monitor" placeholder="secret ref" value={c.secretRef ?? ''} onChange={(e) => upd(i, { ...c, secretRef: e.target.value || undefined })} /></>}
          {(c.type === 'slack' || c.type === 'discord') && <Input className="grow" list="secret-names-monitor" placeholder="webhook URL secret" value={c.webhookUrlRef} onChange={(e) => upd(i, { ...c, webhookUrlRef: e.target.value })} />}
          {c.type === 'telegram' && <><Input list="secret-names-monitor" placeholder="bot token secret" value={c.botTokenRef} onChange={(e) => upd(i, { ...c, botTokenRef: e.target.value })} /><Input placeholder="chat id" value={c.chatId} onChange={(e) => upd(i, { ...c, chatId: e.target.value })} /></>}
          {c.type === 'ntfy' && <><Input placeholder="topic" value={c.topic} onChange={(e) => upd(i, { ...c, topic: e.target.value })} /><Input placeholder="server (optional)" value={c.server ?? ''} onChange={(e) => upd(i, { ...c, server: e.target.value || undefined })} /></>}
          {c.type === 'email' && <><Input className="grow" placeholder="to (comma separated)" value={c.to.join(', ')} onChange={(e) => upd(i, { ...c, to: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /><Input list="secret-names-monitor" placeholder="SMTP URL secret" value={c.smtpRef} onChange={(e) => upd(i, { ...c, smtpRef: e.target.value })} /></>}
          <Btn size="sm" variant="ghost" onClick={() => set({ channels: m.channels.filter((_, j) => j !== i) })}>✕</Btn>
        </div>
      ))}
    </div>
  );
}

function ScheduleTab({ recipe, dispatch }: { recipe: Recipe; dispatch: Dispatch<RecipeAction> }) {
  const s = recipe.schedule;
  const [preview, setPreview] = useState<{ ok: true; next: number[] } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    if (!s?.cron) { setPreview(null); return; }
    const t = setTimeout(() => void invoke('schedules.preview', s.cron, s.tz).then(setPreview).catch((e: Error) => setPreview({ ok: false, error: e.message })), 300);
    return () => clearTimeout(t);
  }, [s?.cron, s?.tz]);
  const presets: Array<[string, string]> = [['every hour', '0 * * * *'], ['daily 06:00', '0 6 * * *'], ['weekdays 09:00', '0 9 * * 1-5'], ['every 15 min', '*/15 * * * *'], ['weekly Monday', '0 8 * * 1']];
  return (
    <div className="col">
      <Check label="schedule this recipe" checked={!!s} onChange={(v) => dispatch({ type: 'setSchedule', schedule: v ? { enabled: true, cron: '0 6 * * *', skipIfRunning: true } : undefined })} />
      {s && (
        <>
          <div className="row wrap gap-12">
            <Check label="enabled" checked={s.enabled} onChange={(v) => dispatch({ type: 'setSchedule', schedule: { ...s, enabled: v } })} />
            <Check label="skip if previous run still running" checked={s.skipIfRunning} onChange={(v) => dispatch({ type: 'setSchedule', schedule: { ...s, skipIfRunning: v } })} />
          </div>
          <FieldRow label="Cron"><Input mono value={s.cron} onChange={(e) => dispatch({ type: 'setSchedule', schedule: { ...s, cron: e.target.value } })} /></FieldRow>
          <FieldRow label="Timezone"><Input value={s.tz ?? ''} placeholder="system (e.g. Europe/Berlin)" onChange={(e) => dispatch({ type: 'setSchedule', schedule: { ...s, tz: e.target.value || undefined } })} /></FieldRow>
          <div className="row wrap">{presets.map(([l, c]) => <Btn key={c} size="sm" onClick={() => dispatch({ type: 'setSchedule', schedule: { ...s, cron: c } })}>{l}</Btn>)}</div>
          {preview && (preview.ok ? <div className="card"><h4>Next runs</h4>{preview.next.map((n) => <div key={n} className="small">{fmtTime(n)}</div>)}</div> : <div className="errors">{preview.error}</div>)}
          <div className="faint tiny">The schedule is registered when you save the recipe; the desktop app must be running for scheduled runs.</div>
        </>
      )}
    </div>
  );
}

function AiTab({ recipe, dispatch }: { recipe: Recipe; dispatch: Dispatch<RecipeAction> }) {
  const [providers, setProviders] = useState<string[]>([]);
  useEffect(() => { void invoke('ai.available').then((a) => setProviders(a.providers)).catch(() => undefined); }, []);
  return (
    <div className="col">
      <FieldRow label="Provider"><Select value={recipe.ai.provider ?? ''} onChange={(e) => dispatch({ type: 'setAi', patch: { provider: e.target.value || undefined } })}><option value="">default</option>{providers.map((p) => <option key={p}>{p}</option>)}</Select></FieldRow>
      <FieldRow label="Model override"><Input value={recipe.ai.model ?? ''} placeholder="provider default" onChange={(e) => dispatch({ type: 'setAi', patch: { model: e.target.value || undefined } })} /></FieldRow>
      <Check label="self-heal broken selectors with AI during runs" checked={recipe.ai.selfHeal} onChange={(v) => dispatch({ type: 'setAi', patch: { selfHeal: v } })} />
      {providers.length === 0 && <div className="faint tiny">No AI providers configured. Add one in Settings to enable AI fields, AI transforms, self-healing and suggestions.</div>}
    </div>
  );
}

function JsonTab({ recipe, dispatch }: { recipe: Recipe; dispatch: Dispatch<RecipeAction> }) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify(recipe, null, 2));
  const [errors, setErrors] = useState<string[] | null>(null);
  useEffect(() => { setText(JSON.stringify(recipe, null, 2)); setErrors(null); }, [recipe]);
  const validate = async (apply: boolean) => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { setErrors([`JSON syntax: ${(e as Error).message}`]); return; }
    const v = await invoke('app.validateRecipe', parsed);
    if (!v.success) { setErrors(v.errors); return; }
    setErrors([]);
    if (apply) { dispatch({ type: 'set', recipe: v.recipe }); toast('Recipe JSON applied', 'ok'); }
  };
  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row"><Btn size="sm" onClick={() => void validate(false)} data-testid="json-validate">Validate</Btn><Btn size="sm" variant="primary" onClick={() => void validate(true)} data-testid="json-apply">Validate and apply</Btn><Btn size="sm" onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Clipboard unavailable', 'warn'))} data-testid="json-copy">Copy</Btn>{errors && errors.length === 0 && <Badge tone="ok"><span data-testid="json-valid">valid</span></Badge>}</div>
      {errors && errors.length > 0 && <div className="errors" data-testid="json-errors">{errors.join('\n')}</div>}
      <textarea className="jsonbox input" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} data-testid="json-text" />
    </div>
  );
}
