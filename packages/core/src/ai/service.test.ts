import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiService } from './service.js';
import type { LlmProvider, LlmCompleteOptions, LlmResult } from './provider.js';
import { strictSchema, parseJsonLoose } from './provider.js';
import { cleanHtml, htmlToMarkdown, estimateTokens } from './clean.js';
import { startFixtureSite } from '../test/fixtureSite.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Runner } from '../engine/runner.js';
import { parseRecipe } from '../recipe/schema.js';
import { Logger } from '../util/logger.js';

/** A deterministic fake LLM that answers extraction batches and selector repairs. */
class FakeProvider implements LlmProvider {
  readonly name = 'fake'; readonly kind = 'openai-compatible' as const;
  calls: LlmCompleteOptions[] = [];
  async complete(opts: LlmCompleteOptions): Promise<LlmResult> {
    this.calls.push(opts);
    const user = opts.messages.find((m) => m.role === 'user')?.content ?? '';
    if (/repair CSS selectors/.test(opts.messages[0].content)) {
      return { text: JSON.stringify({ candidates: [{ css: '.does-not-exist-either', reason: 'guess' }, { css: 'h3 a', reason: 'title link' }] }), json: { candidates: [{ css: '.does-not-exist-either', reason: 'guess' }, { css: 'h3 a', reason: 'title link' }] }, model: 'fake' };
    }
    const items = Array.from(user.matchAll(/### ITEM (\d+)\n([\s\S]*?)(?=\n\n### ITEM|\n\nReturn)/g));
    const results = items.map((m) => ({ item: Number(m[1]), value: m[2].trim().toUpperCase() }));
    return { text: JSON.stringify({ results }), json: { results }, model: 'fake', inputTokens: 10, outputTokens: 5 };
  }
  async test() { return { ok: true }; }
}

describe('AiService', () => {
  it('batches extraction calls and maps results back in order', async () => {
    const p = new FakeProvider();
    const ai = new AiService(p, new Logger('error'));
    const out = await ai.extractBatch('upper', ['a', null, 'b', '', 'c']);
    expect(out).toEqual(['A', null, 'B', null, 'C']);
    expect(p.calls).toHaveLength(1);
    expect(ai.usage.calls).toBe(1);
    const many = await ai.extractBatch('upper', Array.from({ length: 30 }, (_, i) => `v${i}`));
    expect(many[29]).toBe('V29');
    expect(p.calls).toHaveLength(1 + 3);
  });

  it('strictSchema adds additionalProperties:false and strips unsupported keywords', () => {
    const s = strictSchema({ type: 'object', properties: { a: { type: 'string', minLength: 1 }, b: { type: 'object', properties: { c: { type: 'number', minimum: 0 } } } } });
    expect(s.additionalProperties).toBe(false);
    expect((s.properties as Record<string, Record<string, unknown>>).a.minLength).toBeUndefined();
    expect(((s.properties as Record<string, Record<string, unknown>>).b as Record<string, unknown>).additionalProperties).toBe(false);
    expect(s.required).toEqual(['a', 'b']);
  });

  it('parseJsonLoose tolerates fences and prose', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! {"a":[1,2]} hope this helps')).toEqual({ a: [1, 2] });
    expect(parseJsonLoose('nope')).toBeUndefined();
  });

  it('cleanHtml/htmlToMarkdown shrink pages substantially', () => {
    const html = `<html><head><style>.x{}</style><script>var a=1</script></head><body><nav>menu</nav><div class="a b" style="color:red" data-track="1"><h1>Title</h1><p>Hello <a href="/x">link</a></p><img src="data:image/png;base64,AAAA"><table><tr><th>A</th></tr><tr><td>1</td></tr></table></div><footer>f</footer></body></html>`;
    const cleaned = cleanHtml(html, 'https://x.test/');
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('style=');
    expect(cleaned).not.toContain('menu');
    expect(cleaned).toContain('href="/x"');
    const md = htmlToMarkdown(html, 'https://x.test/');
    expect(md).toContain('# Title');
    expect(md).toContain('[link](/x)');
    expect(estimateTokens(md)).toBeLessThan(estimateTokens(html));
  });
});

describe('Runner + AI', () => {
  let site: Awaited<ReturnType<typeof startFixtureSite>>; let outDir: string;
  beforeAll(async () => { site = await startFixtureSite(); outDir = mkdtempSync(join(tmpdir(), 'scrappia-ai-')); });
  afterAll(async () => { await site.close(); rmSync(outDir, { recursive: true, force: true }); });

  it('ai fields and ai transforms are resolved through the provider', async () => {
    const ai = new AiService(new FakeProvider(), new Logger('error'));
    const storage = new SqliteStorage();
    const recipe = parseRecipe({
      name: 'ai', entry: { urls: [`${site.url}/products`], template: 't' }, engine: { mode: 'http', delayMs: 0, jitterMs: 0 },
      templates: { t: { list: { selector: [{ value: 'article.product' }], limit: 3, fields: [
        { name: 'shout', type: 'ai', prompt: 'upper', selector: [{ value: 'h3 a' }] },
        { name: 'price', selector: [{ value: '.price' }], transforms: [{ type: 'ai', prompt: 'upper' }] },
      ] } } },
    });
    const { run, stats } = await new Runner({ recipe, storage, outDir, ai, logger: new Logger('error') }).start();
    const rows = Array.from(storage.iterRows(run.id));
    expect(rows[0].data.shout).toBe('PRODUCT 1');
    expect(rows[0].data.price).toBe('$10.00');
    expect(stats.aiCalls).toBeGreaterThanOrEqual(2);
  });

  it('self-heals a broken selector and records a healed drift event', async () => {
    const ai = new AiService(new FakeProvider(), new Logger('error'));
    const storage = new SqliteStorage();
    const recipe = parseRecipe({
      name: 'heal', entry: { urls: [`${site.url}/products`], template: 't' }, engine: { mode: 'http', delayMs: 0, jitterMs: 0 },
      templates: { t: { list: { selector: [{ value: 'article.product' }], fields: [{ name: 'name', selector: [{ value: '.old-title-class' }] }, { name: 'price', selector: [{ value: '.price' }] }] } } },
    });
    const { run, stats } = await new Runner({ recipe, storage, outDir, ai, logger: new Logger('error') }).start();
    expect(stats.healed).toBe(1);
    const drift = storage.listDrift(run.id);
    expect(drift.some((d) => d.kind === 'field-missing' && d.field === 'name')).toBe(true);
    expect(drift.some((d) => d.kind === 'healed' && (d.detail as { selector: string }).selector === 'h3 a')).toBe(true);
    const rows = Array.from(storage.iterRows(run.id));
    expect(rows.every((r) => typeof r.data.name === 'string' && (r.data.name as string).startsWith('Product'))).toBe(true);
  });
});
