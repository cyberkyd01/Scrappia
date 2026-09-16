/**
 * Settings: AI providers, secrets vault, defaults, browser install, about.
 */
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, LlmProviderConfig } from '@scrappia/core';
import type { AppInfo } from '@shared/ipc';
import { invoke, useIpcEvent } from '../api';
import { Btn, Input, Select, Check, FieldRow, Badge, Tabs, Empty, useToast, useAsync } from '../components/ui';

type Tab = 'ai' | 'secrets' | 'defaults' | 'browsers' | 'about';

export function Settings() {
  const toast = useToast();
  const { run } = useAsync();
  const [tab, setTab] = useState<Tab>('ai');
  const [settings, setSettings] = useState<AppSettings>({ ai: { providers: [] }, defaults: {} });
  const [secrets, setSecrets] = useState<string[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);

  const reload = async () => {
    const [s, names, i] = await Promise.all([invoke('settings.get'), invoke('secrets.list'), invoke('app.info')]);
    setSettings(s); setSecrets(names); setInfo(i);
  };
  useEffect(() => { void reload().catch((e) => toast((e as Error).message, 'error')); }, [toast]);

  const save = (s: AppSettings) => run(async () => { await invoke('settings.save', s); setSettings(s); }, 'Settings saved');

  return (
    <div className="view">
      <div className="view-header"><h1>Settings</h1></div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'ai', label: 'AI providers' }, { id: 'secrets', label: 'Secrets' }, { id: 'defaults', label: 'Defaults' }, { id: 'browsers', label: 'Browsers' }, { id: 'about', label: 'About' }]} />
      <div className="view-body">
        {tab === 'ai' && <AiProviders settings={settings} secrets={secrets} onSave={save} />}
        {tab === 'secrets' && <SecretsVault secrets={secrets} onChange={() => void invoke('secrets.list').then(setSecrets)} />}
        {tab === 'defaults' && <Defaults settings={settings} onSave={save} info={info} />}
        {tab === 'browsers' && <Browsers />}
        {tab === 'about' && <About info={info} />}
      </div>
    </div>
  );
}

function AiProviders({ settings, secrets, onSave }: { settings: AppSettings; secrets: string[]; onSave: (s: AppSettings) => Promise<unknown> }) {
  const toast = useToast();
  const [editing, setEditing] = useState<LlmProviderConfig | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const providers = settings.ai.providers;
  const test = async (p: LlmProviderConfig) => {
    setTesting(p.name);
    try { const r = await invoke('ai.test', p); toast(r.ok ? `${p.name}: OK` : `${p.name}: ${r.error ?? 'failed'}`, r.ok ? 'ok' : 'error'); }
    finally { setTesting(null); }
  };
  const upsert = (p: LlmProviderConfig) => {
    const list = providers.some((x) => x.name === p.name) ? providers.map((x) => (x.name === p.name ? p : x)) : [...providers, p];
    void onSave({ ...settings, ai: { ...settings.ai, providers: list, default: settings.ai.default ?? p.name } });
    setEditing(null);
  };
  return (
    <div className="col" style={{ maxWidth: 820 }}>
      <div className="row"><h3 className="grow">Providers</h3>
        <Btn size="sm" onClick={() => setEditing({ name: 'anthropic', kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'ANTHROPIC_API_KEY', effort: 'low' })}>+ Anthropic</Btn>
        <Btn size="sm" onClick={() => setEditing({ name: 'openai', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'OPENAI_API_KEY' })}>+ OpenAI-compatible</Btn>
        <Btn size="sm" onClick={() => setEditing({ name: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434', model: 'llama3.1' })}>+ Ollama (local)</Btn>
      </div>
      {providers.length === 0 && <div className="faint small">No providers. Without one, AI fields/transforms, self-healing and "AI suggest" are disabled. ANTHROPIC_API_KEY / OPENAI_API_KEY environment variables are picked up automatically.</div>}
      {providers.length > 0 && (
        <table className="grid card pad-0">
          <thead><tr><th>Name</th><th>Kind</th><th>Model</th><th>Base URL</th><th>API key secret</th><th>Default</th><th></th></tr></thead>
          <tbody>{providers.map((p) => (
            <tr key={p.name}>
              <td><b>{p.name}</b></td><td>{p.kind}</td><td className="mono">{p.model}</td><td className="mono ellipsis">{p.baseUrl ?? ''}</td><td className="mono">{p.apiKey ?? <span className="faint">none</span>}</td>
              <td><input type="radio" checked={settings.ai.default === p.name} onChange={() => void onSave({ ...settings, ai: { ...settings.ai, default: p.name } })} /></td>
              <td className="row gap-4"><Btn size="sm" onClick={() => void test(p)} disabled={testing === p.name}>{testing === p.name ? 'Testing…' : 'Test'}</Btn><Btn size="sm" onClick={() => setEditing(p)}>Edit</Btn><Btn size="sm" variant="ghost" onClick={() => void onSave({ ...settings, ai: { providers: providers.filter((x) => x.name !== p.name), default: settings.ai.default === p.name ? undefined : settings.ai.default } })}>✕</Btn></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {editing && (
        <div className="card col">
          <h3>{providers.some((x) => x.name === editing.name) ? 'Edit provider' : 'New provider'}</h3>
          <FieldRow label="Name"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></FieldRow>
          <FieldRow label="Kind"><Select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as LlmProviderConfig['kind'] })}><option value="anthropic">anthropic</option><option value="openai-compatible">openai-compatible</option></Select></FieldRow>
          <FieldRow label="Model"><Input full mono value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} /></FieldRow>
          <FieldRow label="Base URL" hint={editing.kind === 'anthropic' ? 'optional (proxy)' : 'e.g. https://api.openai.com/v1, http://localhost:11434, https://openrouter.ai/api/v1'}><Input full mono value={editing.baseUrl ?? ''} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value || undefined })} /></FieldRow>
          <FieldRow label="API key" hint="name of a secret from the vault (or an environment variable); leave blank for local servers"><Input full list="secret-names-ai" value={editing.apiKey ?? ''} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value || undefined })} /><datalist id="secret-names-ai">{secrets.map((s) => <option key={s} value={s} />)}</datalist></FieldRow>
          {editing.kind === 'anthropic' && <FieldRow label="Effort"><Select value={editing.effort ?? 'low'} onChange={(e) => setEditing({ ...editing, effort: e.target.value as LlmProviderConfig['effort'] })}><option>low</option><option>medium</option><option>high</option></Select></FieldRow>}
          <div className="row"><Btn variant="primary" onClick={() => upsert(editing)} disabled={!editing.name || !editing.model}>Save provider</Btn><Btn onClick={() => void test(editing)}>Test</Btn><Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn></div>
        </div>
      )}
    </div>
  );
}

function SecretsVault({ secrets, onChange }: { secrets: string[]; onChange: () => void }) {
  const { run } = useAsync();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const add = () => run(async () => { await invoke('secrets.set', name.trim(), value); setName(''); setValue(''); onChange(); }, 'Secret saved');
  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <div className="faint small">Secrets are stored in the local database and referenced by name from recipes (API keys, connection strings, webhook URLs). Values are never sent back to the UI.</div>
      <div className="row"><Input placeholder="NAME (e.g. ANTHROPIC_API_KEY)" mono value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} /><Input className="grow" type={show ? 'text' : 'password'} placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} /><Check label="show" checked={show} onChange={setShow} /><Btn variant="primary" onClick={add} disabled={!name || !value}>{secrets.includes(name) ? 'Update' : 'Add'}</Btn></div>
      {secrets.length === 0 ? <Empty>No secrets stored.</Empty> : (
        <table className="grid card pad-0"><thead><tr><th>Name</th><th>Value</th><th></th></tr></thead><tbody>
          {secrets.map((s) => <tr key={s}><td className="mono">{s}</td><td className="faint">••••••••</td><td><Btn size="sm" variant="ghost" onClick={() => void run(async () => { await invoke('secrets.delete', s); onChange(); }, 'Secret deleted')}>Delete</Btn></td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}

function Defaults({ settings, onSave, info }: { settings: AppSettings; onSave: (s: AppSettings) => Promise<unknown>; info: AppInfo | null }) {
  const d = settings.defaults;
  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <FieldRow label="Output directory" hint={`relative sink paths resolve here (default: ${info?.dataDir ?? 'data dir'})`}>
        <span className="row"><Input full mono value={d.outDir ?? ''} placeholder={info?.dataDir} onChange={(e) => void onSave({ ...settings, defaults: { ...d, outDir: e.target.value || undefined } })} /><Btn size="sm" onClick={async () => { const p = await invoke('dialogs.open', { directory: true }); if (p) void onSave({ ...settings, defaults: { ...d, outDir: p } }); }}>Browse…</Btn></span>
      </FieldRow>
      <FieldRow label="Browser runs"><Select value={d.headless === undefined ? '' : d.headless ? 'headless' : 'headed'} onChange={(e) => void onSave({ ...settings, defaults: { ...d, headless: e.target.value === '' ? undefined : e.target.value === 'headless' } })}><option value="">as configured in each recipe</option><option value="headless">always headless</option><option value="headed">always show the browser window</option></Select></FieldRow>
    </div>
  );
}

function Browsers() {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useIpcEvent('browsers:output', (o) => { setLines((l) => [...l, o.line].slice(-500)); if (o.done) setRunning(false); setTimeout(() => ref.current?.scrollTo(0, ref.current.scrollHeight), 0); });
  const install = () => { setLines([]); setRunning(true); void invoke('browsers.install').finally(() => setRunning(false)); };
  return (
    <div className="col" style={{ maxWidth: 820 }}>
      <div className="muted small">Scrappia drives Chromium through patchright (a stealth Playwright fork). The browser binary is downloaded once into the Playwright cache; if the recorder fails to open or a run reports "Executable doesn't exist", install it here.</div>
      <div className="row"><Btn variant="primary" onClick={install} disabled={running}>{running ? 'Installing…' : 'Install Chromium'}</Btn><span className="faint tiny">runs <code>npx patchright install chromium</code></span></div>
      {lines.length > 0 && <div ref={ref} className="card log" style={{ maxHeight: 360, overflow: 'auto' }}>{lines.join('')}</div>}
    </div>
  );
}

function About({ info }: { info: AppInfo | null }) {
  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <h2>Scrappia <Badge>{info?.version}</Badge></h2>
      <div className="muted">Visual web scraper: point-and-click recorder, stealth engine, scheduler, exports, monitoring.</div>
      {info && (
        <table className="grid card pad-0"><tbody>
          <tr><td>Electron</td><td className="mono">{info.electron}</td></tr>
          <tr><td>Node</td><td className="mono">{info.node}</td></tr>
          <tr><td>Chromium (UI)</td><td className="mono">{info.chrome}</td></tr>
          <tr><td>Platform</td><td className="mono">{info.platform}</td></tr>
          <tr><td>Data directory</td><td className="mono row"><span className="grow ellipsis">{info.dataDir}</span><Btn size="sm" onClick={() => void invoke('shell.openPath', info.dataDir)}>Open</Btn></td></tr>
          <tr><td>Browser profiles</td><td className="mono">{info.profilesDir}</td></tr>
        </tbody></table>
      )}
    </div>
  );
}
