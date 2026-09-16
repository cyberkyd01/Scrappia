/**
 * Recipe schema: the versioned JSON document that describes what to scrape.
 *
 * Everything the desktop recorder, CLI, server and MCP server exchange is a Recipe.
 * The schema is the public contract; keep it backwards compatible and bump `version`
 * only for breaking changes (see recipe/migrate.ts).
 */
import { z } from 'zod';

// ---------- Selectors ----------

export const SelectorKind = z.enum(['css', 'xpath', 'text', 'role', 'auto']);
export type SelectorKind = z.infer<typeof SelectorKind>;

export const SelectorCandidate = z.object({
  kind: SelectorKind.default('css'),
  value: z.string().min(1),
  /** Higher = preferred. Populated by the inspector's scorer; runtime sorts descending. */
  score: z.number().optional(),
  /** Human note, e.g. "generated from data-testid". */
  note: z.string().optional(),
});
export type SelectorCandidate = z.infer<typeof SelectorCandidate>;

/** A selector is always a ranked list of candidates so the runtime can self-heal. */
export const Selector = z.array(SelectorCandidate).min(1);
export type Selector = z.infer<typeof Selector>;

// ---------- Transforms ----------

export const Transform = z.discriminatedUnion('type', [
  z.object({ type: z.literal('trim') }),
  z.object({ type: z.literal('lowercase') }),
  z.object({ type: z.literal('uppercase') }),
  z.object({ type: z.literal('collapseWhitespace') }),
  z.object({ type: z.literal('stripHtml') }),
  z.object({
    type: z.literal('regex'),
    pattern: z.string(),
    flags: z.string().optional(),
    /** capture group index or name; default whole match */
    group: z.union([z.number(), z.string()]).optional(),
    /** return all matches joined by `join` (default: first match) */
    all: z.boolean().optional(),
    join: z.string().optional(),
  }),
  z.object({ type: z.literal('replace'), pattern: z.string(), flags: z.string().optional(), replacement: z.string() }),
  z.object({ type: z.literal('split'), separator: z.string(), index: z.number().optional() }),
  z.object({ type: z.literal('substring'), start: z.number(), end: z.number().optional() }),
  z.object({ type: z.literal('prefix'), value: z.string() }),
  z.object({ type: z.literal('suffix'), value: z.string() }),
  z.object({ type: z.literal('default'), value: z.string() }),
  z.object({ type: z.literal('number'), decimal: z.string().optional(), thousands: z.string().optional() }),
  z.object({ type: z.literal('integer') }),
  z.object({ type: z.literal('boolean'), truthy: z.array(z.string()).optional() }),
  z.object({ type: z.literal('currency') }),
  z.object({ type: z.literal('date'), inputFormat: z.string().optional(), outputFormat: z.string().optional() }),
  z.object({ type: z.literal('absoluteUrl') }),
  z.object({ type: z.literal('urlParam'), name: z.string() }),
  z.object({ type: z.literal('template'), template: z.string() }),
  z.object({ type: z.literal('map'), mapping: z.record(z.string()), fallback: z.string().optional() }),
  z.object({ type: z.literal('hash'), algorithm: z.enum(['md5', 'sha1', 'sha256']).default('sha256') }),
  z.object({ type: z.literal('js'), code: z.string() }),
  z.object({
    type: z.literal('ai'),
    prompt: z.string(),
    /** JSON schema for structured output; when omitted the result is a string */
    schema: z.record(z.any()).optional(),
    provider: z.string().optional(),
  }),
]);
export type Transform = z.infer<typeof Transform>;

// ---------- Fields ----------

export const FieldType = z.enum([
  'text', // innerText
  'html', // outerHTML
  'innerHtml',
  'attr', // attribute value, needs `attr`
  'href', // absolute link
  'src', // absolute image/media URL
  'email', // mailto or regex-detected email in text
  'phone',
  'regex', // regex over text/HTML, needs `pattern`
  'constant', // `value`
  'pageUrl',
  'pageTitle',
  'timestamp',
  'image', // download image to disk, store path
  'screenshot', // element or page screenshot to disk
  'count', // number of matches
  'exists', // boolean
  'ai', // LLM extraction over element (or page) content
  'json', // parse JSON from script tag / attr / text
  'table', // extract an HTML table as array of records
]);
export type FieldType = z.infer<typeof FieldType>;

export const Field = z.object({
  name: z.string().min(1),
  type: FieldType.default('text'),
  /** Omit for page-level types (pageUrl, timestamp, constant). */
  selector: Selector.optional(),
  attr: z.string().optional(),
  pattern: z.string().optional(),
  flags: z.string().optional(),
  value: z.string().optional(),
  /** For `ai`: natural-language instruction; `schema` optional JSON schema. */
  prompt: z.string().optional(),
  schema: z.record(z.any()).optional(),
  /** Source for regex/ai fields: 'text' (default) or 'html'. */
  source: z.enum(['text', 'html']).optional(),
  /** Capture all matches as an array instead of the first. */
  multiple: z.boolean().default(false),
  /** Selector is relative to the record element (default) or to the whole document. */
  scope: z.enum(['record', 'document']).default('record'),
  /** Walk up N ancestors from the matched element before extracting ("capture more content"). */
  ancestor: z.number().int().min(0).optional(),
  /** Capture text that follows a label/heading (WebHarvy "capture following text"). */
  following: z.boolean().optional(),
  transforms: z.array(Transform).default([]),
  required: z.boolean().default(false),
  /** Directory for image/screenshot downloads; supports {{run}} {{field:name}} tokens. */
  downloadDir: z.string().optional(),
  /** File naming for downloads: 'url' (default) or a template like '{{field:sku}}'. */
  fileName: z.string().optional(),
  description: z.string().optional(),
});
export type Field = z.infer<typeof Field>;

// ---------- Actions (pre-extraction interactions) ----------

export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: Selector, optional: z.boolean().optional(), all: z.boolean().optional() }),
  z.object({ type: z.literal('type'), selector: Selector, text: z.string(), submit: z.boolean().optional(), clear: z.boolean().optional() }),
  z.object({ type: z.literal('select'), selector: Selector, value: z.string() }),
  z.object({ type: z.literal('hover'), selector: Selector }),
  z.object({ type: z.literal('scroll'), selector: Selector.optional(), times: z.number().optional(), untilNoChange: z.boolean().optional(), delayMs: z.number().optional() }),
  z.object({ type: z.literal('wait'), ms: z.number() }),
  z.object({ type: z.literal('waitFor'), selector: Selector, state: z.enum(['attached', 'visible', 'hidden']).optional(), timeoutMs: z.number().optional() }),
  z.object({ type: z.literal('waitForNetworkIdle'), timeoutMs: z.number().optional() }),
  z.object({ type: z.literal('script'), code: z.string() }),
  z.object({ type: z.literal('press'), key: z.string(), selector: Selector.optional() }),
  z.object({ type: z.literal('frame'), selector: Selector }),
  z.object({ type: z.literal('goBack') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('screenshot'), path: z.string().optional(), fullPage: z.boolean().optional() }),
  z.object({ type: z.literal('setCookie'), name: z.string(), value: z.string(), domain: z.string().optional() }),
  z.object({ type: z.literal('solveCaptcha'), kind: z.enum(['auto', 'turnstile', 'recaptchaV2', 'recaptchaV3', 'hcaptcha', 'image']).optional(), selector: Selector.optional() }),
  /** Repeat a set of actions while a selector exists / up to N times (e.g. click "show more"). */
  z.object({ type: z.literal('repeat'), actions: z.array(z.any()), whileSelector: Selector.optional(), max: z.number().optional(), delayMs: z.number().optional() }),
]);
export type Action = z.infer<typeof Action>;

// ---------- Pagination ----------

export const Pagination = z.discriminatedUnion('type', [
  /** Click / follow a "next" link. */
  z.object({
    type: z.literal('next'),
    selector: Selector,
    maxPages: z.number().default(-1),
    stopWhenNoNewRows: z.boolean().default(true),
    /** Follow href (HTTP-friendly) or click (JS pagination). Default auto. */
    method: z.enum(['auto', 'href', 'click']).default('auto'),
  }),
  /** Click a "load more" button until it disappears or no new rows. */
  z.object({
    type: z.literal('loadMore'),
    selector: Selector,
    maxClicks: z.number().default(-1),
    delayMs: z.number().default(1000),
    stopWhenNoNewRows: z.boolean().default(true),
  }),
  /** Infinite scroll until no new rows / no height change. */
  z.object({
    type: z.literal('scroll'),
    maxScrolls: z.number().default(-1),
    delayMs: z.number().default(1000),
    selector: Selector.optional(),
    stopWhenNoNewRows: z.boolean().default(true),
  }),
  /** URL template with {{page}} token, e.g. https://x.com/list?page={{page}}. */
  z.object({
    type: z.literal('urlPattern'),
    template: z.string(),
    start: z.number().default(1),
    step: z.number().default(1),
    maxPages: z.number().default(-1),
    stopWhenNoNewRows: z.boolean().default(true),
  }),
  /** Explicit URL list. */
  z.object({ type: z.literal('urlList'), urls: z.array(z.string()) }),
  /** Numbered page links discovered on the page (WebHarvy "load next page set"). */
  z.object({
    type: z.literal('pageLinks'),
    selector: Selector,
    maxPages: z.number().default(-1),
  }),
  /** Custom JS run in page that returns true if a next page was loaded. */
  z.object({ type: z.literal('script'), code: z.string(), maxPages: z.number().default(-1), delayMs: z.number().default(1000) }),
]);
export type Pagination = z.infer<typeof Pagination>;

// ---------- Follow ----------

export const FollowMode = z.enum([
  'merge', // detail fields become extra columns on the parent row
  'nest', // detail record(s) nested under the parent row as an object/array
  'separate', // detail rows emitted into their own dataset, with a parentKey column
]);

export const Follow = z.object({
  /** Field on the record that holds the URL (type href/src/attr), or omit + `selector` to click. */
  field: z.string().optional(),
  selector: Selector.optional(),
  template: z.string(),
  mode: FollowMode.default('merge'),
  /** Follow at most N links per page (0 = unlimited). */
  limit: z.number().optional(),
  /** Follow via HTTP navigation (default) or by clicking in the same tab and going back. */
  method: z.enum(['navigate', 'click']).default('navigate'),
});
export type Follow = z.infer<typeof Follow>;

// ---------- Template ----------

export const ListSpec = z.object({
  selector: Selector,
  fields: z.array(Field).default([]),
  follow: z.array(Follow).default([]),
  /** Minimum records expected; fewer triggers drift telemetry (and browser fallback in auto mode). */
  minItems: z.number().default(1),
  /** Skip records that fail this JS predicate (receives the record object). */
  filter: z.string().optional(),
  limit: z.number().optional(),
});
export type ListSpec = z.infer<typeof ListSpec>;

export const Template = z.object({
  description: z.string().optional(),
  /** Actions before extraction (login, dismiss cookie banner, expand tabs). */
  actions: z.array(Action).default([]),
  /** Page-level fields (detail pages, single records). */
  fields: z.array(Field).default([]),
  /** Repeating records on this page. */
  list: ListSpec.optional(),
  /** Page-level follow links (e.g. category links -> another template). */
  follow: z.array(Follow).default([]),
  pagination: Pagination.optional(),
  /** Force fetch mode for this template. */
  mode: z.enum(['http', 'browser']).optional(),
  /** Wait for this selector before extracting (browser mode). */
  waitFor: Selector.optional(),
  /** Emit rows from this template into a named dataset (default: recipe name / 'default'). */
  dataset: z.string().optional(),
});
export type Template = z.infer<typeof Template>;

// ---------- Engine / anti-bot ----------

export const ProxyConfig = z.object({
  urls: z.array(z.string()).default([]),
  /** Reference to a proxy pool defined in settings (name), alternative to `urls`. */
  pool: z.string().optional(),
  /** 'request' = new proxy each request; 'session' = sticky per session; 'none'. */
  rotate: z.enum(['request', 'session', 'none']).default('session'),
  /** Retire a proxy after this many consecutive failures. */
  maxErrors: z.number().default(3),
  /** Country hint appended for providers that support it (implementation-specific). */
  country: z.string().optional(),
});

export const CaptchaConfig = z.object({
  provider: z.enum(['none', '2captcha', 'capsolver', 'anticaptcha', 'manual']).default('none'),
  apiKeyRef: z.string().optional(),
  autoDetect: z.boolean().default(true),
});

export const EngineConfig = z.object({
  mode: z.enum(['http', 'browser', 'auto']).default('auto'),
  browser: z.enum(['patchright', 'playwright']).default('patchright'),
  headless: z.boolean().default(true),
  stealth: z.boolean().default(true),
  channel: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).default(4),
  /** Max concurrent requests to the same host. */
  perHostConcurrency: z.number().int().min(1).default(2),
  delayMs: z.number().min(0).default(250),
  jitterMs: z.number().min(0).default(250),
  timeoutMs: z.number().default(30000),
  navigationWaitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('domcontentloaded'),
  retries: z.number().int().min(0).default(3),
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  headers: z.record(z.string()).default({}),
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string().optional(), path: z.string().optional() })).default([]),
  blockResources: z.array(z.enum(['image', 'font', 'media', 'stylesheet', 'script', 'xhr', 'fetch', 'websocket', 'other'])).default(['image', 'font', 'media']),
  blockUrlPatterns: z.array(z.string()).default([]),
  respectRobots: z.boolean().default(false),
  proxy: ProxyConfig.default({}),
  captcha: CaptchaConfig.default({}),
  session: z.object({
    /** Persist cookies/storage between runs in a named profile (login sessions). */
    persist: z.boolean().default(false),
    profile: z.string().default('default'),
    /** Clear cookies every N requests (WebHarvy "disable cookies while mining"). */
    clearEvery: z.number().optional(),
  }).default({}),
  /** Hard cap on total requests for a run (safety). */
  maxRequests: z.number().optional(),
  /** Hard cap on total rows for a run. */
  maxRows: z.number().optional(),
  /** Fingerprint injection (browser mode). */
  fingerprint: z.boolean().default(true),
});
export type EngineConfig = z.infer<typeof EngineConfig>;

// ---------- Output ----------

export const ValidationRule = z.object({
  field: z.string(),
  rule: z.enum(['required', 'regex', 'min', 'max', 'minLength', 'maxLength', 'url', 'email', 'number', 'enum', 'js']),
  value: z.any().optional(),
  /** 'drop' the row, 'flag' it (default), or 'fail' the run. */
  action: z.enum(['drop', 'flag', 'fail']).default('flag'),
});
export type ValidationRule = z.infer<typeof ValidationRule>;

export const OutputConfig = z.object({
  /** Row identity for dedupe / upsert / monitoring. Empty = hash of all fields. */
  keys: z.array(z.string()).default([]),
  dedupe: z.boolean().default(true),
  validation: z.array(ValidationRule).default([]),
  /** Add provenance columns. */
  addPageUrl: z.boolean().default(false),
  addTimestamp: z.boolean().default(false),
  addKeyword: z.boolean().default(false),
  addCategoryPath: z.boolean().default(false),
  /** Emit a blank row for pages that produced no records (WebHarvy option). */
  blankRowWhenEmpty: z.boolean().default(false),
  /** Column order; unspecified columns follow in discovery order. */
  columns: z.array(z.string()).optional(),
  /** Flatten nested objects with dot-notation keys when exporting to tabular formats. */
  flatten: z.boolean().default(true),
});
export type OutputConfig = z.infer<typeof OutputConfig>;

// ---------- Sinks ----------

const sinkBase = {
  name: z.string().optional(),
  mode: z.enum(['append', 'overwrite', 'upsert']).default('overwrite'),
  key: z.union([z.string(), z.array(z.string())]).optional(),
  dataset: z.string().optional(),
  enabled: z.boolean().default(true),
};

export const Sink = z.discriminatedUnion('type', [
  z.object({ type: z.literal('csv'), path: z.string(), delimiter: z.string().optional(), bom: z.boolean().optional(), ...sinkBase }),
  z.object({ type: z.literal('tsv'), path: z.string(), ...sinkBase }),
  z.object({ type: z.literal('json'), path: z.string(), pretty: z.boolean().optional(), ...sinkBase }),
  z.object({ type: z.literal('jsonl'), path: z.string(), ...sinkBase }),
  z.object({ type: z.literal('xlsx'), path: z.string(), sheet: z.string().optional(), ...sinkBase }),
  z.object({ type: z.literal('xml'), path: z.string(), root: z.string().optional(), row: z.string().optional(), ...sinkBase }),
  z.object({ type: z.literal('parquet'), path: z.string(), ...sinkBase }),
  z.object({ type: z.literal('sqlite'), path: z.string(), table: z.string(), ...sinkBase }),
  z.object({ type: z.literal('postgres'), connectionRef: z.string(), table: z.string(), schema: z.string().optional(), ...sinkBase }),
  z.object({ type: z.literal('mysql'), connectionRef: z.string(), table: z.string(), ...sinkBase }),
  z.object({ type: z.literal('mongodb'), connectionRef: z.string(), database: z.string(), collection: z.string(), ...sinkBase }),
  z.object({ type: z.literal('google-sheets'), credentialRef: z.string(), spreadsheetId: z.string(), sheet: z.string().optional(), ...sinkBase }),
  z.object({ type: z.literal('airtable'), credentialRef: z.string(), baseId: z.string(), table: z.string(), ...sinkBase }),
  z.object({ type: z.literal('notion'), credentialRef: z.string(), databaseId: z.string(), ...sinkBase }),
  z.object({ type: z.literal('s3'), credentialRef: z.string(), bucket: z.string(), keyTemplate: z.string(), format: z.enum(['csv', 'json', 'jsonl', 'parquet']).default('jsonl'), endpoint: z.string().optional(), region: z.string().optional(), ...sinkBase }),
  z.object({ type: z.literal('webhook'), url: z.string(), secretRef: z.string().optional(), batchSize: z.number().default(100), headers: z.record(z.string()).optional(), ...sinkBase }),
  z.object({ type: z.literal('stdout'), format: z.enum(['json', 'jsonl', 'csv', 'table']).default('jsonl'), ...sinkBase }),
]);
export type Sink = z.infer<typeof Sink>;

// ---------- Monitoring / alerts ----------

export const AlertChannel = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), url: z.string(), secretRef: z.string().optional() }),
  z.object({ type: z.literal('email'), to: z.array(z.string()), smtpRef: z.string() }),
  z.object({ type: z.literal('slack'), webhookUrlRef: z.string() }),
  z.object({ type: z.literal('discord'), webhookUrlRef: z.string() }),
  z.object({ type: z.literal('telegram'), botTokenRef: z.string(), chatId: z.string() }),
  z.object({ type: z.literal('ntfy'), topic: z.string(), server: z.string().optional() }),
  z.object({ type: z.literal('desktop') }),
]);
export type AlertChannel = z.infer<typeof AlertChannel>;

export const MonitorConfig = z.object({
  enabled: z.boolean().default(false),
  /** Fields to watch; empty = all. */
  fields: z.array(z.string()).default([]),
  /** Only alert when a numeric field changes by more than this percent. */
  thresholdPercent: z.number().optional(),
  on: z.array(z.enum(['added', 'removed', 'changed', 'drift', 'failure', 'empty'])).default(['added', 'removed', 'changed', 'drift', 'failure']),
  channels: z.array(AlertChannel).default([]),
});
export type MonitorConfig = z.infer<typeof MonitorConfig>;

export const ScheduleConfig = z.object({
  enabled: z.boolean().default(true),
  cron: z.string(),
  tz: z.string().optional(),
  /** Skip a run if the previous one is still running. */
  skipIfRunning: z.boolean().default(true),
});

// ---------- Recipe ----------

export const Recipe = z.object({
  version: z.literal(1).default(1),
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  entry: z.object({
    urls: z.array(z.string()).min(1),
    template: z.string(),
    /** HTTP method / body for POST start URLs. */
    method: z.enum(['GET', 'POST']).default('GET'),
    body: z.string().optional(),
  }),
  /**
   * Keyword lists substituted into entry URLs, POST bodies and `type` actions as {{name}}.
   * Multiple lists produce the cartesian product unless `keywordMode` is 'zip' (row-wise).
   */
  keywords: z.record(z.array(z.string())).default({}),
  keywordMode: z.enum(['product', 'zip']).default('product'),
  templates: z.record(Template),
  engine: EngineConfig.default({}),
  output: OutputConfig.default({}),
  sinks: z.array(Sink).default([]),
  monitor: MonitorConfig.default({}),
  schedule: ScheduleConfig.optional(),
  /** AI provider name from settings used by ai fields/transforms and self-healing. */
  ai: z.object({
    provider: z.string().optional(),
    selfHeal: z.boolean().default(true),
    model: z.string().optional(),
  }).default({}),
  meta: z.record(z.any()).default({}),
});
export type Recipe = z.infer<typeof Recipe>;
export type RecipeInput = z.input<typeof Recipe>;

export function parseRecipe(input: unknown): Recipe {
  const recipe = Recipe.parse(input);
  validateRecipeReferences(recipe);
  return recipe;
}

export function safeParseRecipe(input: unknown): { success: true; recipe: Recipe } | { success: false; errors: string[] } {
  const result = Recipe.safeParse(input);
  if (!result.success) {
    return { success: false, errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  try {
    validateRecipeReferences(result.data);
  } catch (e) {
    return { success: false, errors: [(e as Error).message] };
  }
  return { success: true, recipe: result.data };
}

/** Cross-reference checks zod cannot express. */
export function validateRecipeReferences(recipe: Recipe): void {
  const names = Object.keys(recipe.templates);
  if (!recipe.templates[recipe.entry.template]) {
    throw new Error(`entry.template "${recipe.entry.template}" is not defined in templates (${names.join(', ')})`);
  }
  for (const [tname, t] of Object.entries(recipe.templates)) {
    const follows = [...t.follow, ...(t.list?.follow ?? [])];
    for (const f of follows) {
      if (!recipe.templates[f.template]) throw new Error(`templates.${tname}: follow target "${f.template}" is not defined`);
      if (!f.field && !f.selector) throw new Error(`templates.${tname}: follow needs either "field" or "selector"`);
      if (f.field && t.list && !t.list.fields.some((x) => x.name === f.field)) {
        throw new Error(`templates.${tname}: follow field "${f.field}" is not a list field`);
      }
    }
    const allFields = [...t.fields, ...(t.list?.fields ?? [])];
    const seen = new Set<string>();
    for (const f of allFields) {
      if (seen.has(f.name)) throw new Error(`templates.${tname}: duplicate field name "${f.name}"`);
      seen.add(f.name);
      if (f.type === 'attr' && !f.attr) throw new Error(`templates.${tname}.${f.name}: attr fields need "attr"`);
      if (f.type === 'regex' && !f.pattern) throw new Error(`templates.${tname}.${f.name}: regex fields need "pattern"`);
      if (f.type === 'ai' && !f.prompt) throw new Error(`templates.${tname}.${f.name}: ai fields need "prompt"`);
      if (f.type === 'constant' && f.value === undefined) throw new Error(`templates.${tname}.${f.name}: constant fields need "value"`);
      const needsSelector = !['constant', 'pageUrl', 'pageTitle', 'timestamp'].includes(f.type);
      if (needsSelector && !f.selector && f.type !== 'ai' && f.type !== 'regex' && f.type !== 'screenshot') {
        throw new Error(`templates.${tname}.${f.name}: "${f.type}" fields need a selector`);
      }
    }
  }
}
