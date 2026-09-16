/**
 * Pure helpers turning inspector overlay results (PickedElement / DetectedList) into recipe Fields.
 */
import type { PickedElement, DetectedList, SuggestedField, Field, FieldType, SelectorCandidate, Transform } from '@scrappia/core';
import { makeField, slugName } from '../state/recipe';

export interface PickChoices {
  name: string;
  type: FieldType;
  attr?: string;
  /** 'record' = selector relative to the list record (requires a list); 'document' = page-level. */
  scope: 'record' | 'document';
  /** Reorder candidates so this index comes first (the user's preferred selector). */
  preferredCandidate?: number;
  /** Override the candidate list entirely (after the user edited them). */
  selectors?: SelectorCandidate[];
  transforms?: Transform[];
  multiple?: boolean;
  ancestor?: number;
}

/** Selector candidates appropriate for the chosen scope. */
export function selectorsFor(el: PickedElement, scope: 'record' | 'document'): SelectorCandidate[] {
  const list = scope === 'record' && el.relativeSelectors?.length ? el.relativeSelectors : el.selectors;
  return list.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Suggested field name for a picked element (snake_case, non-empty). */
export function suggestFieldName(el: PickedElement): string {
  const base = el.suggestedName?.trim() || el.attrs['name'] || el.attrs['id'] || el.attrs['data-testid'] || el.tag || 'field';
  return slugName(base);
}

/** Types that need `attr` set. */
export function needsAttr(type: FieldType) { return type === 'attr'; }

/** Guess transforms from the element's text, e.g. prices -> currency. */
export function defaultTransformsFor(type: FieldType, text: string): Transform[] {
  if (type !== 'text') return [];
  const t = text.trim();
  if (/^[^\d]{0,4}\s?\d[\d.,\s]*(?:\s?[A-Z]{3})?$/.test(t) && /[$€£¥₹]|USD|EUR|GBP/.test(t)) return [{ type: 'currency' }];
  return [];
}

export function pickToField(el: PickedElement, choices: PickChoices): Field {
  const scope = choices.scope;
  let selectors = choices.selectors ?? selectorsFor(el, scope);
  if (choices.preferredCandidate !== undefined && choices.preferredCandidate > 0 && choices.preferredCandidate < selectors.length) {
    const preferred = selectors[choices.preferredCandidate];
    selectors = [preferred, ...selectors.filter((_, i) => i !== choices.preferredCandidate)];
  }
  const field = makeField({
    name: choices.name.trim() ? slugName(choices.name) : suggestFieldName(el),
    type: choices.type,
    selector: selectors.length ? selectors : undefined,
    scope,
    transforms: choices.transforms ?? defaultTransformsFor(choices.type, el.text),
    multiple: choices.multiple ?? false,
  });
  if (needsAttr(choices.type)) field.attr = choices.attr || Object.keys(el.attrs)[0] || 'value';
  if (choices.ancestor) field.ancestor = choices.ancestor;
  return field;
}

/** Fields for a detected list, filtered by the names the user kept. */
export function suggestedToFields(list: DetectedList, keep?: Set<string>): Field[] {
  const seen = new Set<string>();
  const out: Field[] = [];
  for (const s of list.fields) {
    if (keep && !keep.has(s.name)) continue;
    let name = slugName(s.name);
    if (seen.has(name)) { let i = 2; while (seen.has(`${name}_${i}`)) i++; name = `${name}_${i}`; }
    seen.add(name);
    out.push(suggestedToField({ ...s, name }));
  }
  return out;
}

export function suggestedToField(s: SuggestedField): Field {
  const f = makeField({ name: slugName(s.name), type: s.type, selector: s.selector, scope: 'record', transforms: defaultTransformsFor(s.type, s.samples[0] ?? '') });
  if (needsAttr(s.type)) f.attr = s.attr ?? 'value';
  return f;
}
