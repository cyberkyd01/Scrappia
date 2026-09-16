import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { EXAMPLE_RECIPES, exampleRecipe, parseRecipe } from '@scrappia/core';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { json, table, fmtDate } from '../ui.js';

export function registerMiscCommands(program: Command, ctx: () => CliContext) {
  // ----- examples -----
  const examples = program.command('examples').description('Bundled example recipes (demo sites: books.toscrape.com, quotes.toscrape.com, Hacker News)');
  examples.command('list').description('List examples').option('--json').action((opts: { json?: boolean }) => {
    const c = ctx();
    const rows = Object.entries(EXAMPLE_RECIPES).map(([name, r]) => ({ name, title: r.name, mode: r.engine?.mode ?? 'auto', description: r.description ?? '', tags: (r.tags ?? []).join(', ') }));
    if (opts.json) { c.out(json(rows)); return; }
    c.out(table(rows, ['name', 'title', 'mode', 'description', 'tags'], { painter: c.paint, maxWidth: 80 }));
    c.out(c.paint.dim('\nrun one directly:  scrappia run example:<name> --max-requests 5 --out out.csv\n'));
  });
  examples.command('show').description('Print an example recipe as JSON').argument('<name>').action((name: string) => {
    const c = ctx();
    if (!EXAMPLE_RECIPES[name]) throw new CliError(`unknown example "${name}". Available: ${Object.keys(EXAMPLE_RECIPES).join(', ')}`);
    c.out(json(parseRecipe(exampleRecipe(name))));
  });
  examples.command('copy').description('Copy an example recipe to a file you can edit and run').argument('<name>').argument('<file>').option('--force', 'overwrite an existing file').action((name: string, file: string, opts: { force?: boolean }) => {
    const c = ctx();
    if (!EXAMPLE_RECIPES[name]) throw new CliError(`unknown example "${name}". Available: ${Object.keys(EXAMPLE_RECIPES).join(', ')}`);
    const path = resolve(file);
    if (existsSync(path) && !opts.force) throw new CliError(`${path} exists (use --force to overwrite)`);
    writeFileSync(path, JSON.stringify(exampleRecipe(name), null, 2) + '\n');
    c.ok(`wrote ${path}`);
    c.out(`run it with: scrappia run ${file}\n`);
  });

  // ----- api keys -----
  const apiKey = program.command('api-key').description('API keys for the REST server (@scrappia/server) and the MCP HTTP transport');
  apiKey.command('create').description('Create a key; the plain key is printed once and only its hash is stored')
    .argument('<name>')
    .option('--scopes <list>', 'comma-separated scopes', 'read,write')
    .option('--json')
    .action((name: string, opts: { scopes: string; json?: boolean }) => {
      const c = ctx();
      const key = c.app.createApiKey(name, opts.scopes);
      if (opts.json) { c.out(json({ name, scopes: opts.scopes.split(','), key })); return; }
      c.ok(`created API key "${name}" with scopes ${opts.scopes}`);
      c.out(`${key}\n`);
      c.err(c.paint.dim('store it now; it cannot be shown again\n'));
    });
  apiKey.command('list').description('List keys').option('--json').action((opts: { json?: boolean }) => {
    const c = ctx();
    const keys = c.app.storage.listApiKeys();
    if (opts.json) { c.out(json(keys)); return; }
    if (!keys.length) { c.out('no API keys\n'); return; }
    c.out(table(keys.map((k) => ({ id: k.id, name: k.name, scopes: k.scopes.join(','), created: fmtDate(k.createdAt), lastUsed: fmtDate(k.lastUsedAt) })), ['id', 'name', 'scopes', 'created', 'lastUsed'], { painter: c.paint }));
  });
  apiKey.command('rm').description('Revoke a key').argument('<id>').action((id: string) => {
    const c = ctx();
    if (!c.app.storage.listApiKeys().some((k) => k.id === id)) throw new CliError(`api key ${id} not found`);
    c.app.storage.deleteApiKey(id);
    c.ok(`revoked api key ${id}`);
  });

  // ----- browsers -----
  const browsers = program.command('browsers').description('Manage the stealth Chromium used for browser-mode scraping');
  browsers.command('install').description('Download Chromium via patchright (npx patchright install chromium)')
    .option('--with-deps', 'also install OS dependencies (Linux)')
    .action(async (opts: { withDeps?: boolean }) => {
      const c = ctx();
      const args = ['patchright', 'install', ...(opts.withDeps ? ['--with-deps'] : []), 'chromium'];
      c.err(`running: npx ${args.join(' ')}\n`);
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('error', (e) => { c.fail(`could not start npx: ${e.message}`); resolve(1); });
        child.on('exit', (code) => resolve(code ?? 1));
      });
      if (code === 0) c.ok('chromium installed'); else throw new CliError(`patchright install exited with code ${code}`, code);
    });

  // ----- server -----
  program.command('server').description('How to start the REST API server (@scrappia/server)').action(() => {
    const c = ctx();
    c.out(`The REST API, web recorder and multi-user features live in the @scrappia/server package.

Start it with one of:
  npm run start --prefix apps/server          (from the Scrappia checkout)
  npm run dev:server                          (watch mode)
  node apps/server/dist/index.js

Environment: SCRAPPIA_HOME (data dir, default ~/.scrappia), PORT (default 8080).
Create API keys for it with:  scrappia api-key create <name> --scopes read,write
The MCP server for AI agents is separate:  scrappia-mcp  (see packages/mcp/README.md)
`);
  });
}
