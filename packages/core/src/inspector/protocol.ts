/**
 * Message protocol between the in-page inspector overlay (packages/inspector) and its host
 * (desktop app via Playwright exposeBinding, or the server recorder over CDP).
 *
 * The overlay is injected with `context.addInitScript(bundle)`; the host exposes
 * `window.__scrappiaHost(message)` via `context.exposeBinding('__scrappiaHost', ...)`.
 * The host drives the overlay by evaluating `window.__scrappiaInspector.<command>(...)`.
 */
import type { SelectorCandidate, FieldType } from '../recipe/schema.js';

// ---------- overlay -> host ----------

export interface PickedElement {
  /** ranked selector candidates for this exact element (document scope) */
  selectors: SelectorCandidate[];
  /** selector candidates relative to the detected record element, when the element sits inside a repeating record */
  relativeSelectors?: SelectorCandidate[];
  tag: string;
  text: string;
  html: string;
  attrs: Record<string, string>;
  href?: string;
  src?: string;
  rect: { x: number; y: number; width: number; height: number };
  /** suggested field type based on the element (href for anchors, src for images, ...) */
  suggestedType: FieldType;
  suggestedName: string;
  /** detected repeating-record context, if any */
  record?: DetectedList;
  frameUrl: string;
}

export interface DetectedList {
  /** selector matching all record elements */
  selector: SelectorCandidate[];
  count: number;
  /** selector of the container (parent of the records) */
  containerSelector?: string;
  /** index of the record that contains the clicked element */
  clickedIndex: number;
  /** inferred fields shared by the records */
  fields: SuggestedField[];
  /** other plausible lists on the page, largest first (for "try another list") */
  alternatives?: Array<{ selector: SelectorCandidate[]; count: number; sample: string }>;
}

export interface SuggestedField {
  name: string;
  type: FieldType;
  attr?: string;
  selector: SelectorCandidate[];
  /** sample values from the first few records */
  samples: string[];
  /** 0..1 how many records have a non-empty value */
  coverage: number;
}

export type OverlayMessage =
  | { type: 'ready'; url: string; frameUrl: string }
  | { type: 'picked'; element: PickedElement }
  | { type: 'hover'; selector: string; tag: string; text: string }
  | { type: 'list.detected'; list: DetectedList }
  | { type: 'preview'; selector: string; count: number; samples: string[] }
  | { type: 'navigated'; url: string }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string };

// ---------- host -> overlay (window.__scrappiaInspector API) ----------

export type InspectorMode = 'off' | 'pick' | 'pickList' | 'pickAction';

export interface InspectorApi {
  /** Enable/disable the overlay and set the picking mode. */
  setMode(mode: InspectorMode): void;
  /** Highlight all elements matched by a selector (preview), returns count and sample texts. */
  highlight(selectors: SelectorCandidate[], scope?: SelectorCandidate[]): { count: number; samples: string[]; candidate: number };
  /** Clear preview highlights. */
  clearHighlights(): void;
  /** Auto-detect lists on the page without a click (largest repeating region first). */
  detectLists(): DetectedList[];
  /** Compute selectors + record context for an element identified by a unique selector (used after re-render). */
  describe(selector: string): PickedElement | null;
  /** Walk up from a picked element ("capture more content"). Returns the parent as a picked element. */
  expand(selector: string, levels?: number): PickedElement | null;
  /** Return a compact HTML of the record/list region (for AI suggestions). */
  regionHtml(selectors: SelectorCandidate[], maxChars?: number): string;
  /** Generate selectors for a fresh element (used by the pick flow internally). */
  version: string;
}

export const INSPECTOR_BINDING = '__scrappiaHost';
export const INSPECTOR_GLOBAL = '__scrappiaInspector';
