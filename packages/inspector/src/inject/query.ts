/**
 * Selector evaluation with candidate fall-through. Mirrors the run-time semantics of
 * packages/core/src/dom/extractor.ts (`query`) so previews in the overlay match what the
 * engine will extract.
 */
import type { SelectorCandidate } from '@scrappia/core';
import { docOf } from './util.js';

export function evaluateXPath(expr: string, root: Node): Element[] {
  const out: Element[] = [];
  try {
    const d = docOf(root);
    const res = d.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < res.snapshotLength; i++) {
      const n = res.snapshotItem(i);
      if (n && n.nodeType === 1) out.push(n as Element);
      else if (n && n.nodeType === 2) {
        const owner = (n as Attr).ownerElement;
        if (owner) out.push(owner);
      }
    }
  } catch {
    /* invalid xpath */
  }
  return out;
}

function byText(value: string, root: ParentNode): Element[] {
  const needle = value.trim().toLowerCase();
  const all = Array.from(root.querySelectorAll('*'));
  return all.filter((el) => {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) return false;
    const own = (el.textContent || '').trim().toLowerCase();
    if (own !== needle) return false;
    return !Array.from(el.children).some((c) => (c.textContent || '').trim().toLowerCase() === needle);
  });
}

function byRole(value: string, root: ParentNode): Element[] {
  const m = /^([a-z]+)(?:\[name=(.+)\])?$/i.exec(value.trim());
  if (!m) return [];
  const role = m[1].toLowerCase();
  const name = (m[2] || '').replace(/^["']|["']$/g, '').toLowerCase();
  const roleSelectors: Record<string, string> = {
    button: 'button, [role=button], input[type=button], input[type=submit]',
    link: 'a[href], [role=link]',
    textbox: 'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], textarea, [role=textbox]',
    heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
    listitem: 'li,[role=listitem]',
    row: 'tr,[role=row]',
    cell: 'td,th,[role=cell]',
    img: 'img,[role=img]',
    combobox: 'select,[role=combobox]',
    checkbox: 'input[type=checkbox],[role=checkbox]',
  };
  const sel = roleSelectors[role] || `[role=${role}]`;
  let els: Element[] = [];
  try { els = Array.from(root.querySelectorAll(sel)); } catch { els = []; }
  if (!name) return els;
  return els.filter((el) => {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || el.textContent || '').trim().toLowerCase();
    return label.includes(name);
  });
}

/** Evaluate a single candidate against a root. Never throws. */
export function queryOne(c: SelectorCandidate | { kind?: string; value: string }, root: ParentNode): Element[] {
  const kind = c.kind || 'css';
  try {
    if ((kind === 'css' || kind === 'auto') && /^:scope\s*$/.test(c.value)) {
      return root.nodeType === 1 ? [root as Element] : [docOf(root as Node).documentElement];
    }
    if (kind === 'xpath' || (kind === 'auto' && /^(\/|\.\/|\(\/)/.test(c.value))) return evaluateXPath(c.value, root as Node);
    if (kind === 'text') return byText(c.value, root);
    if (kind === 'role') return byRole(c.value, root);
    return Array.from(root.querySelectorAll(c.value));
  } catch {
    return [];
  }
}

/** Try candidates in order, return matches of the first candidate that matches anything. */
export function queryCandidates(candidates: SelectorCandidate[] | undefined, root: ParentNode): { els: Element[]; candidate: number } {
  if (!candidates || !candidates.length) return { els: [], candidate: -1 };
  for (let i = 0; i < candidates.length; i++) {
    const els = queryOne(candidates[i], root);
    if (els.length) return { els, candidate: i };
  }
  return { els: [], candidate: -1 };
}

/** Resolve a raw selector string (css, or xpath when it starts with `/` or `(`) to its first match. */
export function resolveFirst(selector: string, root: ParentNode = document): Element | null {
  const s = selector.trim();
  if (!s) return null;
  const kind = /^(\/|\.\/|\(\/)/.test(s) ? 'xpath' : 'css';
  const els = queryOne({ kind, value: s }, root);
  return els[0] || null;
}
