import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createProvider, httpFetch, safeParseRecipe, autoDetectProviders, type LlmProviderConfig } from '@scrappia/core';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { json, table } from '../ui.js';

export function registerAiCommands(program: Command, ctx: () => CliContext) {
  const ai = program.command('ai').description('AI providers (Anthropic, OpenAI-compatible, Ollama/LM Studio) and natural-language recipe generation')
    .addHelpText('after', `
When no provider is configured, ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST in the environment
are picked up automatically. Providers are used for "ai" fields and transforms, selector self-healing
and \`scrappia ai generate\`.

Examples:
  scrappia secrets set ANTHROPIC_API_KEY
  scrappia ai add --name claude --kind anthropic --model claude-sonnet-5 --api-key-ref ANTHROPIC_API_KEY
  scrappia ai add --name local --kind openai-compatible --base-url http://localhost:11434 --model llama3.1
  scrappia ai test claude
  scrappia ai generate https://example.com/products "product name, price and link for every product" --out products.json`);

  ai.command('providers').description('List configured providers').option('--json').action((opts: { json?: boolean }) => {
    const c = ctx();
    const s = c.app.settings;
    const configured = s.ai.providers;
    const auto = configured.length ? [] : autoDetectProviders();
    const rows = [...configured.map((p) => ({ ...p, source: 'settings' })), ...auto.map((p) => ({ ...p, source: 'env (auto)' }))];
    if (opts.json) { c.out(json(rows.map((r) => ({ ...r, apiKey: r.apiKey ? '(ref)' : undefined })))); return; }
    if (!rows.length) { c.out('no AI providers; add one with `scrappia ai add` or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST\n'); return; }
    c.out(table(rows.map((r) => ({ name: r.name + (r.name === (s.ai.default ?? rows[0].name) ? ' *' : ''), kind: r.kind, model: r.model, baseUrl: r.baseUrl ?? '', apiKeyRef: r.apiKey ?? '', source: r.source })), ['name', 'kind', 'model', 'baseUrl', 'apiKeyRef', 'source'], { painter: c.paint }));
    c.out(c.paint.dim('* default\n'));
  });

  ai.command('add').description('Add or replace a provider')
    .requiredOption('--name <name>')
    .requiredOption('--kind <kind>', 'anthropic|openai-compatible')
    .requiredOption('--model <model>')
    .option('--base-url <url>', 'endpoint for openai-compatible (Ollama: http://localhost:11434, LM Studio: http://localhost:1234)')
    .option('--api-key-ref <secret>', 'name of a secret (see `scrappia secrets set`) holding the API key')
    .option('--effort <level>', 'anthropic effort hint: low|medium|high')
    .option('--default', 'make this the default provider')
    .action((opts: { name: string; kind: string; model: string; baseUrl?: string; apiKeyRef?: string; effort?: string; default?: boolean }) => {
      const c = ctx();
      if (opts.kind !== 'anthropic' && opts.kind !== 'openai-compatible') throw new CliError('--kind must be anthropic|openai-compatible');
      if (opts.effort && !['low', 'medium', 'high'].includes(opts.effort)) throw new CliError('--effort must be low|medium|high');
      const cfg: LlmProviderConfig = { name: opts.name, kind: opts.kind, model: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKeyRef, effort: opts.effort as LlmProviderConfig['effort'] };
      const s = c.app.settings;
      const idx = s.ai.providers.findIndex((p) => p.name === opts.name);
      if (idx >= 0) s.ai.providers[idx] = cfg; else s.ai.providers.push(cfg);
      if (opts.default || s.ai.providers.length === 1) s.ai.default = opts.name;
      c.app.saveSettings(s);
      c.ok(`${idx >= 0 ? 'updated' : 'added'} provider ${opts.name} (${opts.kind}, ${opts.model})${s.ai.default === opts.name ? ' [default]' : ''}`);
      if (opts.apiKeyRef && !c.app.secret(opts.apiKeyRef)) c.warn(`secret "${opts.apiKeyRef}" is not set yet: scrappia secrets set ${opts.apiKeyRef}`);
    });

  ai.command('rm').description('Remove a provider').argument('<name>').action((name: string) => {
    const c = ctx();
    const s = c.app.settings;
    if (!s.ai.providers.some((p) => p.name === name)) throw new CliError(`provider ${name} not found`);
    s.ai.providers = s.ai.providers.filter((p) => p.name !== name);
    if (s.ai.default === name) s.ai.default = s.ai.providers[0]?.name;
    c.app.saveSettings(s);
    c.ok(`removed provider ${name}`);
  });

  ai.command('test').description('Send a tiny request to a provider to verify credentials and connectivity').argument('[name]', 'provider name (default: the default provider)').action(async (name?: string) => {
    const c = ctx();
    const s = c.app.settings;
    const cfgs = s.ai.providers.length ? s.ai.providers : autoDetectProviders();
    const cfg = name ? cfgs.find((p) => p.name === name) : cfgs.find((p) => p.name === s.ai.default) ?? cfgs[0];
    if (!cfg) throw new CliError(name ? `provider ${name} not found` : 'no AI provider configured');
    let provider;
    try { provider = createProvider(cfg, (r) => c.app.secret(r)); } catch (e) { throw new CliError((e as Error).message); }
    const started = Date.now();
    const r = await provider.test();
    if (r.ok) c.ok(`${cfg.name} ok (${Date.now() - started} ms)${r.models?.length ? `; ${r.models.length} models: ${r.models.slice(0, 8).join(', ')}${r.models.length > 8 ? ', …' : ''}` : ''}`);
    else throw new CliError(`${cfg.name} failed: ${r.error ?? 'unknown error'}`);
  });

  ai.command('generate').description('Fetch a page and let the AI draft a recipe from a natural-language instruction')
    .argument('<url>')
    .argument('<instruction>', 'what to extract, e.g. "name, price and link of every product"')
    .option('--out <file>', 'write the recipe JSON here (default: print to stdout)')
    .option('--provider <name>')
    .option('--save', 'also save the recipe to the local store')
    .action(async (url: string, instruction: string, opts: { out?: string; provider?: string; save?: boolean }) => {
      const c = ctx();
      const svc = c.app.ai();
      if (!svc) throw new CliError('no AI provider configured (see `scrappia ai --help`)');
      c.err(`fetching ${url} …\n`);
      const page = await httpFetch(url, { timeoutMs: 30_000 });
      if (page.status >= 400) throw new CliError(`fetch failed: HTTP ${page.status}`);
      c.err(`asking ${opts.provider ?? 'default provider'} …\n`);
      const draft = await svc.generateRecipe({ url: page.url, html: page.body, instruction, providerName: opts.provider });
      const v = safeParseRecipe(draft);
      if (!v.success) { c.warn('draft needs manual fixes:\n' + v.errors.map((e) => '  - ' + e).join('\n')); }
      const out = v.success ? v.recipe : draft;
      if (v.success) {
        const t = v.recipe.templates[v.recipe.entry.template];
        const preview = await c.app.preview(v.recipe, page.url).catch(() => undefined);
        c.err(`draft: ${t.list ? `list "${t.list.selector[0].value}" with ${t.list.fields.length} field(s)` : `${t.fields.length} page field(s)`}${preview ? `; preview extracted ${preview.records.length} record(s)` : ''}\n`);
      }
      if (opts.out) { const path = resolve(opts.out); writeFileSync(path, JSON.stringify(out, null, 2) + '\n'); c.ok(`wrote ${path}`); }
      else c.out(json(out));
      if (opts.save && v.success) { const rec = c.app.saveRecipe(v.recipe, { note: 'ai generate' }); c.ok(`saved as recipe ${rec.id}`); }
      c.err(`next: scrappia preview ${opts.out ?? '<file>'} to check selectors, then scrappia run\n`);
    });
}
