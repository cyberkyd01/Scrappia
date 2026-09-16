/**
 * HTML -> compact text/markdown for LLM prompts. Cuts 60-80% of tokens versus raw HTML.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const vc = new VirtualConsole();

const NOISE = 'script, style, noscript, svg, canvas, iframe, template, link, meta, [hidden], [aria-hidden="true"], .cookie, #cookie, .ad, .ads, .advert, [class*="cookie-"], [id*="cookie-"]';
const STRUCTURE = 'nav, footer, aside, header';

export interface CleanOptions {
  /** Keep only the main content (Readability). Default false for extraction (lists are often outside "main"). */
  mainContent?: boolean;
  /** Remove nav/footer/aside/header. Default true. */
  stripChrome?: boolean;
  /** Max characters of output. */
  maxChars?: number;
  /** Keep link hrefs and image srcs (as markdown). Default true. */
  keepLinks?: boolean;
}

export function cleanHtml(html: string, url: string, opts: CleanOptions = {}): string {
  const dom = new JSDOM(html, { url, virtualConsole: vc });
  const doc = dom.window.document;
  try {
    doc.querySelectorAll(NOISE).forEach((el) => el.remove());
    if (opts.stripChrome !== false) doc.querySelectorAll(STRUCTURE).forEach((el) => el.remove());
    // strip attributes except a small allow-list
    const keep = new Set(['href', 'src', 'alt', 'title', 'datetime', 'value', 'type', 'name', 'content', 'itemprop', 'colspan', 'rowspan']);
    doc.querySelectorAll('*').forEach((el) => {
      for (const a of Array.from(el.attributes)) if (!keep.has(a.name)) el.removeAttribute(a.name);
      if (el.hasAttribute('src') && (el.getAttribute('src') || '').startsWith('data:')) el.removeAttribute('src');
    });
    // comments
    const walker = doc.createTreeWalker(doc, dom.window.NodeFilter.SHOW_COMMENT);
    const comments: Node[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.parentNode?.removeChild(c));
    let root: Element | null = doc.body;
    if (opts.mainContent) {
      const art = new Readability(doc, { keepClasses: false }).parse();
      if (art?.content) { const d2 = new JSDOM(art.content, { url, virtualConsole: vc }); root = d2.window.document.body; }
    }
    return truncate(compactHtml(root?.innerHTML ?? ''), opts.maxChars ?? 60_000);
  } finally { dom.window.close(); }
}

export function htmlToMarkdown(html: string, url: string, opts: CleanOptions = {}): string {
  const cleaned = cleanHtml(html, url, { ...opts, maxChars: undefined });
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  if (opts.keepLinks === false) { td.addRule('nolinks', { filter: ['a'], replacement: (content) => content }); td.addRule('noimg', { filter: ['img'], replacement: () => '' }); }
  td.addRule('table-rows', { filter: 'tr', replacement: (content) => `| ${content.replace(/\n+/g, ' ').trim()} |\n` });
  td.addRule('table-cells', { filter: ['td', 'th'], replacement: (content) => ` ${content.replace(/\|/g, '\\|').trim()} |` });
  const md = td.turndown(cleaned).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  return truncate(md, opts.maxChars ?? 40_000);
}

export function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function compactHtml(html: string): string {
  return html.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').replace(/<(div|span)><\/\1>/g, '').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n<!-- truncated -->' : s;
}

/** Rough token estimate (chars/4) used for budgeting prompts. */
export function estimateTokens(s: string): number { return Math.ceil(s.length / 4); }
