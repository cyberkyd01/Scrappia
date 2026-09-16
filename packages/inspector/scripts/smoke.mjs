/**
 * Real-browser smoke test for the inspector bundle.
 *
 *   node packages/inspector/scripts/smoke.mjs [url]
 *
 * Launches headless Chromium via patchright, injects dist/inspector.iife.js with addInitScript,
 * exposes `__scrappiaHost` to collect overlay messages, then calls detectLists() and describe()
 * through page.evaluate and prints a summary. Falls back to an inline data: page when the
 * network is unavailable (and says so).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '..', 'dist', 'inspector.iife.js'), 'utf8');
const TARGET = process.argv[2] || 'https://books.toscrape.com/';

const FALLBACK_HTML = `<!doctype html><html><head><title>Fallback</title></head><body>
<section><ol class="row">${Array.from({ length: 20 }, (_, i) => `<li class="col-xs-6 col-sm-4 col-md-3 col-lg-3">
<article class="product_pod"><div class="image_container"><a href="catalogue/book-${i + 1}/index.html"><img src="media/book-${i + 1}.jpg" alt="Book ${i + 1}"></a></div>
<p class="star-rating Three"><i class="icon-star"></i><i class="icon-star"></i><i class="icon-star"></i></p>
<h3><a href="catalogue/book-${i + 1}/index.html" title="Book ${i + 1}">Book ${i + 1}</a></h3>
<div class="product_price"><p class="price_color">£${(10 + i * 2.25).toFixed(2)}</p><p class="instock availability"><i class="icon-ok"></i> In stock</p>
<form><button type="submit" class="btn btn-primary">Add to basket</button></form></div></article></li>`).join('')}</ol></section>
</body></html>`;

function summarizeList(l) {
  return {
    selector: l.selector.map((c) => `${c.kind}:${c.value} (${c.score})`),
    count: l.count,
    containerSelector: l.containerSelector,
    clickedIndex: l.clickedIndex,
    fields: l.fields.map((f) => `${f.name} [${f.type}${f.attr ? ' ' + f.attr : ''}] cov=${f.coverage} sel=${f.selector[0]?.value} sample=${JSON.stringify(f.samples[0])}`),
    alternatives: (l.alternatives || []).map((a) => `${a.selector[0]?.value} x${a.count} "${a.sample.slice(0, 40)}"`),
  };
}

const messages = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(bundle);
  await context.exposeBinding('__scrappiaHost', (_source, msg) => {
    messages.push(msg);
  });
  const page = await context.newPage();
  // patchright evaluates in an isolated world by default; the init script (and therefore the
  // inspector API) lives in the main world, so pass isolatedContext=false (4th argument).
  // Plain playwright ignores the extra arguments and evaluates in the main world anyway.
  const ev = (fn, arg) => page.evaluate(fn, arg, {}, false);

  let usedFallback = false;
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    usedFallback = true;
    console.log(`[smoke] could not load ${TARGET} (${err.message.split('\n')[0]}); using inline data: URL page instead`);
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(FALLBACK_HTML), { waitUntil: 'load' });
  }
  await page.waitForTimeout(500);

  const info = await ev(() => ({
    hasApi: typeof window.__scrappiaInspector === 'object' && typeof window.__scrappiaInspector.detectLists === 'function',
    hasHost: typeof window.__scrappiaHost === 'function',
    version: window.__scrappiaInspector?.version,
    url: location.href,
  }));
  console.log('[smoke] page:', info.url, usedFallback ? '(fallback)' : '(live)');
  console.log('[smoke] api present:', info.hasApi, 'version:', info.version, '| host binding visible in page:', info.hasHost);

  const t0 = Date.now();
  const lists = await ev(() => window.__scrappiaInspector.detectLists());
  console.log(`[smoke] detectLists(): ${lists.length} lists in ${Date.now() - t0}ms`);
  lists.forEach((l, i) => console.log(`  #${i + 1}`, JSON.stringify(summarizeList(l), null, 2).replace(/\n/g, '\n     ')));

  const t1 = Date.now();
  const picked = await ev(() => window.__scrappiaInspector.describe('article.product_pod h3 a'));
  console.log(`[smoke] describe('article.product_pod h3 a') in ${Date.now() - t1}ms:`);
  if (picked) {
    console.log('  tag:', picked.tag, '| text:', JSON.stringify(picked.text), '| href:', picked.href);
    console.log('  suggested:', picked.suggestedType, picked.suggestedName, '| rect:', JSON.stringify(picked.rect));
    console.log('  selectors:', picked.selectors.map((c) => `${c.kind}:${c.value} (${c.score})`));
    console.log('  relative :', (picked.relativeSelectors || []).map((c) => `${c.kind}:${c.value} (${c.score})`));
    if (picked.record) console.log('  record   :', JSON.stringify(summarizeList(picked.record), null, 2).replace(/\n/g, '\n     '));
  } else console.log('  null');

  const hl = await ev(() => window.__scrappiaInspector.highlight([{ kind: 'css', value: 'article.product_pod' }]));
  console.log('[smoke] highlight(article.product_pod):', JSON.stringify(hl));
  const boxes = await ev(() => document.querySelectorAll('[data-scrappia-overlay="box"]').length);
  console.log('[smoke] overlay boxes drawn:', boxes);

  // pick mode: synthetic click on a price
  await ev(() => window.__scrappiaInspector.setMode('pick'));
  await page.click('article.product_pod:nth-child(3) .price_color', { force: true }).catch(() => page.evaluate(() => {
    document.querySelectorAll('article.product_pod .price_color')[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }));
  await page.waitForTimeout(500);
  await ev(() => window.__scrappiaInspector.setMode('off'));

  const region = await ev(() => window.__scrappiaInspector.regionHtml([{ kind: 'css', value: 'article.product_pod' }], 600));
  console.log('[smoke] regionHtml (first 600 chars):', region.slice(0, 200).replace(/\n/g, ' ') + ' ...');

  await page.waitForTimeout(300);
  const types = messages.map((m) => m.type);
  console.log('[smoke] host messages:', types.join(', '));
  const pickedMsg = messages.find((m) => m.type === 'picked');
  if (pickedMsg) console.log('[smoke] picked via click:', pickedMsg.element.suggestedName, pickedMsg.element.suggestedType, JSON.stringify(pickedMsg.element.text), '| record count:', pickedMsg.element.record?.count);

  const top = lists[0];
  const ok = top && top.count === 20 && ['title', 'price', 'url'].every((n) => top.fields.some((f) => f.name === n)) && top.fields.some((f) => f.type === 'src');
  console.log(`[smoke] RESULT: ${ok ? 'PASS' : 'FAIL'} (top list count=${top?.count}, fields=${top?.fields.map((f) => f.name).join(',')})`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
