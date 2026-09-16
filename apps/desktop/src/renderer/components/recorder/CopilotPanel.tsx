/**
 * Copilot chat panel (bottom of the recorder): talks to the main-process CopilotManager over IPC,
 * renders the conversation (user / assistant bubbles, tool chips, events, errors), shows the
 * "waiting for picks" banner and pushes recipe updates from the copilot into the working recipe.
 * The conversation itself lives in the main process, so remounting the panel restores it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Recipe } from '@scrappia/core';
import type { CopilotAvailable, CopilotStatus } from '@shared/ipc';
import { invoke, useIpcEvent } from '../../api';
import { useApp } from '../../App';
import { Btn, Select, Badge, useToast } from '../ui';
import { buildChat, emptyChat, foldLogItem, turnResultToItems, waitingBanner, type ChatEntry, type ChatState } from '../../lib/copilotLog';

export const QUICK_REPLIES = ["Let's start scraping", "I'm done picking", 'Detail pages', 'Next page', 'Run it', 'Save recipe'] as const;

const LS_COLLAPSED = 'scrappia.copilot.collapsed';
const LS_HEIGHT = 'scrappia.copilot.height';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 640;

function readLs<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; } }
function writeLs(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

export interface CopilotPanelProps {
  recipe: Recipe;
  /** Identifies the recorder session in main; a new key starts a fresh conversation. */
  sessionKey: string;
  /** Apply the copilot's recipe to the recorder (only when it already had a conversation with this key). */
  restore?: boolean;
  onRecipe: (recipe: Recipe) => void;
  onOpenRun: (runId: string) => void;
  /** Whether the copilot currently waits for the user to click elements (the recorder suppresses its own pick handling). */
  onWaiting?: (waiting: boolean) => void;
  /** Increment to un-collapse the panel and focus the input (Ctrl+/). */
  focusSignal?: number;
}

export function CopilotPanel({ recipe, sessionKey, restore, onRecipe, onOpenRun, onWaiting, focusSignal }: CopilotPanelProps) {
  const { go } = useApp();
  const toast = useToast();
  const [avail, setAvail] = useState<CopilotAvailable | null>(null);
  const [provider, setProvider] = useState<string>('');
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [status, setStatus] = useState<CopilotStatus>({ started: false, busy: false, waitingForPicks: false, mode: 'off', instruction: '' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readLs(LS_COLLAPSED, false));
  const [height, setHeight] = useState(() => readLs(LS_HEIGHT, DEFAULT_HEIGHT));
  const recipeRef = useRef(recipe); recipeRef.current = recipe;
  const onRecipeRef = useRef(onRecipe); onRecipeRef.current = onRecipe;
  const onOpenRunRef = useRef(onOpenRun); onOpenRunRef.current = onOpenRun;
  const onWaitingRef = useRef(onWaiting); onWaitingRef.current = onWaiting;
  const progressSeen = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const ready = !!avail?.ok && status.started;
  const busy = status.busy || sending;

  // ---- lifecycle: start (or resume) the session in main ----
  const start = useCallback(async (providerName?: string) => {
    const a = await invoke('copilot.available');
    setAvail(a);
    if (!a.ok) return;
    const st = await invoke('copilot.start', { recipe: recipeRef.current, sessionKey, providerName });
    setChat(buildChat(st.log));
    setStatus(st.status);
    setProvider(st.status.providerName ?? a.default ?? a.providers[0] ?? '');
    if (restore && st.recipe && st.log.length) onRecipeRef.current(st.recipe);
  }, [sessionKey, restore]);

  useEffect(() => { void start().catch((e) => toast((e as Error).message, 'error')); }, [start, toast]);

  useIpcEvent('copilot:log', (item) => { if (item.kind === 'progress') progressSeen.current++; setChat((c) => foldLogItem(c, item)); });
  useIpcEvent('copilot:status', (s) => { setStatus(s); onWaitingRef.current?.(s.waitingForPicks); });
  useIpcEvent('copilot:recipe', (r) => onRecipeRef.current(r));
  useIpcEvent('copilot:run', ({ runId }) => onOpenRunRef.current(runId));
  useEffect(() => { onWaitingRef.current?.(status.waitingForPicks); }, [status.waitingForPicks]);

  // ---- focus shortcut / autoscroll ----
  useEffect(() => { if (focusSignal) { setCollapsed(false); writeLs(LS_COLLAPSED, false); setTimeout(() => inputRef.current?.focus(), 0); } }, [focusSignal]);
  useLayoutEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat, collapsed]);

  // ---- actions ----
  const send = useCallback(async (message: string) => {
    const msg = message.trim();
    if (!msg || !ready || busy) return;
    setText('');
    setSending(true);
    const before = progressSeen.current;
    try {
      const r = await invoke('copilot.turn', { recipe: recipeRef.current, message: msg });
      onRecipeRef.current(r.recipe);
      if (progressSeen.current === before) { const at = Date.now(); setChat((c) => turnResultToItems(r, at).reduce(foldLogItem, c)); }
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSending(false); inputRef.current?.focus(); }
  }, [ready, busy, toast]);

  const reset = async () => {
    await invoke('copilot.reset').catch(() => undefined);
    setChat(emptyChat());
    await start(provider || undefined).catch((e) => toast((e as Error).message, 'error'));
  };
  const changeProvider = (name: string) => { setProvider(name); void start(name).catch((e) => toast((e as Error).message, 'error')); };
  const cancel = () => void invoke('copilot.cancel').catch(() => undefined);
  const toggle = () => setCollapsed((v) => { writeLs(LS_COLLAPSED, !v); return !v; });

  // ---- resize by dragging the top edge ----
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = height;
    const move = (ev: MouseEvent) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH - (ev.clientY - startY))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setHeight((h) => { writeLs(LS_HEIGHT, h); return h; }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); }
  };

  return (
    <div className={`copilot${collapsed ? ' collapsed' : ''}`} style={collapsed ? undefined : { height }} data-testid="copilot-panel">
      {!collapsed && <div className="copilot-resize" onMouseDown={onDragStart} title="Drag to resize" />}
      <div className="panel-head">
        <button type="button" className="btn ghost sm" onClick={toggle} title={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? '▴' : '▾'}</button>
        <span>Copilot</span>
        {status.waitingForPicks ? <Badge tone="warn">waiting for picks</Badge> : busy ? <Badge tone="accent">working…</Badge> : avail && !avail.ok ? <Badge tone="danger">no provider</Badge> : null}
        <div className="grow" />
        {avail?.ok && avail.providers.length > 0 && (
          <span className="row gap-4 tiny"><span className="faint">provider</span>
            <Select value={provider} onChange={(e) => changeProvider(e.target.value)} disabled={busy} data-testid="copilot-provider">{avail.providers.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
          </span>
        )}
        {busy && <Btn size="sm" variant="danger" onClick={cancel}>Cancel</Btn>}
        <Btn size="sm" onClick={() => void reset()} disabled={!avail?.ok} title="Forget the conversation and start over">Reset</Btn>
      </div>
      {!collapsed && (
        avail && !avail.ok ? (
          <div className="copilot-empty" data-testid="copilot-empty">
            <div><b>Copilot needs an AI provider.</b></div>
            <div className="muted small">{avail.reason}</div>
            <div className="muted small">Works with Anthropic, OpenAI, OpenRouter, Ollama, LM Studio or any OpenAI-compatible endpoint.</div>
            <Btn variant="primary" size="sm" onClick={() => go({ name: 'settings' })} data-testid="copilot-open-settings">Open Settings</Btn>
          </div>
        ) : (
          <>
            <div className="copilot-msgs" ref={listRef} data-testid="copilot-messages">
              {chat.entries.length === 0 && !chat.typing && (
                <div className="copilot-hint muted small">
                  Tell the copilot what you want to scrape ("all products with name and price, then the detail pages") or click <b>Let's start scraping</b> to build the recipe together: it asks you to click elements in the browser window and turns your picks into fields.
                </div>
              )}
              {renderEntries(chat.entries)}
              {chat.typing && <div className="copilot-typing" data-testid="copilot-typing"><span /><span /><span /><span className="faint tiny">Copilot is working…</span></div>}
            </div>
            {status.waitingForPicks && <div className="banner warn small copilot-banner" data-testid="copilot-waiting">{waitingBanner(status.mode, status.instruction)}</div>}
            <div className="copilot-quick">
              {QUICK_REPLIES.map((q) => <button type="button" key={q} className="chip" onClick={() => void send(q)} disabled={!ready || busy}>{q}</button>)}
            </div>
            <div className="copilot-input">
              <textarea ref={inputRef} className="textarea grow" rows={2} value={text} placeholder={ready ? 'Ask the copilot… (Enter to send, Shift+Enter for a new line, Ctrl+/ to focus)' : 'Starting copilot…'} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={!ready} data-testid="copilot-input" />
              <Btn variant="primary" onClick={() => void send(text)} disabled={!ready || busy || !text.trim()} data-testid="copilot-send">Send</Btn>
            </div>
          </>
        )
      )}
    </div>
  );
}

/** Render entries; consecutive tool chips are grouped on one line. */
function renderEntries(entries: ChatEntry[]): ReactNode[] {
  const out: ReactNode[] = [];
  let chips: ChatEntry[] = [];
  const flush = () => {
    if (!chips.length) return;
    out.push(<div className="copilot-tools" key={`t-${chips[0].id}`}>{chips.map((c) => c.kind === 'tool' && <span key={c.id} className={`copilot-chip${c.ok ? '' : ' err'}${c.pending ? ' pending' : ''}`} data-tool={c.tool} title={c.tool}>{c.summary}</span>)}</div>);
    chips = [];
  };
  for (const e of entries) {
    if (e.kind === 'tool') { chips.push(e); continue; }
    flush();
    switch (e.kind) {
      case 'user': out.push(<div key={e.id} className="copilot-msg user" data-role="user">{e.text}</div>); break;
      case 'assistant': out.push(<div key={e.id} className="copilot-msg assistant" data-role="assistant">{e.text}</div>); break;
      case 'event': out.push(<div key={e.id} className="copilot-event faint tiny" data-role="event">{e.text}</div>); break;
      case 'error': out.push(<div key={e.id} className="copilot-error small" data-role="error">{e.text}</div>); break;
    }
  }
  flush();
  return out;
}
