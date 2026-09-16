import type { Recipe } from '../recipe/schema.js';
import { cartesian, interpolate } from '../util/misc.js';

export interface SeedRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  template: string;
  keywords: Record<string, string>;
}

/** Expand entry URLs x keyword lists into concrete seed requests. */
export function planSeeds(recipe: Recipe): SeedRequest[] {
  const names = Object.keys(recipe.keywords).filter((k) => recipe.keywords[k].length);
  let combos: Array<Record<string, string>> = [{}];
  if (names.length) {
    if (recipe.keywordMode === 'zip') {
      const len = Math.max(...names.map((n) => recipe.keywords[n].length));
      combos = Array.from({ length: len }, (_, i) => Object.fromEntries(names.map((n) => [n, recipe.keywords[n][i] ?? recipe.keywords[n][recipe.keywords[n].length - 1]])));
    } else {
      combos = cartesian(names.map((n) => recipe.keywords[n])).map((vals) => Object.fromEntries(names.map((n, i) => [n, vals[i]])));
    }
  }
  const seeds: SeedRequest[] = [];
  const seen = new Set<string>();
  for (const kw of combos) {
    const vars = (name: string) => (name.startsWith('kw:') ? kw[name.slice(3)] : kw[name] !== undefined ? encodeURIComponent(kw[name]) : name.startsWith('raw:') ? kw[name.slice(4)] : undefined);
    for (const raw of recipe.entry.urls) {
      const url = interpolate(raw, vars);
      const body = recipe.entry.body ? interpolate(recipe.entry.body, (n) => kw[n]) : undefined;
      const key = `${recipe.entry.method} ${url} ${body ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ url, method: recipe.entry.method, body, template: recipe.entry.template, keywords: kw });
    }
  }
  return seeds;
}

/** Normalise a URL for queue de-duplication (strip fragment, sort query, drop tracking params). */
export function uniqueKey(method: string, url: string, body?: string, extra?: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return `${method} ${url} ${body ?? ''} ${extra ?? ''}`; }
  u.hash = '';
  const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', '_ga'];
  for (const d of drop) u.searchParams.delete(d);
  u.searchParams.sort();
  return `${method} ${u.toString()}${body ? ' ' + body : ''}${extra ? ' #' + extra : ''}`;
}
