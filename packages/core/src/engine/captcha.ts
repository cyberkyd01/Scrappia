/**
 * CAPTCHA solving: 2Captcha, CapSolver, Anti-Captcha (all createTask/getTaskResult style),
 * plus a "manual" solver that waits for a human in headed mode.
 */
import { fetch } from 'undici';
import type { Page } from '../browser/provider.js';
import type { CaptchaConfig } from '../recipe/schema.js';
import { sleep } from '../util/misc.js';
import type { z } from 'zod';

type Cfg = z.infer<typeof CaptchaConfig>;
export type CaptchaKind = 'auto' | 'turnstile' | 'recaptchaV2' | 'recaptchaV3' | 'hcaptcha' | 'image';

export interface CaptchaSolver {
  readonly name: string;
  detect(page: Page): Promise<{ kind: Exclude<CaptchaKind, 'auto'>; siteKey?: string; action?: string } | null>;
  solve(page: Page, kind?: CaptchaKind): Promise<boolean>;
}

const DETECT_SCRIPT = `(() => {
  const q = (s) => document.querySelector(s);
  const ts = q('.cf-turnstile, [data-sitekey][class*="turnstile"], iframe[src*="challenges.cloudflare.com"]');
  if (ts) return { kind: 'turnstile', siteKey: ts.getAttribute('data-sitekey') || (q('[data-sitekey]') || {}).getAttribute?.('data-sitekey') || undefined };
  const rc = q('.g-recaptcha[data-sitekey], iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
  if (rc) { let key = rc.getAttribute('data-sitekey'); if (!key && rc.src) { const m = /[?&]k=([^&]+)/.exec(rc.src); key = m && m[1]; } return { kind: 'recaptchaV2', siteKey: key || undefined }; }
  const hc = q('.h-captcha[data-sitekey], iframe[src*="hcaptcha.com"]');
  if (hc) { let key = hc.getAttribute('data-sitekey'); if (!key && hc.src) { const m = /sitekey=([^&]+)/.exec(hc.src); key = m && m[1]; } return { kind: 'hcaptcha', siteKey: key || undefined }; }
  const v3 = Array.from(document.scripts).find((s) => /recaptcha\\/api\\.js\\?render=/.test(s.src));
  if (v3) { const m = /render=([^&]+)/.exec(v3.src); return { kind: 'recaptchaV3', siteKey: m && m[1] }; }
  return null;
})()`;

abstract class ApiSolver implements CaptchaSolver {
  constructor(public readonly name: string, protected apiKey: string) {}
  protected abstract createTask(task: Record<string, unknown>): Promise<string>;
  protected abstract pollResult(taskId: string): Promise<{ done: boolean; token?: string; error?: string }>;
  protected abstract taskFor(kind: Exclude<CaptchaKind, 'auto' | 'image'>, siteKey: string, url: string, action?: string): Record<string, unknown>;

  async detect(page: Page) {
    return page.evaluate(DETECT_SCRIPT).catch(() => null) as Promise<{ kind: Exclude<CaptchaKind, 'auto'>; siteKey?: string; action?: string } | null>;
  }

  async solve(page: Page, kind: CaptchaKind = 'auto'): Promise<boolean> {
    const det = await this.detect(page);
    const k = kind === 'auto' ? det?.kind : kind;
    if (!k || k === 'image') return false;
    const siteKey = det?.siteKey;
    if (!siteKey) return false;
    const taskId = await this.createTask(this.taskFor(k, siteKey, page.url(), det?.action));
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const r = await this.pollResult(taskId);
      if (r.error) throw new Error(`${this.name}: ${r.error}`);
      if (r.done && r.token) { await injectToken(page, k, r.token); return true; }
    }
    throw new Error(`${this.name}: timed out waiting for solution`);
  }
}

export class TwoCaptchaSolver extends ApiSolver {
  constructor(apiKey: string) { super('2captcha', apiKey); }
  protected async createTask(task: Record<string, unknown>) {
    const res = await fetch('https://api.2captcha.com/createTask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: this.apiKey, task }) });
    const j = (await res.json()) as { errorId: number; taskId?: number; errorDescription?: string };
    if (j.errorId) throw new Error(`2captcha: ${j.errorDescription}`);
    return String(j.taskId);
  }
  protected async pollResult(taskId: string) {
    const res = await fetch('https://api.2captcha.com/getTaskResult', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: this.apiKey, taskId: Number(taskId) }) });
    const j = (await res.json()) as { errorId: number; status?: string; solution?: { token?: string; gRecaptchaResponse?: string }; errorDescription?: string };
    if (j.errorId) return { done: true, error: j.errorDescription };
    return { done: j.status === 'ready', token: j.solution?.token ?? j.solution?.gRecaptchaResponse };
  }
  protected taskFor(kind: Exclude<CaptchaKind, 'auto' | 'image'>, siteKey: string, url: string, action?: string) {
    const map = { turnstile: 'TurnstileTaskProxyless', recaptchaV2: 'RecaptchaV2TaskProxyless', recaptchaV3: 'RecaptchaV3TaskProxyless', hcaptcha: 'HCaptchaTaskProxyless' } as const;
    return { type: map[kind], websiteURL: url, websiteKey: siteKey, ...(kind === 'recaptchaV3' ? { minScore: 0.3, pageAction: action ?? 'verify' } : {}) };
  }
}

export class CapSolverSolver extends ApiSolver {
  constructor(apiKey: string) { super('capsolver', apiKey); }
  protected async createTask(task: Record<string, unknown>) {
    const res = await fetch('https://api.capsolver.com/createTask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: this.apiKey, task }) });
    const j = (await res.json()) as { errorId: number; taskId?: string; errorDescription?: string };
    if (j.errorId) throw new Error(`capsolver: ${j.errorDescription}`);
    return j.taskId!;
  }
  protected async pollResult(taskId: string) {
    const res = await fetch('https://api.capsolver.com/getTaskResult', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: this.apiKey, taskId }) });
    const j = (await res.json()) as { errorId: number; status?: string; solution?: { token?: string; gRecaptchaResponse?: string }; errorDescription?: string };
    if (j.errorId) return { done: true, error: j.errorDescription };
    return { done: j.status === 'ready', token: j.solution?.token ?? j.solution?.gRecaptchaResponse };
  }
  protected taskFor(kind: Exclude<CaptchaKind, 'auto' | 'image'>, siteKey: string, url: string, action?: string) {
    const map = { turnstile: 'AntiTurnstileTaskProxyLess', recaptchaV2: 'ReCaptchaV2TaskProxyLess', recaptchaV3: 'ReCaptchaV3TaskProxyLess', hcaptcha: 'HCaptchaTaskProxyLess' } as const;
    return { type: map[kind], websiteURL: url, websiteKey: siteKey, ...(kind === 'recaptchaV3' ? { pageAction: action ?? 'verify' } : {}) };
  }
}

export class AntiCaptchaSolver extends ApiSolver {
  constructor(apiKey: string) { super('anticaptcha', apiKey); }
  protected async createTask(task: Record<string, unknown>) {
    const res = await fetch('https://api.anti-captcha.com/createTask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: this.apiKey, task }) });
    const j = (await res.json()) as { errorId: number; taskId?: number; errorDescription?: string };
    if (j.errorId) throw new Error(`anticaptcha: ${j.errorDescription}`);
    return String(j.taskId);
  }
  protected async pollResult(taskId: string) {
    const res = await fetch('https://api.anti-captcha.com/getTaskResult', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: this.apiKey, taskId: Number(taskId) }) });
    const j = (await res.json()) as { errorId: number; status?: string; solution?: { token?: string; gRecaptchaResponse?: string }; errorDescription?: string };
    if (j.errorId) return { done: true, error: j.errorDescription };
    return { done: j.status === 'ready', token: j.solution?.token ?? j.solution?.gRecaptchaResponse };
  }
  protected taskFor(kind: Exclude<CaptchaKind, 'auto' | 'image'>, siteKey: string, url: string, action?: string) {
    const map = { turnstile: 'TurnstileTaskProxyless', recaptchaV2: 'RecaptchaV2TaskProxyless', recaptchaV3: 'RecaptchaV3TaskProxyless', hcaptcha: 'HCaptchaTaskProxyless' } as const;
    return { type: map[kind], websiteURL: url, websiteKey: siteKey, ...(kind === 'recaptchaV3' ? { minScore: 0.3, pageAction: action ?? 'verify' } : {}) };
  }
}

/** Headed mode: wait until the challenge disappears (a human solves it). */
export class ManualSolver implements CaptchaSolver {
  readonly name = 'manual';
  constructor(private onNeeded?: (url: string, kind: string) => void, private timeoutMs = 180_000) {}
  async detect(page: Page) { return page.evaluate(DETECT_SCRIPT).catch(() => null) as Promise<{ kind: Exclude<CaptchaKind, 'auto'>; siteKey?: string } | null>; }
  async solve(page: Page): Promise<boolean> {
    const det = await this.detect(page);
    if (!det) return false;
    this.onNeeded?.(page.url(), det.kind);
    await page.bringToFront().catch(() => { });
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (!(await this.detect(page))) return true;
    }
    return false;
  }
}

async function injectToken(page: Page, kind: Exclude<CaptchaKind, 'auto' | 'image'>, token: string) {
  await page.evaluate(([k, tok]) => {
    const set = (sel: string) => document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(sel).forEach((el) => { el.value = tok; el.style.display = 'block'; });
    if (k === 'turnstile') set('[name="cf-turnstile-response"], input[name*="turnstile"]');
    else if (k === 'hcaptcha') set('[name="h-captcha-response"], [name="g-recaptcha-response"]');
    else set('[name="g-recaptcha-response"]');
    // fire common callbacks
    const w = window as unknown as Record<string, unknown>;
    for (const name of ['onCaptchaSuccess', 'captchaCallback', 'onSuccess', 'turnstileCallback', 'recaptchaCallback']) if (typeof w[name] === 'function') try { (w[name] as (t: string) => void)(tok); } catch { /* ignore */ }
    const cfg = document.querySelector('[data-callback]')?.getAttribute('data-callback');
    if (cfg && typeof w[cfg] === 'function') try { (w[cfg] as (t: string) => void)(tok); } catch { /* ignore */ }
  }, [kind, token] as const);
}

export function createCaptchaSolver(cfg: Cfg, resolveSecret: (ref: string) => string | undefined, onNeeded?: (url: string, kind: string) => void): CaptchaSolver | undefined {
  if (cfg.provider === 'none') return undefined;
  if (cfg.provider === 'manual') return new ManualSolver(onNeeded);
  const key = cfg.apiKeyRef ? resolveSecret(cfg.apiKeyRef) ?? cfg.apiKeyRef : undefined;
  if (!key) throw new Error(`CAPTCHA provider ${cfg.provider} needs apiKeyRef`);
  if (cfg.provider === '2captcha') return new TwoCaptchaSolver(key);
  if (cfg.provider === 'capsolver') return new CapSolverSolver(key);
  return new AntiCaptchaSolver(key);
}

/** Detects block/challenge pages by content so the engine can retry with a different session. */
export function looksBlocked(html: string, status?: number): string | null {
  if (status === 403 || status === 429 || status === 503) {
    if (/cloudflare|cf-ray|attention required|access denied|rate limit|too many requests|captcha/i.test(html)) return `http-${status}`;
    if (status === 429) return 'rate-limited';
  }
  if (/cf-browser-verification|_cf_chl_opt|challenge-platform|Just a moment\.\.\.|Checking your browser before accessing/i.test(html)) return 'cloudflare-challenge';
  if (/px-captcha|perimeterx/i.test(html) && /captcha|blocked|access denied/i.test(html)) return 'perimeterx';
  if (/datadome/i.test(html) && /captcha/i.test(html)) return 'datadome';
  if (/<title>\s*(Access Denied|Blocked|Bot Detected|Are you a robot|Pardon Our Interruption|Robot Check|Sorry! Something went wrong)/i.test(html)) return 'block-page';
  // Amazon, Google and similar "are you a human" interstitials
  if (/Enter the characters you see below|automated access to .{0,40}data|unusual traffic from your (computer|network)|verify (that )?you are (a )?human|Type the characters you see/i.test(html)) return 'bot-check';
  return null;
}
