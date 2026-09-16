/**
 * AI service: per-field extraction, transforms, selector healing, field suggestion and
 * natural-language recipe generation. Everything goes through LlmProvider so it works with
 * Anthropic or a local model.
 */
import type { LlmProvider } from './provider.js';
import { cleanHtml, htmlToMarkdown, htmlToText } from './clean.js';
import type { Field, Recipe, SelectorCandidate } from '../recipe/schema.js';
import { Logger } from '../util/logger.js';
import { chunk } from '../util/misc.js';

export interface AiUsage { calls: number; inputTokens: number; outputTokens: number }

export class AiService {
  readonly usage: AiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  private providers = new Map<string, LlmProvider>();

  constructor(private defaultProvider: LlmProvider, private log: Logger = new Logger('info', 'ai')) {
    this.providers.set(defaultProvider.name, defaultProvider);
  }

  addProvider(p: LlmProvider) { this.providers.set(p.name, p); }
  provider(name?: string): LlmProvider { return (name && this.providers.get(name)) || this.defaultProvider; }

  private async call(providerName: string | undefined, opts: Parameters<LlmProvider['complete']>[0]) {
    const p = this.provider(providerName);
    const r = await p.complete(opts);
    this.usage.calls++; this.usage.inputTokens += r.inputTokens ?? 0; this.usage.outputTokens += r.outputTokens ?? 0;
    return r;
  }

  /** Extract one value from content according to an instruction. */
  async extract(prompt: string, content: unknown, schema?: Record<string, unknown>, providerName?: string): Promise<unknown> {
    const [v] = await this.extractBatch(prompt, [content], schema, providerName);
    return v;
  }

  /** Extract values for many inputs in as few calls as possible (batches of up to 12 items). */
  async extractBatch(prompt: string, inputs: unknown[], schema?: Record<string, unknown>, providerName?: string): Promise<unknown[]> {
    const out: unknown[] = new Array(inputs.length).fill(null);
    const idx = inputs.map((v, i) => ({ v, i })).filter((x) => x.v != null && x.v !== '');
    for (const batch of chunk(idx, 12)) {
      const items = batch.map((x, j) => `### ITEM ${j}\n${toText(x.v).slice(0, 6000)}`).join('\n\n');
      const itemSchema = schema ?? { type: 'string' };
      const resultSchema = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { item: { type: 'integer' }, value: itemSchema }, required: ['item', 'value'], additionalProperties: false } } }, required: ['results'], additionalProperties: false };
      const r = await this.call(providerName, {
        messages: [
          { role: 'system', content: 'You are a precise data extraction engine. For each ITEM apply the instruction and return the value. If the value is absent, return null (or an empty string when the schema is a string). Never invent data. Output JSON only.' },
          { role: 'user', content: `Instruction: ${prompt}\n\n${items}\n\nReturn {"results":[{"item":<index>,"value":<value>}...]} with exactly ${batch.length} entries, in order.` },
        ],
        schema: resultSchema, maxTokens: 4096,
      });
      const j = r.json as { results?: Array<{ item: number; value: unknown }> } | undefined;
      if (!j?.results) { this.log.warn('AI batch returned no parsable JSON'); continue; }
      j.results.forEach((res, j2) => { const target = batch[typeof res.item === 'number' && batch[res.item] ? res.item : j2]; if (target) out[target.i] = res.value; });
    }
    return out;
  }

  async transform(prompt: string, value: unknown, schema?: Record<string, unknown>, providerName?: string): Promise<unknown> {
    return this.extract(prompt, value, schema, providerName);
  }

  /** Suggest a replacement selector for a field whose candidates all failed. */
  async healSelector(opts: { html: string; url: string; field: Field; listSelector?: string; sampleValues?: unknown[]; providerName?: string }): Promise<SelectorCandidate[]> {
    const compact = cleanHtml(opts.html, opts.url, { stripChrome: false, maxChars: 50_000 });
    const schema = { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object', properties: { css: { type: 'string' }, reason: { type: 'string' } }, required: ['css', 'reason'], additionalProperties: false } } }, required: ['candidates'], additionalProperties: false };
    const r = await this.call(opts.providerName, {
      messages: [
        { role: 'system', content: 'You repair CSS selectors for a web scraper after a site layout change. Return up to 3 CSS selectors, most robust first. Prefer semantic attributes (itemprop, data-*, aria-*, stable class names). Avoid generated class names (random hashes) and nth-child unless unavoidable. Output JSON only.' },
        { role: 'user', content: `Field "${opts.field.name}" (type ${opts.field.type}${opts.field.attr ? ', attr ' + opts.field.attr : ''}).\nOld selectors: ${opts.field.selector?.map((c) => c.value).join(' | ')}\n${opts.listSelector ? `Selector is relative to each record matched by: ${opts.listSelector}\n` : ''}${opts.sampleValues?.length ? `Example values from earlier runs: ${JSON.stringify(opts.sampleValues.slice(0, 5))}\n` : ''}${opts.field.description ? `Description: ${opts.field.description}\n` : ''}\nHTML:\n${compact}` },
      ],
      schema, maxTokens: 800,
    });
    const j = r.json as { candidates?: Array<{ css: string; reason: string }> } | undefined;
    return (j?.candidates ?? []).filter((c) => c.css).map((c, i) => ({ kind: 'css' as const, value: c.css, score: 50 - i, note: `ai: ${c.reason}` }));
  }

  /** Suggest a record selector + fields for a page (used by the recorder "auto-detect" and NL generation). */
  async suggestFields(opts: { html: string; url: string; instruction?: string; providerName?: string }): Promise<{ list?: { selector: string; fields: Array<{ name: string; selector: string; type: Field['type']; attr?: string }> }; pageFields: Array<{ name: string; selector: string; type: Field['type']; attr?: string }>; pagination?: { type: 'next' | 'loadMore' | 'scroll'; selector?: string }; notes?: string }> {
    const compact = cleanHtml(opts.html, opts.url, { stripChrome: false, maxChars: 60_000 });
    const fieldSchema = { type: 'object', properties: { name: { type: 'string' }, selector: { type: 'string' }, type: { type: 'string', enum: ['text', 'href', 'src', 'attr', 'html', 'email', 'phone'] }, attr: { type: ['string', 'null'] } }, required: ['name', 'selector', 'type', 'attr'], additionalProperties: false };
    const schema = {
      type: 'object',
      properties: {
        list: { type: ['object', 'null'], properties: { selector: { type: 'string' }, fields: { type: 'array', items: fieldSchema } }, required: ['selector', 'fields'], additionalProperties: false },
        pageFields: { type: 'array', items: fieldSchema },
        pagination: { type: ['object', 'null'], properties: { type: { type: 'string', enum: ['next', 'loadMore', 'scroll'] }, selector: { type: ['string', 'null'] } }, required: ['type', 'selector'], additionalProperties: false },
        notes: { type: 'string' },
      },
      required: ['list', 'pageFields', 'pagination', 'notes'], additionalProperties: false,
    };
    const r = await this.call(opts.providerName, {
      messages: [
        { role: 'system', content: 'You design web-scraping configurations. Given page HTML, identify the repeating records (if any) and the most useful fields, expressed as CSS selectors. Record field selectors must be RELATIVE to the record element. Use snake_case field names. Prefer stable, semantic selectors. If the page is a single item (detail page), return list null and use pageFields. Identify pagination controls when present. Output JSON only.' },
        { role: 'user', content: `${opts.instruction ? `User goal: ${opts.instruction}\n\n` : ''}URL: ${opts.url}\n\nHTML:\n${compact}` },
      ],
      schema, maxTokens: 2000,
    });
    const j = (r.json ?? { pageFields: [] }) as Awaited<ReturnType<AiService['suggestFields']>>;
    return j;
  }

  /** Turn a natural-language request + sample page into a Recipe draft. */
  async generateRecipe(opts: { url: string; html: string; instruction: string; providerName?: string }): Promise<Partial<Recipe>> {
    const s = await this.suggestFields({ html: opts.html, url: opts.url, instruction: opts.instruction, providerName: opts.providerName });
    const mkField = (f: { name: string; selector: string; type: Field['type']; attr?: string | null }): Field => ({
      name: f.name, type: f.type, selector: [{ kind: 'css', value: f.selector, score: 40, note: 'ai' }], attr: f.attr ?? undefined, multiple: false, scope: 'record', transforms: [], required: false,
    } as Field);
    const template: Recipe['templates'][string] = {
      actions: [], fields: s.pageFields.map(mkField), follow: [],
      list: s.list ? { selector: [{ kind: 'css', value: s.list.selector, score: 40, note: 'ai' }], fields: s.list.fields.map(mkField), follow: [], minItems: 1 } : undefined,
      pagination: s.pagination?.type === 'next' && s.pagination.selector ? { type: 'next', selector: [{ kind: 'css', value: s.pagination.selector }], maxPages: -1, stopWhenNoNewRows: true, method: 'auto' }
        : s.pagination?.type === 'loadMore' && s.pagination.selector ? { type: 'loadMore', selector: [{ kind: 'css', value: s.pagination.selector }], maxClicks: -1, delayMs: 1000, stopWhenNoNewRows: true }
        : s.pagination?.type === 'scroll' ? { type: 'scroll', maxScrolls: -1, delayMs: 1000, stopWhenNoNewRows: true } : undefined,
    } as Recipe['templates'][string];
    return { version: 1, name: opts.instruction.slice(0, 60), description: s.notes, entry: { urls: [opts.url], template: 'main', method: 'GET' }, templates: { main: template } } as Partial<Recipe>;
  }

  /** Free-form question over a page (used by MCP / agents). */
  async ask(opts: { html: string; url: string; question: string; schema?: Record<string, unknown>; providerName?: string }): Promise<unknown> {
    const md = htmlToMarkdown(opts.html, opts.url, { maxChars: 80_000 });
    const r = await this.call(opts.providerName, {
      messages: [
        { role: 'system', content: 'Answer strictly from the page content provided. If the information is not present say so. Output JSON when a schema is given.' },
        { role: 'user', content: `Page: ${opts.url}\n\n${md}\n\nQuestion: ${opts.question}` },
      ],
      schema: opts.schema, maxTokens: 2000,
    });
    return opts.schema ? r.json : r.text;
  }
}

function toText(v: unknown): string {
  if (typeof v === 'string') return /<[a-z][\s\S]*>/i.test(v) ? htmlToText(v) : v;
  return JSON.stringify(v);
}
