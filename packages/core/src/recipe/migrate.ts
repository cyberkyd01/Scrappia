/**
 * Recipe migrations. Each entry upgrades a recipe from `from` to `from + 1`.
 * `migrateRecipe` runs them in order until the document is at CURRENT_VERSION,
 * then the caller validates with `parseRecipe`.
 */
export const CURRENT_VERSION = 1;

type Migration = { from: number; up: (doc: Record<string, unknown>) => Record<string, unknown> };

const migrations: Migration[] = [
  // Example for the future:
  // { from: 1, up: (doc) => ({ ...doc, version: 2, engine: { ...(doc.engine as object), newField: 'x' } }) },
];

export function migrateRecipe(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new Error('recipe must be an object');
  let doc = { ...(input as Record<string, unknown>) };
  // Legacy / foreign formats
  if (doc.version === undefined) doc = { ...doc, version: 1 };
  if (typeof doc.version !== 'number') throw new Error(`unsupported recipe version ${String(doc.version)}`);
  if (doc.version > CURRENT_VERSION) throw new Error(`recipe version ${doc.version} is newer than this engine (${CURRENT_VERSION}); upgrade Scrappia`);
  while ((doc.version as number) < CURRENT_VERSION) {
    const m = migrations.find((x) => x.from === doc.version);
    if (!m) throw new Error(`no migration from recipe version ${doc.version}`);
    doc = m.up(doc);
  }
  return doc;
}

/**
 * Best-effort import of a webscraper.io "sitemap" (selector tree) into a Scrappia recipe draft.
 * Supports SelectorText, SelectorLink (follow), SelectorImage, SelectorElementAttribute, SelectorElement
 * (record), SelectorPagination / SelectorLink with paginate flag. Unsupported selectors are skipped and reported.
 */
export function importWebScraperSitemap(sitemap: { _id?: string; startUrl?: string[] | string; selectors?: Array<Record<string, unknown>> }): { recipe: Record<string, unknown>; skipped: string[] } {
  const skipped: string[] = [];
  const selectors = sitemap.selectors ?? [];
  const byParent = (p: string) => selectors.filter((s) => (s.parentSelectors as string[] | undefined)?.includes(p));
  const toField = (s: Record<string, unknown>) => {
    const base = { name: String(s.id), selector: [{ kind: 'css', value: String(s.selector) }], multiple: !!s.multiple };
    switch (s.type) {
      case 'SelectorText': return { ...base, type: 'text', transforms: s.regex ? [{ type: 'regex', pattern: String(s.regex) }] : [] };
      case 'SelectorLink': return { ...base, type: 'href' };
      case 'SelectorImage': return { ...base, type: 'src' };
      case 'SelectorHTML': return { ...base, type: 'html' };
      case 'SelectorElementAttribute': return { ...base, type: 'attr', attr: String(s.extractAttribute ?? 'value') };
      case 'SelectorTable': return { ...base, type: 'table' };
      default: skipped.push(`${s.id} (${s.type})`); return null;
    }
  };
  const templates: Record<string, unknown> = {};
  const build = (parent: string, name: string) => {
    const children = byParent(parent);
    const fields: unknown[] = [];
    let list: Record<string, unknown> | undefined;
    let pagination: Record<string, unknown> | undefined;
    const follow: unknown[] = [];
    for (const s of children) {
      if (s.type === 'SelectorElement' || s.type === 'SelectorElementScroll' || s.type === 'SelectorElementClick') {
        const lf = byParent(String(s.id)).map(toField).filter(Boolean);
        list = { selector: [{ kind: 'css', value: String(s.selector) }], fields: lf, follow: [] };
        if (s.type === 'SelectorElementScroll') pagination = { type: 'scroll' };
        if (s.type === 'SelectorElementClick' && s.clickElementSelector) pagination = { type: 'loadMore', selector: [{ kind: 'css', value: String(s.clickElementSelector) }] };
      } else if (s.type === 'SelectorPagination' || (s.type === 'SelectorLink' && byParent(String(s.id)).length && (s.parentSelectors as string[]).includes(String(s.id)))) {
        pagination = { type: 'next', selector: [{ kind: 'css', value: String(s.selector) }] };
      } else if (s.type === 'SelectorLink' && byParent(String(s.id)).length) {
        const child = `${name}_${s.id}`;
        build(String(s.id), child);
        follow.push({ selector: [{ kind: 'css', value: String(s.selector) }], template: child, mode: 'merge' });
        fields.push({ name: String(s.id), type: 'href', selector: [{ kind: 'css', value: String(s.selector) }] });
      } else {
        const f = toField(s);
        if (f) fields.push(f);
      }
    }
    templates[name] = { fields, list, follow, pagination };
  };
  build('_root', 'main');
  const urls = Array.isArray(sitemap.startUrl) ? sitemap.startUrl : sitemap.startUrl ? [sitemap.startUrl] : [];
  return { recipe: { version: 1, name: sitemap._id ?? 'imported', entry: { urls: urls.map((u) => u.replace(/\[(\d+)-(\d+)\]/, '{{page}}')), template: 'main' }, templates }, skipped };
}
