/**
 * Node-side helpers for @scrappia/inspector: load the in-page bundle and re-export the
 * overlay <-> host protocol types.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type {
  PickedElement,
  DetectedList,
  SuggestedField,
  OverlayMessage,
  InspectorMode,
  InspectorApi,
  SelectorCandidate,
  FieldType,
} from '@scrappia/core';

/** Name of the binding the host exposes (mirrors INSPECTOR_BINDING in @scrappia/core). */
export const INSPECTOR_BINDING = '__scrappiaHost';
/** Name of the window global holding the InspectorApi (mirrors INSPECTOR_GLOBAL in @scrappia/core). */
export const INSPECTOR_GLOBAL = '__scrappiaInspector';

let cached: string | undefined;

/** Path of the built IIFE bundle (dist/inspector.iife.js), resolved relative to this module. */
export function getInspectorBundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'inspector.iife.js'), join(here, '..', 'dist', 'inspector.iife.js')];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`@scrappia/inspector: bundle not found (looked in ${candidates.join(', ')}). Run "npm run build --prefix packages/inspector".`);
}

/** Source of the in-page bundle, for `context.addInitScript(...)`. Cached after the first read. */
export function getInspectorBundle(): string {
  if (cached === undefined) cached = readFileSync(getInspectorBundlePath(), 'utf8');
  return cached;
}
