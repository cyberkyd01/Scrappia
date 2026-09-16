/**
 * Copilot: a conversational agent that builds and runs recipes for the user.
 *
 * It works with ANY LlmProvider (Anthropic or OpenAI-compatible, including local models) because
 * every turn is a structured JSON reply: `{ reply, calls: [{ tool, args }], done }`. The host
 * (desktop recorder, server, tests) executes the tool calls against the live page / recipe and the
 * loop continues until the model has nothing more to do or is waiting for the user (e.g. after
 * enabling element picking).
 *
 * Two ways of working, both supported by the same tool set:
 *  - autonomous: "scrape all products with name and price" -> get_page, detect_lists, set_list,
 *    preview, set_pagination, test_run, start_run
 *  - interactive: "let's start" -> enable_picking -> user clicks elements -> `picked` events arrive
 *    -> the copilot proposes fields / asks "detail pages? next page? what's next?"
 */
import type { Action, Field, Pagination, Recipe, RecipeInput, Selector, SelectorCandidate, Sink, Template, Transform } from '../recipe/schema.js';
import { Recipe as RecipeSchema, Sink as SinkSchema, Action as ActionSchema, Pagination as PaginationSchema, safeParseRecipe } from '../recipe/schema.js';
import type { LlmProvider } from './provider.js';
import type { DetectedList, InspectorMode, PickedElement } from '../inspector/protocol.js';
import type { RunStats } from '../engine/events.js';
import { Logger } from '../util/logger.js';

// ---------- host interface ----------

export interface CopilotPreview { records: Array<Record<string, unknown>>; page: Record<string, unknown>; listMatched: number; fieldMatches: Record<string, { candidate: number; matched: number }> }

export interface CopilotHost {
  /** Current page (null when no browser page is open). */
  page(): Promise<{ url: string; title: string } | null>;
  /** Compact page content for the model. */
  pageContent(opts: { maxChars: number; format: 'markdown' | 'html' }): Promise<string>;
  detectLists(): Promise<DetectedList[]>;
  /** Enable a picking mode in the recorder; the user's picks arrive later as `picked` events. */
  setPickMode(mode: InspectorMode, instruction: string): Promise<void>;
  testSelector(selectors: SelectorCandidate[], scope?: SelectorCandidate[]): Promise<{ count: number; samples: string[] }>;
  previewExtract(template: Template, recipe: Recipe): Promise<CopilotPreview>;
  navigate(url: string): Promise<{ url: string; title: string }>;
  runActions(actions: Action[]): Promise<void>;
  testRun(recipe: Recipe, maxRequests: number): Promise<{ stats: Partial<RunStats>; rows: Array<Record<string, unknown>>; drift: string[]; status: string }>;
  startRun(recipe: Recipe): Promise<{ runId: string }>;
  saveRecipe(recipe: Recipe): Promise<{ id: string }>;
  secretNames(): Promise<string[]>;
  sinkTypes(): string[];
}

// ---------- events / results ----------

export type CopilotEvent =
  | { type: 'picked'; element: PickedElement }
  | { type: 'list.detected'; list: DetectedList }
  | { type: 'navigated'; url: string }
  | { type: 'run.finished'; runId: string; status: string; rows: number };

export type CopilotProgress =
  | { type: 'thinking' }
  | { type: 'call'; tool: string; args: Record<string, unknown> }
  | { type: 'result'; tool: string; ok: boolean; summary: string }
  | { type: 'reply'; text: string };

export interface CopilotTurnInput { message?: string; event?: CopilotEvent; recipe: RecipeInput | Recipe }

export interface CopilotTurnResult {
  reply: string;
  recipe: Recipe;
  /** UI side-effects requested during the turn (already executed by the host, listed for the UI). */
  actions: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }>;
  /** true when the copilot is waiting for the user to pick elements */
  waitingForPicks: boolean;
  /** set when a full run was started */
  runId?: string;
  done: boolean;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

export interface CopilotMessage { role: 'user' | 'assistant'; content: string }

export interface CopilotOptions {
  provider: LlmProvider;
  host: CopilotHost;
  logger?: Logger;
  maxRounds?: number;
  onProgress?: (p: CopilotProgress) => void;
  /** Extra guidance appended to the system prompt (e.g. user preferences). */
  extraInstructions?: string;
  model?: string;
}

// ---------- tool definitions (documentation shown to the model) ----------

const TOOL_DOCS: Array<{ name: string; args: string; doc: string; blocking?: boolean }> = [
  { name: 'get_page', args: '{ "maxChars"?: number, "format"?: "markdown"|"html" }', doc: 'Read the current page (URL, title, cleaned content) to understand its structure.' },
  { name: 'detect_lists', args: '{}', doc: 'Auto-detect repeating records on the page: returns candidate lists with record selector, count and suggested fields (name, type, selector relative to the record, samples, coverage).' },
  { name: 'enable_picking', args: '{ "mode": "pickList"|"pick"|"pickAction", "instruction": string }', doc: 'Turn on element picking in the browser so the USER clicks elements. Use pickList for repeating records, pick for single fields (title, price, next-page link), pickAction for buttons/inputs. After calling this STOP and wait; picks arrive as events.', blocking: true },
  { name: 'disable_picking', args: '{}', doc: 'Turn picking off so the user can browse normally.' },
  { name: 'test_selector', args: '{ "selector": string|string[], "scope"?: string }', doc: 'Count matches of a selector on the page (optionally inside each record matched by scope) and return sample texts. Use to verify before setting fields.' },
  { name: 'get_recipe', args: '{}', doc: 'Return the full current recipe JSON.' },
  { name: 'set_entry', args: '{ "urls": string[], "template"?: string, "method"?: "GET"|"POST", "body"?: string }', doc: 'Set start URLs (defaults to the current page) and the entry template.' },
  { name: 'set_keywords', args: '{ "lists": { "name": string[] }, "mode"?: "product"|"zip" }', doc: 'Keyword lists substituted as {{name}} in URLs, POST bodies and typed text.' },
  { name: 'set_list', args: '{ "template"?: string, "selector": string|string[], "fields": [{ "name": string, "type"?: string, "selector": string|string[], "attr"?: string, "transforms"?: (string|object)[], "multiple"?: boolean }], "minItems"?: number }', doc: 'Define the repeating records of a template (default: the entry template) and their fields. Field selectors are RELATIVE to the record; ":scope" means the record itself. Types: text, href, src, attr, html, email, phone, regex, image, count, exists, ai, json, table.' },
  { name: 'add_fields', args: '{ "template"?: string, "scope"?: "record"|"page", "fields": [ ...same as set_list ] }', doc: 'Add fields to a template: record fields (inside the list) or page fields (once per page, e.g. on detail pages).' },
  { name: 'update_field', args: '{ "template"?: string, "name": string, "patch": object }', doc: 'Change a field (rename via patch.name, selector, type, transforms, required...).' },
  { name: 'remove_field', args: '{ "template"?: string, "name": string }', doc: 'Remove a field.' },
  { name: 'set_pagination', args: '{ "template"?: string, "pagination": { "type": "next"|"pageLinks"|"loadMore"|"scroll"|"urlPattern"|"urlList"|"script", ... } }', doc: 'How to reach more pages. next: {selector, maxPages?, method?: "auto"|"href"|"click"}. pageLinks: {selector}. loadMore: {selector}. scroll: {}. urlPattern: {template: "https://x/?page={{page}}", start?}. urlList: {urls}. maxPages -1 = all.' },
  { name: 'clear_pagination', args: '{ "template"?: string }', doc: 'Remove pagination.' },
  { name: 'add_follow', args: '{ "template"?: string, "field"?: string, "selector"?: string, "target": string, "mode"?: "merge"|"nest"|"separate", "limit"?: number, "fields"?: [ page fields for the target template ] }', doc: 'Follow links into detail pages: from a record field holding a URL (field) or from links matched on the page (selector, e.g. category links). Creates the target template if needed; "fields" become its page fields. merge = detail columns added to the parent row.' },
  { name: 'add_action', args: '{ "template"?: string, "action": { "type": "click"|"type"|"select"|"hover"|"scroll"|"wait"|"waitFor"|"script"|"press"|"solveCaptcha", ... }, "index"?: number }', doc: 'Add a pre-extraction step (close cookie banner, type keyword and submit, wait for content). Examples: {"type":"click","selector":"#accept"}, {"type":"type","selector":"input[name=q]","text":"{{q}}","submit":true}, {"type":"waitFor","selector":".results"}.' },
  { name: 'clear_actions', args: '{ "template"?: string }', doc: 'Remove all actions of a template.' },
  { name: 'set_template', args: '{ "template": string, "patch": { "waitFor"?: string, "mode"?: "http"|"browser", "dataset"?: string, "description"?: string } }', doc: 'Template options.' },
  { name: 'remove_template', args: '{ "template": string }', doc: 'Delete a template (and follows pointing to it).' },
  { name: 'configure', args: '{ "section": "engine"|"output"|"monitor"|"schedule"|"ai", "patch": object }', doc: 'Deep-merge settings. engine: mode(http|browser|auto), headless, concurrency, delayMs, timeoutMs, retries, respectRobots, blockResources, proxy{urls,rotate}, captcha{provider,apiKeyRef}, session{persist,profile}, maxRequests, maxRows. output: keys[], dedupe, validation[{field,rule,value,action}], addPageUrl, addTimestamp, addKeyword, addCategoryPath. monitor: enabled, on[], channels[], thresholdPercent. schedule: cron, tz. ai: provider, selfHeal.' },
  { name: 'add_sink', args: '{ "sink": { "type": string, ... } }', doc: 'Add an export. xlsx/csv/json/jsonl/xml/parquet: {path, mode?: overwrite|append|upsert, key?}. sqlite: {path, table}. postgres/mysql: {connectionRef, table}. google-sheets: {credentialRef, spreadsheetId, sheet?}. airtable: {credentialRef, baseId, table}. notion: {credentialRef, databaseId}. s3: {credentialRef, bucket, keyTemplate}. webhook: {url, secretRef?}. credentialRef/connectionRef must be secret NAMES (see list_secrets).' },
  { name: 'remove_sink', args: '{ "index": number }', doc: 'Remove an export by index.' },
  { name: 'rename_recipe', args: '{ "name"?: string, "description"?: string, "tags"?: string[] }', doc: 'Name/describe the recipe.' },
  { name: 'set_recipe_json', args: '{ "recipe": object }', doc: 'Replace the whole recipe (advanced; validated).' },
  { name: 'preview', args: '{ "template"?: string }', doc: 'Extract the current page with a template and return sample records plus per-field match statistics. ALWAYS do this after set_list/add_fields to verify.' },
  { name: 'navigate', args: '{ "url": string }', doc: 'Open a URL in the recorder browser (e.g. a detail page to define its fields).' },
  { name: 'run_actions', args: '{ "actions": [action...] }', doc: 'Perform actions live on the page now (test a click / typing).' },
  { name: 'test_run', args: '{ "maxRequests"?: number }', doc: 'Dry run of the whole recipe limited to a few pages (default 3): returns stats, drift and sample rows. No exports. Use before start_run.' },
  { name: 'start_run', args: '{}', doc: 'Start the full run with exports and monitoring. Only after the user agreed (or asked to run). Afterwards tell the user where results will appear and set done=true.' },
  { name: 'save_recipe', args: '{ "name"?: string }', doc: 'Save the recipe to the library (needed for schedules and the server).' },
  { name: 'list_secrets', args: '{}', doc: 'Names of stored secrets usable as credentialRef/connectionRef/apiKeyRef.' },
  { name: 'list_sink_types', args: '{}', doc: 'Available export types.' },
];

const TOOL_NAMES = TOOL_DOCS.map((t) => t.name);
const BLOCKING = new Set(TOOL_DOCS.filter((t) => t.blocking).map((t) => t.name));

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What to say to the user now (short, friendly, concrete). Empty string only when you will keep working silently.' },
    calls: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string', enum: TOOL_NAMES }, args: { type: 'string', description: 'JSON object string with the tool arguments' } }, required: ['tool', 'args'], additionalProperties: false } },
    done: { type: 'boolean', description: 'true when the whole job is complete (recipe finished and run started or user is finished)' },
  },
  required: ['reply', 'calls', 'done'],
  additionalProperties: false,
};

// ---------- system prompt ----------

function systemPrompt(extra?: string): string {
  const tools = TOOL_DOCS.map((t) => `- ${t.name} ${t.args}\n  ${t.doc}`).join('\n');
  return `You are Scrappia Copilot, an expert web-scraping assistant embedded in a visual scraper. The user has a website open in the recorder browser. Your job is to build a complete, correct scraping recipe for what the user wants, verify it, and run it, either fully on your own from the user's description or interactively with the user picking elements.

You answer ONLY with JSON: {"reply": string, "calls": [{"tool": string, "args": "<json string>"}], "done": boolean}. Tool results come back in the next message as "[Tool results]". Keep "reply" short (1-3 sentences), specific, and end with a clear question or the next step when the job is not finished.

## Tools
${tools}

## How to work
1. Understand the goal. If unclear, ask ONE precise question (what to extract, from which pages, how many pages, which output).
2. Look before you act: get_page and/or detect_lists. Prefer detect_lists for listings; it gives selectors and sample values.
3. Autonomous mode (user says "do it", "scrape all X", gives a full description): set_list with sensible fields (snake_case names; price -> transforms ["currency"]; links -> type href; images -> type src), then preview to verify coverage; fix empty fields (test_selector, adjust); set_pagination when the page has next/load-more/scroll; add_follow for detail pages when the user wants fields that only exist there (navigate to one detail page first and preview its fields); configure output.keys with a unique field (url) for dedupe; add an export (default xlsx named after the recipe) unless the user chose one; test_run; then ask the user for permission to start_run unless they already said to run everything.
4. Interactive mode (user wants to pick, or the page is ambiguous): explain what to click, call enable_picking, then STOP. When "[Event] picked" arrives, convert it into fields (use element.relativeSelectors for record fields and element.record.selector for the list; suggested fields from element.record.fields are good defaults), confirm with preview, and ask what is next: more fields, detail pages ("click into each item?"), next page / load more / infinite scroll, keyword search, outputs, schedule.
5. Follow the classic flow: records & fields -> detail pages -> pagination -> outputs -> test_run -> run. Skip steps the user does not need.
6. Verify everything with preview / test_selector / test_run. Never claim data was extracted without a preview result. If preview shows 0 records, try alternative selectors from detect_lists before asking the user.
7. Settings: you have access to all recipe settings via configure/add_sink/set_keywords/add_action. Use engine.mode "browser" for JavaScript-heavy pages, session.persist for logged-in sites, delayMs/concurrency to be polite, monitor for change alerts, schedule for recurring runs. Secrets are referenced by NAME only; never ask the user to paste passwords into chat, tell them to add a secret in Settings and give you its name.
8. Safety: start_run only after the user's OK or explicit instruction; keep replies honest about what is verified.
9. Field types: text (default), href (links), src (images), attr (+attr), email, phone, regex (+pattern), image (download), ai (+prompt), count, exists. Transforms: trim, currency, number, integer, boolean, date, regex{pattern}, replace{pattern,replacement}, split{separator,index}, template{template}, absoluteUrl, ai{prompt}.
${extra ? `\n## Additional instructions\n${extra}\n` : ''}`;
}

// ---------- helpers ----------

export function toSelector(v: unknown): Selector {
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === 'string' ? candidate(x) : x)).filter((c): c is SelectorCandidate => !!c && typeof (c as SelectorCandidate).value === 'string');
    if (out.length) return out;
  }
  if (typeof v === 'string' && v.trim()) return [candidate(v)];
  if (v && typeof v === 'object' && typeof (v as SelectorCandidate).value === 'string') return [v as SelectorCandidate];
  throw new Error('selector must be a string, a string array or selector candidates');
}
function candidate(s: string): SelectorCandidate {
  const t = s.trim();
  if (/^xpath:/i.test(t)) return { kind: 'xpath', value: t.slice(6) };
  if (/^text:/i.test(t)) return { kind: 'text', value: t.slice(5) };
  if (/^role:/i.test(t)) return { kind: 'role', value: t.slice(5) };
  if (/^(\/|\.\/|\(\/)/.test(t)) return { kind: 'xpath', value: t };
  return { kind: 'css', value: t };
}

function toTransform(t: unknown): Transform {
  if (typeof t === 'string') return { type: t } as Transform;
  return t as Transform;
}

export function toField(raw: Record<string, unknown>): Field {
  const f: Record<string, unknown> = { ...raw };
  if (f.selector !== undefined) f.selector = toSelector(f.selector);
  if (Array.isArray(f.transforms)) f.transforms = f.transforms.map(toTransform);
  if (!f.name) throw new Error('field needs a name');
  f.name = String(f.name).trim().replace(/\s+/g, '_');
  if (!f.type) f.type = 'text';
  if ((f.type === 'href' || f.type === 'src') && !f.selector) f.selector = [{ kind: 'css', value: ':scope' }];
  return f as unknown as Field;
}

function normalizePagination(p: Record<string, unknown>): Pagination {
  const out: Record<string, unknown> = { ...p };
  if (out.selector !== undefined) out.selector = toSelector(out.selector);
  if (out.type === 'urlPattern' && typeof out.template === 'string') out.template = (out.template as string).replace(/%%pagenumber%%/g, '{{page}}');
  return PaginationSchema.parse(out);
}

function normalizeAction(a: Record<string, unknown>): Action {
  const out: Record<string, unknown> = { ...a };
  for (const k of ['selector', 'whileSelector']) if (out[k] !== undefined) out[k] = toSelector(out[k]);
  if (Array.isArray(out.actions)) out.actions = out.actions.map((x) => normalizeAction(x as Record<string, unknown>));
  return ActionSchema.parse(out);
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}

function compactJson(v: unknown, max = 6000): string {
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
}

function summarizePick(e: PickedElement): Record<string, unknown> {
  return {
    tag: e.tag, text: e.text.slice(0, 120), href: e.href, src: e.src, suggestedType: e.suggestedType, suggestedName: e.suggestedName,
    selectors: e.selectors.slice(0, 3).map((s) => s.value), relativeSelectors: e.relativeSelectors?.slice(0, 3).map((s) => s.value),
    record: e.record ? { selector: e.record.selector.slice(0, 2).map((s) => s.value), count: e.record.count, fields: e.record.fields.slice(0, 12).map((f) => ({ name: f.name, type: f.type, attr: f.attr, selector: f.selector[0]?.value, sample: f.samples[0], coverage: f.coverage })) } : undefined,
  };
}

function summarizeList(l: DetectedList): Record<string, unknown> {
  return { selector: l.selector.slice(0, 3).map((s) => s.value), count: l.count, fields: l.fields.slice(0, 15).map((f) => ({ name: f.name, type: f.type, attr: f.attr, selector: f.selector[0]?.value, samples: f.samples.slice(0, 2), coverage: f.coverage })), alternatives: l.alternatives?.slice(0, 4).map((a) => ({ selector: a.selector[0]?.value, count: a.count })) };
}

// ---------- the session ----------

export class CopilotSession {
  readonly history: CopilotMessage[] = [];
  private recipe!: Recipe;
  private log: Logger;
  private lastPreview?: { template: string; records: number; empties: string[] };
  private usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  private busy = false;

  constructor(private opts: CopilotOptions) { this.log = (opts.logger ?? new Logger('info')).child('copilot'); }

  get currentRecipe(): Recipe { return this.recipe; }

  /** Restore history (e.g. when the desktop re-creates the session). */
  load(history: CopilotMessage[]) { this.history.splice(0, this.history.length, ...history); }

  async turn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    if (this.busy) throw new Error('copilot is busy with the previous turn');
    this.busy = true;
    try {
      this.recipe = this.parse(input.recipe);
      if (input.event) this.history.push({ role: 'user', content: this.eventText(input.event) });
      if (input.message) this.history.push({ role: 'user', content: input.message });
      if (!input.event && !input.message) throw new Error('nothing to do: message or event required');

      const actions: CopilotTurnResult['actions'] = [];
      let waitingForPicks = false; let runId: string | undefined; let done = false; let reply = '';
      const maxRounds = this.opts.maxRounds ?? 8;
      for (let round = 0; round < maxRounds; round++) {
        this.opts.onProgress?.({ type: 'thinking' });
        const turn = await this.ask();
        reply = turn.reply;
        done = turn.done;
        if (!turn.calls.length) break;
        const results: Array<{ tool: string; ok: boolean; result: unknown }> = [];
        let blocked = false;
        for (const call of turn.calls) {
          const args = parseArgs(call.args);
          this.opts.onProgress?.({ type: 'call', tool: call.tool, args });
          let ok = true; let result: unknown;
          try { result = await this.execute(call.tool, args); }
          catch (e) { ok = false; result = { error: (e as Error).message }; }
          const summary = summarizeResult(call.tool, ok, result);
          actions.push({ tool: call.tool, args, ok, summary });
          this.opts.onProgress?.({ type: 'result', tool: call.tool, ok, summary });
          results.push({ tool: call.tool, ok, result });
          if (ok && call.tool === 'enable_picking') waitingForPicks = true;
          if (ok && call.tool === 'start_run') runId = (result as { runId: string }).runId;
          if (ok && BLOCKING.has(call.tool)) { blocked = true; }
        }
        this.history.push({ role: 'user', content: `[Tool results]\n${results.map((r) => `${r.tool}: ${compactJson(r.result, 5000)}`).join('\n')}` });
        if (blocked) {
          // Let the model phrase its message after a blocking action if it said nothing
          if (!reply.trim()) { const t = await this.ask(); reply = t.reply; done = t.done; }
          break;
        }
        if (round === maxRounds - 1) reply = reply || 'I have done several steps; tell me how you would like to continue.';
      }
      if (reply.trim()) this.history.push({ role: 'assistant', content: reply });
      this.opts.onProgress?.({ type: 'reply', text: reply });
      this.trimHistory();
      return { reply, recipe: this.recipe, actions, waitingForPicks, runId, done, usage: { ...this.usage } };
    } finally { this.busy = false; }
  }

  // ---------- model call ----------

  private async ask(): Promise<{ reply: string; calls: Array<{ tool: string; args: string }>; done: boolean }> {
    const context = await this.contextBlock();
    const messages = [
      { role: 'system' as const, content: systemPrompt(this.opts.extraInstructions) },
      ...this.history.slice(0, -1),
      // the freshest context goes right before the last user message so it is never stale
      { role: 'user' as const, content: `[Context]\n${context}` },
      this.history[this.history.length - 1],
    ];
    // The last message must be from the user; when it is an assistant reply (e.g. an event was
    // pushed after) the ordering above still ends with the pushed user message.
    const r = await this.opts.provider.complete({ messages, schema: TURN_SCHEMA, maxTokens: 2000, model: this.opts.model, temperature: 0 });
    this.usage.calls++; this.usage.inputTokens += r.inputTokens ?? 0; this.usage.outputTokens += r.outputTokens ?? 0;
    const j = (r.json ?? {}) as { reply?: unknown; calls?: unknown; done?: unknown };
    const calls = Array.isArray(j.calls) ? j.calls.filter((c): c is { tool: string; args: string } => !!c && typeof (c as { tool?: unknown }).tool === 'string').map((c) => ({ tool: c.tool, args: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) })) : [];
    const reply = typeof j.reply === 'string' ? j.reply : r.text && !r.json ? r.text : '';
    // Record what the model decided so the next round has its own plan in context
    this.history.push({ role: 'assistant', content: JSON.stringify({ reply, calls, done: !!j.done }) });
    return { reply, calls, done: !!j.done };
  }

  private async contextBlock(): Promise<string> {
    const page = await this.opts.host.page().catch(() => null);
    const r = this.recipe;
    const summary = {
      name: r.name, entry: r.entry, keywords: Object.keys(r.keywords).length ? r.keywords : undefined,
      templates: Object.fromEntries(Object.entries(r.templates).map(([n, t]) => [n, {
        actions: t.actions.length, fields: t.fields.map((f) => `${f.name}:${f.type}`), list: t.list ? { selector: t.list.selector[0]?.value, fields: t.list.fields.map((f) => `${f.name}:${f.type}`), follow: t.list.follow.map((f) => `${f.field ?? f.selector?.[0]?.value}->${f.template}(${f.mode})`) } : undefined,
        follow: t.follow.map((f) => `${f.selector?.[0]?.value ?? f.field}->${f.template}`), pagination: t.pagination ? t.pagination.type : undefined,
      }])),
      engine: { mode: r.engine.mode, headless: r.engine.headless, concurrency: r.engine.concurrency, delayMs: r.engine.delayMs, session: r.engine.session.persist ? r.engine.session.profile : undefined, proxies: r.engine.proxy.urls.length, captcha: r.engine.captcha.provider },
      output: { keys: r.output.keys, validation: r.output.validation.length }, sinks: r.sinks.map((s) => ('path' in s ? `${s.type}:${s.path}` : s.type)), monitor: r.monitor.enabled, schedule: r.schedule?.cron,
    };
    return [
      `Page: ${page ? `${page.url} (${page.title})` : 'no page open'}`,
      `Recipe: ${compactJson(summary, 3000)}`,
      this.lastPreview ? `Last preview: template ${this.lastPreview.template}, ${this.lastPreview.records} records, empty fields: ${this.lastPreview.empties.join(', ') || 'none'}` : '',
    ].filter(Boolean).join('\n');
  }

  private eventText(e: CopilotEvent): string {
    switch (e.type) {
      case 'picked': return `[Event] picked: ${compactJson(summarizePick(e.element), 4000)}`;
      case 'list.detected': return `[Event] list.detected: ${compactJson(summarizeList(e.list), 4000)}`;
      case 'navigated': return `[Event] navigated: ${e.url}`;
      case 'run.finished': return `[Event] run.finished: ${JSON.stringify(e)}`;
    }
  }

  private trimHistory() {
    const MAX = 60;
    if (this.history.length > MAX) this.history.splice(0, this.history.length - MAX);
  }

  private parse(input: RecipeInput | Recipe): Recipe {
    const r = safeParseRecipe(input);
    if (!r.success) {
      // Fresh recipes from the UI may be skeletons; build the minimal valid one.
      const raw = input as Partial<RecipeInput>;
      const name = raw.name || 'Untitled';
      const fallback = safeParseRecipe({ ...raw, version: 1, name, entry: raw.entry?.urls?.length ? raw.entry : { urls: ['https://example.invalid/'], template: raw.entry?.template ?? 'main' }, templates: Object.keys(raw.templates ?? {}).length ? raw.templates : { main: {} } });
      if (!fallback.success) throw new Error(`invalid recipe: ${r.errors.join('; ')}`);
      return fallback.recipe;
    }
    return r.recipe;
  }

  // ---------- tools ----------

  private tpl(name?: string): { name: string; template: Template } {
    const n = name || this.recipe.entry.template;
    const t = this.recipe.templates[n];
    if (!t) throw new Error(`template "${n}" does not exist (have: ${Object.keys(this.recipe.templates).join(', ')})`);
    return { name: n, template: t };
  }

  /** Apply a mutation to a copy of the recipe; keep it only if it validates. */
  private mutate(fn: (r: RecipeInput) => void): { ok: true; recipe: Recipe } {
    const draft = JSON.parse(JSON.stringify(this.recipe)) as RecipeInput;
    fn(draft);
    const parsed = safeParseRecipe(draft);
    if (!parsed.success) throw new Error(`recipe invalid after change: ${parsed.errors.join('; ')}`);
    this.recipe = parsed.recipe;
    return { ok: true, recipe: this.recipe };
  }

  private async ensureEntryUrl() {
    if (this.recipe.entry.urls[0] === 'https://example.invalid/') {
      const p = await this.opts.host.page();
      if (p?.url) this.mutate((r) => { r.entry.urls = [p.url]; });
    }
  }

  private async execute(tool: string, a: Record<string, unknown>): Promise<unknown> {
    const host = this.opts.host;
    switch (tool) {
      case 'get_page': {
        const p = await host.page();
        const content = await host.pageContent({ maxChars: Number(a.maxChars ?? 12000), format: (a.format as 'markdown' | 'html') ?? 'markdown' });
        return { url: p?.url, title: p?.title, content };
      }
      case 'detect_lists': {
        const lists = await host.detectLists();
        return { lists: lists.slice(0, 5).map(summarizeList) };
      }
      case 'enable_picking': {
        const mode = String(a.mode ?? 'pick') as InspectorMode;
        if (!['pick', 'pickList', 'pickAction'].includes(mode)) throw new Error('mode must be pick, pickList or pickAction');
        await host.setPickMode(mode, String(a.instruction ?? ''));
        return { enabled: mode, note: 'Waiting for the user to click elements. Their picks will arrive as events.' };
      }
      case 'disable_picking': await host.setPickMode('off', ''); return { enabled: 'off' };
      case 'test_selector': {
        const sel = toSelector(a.selector);
        const scope = a.scope ? toSelector(a.scope) : undefined;
        return host.testSelector(sel, scope);
      }
      case 'get_recipe': return this.recipe;
      case 'set_entry': {
        const urls = Array.isArray(a.urls) ? a.urls.map(String) : a.urls ? [String(a.urls)] : [];
        if (!urls.length) { const p = await host.page(); if (p) urls.push(p.url); }
        this.mutate((r) => { r.entry = { ...r.entry, urls, template: (a.template as string) ?? r.entry.template, method: (a.method as 'GET' | 'POST') ?? r.entry.method, body: (a.body as string) ?? r.entry.body }; if (!r.templates![r.entry.template]) r.templates![r.entry.template] = {}; });
        return { entry: this.recipe.entry };
      }
      case 'set_keywords': {
        this.mutate((r) => { r.keywords = a.lists as Record<string, string[]>; if (a.mode) r.keywordMode = a.mode as 'product' | 'zip'; });
        return { keywords: this.recipe.keywords, mode: this.recipe.keywordMode };
      }
      case 'set_list': {
        await this.ensureEntryUrl();
        const name = (a.template as string) || this.recipe.entry.template;
        const selector = toSelector(a.selector);
        const fields = (Array.isArray(a.fields) ? a.fields : []).map((f) => toField(f as Record<string, unknown>));
        this.mutate((r) => { r.templates![name] = { ...(r.templates![name] ?? {}), list: { ...(r.templates![name]?.list ?? {}), selector, fields, minItems: (a.minItems as number) ?? 1, follow: r.templates![name]?.list?.follow ?? [] } }; });
        const pv = await this.preview(name);
        return { template: name, fields: fields.map((f) => f.name), preview: pv };
      }
      case 'add_fields': {
        const { name, template } = this.tpl(a.template as string);
        const scope = (a.scope as string) ?? (template.list ? 'record' : 'page');
        const fields = (Array.isArray(a.fields) ? a.fields : []).map((f) => toField(f as Record<string, unknown>));
        this.mutate((r) => {
          const t = r.templates![name];
          if (scope === 'record') { if (!t.list) throw new Error('template has no list; call set_list first or use scope "page"'); t.list.fields = [...(t.list.fields ?? []).filter((f) => !fields.some((n) => n.name === f.name)), ...fields]; }
          else t.fields = [...(t.fields ?? []).filter((f) => !fields.some((n) => n.name === f.name)), ...fields];
        });
        const pv = await this.preview(name);
        return { template: name, scope, fields: fields.map((f) => f.name), preview: pv };
      }
      case 'update_field': {
        const { name } = this.tpl(a.template as string);
        const target = String(a.name);
        const patch = (a.patch ?? {}) as Record<string, unknown>;
        if (patch.selector !== undefined) patch.selector = toSelector(patch.selector);
        if (Array.isArray(patch.transforms)) patch.transforms = patch.transforms.map(toTransform);
        let found = false;
        this.mutate((r) => {
          const t = r.templates![name];
          for (const list of [t.list?.fields, t.fields]) { const f = list?.find((x) => x.name === target); if (f) { Object.assign(f, patch); found = true; } }
        });
        if (!found) throw new Error(`field "${target}" not found in template ${name}`);
        return { updated: patch.name ?? target, preview: await this.preview(name) };
      }
      case 'remove_field': {
        const { name } = this.tpl(a.template as string);
        const target = String(a.name);
        this.mutate((r) => { const t = r.templates![name]; if (t.list) t.list.fields = (t.list.fields ?? []).filter((f) => f.name !== target); t.fields = (t.fields ?? []).filter((f) => f.name !== target); });
        return { removed: target };
      }
      case 'set_pagination': {
        const { name } = this.tpl(a.template as string);
        const p = normalizePagination((a.pagination ?? a) as Record<string, unknown>);
        this.mutate((r) => { r.templates![name].pagination = p; });
        let check: unknown;
        if ('selector' in p && p.selector) check = await host.testSelector(p.selector).catch(() => undefined);
        return { template: name, pagination: p, selectorMatches: check };
      }
      case 'clear_pagination': { const { name } = this.tpl(a.template as string); this.mutate((r) => { delete r.templates![name].pagination; }); return { cleared: true }; }
      case 'add_follow': {
        const { name, template } = this.tpl(a.template as string);
        const target = String(a.target ?? 'detail');
        const pageFields = (Array.isArray(a.fields) ? a.fields : []).map((f) => toField({ ...(f as Record<string, unknown>), scope: 'document' }));
        const follow: Record<string, unknown> = { template: target, mode: (a.mode as string) ?? 'merge', limit: a.limit, method: 'navigate' };
        if (a.field) follow.field = String(a.field); else if (a.selector) follow.selector = toSelector(a.selector); else throw new Error('add_follow needs "field" (a record field with the URL) or "selector"');
        this.mutate((r) => {
          const t = r.templates![name];
          if (!r.templates![target]) r.templates![target] = { fields: pageFields };
          else if (pageFields.length) r.templates![target].fields = [...(r.templates![target].fields ?? []), ...pageFields];
          if (follow.field) { if (!t.list) throw new Error('follow by field needs a list'); t.list.follow = [...(t.list.follow ?? []), follow as Template['list'] extends infer L ? L extends { follow: Array<infer F> } ? F : never : never]; }
          else t.follow = [...(t.follow ?? []), follow as Template['follow'][number]];
        });
        void template;
        return { from: name, to: target, follow, targetFields: pageFields.map((f) => f.name) };
      }
      case 'add_action': {
        const { name } = this.tpl(a.template as string);
        const action = normalizeAction((a.action ?? a) as Record<string, unknown>);
        this.mutate((r) => { const t = r.templates![name]; const list = [...(t.actions ?? [])]; const i = typeof a.index === 'number' ? a.index : list.length; list.splice(i, 0, action); t.actions = list; });
        return { template: name, actions: this.recipe.templates[name].actions.length };
      }
      case 'clear_actions': { const { name } = this.tpl(a.template as string); this.mutate((r) => { r.templates![name].actions = []; }); return { cleared: true }; }
      case 'set_template': {
        const { name } = this.tpl(a.template as string);
        const patch = (a.patch ?? {}) as Record<string, unknown>;
        if (patch.waitFor !== undefined) patch.waitFor = patch.waitFor ? toSelector(patch.waitFor) : undefined;
        this.mutate((r) => { Object.assign(r.templates![name], patch); });
        return { template: name, ...patch };
      }
      case 'remove_template': {
        const name = String(a.template);
        if (name === this.recipe.entry.template) throw new Error('cannot remove the entry template');
        this.mutate((r) => { delete r.templates![name]; for (const t of Object.values(r.templates!)) { t.follow = (t.follow ?? []).filter((f) => f.template !== name); if (t.list) t.list.follow = (t.list.follow ?? []).filter((f) => f.template !== name); } });
        return { removed: name };
      }
      case 'configure': {
        const section = String(a.section);
        if (!['engine', 'output', 'monitor', 'schedule', 'ai'].includes(section)) throw new Error('section must be engine|output|monitor|schedule|ai');
        const patch = (a.patch ?? {}) as Record<string, unknown>;
        this.mutate((r) => { const cur = (r as Record<string, unknown>)[section] as Record<string, unknown> | undefined; (r as Record<string, unknown>)[section] = deepMerge(cur ?? {}, patch); });
        return { [section]: (this.recipe as unknown as Record<string, unknown>)[section] };
      }
      case 'add_sink': {
        const raw = (a.sink ?? a) as Record<string, unknown>;
        if (!raw.type) throw new Error('sink needs a type');
        if (!raw.mode) raw.mode = 'overwrite';
        const sink = SinkSchema.parse(raw) as Sink;
        if ('credentialRef' in sink || 'connectionRef' in sink) {
          const ref = (sink as { credentialRef?: string; connectionRef?: string }).credentialRef ?? (sink as { connectionRef?: string }).connectionRef!;
          const names = await host.secretNames();
          if (!names.includes(ref)) return this.mutate((r) => { r.sinks = [...(r.sinks ?? []), sink]; }) && { added: sink, warning: `secret "${ref}" does not exist yet; ask the user to add it in Settings > Secrets` };
        }
        this.mutate((r) => { r.sinks = [...(r.sinks ?? []), sink]; });
        return { added: sink, sinks: this.recipe.sinks.length };
      }
      case 'remove_sink': { const i = Number(a.index); this.mutate((r) => { r.sinks = (r.sinks ?? []).filter((_, j) => j !== i); }); return { sinks: this.recipe.sinks.length }; }
      case 'rename_recipe': { this.mutate((r) => { if (a.name) r.name = String(a.name); if (a.description !== undefined) r.description = String(a.description); if (Array.isArray(a.tags)) r.tags = a.tags.map(String); }); return { name: this.recipe.name }; }
      case 'set_recipe_json': { const parsed = safeParseRecipe(a.recipe); if (!parsed.success) throw new Error(parsed.errors.join('; ')); this.recipe = parsed.recipe; return { ok: true }; }
      case 'preview': { const { name } = this.tpl(a.template as string); return this.preview(name); }
      case 'navigate': { const p = await host.navigate(String(a.url)); return p; }
      case 'run_actions': { const actions = (Array.isArray(a.actions) ? a.actions : [a.actions]).map((x) => normalizeAction(x as Record<string, unknown>)); await host.runActions(actions); const p = await host.page(); return { done: true, page: p }; }
      case 'test_run': {
        await this.ensureEntryUrl();
        const r = await host.testRun(this.recipe, Number(a.maxRequests ?? 3));
        return { status: r.status, stats: pick(r.stats, ['rows', 'pages', 'httpFetches', 'browserFetches', 'drift', 'healed', 'validationFlags']), failed: r.stats.requests?.failed, drift: r.drift.slice(0, 10), sampleRows: r.rows.slice(0, 5) };
      }
      case 'start_run': { await this.ensureEntryUrl(); if (!this.recipe.sinks.length) this.mutate((r) => { r.sinks = [{ type: 'xlsx', path: `exports/${slug(r.name!)}.xlsx`, mode: 'overwrite' }]; }); const r = await host.startRun(this.recipe); return { runId: r.runId, sinks: this.recipe.sinks.map((s) => ('path' in s ? s.path : s.type)) }; }
      case 'save_recipe': { if (a.name) this.mutate((r) => { r.name = String(a.name); }); const r = await host.saveRecipe(this.recipe); this.mutate((x) => { x.id = r.id; }); return { id: r.id, name: this.recipe.name }; }
      case 'list_secrets': return { secrets: await host.secretNames() };
      case 'list_sink_types': return { types: host.sinkTypes() };
      default: throw new Error(`unknown tool ${tool}`);
    }
  }

  private async preview(name: string) {
    const t = this.recipe.templates[name];
    const pv = await this.opts.host.previewExtract(t, this.recipe);
    const fields = [...(t.list?.fields ?? []), ...t.fields];
    const empties = fields.filter((f) => {
      const inList = t.list?.fields.includes(f);
      const vals = inList ? pv.records.map((r) => r[f.name]) : [pv.page[f.name]];
      return vals.length > 0 && vals.every((v) => v == null || v === '' || (Array.isArray(v) && !v.length));
    }).map((f) => f.name);
    this.lastPreview = { template: name, records: pv.records.length, empties };
    const stats = Object.fromEntries(fields.map((f) => {
      const inList = t.list?.fields.includes(f);
      const vals = inList ? pv.records.map((r) => r[f.name]) : [pv.page[f.name]];
      const filled = vals.filter((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).length;
      return [f.name, `${filled}/${vals.length}${pv.fieldMatches[f.name]?.candidate > 0 ? ` (fallback candidate ${pv.fieldMatches[f.name].candidate})` : ''}`];
    }));
    return { template: name, records: pv.records.length, listMatched: pv.listMatched, fieldFill: stats, emptyFields: empties, sample: pv.records.slice(0, 3), page: Object.keys(pv.page).length ? pv.page : undefined };
  }
}

function parseArgs(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }; }
  catch { return { _raw: s }; }
}

function summarizeResult(tool: string, ok: boolean, result: unknown): string {
  if (!ok) return `${tool} failed: ${(result as { error?: string })?.error ?? 'error'}`;
  const r = result as Record<string, unknown>;
  switch (tool) {
    case 'set_list': case 'add_fields': case 'preview': case 'update_field': { const pv = (r.preview ?? r) as { records?: number; emptyFields?: string[] }; return `${tool}: ${pv.records ?? '?'} records${pv.emptyFields?.length ? `, empty: ${pv.emptyFields.join(', ')}` : ''}`; }
    case 'detect_lists': return `detect_lists: ${(r.lists as unknown[])?.length ?? 0} candidate list(s)`;
    case 'enable_picking': return `picking enabled (${r.enabled})`;
    case 'test_selector': return `test_selector: ${r.count} match(es)`;
    case 'test_run': return `test_run: ${(r.stats as { rows?: number })?.rows ?? 0} rows, ${(r.stats as { pages?: number })?.pages ?? 0} pages${(r.drift as unknown[])?.length ? ', drift detected' : ''}`;
    case 'start_run': return `run started (${r.runId})`;
    case 'save_recipe': return `saved as ${r.id}`;
    case 'set_pagination': return `pagination: ${(r.pagination as { type: string })?.type}${r.selectorMatches ? ` (${(r.selectorMatches as { count: number }).count} match)` : ''}`;
    case 'add_follow': return `follow ${r.from} -> ${r.to}`;
    case 'add_sink': return `export added: ${((r.added as { type: string })?.type)}${r.warning ? ` (warning: ${r.warning})` : ''}`;
    case 'navigate': return `navigated to ${r.url}`;
    default: return `${tool} ok`;
  }
}

function pick<T extends object>(o: T | undefined, keys: Array<keyof T>): Partial<T> { const out: Partial<T> = {}; if (!o) return out; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }
function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recipe'; }

export const COPILOT_TOOLS = TOOL_DOCS.map((t) => ({ name: t.name, args: t.args, doc: t.doc }));
export { RecipeSchema as _RecipeSchemaForCopilot };
