import type { Field, Follow, Template } from '../recipe/schema.js';
import type { DomExtractSpec, DomField } from '../dom/extractor.js';

export const PAGINATION_PROBE = '__pagination';
export const BROWSER_ONLY_PAGINATION = new Set(['loadMore', 'scroll', 'script']);

export function followId(f: Follow, i: number): string { return `follow:${i}:${f.template}`; }

export function toDomField(f: Field): DomField {
  return {
    name: f.name, type: f.type, selector: f.selector?.map((c) => ({ kind: c.kind, value: c.value })), attr: f.attr, pattern: f.pattern, flags: f.flags,
    value: f.value, source: f.source, multiple: f.multiple, scope: f.scope, ancestor: f.ancestor, following: f.following,
  };
}

/** Build the environment-agnostic extraction spec for a template. */
export function buildSpec(template: Template, baseUrl: string): DomExtractSpec {
  const spec: DomExtractSpec = { baseUrl, fields: template.fields.map(toDomField), probes: [], followSelectors: [] };
  if (template.list) {
    spec.list = {
      selector: template.list.selector.map((c) => ({ kind: c.kind, value: c.value })),
      fields: template.list.fields.map(toDomField),
      limit: template.list.limit,
      followSelectors: template.list.follow.map((f, i) => (f.selector ? { id: followId(f, i), selector: f.selector.map((c) => ({ kind: c.kind, value: c.value })) } : null)).filter((x): x is { id: string; selector: DomField['selector'] & object } => !!x),
    };
  }
  spec.followSelectors = template.follow.map((f, i) => (f.selector ? { id: followId(f, i), selector: f.selector.map((c) => ({ kind: c.kind, value: c.value })) } : null)).filter((x): x is { id: string; selector: DomField['selector'] & object } => !!x);
  const p = template.pagination;
  if (p && (p.type === 'next' || p.type === 'pageLinks' || p.type === 'loadMore')) {
    spec.probes!.push({ id: PAGINATION_PROBE, selector: p.selector.map((c) => ({ kind: c.kind, value: c.value })), all: p.type === 'pageLinks' });
  }
  return spec;
}

/** Does this template need a real browser regardless of engine.mode? */
export function needsBrowser(template: Template): boolean {
  if (template.mode === 'browser') return true;
  if (template.actions.length) return true;
  if (template.waitFor) return true;
  if (template.pagination && BROWSER_ONLY_PAGINATION.has(template.pagination.type)) return true;
  if (template.pagination?.type === 'next' && template.pagination.method === 'click') return true;
  const fields = [...template.fields, ...(template.list?.fields ?? [])];
  if (fields.some((f) => f.type === 'screenshot')) return true;
  if ([...template.follow, ...(template.list?.follow ?? [])].some((f) => f.method === 'click')) return true;
  return false;
}
