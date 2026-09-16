import { JSDOM, VirtualConsole } from 'jsdom';
import { domExtract, type DomExtractSpec, type DomExtractResult } from './extractor.js';

const quiet = new VirtualConsole();
quiet.on('jsdomError', () => { /* ignore CSS parse errors etc. */ });

export function parseHtml(html: string, url: string): JSDOM {
  return new JSDOM(html, { url, virtualConsole: quiet, contentType: 'text/html', pretendToBeVisual: false });
}

export function extractFromHtml(html: string, url: string, spec: Omit<DomExtractSpec, 'baseUrl'> & { baseUrl?: string }): DomExtractResult {
  const dom = parseHtml(html, url);
  try {
    return domExtract(dom.window.document, { ...spec, baseUrl: spec.baseUrl || url });
  } finally {
    dom.window.close();
  }
}

/** Cheap heuristics that a page needs a real browser (SPA shell, challenge page). */
export function looksLikeBrowserRequired(html: string): { required: boolean; reason?: string } {
  const h = html.slice(0, 200_000);
  if (/cf-browser-verification|cf_chl_opt|challenge-platform|_cf_chl|Just a moment\.\.\.|Checking your browser/i.test(h)) return { required: true, reason: 'cloudflare-challenge' };
  if (/px-captcha|perimeterx|_pxhd|Access Denied.*Reference #/i.test(h)) return { required: true, reason: 'perimeterx' };
  if (/datadome|dd\.js.*captcha/i.test(h)) return { required: true, reason: 'datadome' };
  if (/<title>\s*(Robot Check|Sorry! Something went wrong|Access Denied|Are you a robot)/i.test(h) || /Enter the characters you see below|automated access to .{0,40}data|unusual traffic from your/i.test(h)) return { required: true, reason: 'bot-check' };
  if (/<div id="(root|app|__next|__nuxt)"[^>]*>\s*<\/div>/i.test(h) && !/<article|<li|<tr|<h[1-3]/i.test(h)) return { required: true, reason: 'spa-shell' };
  const textLen = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, '').replace(/\s+/g, ' ').length;
  const hasAppScript = /<script(?![^>]*type=["']application\/(ld\+)?json["'])[^>]*>/i.test(h);
  if (textLen < 200 && hasAppScript) return { required: true, reason: 'little-content' };
  return { required: false };
}
