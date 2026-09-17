import type { Frame, Locator, Page } from '../browser/provider.js';
import type { Action, Selector } from '../recipe/schema.js';
import { interpolate, sleep } from '../util/misc.js';
import type { CaptchaSolver } from './captcha.js';
import { scrollPage } from './scroll.js';

export interface ActionContext {
  keywords: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  captcha?: CaptchaSolver;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
  /** Called when a screenshot action has no path (recorder preview). */
  screenshotDir?: string;
}

/** Resolve a selector candidate list to the first Playwright locator that matches something. */
export async function locate(scope: Page | Frame | Locator, selector: Selector, timeoutMs = 0): Promise<{ locator: Locator; candidate: number } | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (let i = 0; i < selector.length; i++) {
      const loc = toLocator(scope, selector[i]);
      try {
        if ((await loc.count()) > 0) return { locator: loc, candidate: i };
      } catch { /* invalid selector */ }
    }
    if (timeoutMs > 0) await sleep(150);
  } while (Date.now() < deadline);
  return null;
}

export function toLocator(scope: Page | Frame | Locator, c: Selector[number]): Locator {
  switch (c.kind) {
    case 'xpath': return scope.locator(`xpath=${c.value}`);
    case 'text': return scope.getByText(c.value, { exact: true });
    case 'role': {
      const m = /^([a-z]+)(?:\[name=(.+)\])?$/i.exec(c.value.trim());
      const role = (m?.[1] ?? 'button') as Parameters<Page['getByRole']>[0];
      const name = m?.[2]?.replace(/^["']|["']$/g, '');
      return scope.getByRole(role, name ? { name, exact: false } : undefined);
    }
    case 'auto': return /^(\/|\.\/|\(\/)/.test(c.value) ? scope.locator(`xpath=${c.value}`) : scope.locator(c.value);
    default: return scope.locator(c.value);
  }
}

export async function runActions(page: Page, actions: Action[], ctx: ActionContext): Promise<{ frame: Page | Frame }> {
  let scope: Page | Frame = page;
  for (const a of actions) {
    if (ctx.signal?.aborted) throw new Error('aborted');
    scope = await runAction(page, scope, a, ctx);
  }
  return { frame: scope };
}

async function runAction(page: Page, scope: Page | Frame, a: Action, ctx: ActionContext): Promise<Page | Frame> {
  const t = ctx.timeoutMs;
  const log = (msg: string, data?: Record<string, unknown>) => ctx.onLog?.(msg, data);
  switch (a.type) {
    case 'click': {
      const found = await locate(scope, a.selector, a.optional ? 1500 : t);
      if (!found) { if (a.optional) return scope; throw new Error(`click: no element for ${describe(a.selector)}`); }
      if (a.all) { const n = await found.locator.count(); for (let i = 0; i < n; i++) await found.locator.nth(i).click({ timeout: t }).catch(() => { }); }
      else await found.locator.first().click({ timeout: t });
      await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => { });
      return scope;
    }
    case 'type': {
      const found = await locate(scope, a.selector, t);
      if (!found) throw new Error(`type: no element for ${describe(a.selector)}`);
      const text = interpolate(a.text, (n) => ctx.keywords[n]);
      const el = found.locator.first();
      if (a.clear !== false) await el.fill('', { timeout: t }).catch(() => { });
      await el.click({ timeout: t }).catch(() => { });
      await el.pressSequentially(text, { delay: 20 + Math.random() * 40, timeout: t });
      if (a.submit) { await el.press('Enter'); await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => { }); }
      return scope;
    }
    case 'select': {
      const found = await locate(scope, a.selector, t);
      if (!found) throw new Error(`select: no element for ${describe(a.selector)}`);
      const value = interpolate(a.value, (n) => ctx.keywords[n]);
      try { await found.locator.first().selectOption(value, { timeout: t }); }
      catch { await found.locator.first().selectOption({ label: value }, { timeout: t }); }
      return scope;
    }
    case 'hover': {
      const found = await locate(scope, a.selector, t);
      if (found) await found.locator.first().hover({ timeout: t }).catch(() => { });
      return scope;
    }
    case 'scroll': {
      const times = a.times ?? (a.untilNoChange ? 50 : 1);
      let lastHeight = -1; let stable = 0;
      for (let i = 0; i < times; i++) {
        if (a.selector) {
          const found = await locate(scope, a.selector, 1000);
          if (found) await found.locator.first().evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; }).catch(() => { });
        } else {
          // works whether the window scrolls or an inner container does
          await scrollPage(scope, 'bottom').catch(() => undefined);
          await page.mouse.wheel(0, 2000).catch(() => { });
        }
        await sleep(a.delayMs ?? 800, ctx.signal);
        if (a.untilNoChange) {
          const h = (await scrollPage(scope, 'probe').catch(() => undefined))?.height ?? 0;
          if (h === lastHeight) { if (++stable >= 2) break; } else stable = 0;
          lastHeight = h;
        }
      }
      return scope;
    }
    case 'wait': await sleep(a.ms, ctx.signal); return scope;
    case 'waitFor': {
      const found = await locate(scope, a.selector, a.timeoutMs ?? t);
      if (!found) throw new Error(`waitFor: ${describe(a.selector)} did not appear`);
      if (a.state && a.state !== 'attached') await found.locator.first().waitFor({ state: a.state, timeout: a.timeoutMs ?? t }).catch(() => { });
      return scope;
    }
    case 'waitForNetworkIdle': await page.waitForLoadState('networkidle', { timeout: a.timeoutMs ?? t }).catch(() => { }); return scope;
    case 'script': {
      const code = interpolate(a.code, (n) => JSON.stringify(ctx.keywords[n]));
      await evaluateMainWorld(scope, code).catch((e: Error) => { throw new Error(`script action failed: ${e.message}`); });
      return scope;
    }
    case 'press': {
      if (a.selector) { const found = await locate(scope, a.selector, t); if (found) await found.locator.first().press(a.key, { timeout: t }); }
      else await page.keyboard.press(a.key);
      return scope;
    }
    case 'frame': {
      const found = await locate(scope, a.selector, t);
      if (!found) throw new Error(`frame: no element for ${describe(a.selector)}`);
      const handle = await found.locator.first().elementHandle();
      const frame = await handle?.contentFrame();
      if (!frame) throw new Error('frame: element is not an iframe');
      return frame;
    }
    case 'goBack': await page.goBack({ timeout: t }).catch(() => { }); return page;
    case 'reload': await page.reload({ timeout: t }).catch(() => { }); return page;
    case 'screenshot': {
      const path = a.path ?? (ctx.screenshotDir ? `${ctx.screenshotDir}/${Date.now()}.png` : undefined);
      await page.screenshot({ path, fullPage: a.fullPage ?? false }).catch((e: Error) => log('screenshot failed', { error: e.message }));
      return scope;
    }
    case 'setCookie': {
      const url = page.url();
      await page.context().addCookies([{ name: a.name, value: interpolate(a.value, (n) => ctx.keywords[n]), domain: a.domain ?? new URL(url).hostname, path: '/' }]);
      return scope;
    }
    case 'solveCaptcha': {
      if (!ctx.captcha) { log('solveCaptcha: no captcha solver configured'); return scope; }
      await ctx.captcha.solve(page, a.kind ?? 'auto');
      return scope;
    }
    case 'repeat': {
      const max = a.max ?? 50;
      for (let i = 0; i < max; i++) {
        if (a.whileSelector) { const found = await locate(scope, a.whileSelector, 500); if (!found) break; }
        for (const inner of a.actions as Action[]) scope = await runAction(page, scope, inner, ctx);
        if (a.delayMs) await sleep(a.delayMs, ctx.signal);
      }
      return scope;
    }
  }
  return scope;
}

export function describe(sel: Selector): string { return sel.map((c) => `${c.kind}:${c.value}`).join(' | '); }

/**
 * Run user JavaScript in the page's MAIN world so it can see the site's own globals.
 * patchright evaluates in an isolated world by default; its 4th `evaluate` argument
 * (isolatedContext=false) selects the main world. Plain Playwright ignores the extra args.
 */
export function evaluateMainWorld(scope: Page | Frame, code: string): Promise<unknown> {
  const ev = scope.evaluate as unknown as (fn: (c: string) => unknown, arg: string, opts?: object, isolated?: boolean) => Promise<unknown>;
  return ev.call(scope, (c: string) => new Function(c)(), code, {}, false);
}
