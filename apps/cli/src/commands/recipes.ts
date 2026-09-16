import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { importWebScraperSitemap } from '@scrappia/core';
import { loadRecipeInput, validateRecipe } from '../recipe.js';
import { json, table, fmtDate, kv } from '../ui.js';

export function registerRecipeCommands(program: Command, ctx: () => CliContext) {
  const recipes = program.command('recipes').description('Manage recipes saved in the local store (used by schedules, the server and the MCP server)');

  recipes.command('list').description('List saved recipes').option('--json').action((opts: { json?: boolean }) => {
    const c = ctx();
    const list = c.app.listRecipes();
    const schedules = c.app.storage.listSchedules();
    if (opts.json) { c.out(json(list)); return; }
    if (!list.length) { c.out('no saved recipes. Add one with: scrappia recipes add <file.json>\n'); return; }
    c.out(table(list.map((r) => ({ id: r.id, name: r.name, version: r.version, updated: fmtDate(r.updatedAt), schedule: schedules.find((s) => s.recipeId === r.id)?.cron ?? '' })), ['id', 'name', 'version', 'updated', 'schedule'], { painter: c.paint }));
  });

  recipes.command('add').description('Validate and save a recipe file (creates a new version when --id already exists)')
    .argument('<file>', 'recipe JSON file or example:<name>')
    .option('--id <id>', 'recipe id (default: the recipe\'s "id" field or a generated id)')
    .option('--note <text>', 'version note')
    .option('--json')
    .action((file: string, opts: { id?: string; note?: string; json?: boolean }) => {
      const c = ctx();
      let { input } = loadRecipeInput(file);
      const { source } = loadRecipeInput(file);
      // webscraper.io "sitemap" exports (selector tree) are converted on the fly
      const doc = input as { selectors?: unknown; startUrl?: unknown; templates?: unknown };
      if (Array.isArray(doc?.selectors) && !doc.templates) {
        const { recipe: converted, skipped } = importWebScraperSitemap(doc as Parameters<typeof importWebScraperSitemap>[0]);
        input = converted;
        if (skipped.length) c.warn(`sitemap import skipped unsupported selectors: ${skipped.join(', ')}`);
      }
      const recipe = validateRecipe(input, source);
      const rec = c.app.saveRecipe(recipe, { id: opts.id, note: opts.note });
      if (opts.json) { c.out(json(rec)); return; }
      c.ok(`saved "${rec.name}" as ${rec.id} (version ${rec.version})`);
      if (recipe.schedule) c.out(`schedule ${recipe.schedule.cron}${recipe.schedule.tz ? ' ' + recipe.schedule.tz : ''} registered; run \`scrappia serve-scheduler\` to execute it\n`);
    });

  recipes.command('show').description('Print a saved recipe as JSON').argument('<id>').option('--versions', 'list versions instead of the current JSON').action((id: string, opts: { versions?: boolean }) => {
    const c = ctx();
    const { record, recipe } = c.app.getRecipe(id);
    if (!record || !recipe) throw new CliError(`recipe ${id} not found`);
    if (opts.versions) { c.out(table(c.app.storage.listRecipeVersions(id).map((v) => ({ version: v.version, created: fmtDate(v.createdAt), note: v.note ?? '' })), ['version', 'created', 'note'], { painter: c.paint })); return; }
    c.out(json({ ...recipe, id }));
  });

  recipes.command('rm').description('Delete a saved recipe (and its schedule)').argument('<id>').action((id: string) => {
    const c = ctx();
    if (!c.app.getRecipe(id).record) throw new CliError(`recipe ${id} not found`);
    c.app.deleteRecipe(id);
    c.ok(`deleted recipe ${id}`);
  });

  recipes.command('export').description('Write a saved recipe to a JSON file').argument('<id>').argument('<file>').action((id: string, file: string) => {
    const c = ctx();
    const { recipe } = c.app.getRecipe(id);
    if (!recipe) throw new CliError(`recipe ${id} not found`);
    const path = resolve(file);
    writeFileSync(path, JSON.stringify({ ...recipe, id }, null, 2) + '\n');
    c.ok(`wrote ${path}`);
  });

  recipes.command('info').description('Summary of a saved recipe: templates, last runs, schedule').argument('<id>').action((id: string) => {
    const c = ctx();
    const { record, recipe } = c.app.getRecipe(id);
    if (!record || !recipe) throw new CliError(`recipe ${id} not found`);
    const runs = c.app.listRuns({ recipeId: id, limit: 5 });
    const sched = c.app.storage.listSchedules().find((s) => s.recipeId === id);
    c.out(kv([['id', id], ['name', record.name], ['version', record.version], ['updated', fmtDate(record.updatedAt)], ['templates', Object.keys(recipe.templates).join(', ')], ['entry', recipe.entry.urls.join(', ')], ['schedule', sched ? `${sched.cron} ${sched.tz ?? ''} (${sched.enabled ? 'enabled' : 'disabled'})` : 'none']], c.paint));
    if (runs.length) c.out('\nrecent runs\n' + table(runs.map((r) => ({ id: r.id, status: r.status, started: fmtDate(r.startedAt), rows: (r.stats as { rows?: number }).rows ?? 0 })), ['id', 'status', 'started', 'rows'], { painter: c.paint }));
  });
}
