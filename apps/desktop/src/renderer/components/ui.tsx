/** Small UI primitives (plain CSS) and a toast context. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function Btn({ className = '', variant, size, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; size?: 'sm'; active?: boolean }) {
  const cls = ['btn', variant ?? '', size ?? '', active ? 'active' : '', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...rest} />;
}

export function Input({ className = '', mono, full, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; full?: boolean }) {
  return <input className={['input', mono ? 'mono' : '', full ? 'full' : '', className].filter(Boolean).join(' ')} {...rest} />;
}

export function Select({ className = '', full, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { full?: boolean }) {
  return <select className={['select', full ? 'full' : '', className].filter(Boolean).join(' ')} {...rest} />;
}

export function Textarea({ className = '', full, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { full?: boolean }) {
  return <textarea className={['textarea', full ? 'full' : '', className].filter(Boolean).join(' ')} {...rest} />;
}

export function Check({ label, checked, onChange, disabled, testId }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>{label}</span>
    </label>
  );
}

export function FieldRow({ label, children, stack, hint }: { label: ReactNode; children: ReactNode; stack?: boolean; hint?: ReactNode }) {
  return (
    <div className={`field-row${stack ? ' stack' : ''}`}>
      <label>{label}</label>
      <div>{children}{hint && <div className="faint tiny">{hint}</div>}</div>
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'accent' }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function Chip({ children, onRemove, onClick, title }: { children: ReactNode; onRemove?: () => void; onClick?: () => void; title?: string }) {
  return (
    <span className="chip" onClick={onClick} title={title}>
      {children}
      {onRemove && <button type="button" className="x" onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label="remove">×</button>}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => <button type="button" key={t.id} className={`tab${t.id === value ? ' active' : ''}`} onClick={() => onChange(t.id)} data-testid={`tab-${t.id}`}>{t.label}</button>)}
    </div>
  );
}

export function Modal({ title, children, onClose, footer, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog">
        <div className="modal-head"><span className="grow">{title}</span><Btn variant="ghost" size="sm" onClick={onClose}>✕</Btn></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

export function StatCard({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return <div className="stat" data-testid={testId}><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

/** Prompt modal (replacement for window.prompt, which Electron does not support). */
export function PromptModal({ title, label, defaultValue = '', placeholder, onSubmit, onClose, submitLabel = 'OK' }: { title: string; label?: string; defaultValue?: string; placeholder?: string; onSubmit: (v: string) => void; onClose: () => void; submitLabel?: string }) {
  const [v, setV] = useState(defaultValue);
  const submit = () => { if (v.trim()) { onSubmit(v.trim()); onClose(); } };
  return (
    <Modal title={title} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={!v.trim()}>{submitLabel}</Btn></>}>
      {label && <div className="muted mb-8">{label}</div>}
      <Input full autoFocus value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
    </Modal>
  );
}

// ---------- toasts ----------

interface Toast { id: number; text: string; tone?: 'ok' | 'error' | 'warn' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone?: Toast['tone']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-4), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone ?? ''}`} data-testid="toast" data-tone={t.tone ?? 'info'}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

export function useToast() { return useContext(ToastCtx); }

/** Run an async action and toast on failure. */
export function useAsync() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; }
    catch (e) { toast((e as Error).message, 'error'); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}
