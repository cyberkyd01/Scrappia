import { createHash } from 'node:crypto';
import type { Transform } from '../recipe/schema.js';
import { absoluteUrl, interpolate } from '../util/misc.js';

export interface TransformContext {
  pageUrl: string;
  row: Record<string, unknown>;
  /** AI transform delegate; injected by the runner. */
  ai?: (prompt: string, input: unknown, schema?: Record<string, unknown>, provider?: string) => Promise<unknown>;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', '₫': 'VND', '₪': 'ILS', '฿': 'THB', 'R$': 'BRL', 'A$': 'AUD', 'C$': 'CAD', 'CHF': 'CHF', 'kr': 'SEK', 'zł': 'PLN',
};

export function parseNumber(input: unknown, decimal?: string, thousands?: string): number | null {
  if (typeof input === 'number') return input;
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/[^\d.,\-+\s'’]/g, ' ').replace(/\s+/g, '');
  if (!s) return null;
  if (decimal || thousands) {
    if (thousands) s = s.split(thousands).join('');
    if (decimal && decimal !== '.') s = s.replace(decimal, '.');
  } else {
    // Heuristic: if both , and . present, the last one is the decimal separator.
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma >= 0) {
      // "1,234" (thousands) vs "12,34" (decimal): 3 digits after comma with no other comma -> thousands
      const after = s.length - lastComma - 1;
      const commas = (s.match(/,/g) || []).length;
      if (after === 3 && commas >= 1 && !/^\d{1,2},\d{3}$/.test(s) ? true : after === 3 && commas > 1) s = s.replace(/,/g, '');
      else if (after === 3 && commas === 1) s = s.replace(',', ''); // "1,234" -> 1234 (ambiguous; prefer thousands)
      else s = s.replace(',', '.');
    } else if (lastDot >= 0) {
      const dots = (s.match(/\./g) || []).length;
      if (dots > 1) s = s.replace(/\./g, '');
    }
    s = s.replace(/['’]/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function parseCurrency(input: unknown): { amount: number | null; currency: string | null } {
  if (input == null) return { amount: null, currency: null };
  const s = String(input);
  let currency: string | null = null;
  const code = /\b(USD|EUR|GBP|JPY|INR|AUD|CAD|CHF|CNY|SEK|NOK|DKK|PLN|BRL|MXN|KRW|RUB|TRY|ZAR|SGD|HKD|NZD|AED|SAR)\b/i.exec(s);
  if (code) currency = code[1].toUpperCase();
  else {
    for (const sym of Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length)) {
      if (s.includes(sym)) { currency = CURRENCY_SYMBOLS[sym]; break; }
    }
  }
  return { amount: parseNumber(s), currency };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Best-effort date parsing to ISO 8601. Supports relative ("3 days ago"), common numeric and textual formats. */
export function parseDate(input: unknown, inputFormat?: string): string | null {
  if (input == null) return null;
  if (input instanceof Date) return isNaN(+input) ? null : input.toISOString();
  const s = String(input).trim();
  if (!s) return null;
  if (inputFormat) {
    const d = parseWithFormat(s, inputFormat);
    if (d) return d.toISOString();
  }
  const rel = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const d = new Date();
    const map: Record<string, () => void> = {
      second: () => d.setSeconds(d.getSeconds() - n), minute: () => d.setMinutes(d.getMinutes() - n), hour: () => d.setHours(d.getHours() - n),
      day: () => d.setDate(d.getDate() - n), week: () => d.setDate(d.getDate() - 7 * n), month: () => d.setMonth(d.getMonth() - n), year: () => d.setFullYear(d.getFullYear() - n),
    };
    map[unit]();
    return d.toISOString();
  }
  if (/^(today|now)$/i.test(s)) return new Date().toISOString();
  if (/^yesterday$/i.test(s)) { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString(); }
  if (/^\d{10,13}$/.test(s)) { const n = parseInt(s, 10); return new Date(s.length === 13 ? n : n * 1000).toISOString(); }
  // dd/mm/yyyy or mm/dd/yyyy (prefer d/m when first > 12)
  const dmy = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
  if (dmy) {
    let a = +dmy[1], b = +dmy[2]; const y = dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3];
    let day = a, month = b;
    if (a <= 12 && b > 12) { day = b; month = a; }
    const d = new Date(Date.UTC(y, month - 1, day));
    return isNaN(+d) ? null : d.toISOString();
  }
  // "12 Mar 2024", "Mar 12, 2024", "March 12 2024"
  const textual = /(\d{1,2})?\s*([A-Za-z]{3,})\.?\s*(\d{1,2})?,?\s*(\d{4})/.exec(s);
  if (textual) {
    const mi = MONTHS.indexOf(textual[2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const day = +(textual[1] || textual[3] || 1);
      const d = new Date(Date.UTC(+textual[4], mi, day));
      const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(s);
      if (time) {
        let h = +time[1]; if (time[4]) { if (/pm/i.test(time[4]) && h < 12) h += 12; if (/am/i.test(time[4]) && h === 12) h = 0; }
        d.setUTCHours(h, +time[2], +(time[3] || 0));
      }
      return isNaN(+d) ? null : d.toISOString();
    }
  }
  const d = new Date(s);
  return isNaN(+d) ? null : d.toISOString();
}

function parseWithFormat(s: string, fmt: string): Date | null {
  // tokens: YYYY MM DD HH mm ss
  const tokens = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'];
  let re = '';
  const order: string[] = [];
  for (let i = 0; i < fmt.length;) {
    const tok = tokens.find((t) => fmt.startsWith(t, i));
    if (tok) { re += tok === 'YYYY' ? '(\\d{4})' : '(\\d{1,2})'; order.push(tok); i += tok.length; }
    else { re += fmt[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  const m = new RegExp('^' + re).exec(s);
  if (!m) return null;
  const parts: Record<string, number> = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
  order.forEach((t, i) => { parts[t] = +m[i + 1]; });
  return new Date(Date.UTC(parts.YYYY, parts.MM - 1, parts.DD, parts.HH, parts.mm, parts.ss));
}

export function formatDate(iso: string, fmt: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return fmt.replace('YYYY', String(d.getUTCFullYear())).replace('MM', p(d.getUTCMonth() + 1)).replace('DD', p(d.getUTCDate()))
    .replace('HH', p(d.getUTCHours())).replace('mm', p(d.getUTCMinutes())).replace('ss', p(d.getUTCSeconds()));
}

function stripHtml(s: string): string {
  return s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}

type JsFn = (value: unknown, row: Record<string, unknown>, ctx: { pageUrl: string }) => unknown;
const jsCache = new Map<string, JsFn>();

export function compileJs(code: string): JsFn {
  const cached = jsCache.get(code);
  if (cached) return cached;
  // The code may be an expression or a function body using `value`, `row`, `ctx`.
  const body = /\breturn\b/.test(code) ? code : `return (${code});`;
  const fn = new Function('value', 'row', 'ctx', body) as JsFn;
  jsCache.set(code, fn);
  return fn;
}

export async function applyTransform(value: unknown, t: Transform, ctx: TransformContext): Promise<unknown> {
  if (Array.isArray(value) && !['default', 'js', 'ai', 'template', 'hash'].includes(t.type)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await applyTransform(v, t, ctx));
    return out;
  }
  const str = () => (value == null ? '' : String(value));
  switch (t.type) {
    case 'trim': return value == null ? value : str().trim();
    case 'lowercase': return value == null ? value : str().toLowerCase();
    case 'uppercase': return value == null ? value : str().toUpperCase();
    case 'collapseWhitespace': return value == null ? value : str().replace(/\s+/g, ' ').trim();
    case 'stripHtml': return value == null ? value : stripHtml(str());
    case 'regex': {
      if (value == null) return value;
      let flags = t.flags || '';
      if (t.all && !flags.includes('g')) flags += 'g';
      const re = new RegExp(t.pattern, flags);
      const pick = (m: RegExpMatchArray) => {
        if (t.group === undefined) return m[1] !== undefined ? m[1] : m[0];
        if (typeof t.group === 'number') return m[t.group] ?? null;
        return m.groups?.[t.group] ?? null;
      };
      if (t.all) {
        const all = Array.from(str().matchAll(re)).map(pick).filter((x) => x != null);
        return t.join !== undefined ? all.join(t.join) : all;
      }
      const m = str().match(re);
      return m ? pick(m) : null;
    }
    case 'replace': return value == null ? value : str().replace(new RegExp(t.pattern, t.flags ?? 'g'), t.replacement);
    case 'split': {
      if (value == null) return value;
      const parts = str().split(t.separator).map((p) => p.trim());
      return t.index === undefined ? parts : (parts[t.index < 0 ? parts.length + t.index : t.index] ?? null);
    }
    case 'substring': return value == null ? value : str().substring(t.start, t.end);
    case 'prefix': return value == null ? value : t.value + str();
    case 'suffix': return value == null ? value : str() + t.value;
    case 'default': return value == null || value === '' || (Array.isArray(value) && !value.length) ? t.value : value;
    case 'number': return parseNumber(value, t.decimal, t.thousands);
    case 'integer': { const n = parseNumber(value); return n == null ? null : Math.trunc(n); }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const truthy = (t.truthy ?? ['true', 'yes', '1', 'y', 'on', 'in stock', 'available']).map((x) => x.toLowerCase());
      return truthy.includes(str().trim().toLowerCase());
    }
    case 'currency': return parseCurrency(value).amount;
    case 'date': {
      const iso = parseDate(value, t.inputFormat);
      return iso && t.outputFormat ? formatDate(iso, t.outputFormat) : iso;
    }
    case 'absoluteUrl': return value == null ? value : absoluteUrl(str(), ctx.pageUrl);
    case 'urlParam': {
      if (value == null) return value;
      try { return new URL(str(), ctx.pageUrl).searchParams.get(t.name); } catch { return null; }
    }
    case 'template': return interpolate(t.template, (name) => (name === 'value' ? value : name === 'pageUrl' ? ctx.pageUrl : ctx.row[name]));
    case 'map': return value == null ? value : (t.mapping[str()] ?? t.fallback ?? value);
    case 'hash': return createHash(t.algorithm).update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
    case 'js': return compileJs(t.code)(value, ctx.row, { pageUrl: ctx.pageUrl });
    case 'ai': {
      if (!ctx.ai) throw new Error('AI transform requested but no AI provider is configured');
      if (value == null || value === '') return value;
      return ctx.ai(t.prompt, value, t.schema, t.provider);
    }
  }
}

export async function applyTransforms(value: unknown, transforms: Transform[], ctx: TransformContext): Promise<unknown> {
  let v = value;
  for (const t of transforms) v = await applyTransform(v, t, ctx);
  return v;
}
