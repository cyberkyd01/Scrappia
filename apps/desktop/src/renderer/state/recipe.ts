/**
 * Working-recipe state for the recorder: a pure reducer over the parsed `Recipe` shape
 * (all schema defaults filled in), plus factories for blank recipes/templates/fields.
 */
import type {
  Recipe, Template, Field, Follow, Pagination, Action, Sink, Selector, EngineConfig, OutputConfig, MonitorConfig, Transform, FieldType,
} from '@scrappia/core';

export type FieldTarget = 'list' | 'page';

export function blankEngine(): EngineConfig {
  return {
    mode: 'auto', browser: 'patchright', headless: true, stealth: true, concurrency: 4, perHostConcurrency: 2, delayMs: 250, jitterMs: 250,
    timeoutMs: 30000, navigationWaitUntil: 'domcontentloaded', retries: 3, headers: {}, cookies: [], blockResources: ['image', 'font', 'media'],
    blockUrlPatterns: [], respectRobots: false, proxy: { urls: [], rotate: 'session', maxErrors: 3 }, captcha: { provider: 'none', autoDetect: true },
    session: { persist: false, profile: 'default' }, fingerprint: true,
  };
}

export function blankOutput(): OutputConfig {
  return { keys: [], dedupe: true, validation: [], addPageUrl: false, addTimestamp: false, addKeyword: false, addCategoryPath: false, blankRowWhenEmpty: false, flatten: true };
}

export function blankMonitor(): MonitorConfig {
  return { enabled: false, fields: [], on: ['added', 'removed', 'changed', 'drift', 'failure'], channels: [] };
}

export function blankTemplate(partial: Partial<Template> = {}): Template {
  return { actions: [], fields: [], follow: [], ...partial };
}

export function blankRecipe(name = 'New recipe', url = ''): Recipe {
  return {
    version: 1,
    name,
    tags: [],
    entry: { urls: url ? [url] : [], template: 'main', method: 'GET' },
    keywords: {},
    keywordMode: 'product',
    templates: { main: blankTemplate() },
    engine: blankEngine(),
    output: blankOutput(),
    sinks: [],
    monitor: blankMonitor(),
    ai: { selfHeal: true },
    meta: {},
  };
}

export function makeField(partial: Partial<Field> & { name: string }): Field {
  return { type: 'text', multiple: false, scope: 'record', transforms: [], required: false, ...partial };
}

/** Convert a raw field name into a safe snake_case identifier. */
export function slugName(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f$1');
  return out || 'field';
}

export function uniqueFieldName(template: Template, base: string): string {
  const taken = new Set([...template.fields, ...(template.list?.fields ?? [])].map((f) => f.name));
  const slug = slugName(base);
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${slug}_${i}`)) return `${slug}_${i}`;
  return `${slug}_${Date.now()}`;
}

export function uniqueTemplateName(recipe: Recipe, base: string): string {
  const slug = slugName(base) || 'template';
  if (!recipe.templates[slug]) return slug;
  for (let i = 2; i < 1000; i++) if (!recipe.templates[`${slug}_${i}`]) return `${slug}_${i}`;
  return `${slug}_${Date.now()}`;
}

export type RecipeAction =
  | { type: 'set'; recipe: Recipe }
  | { type: 'patch'; patch: Partial<Recipe> }
  | { type: 'setEntry'; patch: Partial<Recipe['entry']> }
  | { type: 'setKeywords'; keywords: Record<string, string[]>; mode?: Recipe['keywordMode'] }
  | { type: 'addTemplate'; name: string; template?: Partial<Template> }
  | { type: 'removeTemplate'; name: string }
  | { type: 'renameTemplate'; from: string; to: string }
  | { type: 'updateTemplate'; name: string; patch: Partial<Template> }
  | { type: 'addField'; template: string; target: FieldTarget; field: Field }
  | { type: 'updateField'; template: string; target: FieldTarget; index: number; patch: Partial<Field> }
  | { type: 'removeField'; template: string; target: FieldTarget; index: number }
  | { type: 'moveField'; template: string; target: FieldTarget; index: number; to: number }
  | { type: 'setList'; template: string; selector: Selector; fields?: Field[]; minItems?: number }
  | { type: 'clearList'; template: string }
  | { type: 'addFollow'; template: string; target: FieldTarget; follow: Follow }
  | { type: 'updateFollow'; template: string; target: FieldTarget; index: number; patch: Partial<Follow> }
  | { type: 'removeFollow'; template: string; target: FieldTarget; index: number }
  | { type: 'setPagination'; template: string; pagination?: Pagination }
  | { type: 'addAction'; template: string; action: Action }
  | { type: 'updateAction'; template: string; index: number; action: Action }
  | { type: 'removeAction'; template: string; index: number }
  | { type: 'addSink'; sink: Sink }
  | { type: 'updateSink'; index: number; sink: Sink }
  | { type: 'removeSink'; index: number }
  | { type: 'setEngine'; patch: Partial<EngineConfig> }
  | { type: 'setOutput'; patch: Partial<OutputConfig> }
  | { type: 'setMonitor'; patch: Partial<MonitorConfig> }
  | { type: 'setSchedule'; schedule?: Recipe['schedule'] }
  | { type: 'setAi'; patch: Partial<Recipe['ai']> };

function withTemplate(recipe: Recipe, name: string, fn: (t: Template) => Template): Recipe {
  const t = recipe.templates[name];
  if (!t) return recipe;
  const next = fn(t);
  if (next === t) return recipe;
  return { ...recipe, templates: { ...recipe.templates, [name]: next } };
}

function fieldsOf(t: Template, target: FieldTarget): Field[] { return target === 'list' ? t.list?.fields ?? [] : t.fields; }

function setFields(t: Template, target: FieldTarget, fields: Field[]): Template {
  if (target === 'list') {
    if (!t.list) return t;
    return { ...t, list: { ...t.list, fields } };
  }
  return { ...t, fields };
}

function followsOf(t: Template, target: FieldTarget): Follow[] { return target === 'list' ? t.list?.follow ?? [] : t.follow; }
function setFollows(t: Template, target: FieldTarget, follow: Follow[]): Template {
  if (target === 'list') { if (!t.list) return t; return { ...t, list: { ...t.list, follow } }; }
  return { ...t, follow };
}

function renameRefs(recipe: Recipe, from: string, to: string): Recipe {
  const templates: Record<string, Template> = {};
  for (const [name, t] of Object.entries(recipe.templates)) {
    const fix = (f: Follow): Follow => (f.template === from ? { ...f, template: to } : f);
    templates[name === from ? to : name] = { ...t, follow: t.follow.map(fix), list: t.list ? { ...t.list, follow: t.list.follow.map(fix) } : undefined };
  }
  return { ...recipe, templates, entry: { ...recipe.entry, template: recipe.entry.template === from ? to : recipe.entry.template } };
}

export function recipeReducer(recipe: Recipe, action: RecipeAction): Recipe {
  switch (action.type) {
    case 'set': return action.recipe;
    case 'patch': return { ...recipe, ...action.patch };
    case 'setEntry': return { ...recipe, entry: { ...recipe.entry, ...action.patch } };
    case 'setKeywords': return { ...recipe, keywords: action.keywords, keywordMode: action.mode ?? recipe.keywordMode };
    case 'addTemplate': {
      if (recipe.templates[action.name]) return recipe;
      return { ...recipe, templates: { ...recipe.templates, [action.name]: blankTemplate(action.template) } };
    }
    case 'removeTemplate': {
      if (!recipe.templates[action.name] || Object.keys(recipe.templates).length <= 1 || recipe.entry.template === action.name) return recipe;
      const templates: Record<string, Template> = {};
      for (const [name, t] of Object.entries(recipe.templates)) {
        if (name === action.name) continue;
        templates[name] = { ...t, follow: t.follow.filter((f) => f.template !== action.name), list: t.list ? { ...t.list, follow: t.list.follow.filter((f) => f.template !== action.name) } : undefined };
      }
      return { ...recipe, templates };
    }
    case 'renameTemplate': {
      if (!recipe.templates[action.from] || recipe.templates[action.to] || !action.to) return recipe;
      return renameRefs(recipe, action.from, action.to);
    }
    case 'updateTemplate': return withTemplate(recipe, action.name, (t) => ({ ...t, ...action.patch }));
    case 'addField': return withTemplate(recipe, action.template, (t) => {
      const target: FieldTarget = action.target === 'list' && !t.list ? 'page' : action.target;
      const field = { ...action.field, name: uniqueFieldName(t, action.field.name), scope: target === 'list' ? action.field.scope : 'document' as const };
      return setFields(t, target, [...fieldsOf(t, target), field]);
    });
    case 'updateField': return withTemplate(recipe, action.template, (t) => {
      const fields = fieldsOf(t, action.target).slice();
      if (!fields[action.index]) return t;
      const old = fields[action.index];
      const next = { ...old, ...action.patch };
      if (next.name !== old.name) {
        const others = [...t.fields, ...(t.list?.fields ?? [])].filter((f) => f !== old).map((f) => f.name);
        if (others.includes(next.name)) return t;
        // keep follow references in sync
        const fix = (f: Follow): Follow => (f.field === old.name ? { ...f, field: next.name } : f);
        fields[action.index] = next;
        const t2 = setFields(t, action.target, fields);
        return { ...t2, follow: t2.follow.map(fix), list: t2.list ? { ...t2.list, follow: t2.list.follow.map(fix) } : undefined };
      }
      fields[action.index] = next;
      return setFields(t, action.target, fields);
    });
    case 'removeField': return withTemplate(recipe, action.template, (t) => {
      const fields = fieldsOf(t, action.target);
      const removed = fields[action.index];
      if (!removed) return t;
      const t2 = setFields(t, action.target, fields.filter((_, i) => i !== action.index));
      const drop = (f: Follow) => f.field !== removed.name;
      return { ...t2, follow: t2.follow.filter(drop), list: t2.list ? { ...t2.list, follow: t2.list.follow.filter(drop) } : undefined };
    });
    case 'moveField': return withTemplate(recipe, action.template, (t) => {
      const fields = fieldsOf(t, action.target).slice();
      if (!fields[action.index] || action.to < 0 || action.to >= fields.length) return t;
      const [f] = fields.splice(action.index, 1);
      fields.splice(action.to, 0, f);
      return setFields(t, action.target, fields);
    });
    case 'setList': return withTemplate(recipe, action.template, (t) => ({
      ...t,
      list: { selector: action.selector, fields: action.fields ?? t.list?.fields ?? [], follow: t.list?.follow ?? [], minItems: action.minItems ?? t.list?.minItems ?? 1, filter: t.list?.filter, limit: t.list?.limit },
    }));
    case 'clearList': return withTemplate(recipe, action.template, (t) => ({ ...t, list: undefined }));
    case 'addFollow': return withTemplate(recipe, action.template, (t) => setFollows(t, action.target, [...followsOf(t, action.target), action.follow]));
    case 'updateFollow': return withTemplate(recipe, action.template, (t) => {
      const list = followsOf(t, action.target).slice();
      if (!list[action.index]) return t;
      list[action.index] = { ...list[action.index], ...action.patch };
      return setFollows(t, action.target, list);
    });
    case 'removeFollow': return withTemplate(recipe, action.template, (t) => setFollows(t, action.target, followsOf(t, action.target).filter((_, i) => i !== action.index)));
    case 'setPagination': return withTemplate(recipe, action.template, (t) => ({ ...t, pagination: action.pagination }));
    case 'addAction': return withTemplate(recipe, action.template, (t) => ({ ...t, actions: [...t.actions, action.action] }));
    case 'updateAction': return withTemplate(recipe, action.template, (t) => ({ ...t, actions: t.actions.map((a, i) => (i === action.index ? action.action : a)) }));
    case 'removeAction': return withTemplate(recipe, action.template, (t) => ({ ...t, actions: t.actions.filter((_, i) => i !== action.index) }));
    case 'addSink': return { ...recipe, sinks: [...recipe.sinks, action.sink] };
    case 'updateSink': return { ...recipe, sinks: recipe.sinks.map((s, i) => (i === action.index ? action.sink : s)) };
    case 'removeSink': return { ...recipe, sinks: recipe.sinks.filter((_, i) => i !== action.index) };
    case 'setEngine': return { ...recipe, engine: { ...recipe.engine, ...action.patch } };
    case 'setOutput': return { ...recipe, output: { ...recipe.output, ...action.patch } };
    case 'setMonitor': return { ...recipe, monitor: { ...recipe.monitor, ...action.patch } };
    case 'setSchedule': return { ...recipe, schedule: action.schedule };
    case 'setAi': return { ...recipe, ai: { ...recipe.ai, ...action.patch } };
    default: return recipe;
  }
}

/** Default pagination objects (schema defaults filled in). */
export function paginationFor(kind: 'next' | 'loadMore' | 'scroll', selector?: Selector): Pagination {
  if (kind === 'next') return { type: 'next', selector: selector ?? [{ kind: 'css', value: 'a[rel=next]' }], maxPages: -1, stopWhenNoNewRows: true, method: 'auto' };
  if (kind === 'loadMore') return { type: 'loadMore', selector: selector ?? [{ kind: 'css', value: 'button' }], maxClicks: -1, delayMs: 1000, stopWhenNoNewRows: true };
  return { type: 'scroll', maxScrolls: -1, delayMs: 1000, stopWhenNoNewRows: true };
}

/** Default sink object for a sink type (schema defaults filled in). */
export function blankSink(type: Sink['type'], name = 'export'): Sink {
  const base = { mode: 'overwrite' as const, enabled: true };
  switch (type) {
    case 'csv': return { type, path: `exports/${name}.csv`, ...base };
    case 'tsv': return { type, path: `exports/${name}.tsv`, ...base };
    case 'json': return { type, path: `exports/${name}.json`, pretty: true, ...base };
    case 'jsonl': return { type, path: `exports/${name}.jsonl`, ...base };
    case 'xlsx': return { type, path: `exports/${name}.xlsx`, ...base };
    case 'xml': return { type, path: `exports/${name}.xml`, ...base };
    case 'parquet': return { type, path: `exports/${name}.parquet`, ...base };
    case 'sqlite': return { type, path: `exports/${name}.sqlite`, table: 'rows', ...base };
    case 'postgres': return { type, connectionRef: 'PG_URL', table: 'rows', ...base };
    case 'mysql': return { type, connectionRef: 'MYSQL_URL', table: 'rows', ...base };
    case 'mongodb': return { type, connectionRef: 'MONGO_URL', database: 'scrappia', collection: 'rows', ...base };
    case 'google-sheets': return { type, credentialRef: 'GOOGLE_SA_JSON', spreadsheetId: '', ...base };
    case 'airtable': return { type, credentialRef: 'AIRTABLE_TOKEN', baseId: '', table: 'rows', ...base };
    case 'notion': return { type, credentialRef: 'NOTION_TOKEN', databaseId: '', ...base };
    case 's3': return { type, credentialRef: 'AWS_CREDENTIALS', bucket: '', keyTemplate: `${name}/{{run}}.jsonl`, format: 'jsonl', ...base };
    case 'webhook': return { type, url: '', batchSize: 100, ...base };
    case 'stdout': return { type, format: 'jsonl', ...base };
  }
}

export const FIELD_TYPES: FieldType[] = ['text', 'html', 'innerHtml', 'attr', 'href', 'src', 'email', 'phone', 'regex', 'constant', 'pageUrl', 'pageTitle', 'timestamp', 'image', 'screenshot', 'count', 'exists', 'ai', 'json', 'table'];
export const TRANSFORM_TYPES: Transform['type'][] = ['trim', 'lowercase', 'uppercase', 'collapseWhitespace', 'stripHtml', 'regex', 'replace', 'split', 'substring', 'prefix', 'suffix', 'default', 'number', 'integer', 'boolean', 'currency', 'date', 'absoluteUrl', 'urlParam', 'template', 'map', 'hash', 'js', 'ai'];

/** Default transform object for a type. */
export function blankTransform(type: Transform['type']): Transform {
  switch (type) {
    case 'regex': return { type, pattern: '(.*)', group: 1 };
    case 'replace': return { type, pattern: '', replacement: '' };
    case 'split': return { type, separator: ',', index: 0 };
    case 'substring': return { type, start: 0 };
    case 'prefix': case 'suffix': case 'default': return { type, value: '' };
    case 'number': return { type };
    case 'boolean': return { type };
    case 'date': return { type };
    case 'urlParam': return { type, name: 'id' };
    case 'template': return { type, template: '{{value}}' };
    case 'map': return { type, mapping: {} };
    case 'hash': return { type, algorithm: 'sha256' };
    case 'js': return { type, code: 'return value' };
    case 'ai': return { type, prompt: '' };
    default: return { type } as Transform;
  }
}

/** Human summary of a transform for chips. */
export function describeTransform(t: Transform): string {
  switch (t.type) {
    case 'regex': return `regex ${t.pattern}`;
    case 'replace': return `replace /${t.pattern}/ -> "${t.replacement}"`;
    case 'split': return `split "${t.separator}"[${t.index ?? 0}]`;
    case 'substring': return `substring ${t.start}..${t.end ?? ''}`;
    case 'prefix': return `prefix "${t.value}"`;
    case 'suffix': return `suffix "${t.value}"`;
    case 'default': return `default "${t.value}"`;
    case 'urlParam': return `urlParam ${t.name}`;
    case 'template': return `template ${t.template}`;
    case 'map': return `map (${Object.keys(t.mapping).length})`;
    case 'js': return 'js';
    case 'ai': return `ai: ${t.prompt.slice(0, 20)}`;
    default: return t.type;
  }
}
