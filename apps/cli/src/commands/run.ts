import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, parseIntOpt } from '../context.js';
import { loadRecipe, applyRunOverrides } from '../recipe.js';
import { RunWatcher, printRunSummary, exitCodeFor } from '../progress.js';
import { json } from '../ui.js';

export function registerRunCommands(program: Command, ctx: () => CliContext) {
  program
    .command('run')
    .description('Run a recipe file (or example:<name>) and follow its progress')
    .argument('<recipe>', 'path to a recipe JSON file, example:<name>, or recipe:<savedId>')
    .option('--pages <n>', 'stop after N pages of the entry template (sets pagination maxPages)', parseIntOpt('--pages'))
    .option('--max-requests <n>', 'hard cap on requests for this run (trial runs)', parseIntOpt('--max-requests'))
    .option('--out <file>', 'write results to this file instead of the recipe sinks (format by extension)')
    .option('--format <fmt>', 'file format for --out: csv|tsv|json|jsonl|xlsx|xml|parquet|sqlite')
    .option('--mode <mode>', 'fetch mode override: http|browser|auto')
    .option('--headed', 'show the browser window (browser mode)')
    .option('--concurrency <n>', 'parallel requests', parseIntOpt('--concurrency'))
    .option('--dry-run', 'extract only: skip sinks, monitoring and alerts')
    .option('--quiet', 'no progress output')
    .option('--json', 'print the final { run, stats } as JSON only')
    .addHelpText('after', `
Exit codes: 0 succeeded, 2 partial (some requests failed), 1 failed or cancelled.
Press Ctrl+C once to cancel gracefully (the run can be resumed), twice to force quit.

Examples:
  scrappia run books.json
  scrappia run books.json --pages 2 --out books.csv
  scrappia run example:hacker-news-monitor --out hn.jsonl --json
  scrappia run shop.json --mode browser --headed --concurrency 1`)
    .action(async (file: string, opts: { pages?: number; maxRequests?: number; out?: string; format?: string; mode?: string; headed?: boolean; concurrency?: number; dryRun?: boolean; quiet?: boolean; json?: boolean }) => {
      const c = ctx();
      const { recipe: loaded } = loadRecipe(file, (id) => c.app.getRecipe(id).recipe);
      const recipe = applyRunOverrides(loaded, opts);
      const watcher = new RunWatcher(c, { quiet: opts.quiet, json: opts.json });
      watcher.attach();
      let active;
      try {
        active = await c.app.startRun(recipe, { maxRequests: opts.maxRequests, dryRun: opts.dryRun, headless: opts.headed ? false : undefined, trigger: 'cli' });
      } catch (e) { watcher.detach(); throw new CliError(`could not start run: ${(e as Error).message}`); }
      const { run, stats } = await watcher.wait(active);
      if (opts.json) c.out(json({ run: { ...run, recipeJson: undefined }, stats }));
      else if (!opts.quiet) printRunSummary(c, run, stats);
      c.exitCode = exitCodeFor(run.status);
    });

  program
    .command('resume')
    .description('Resume a stopped (cancelled/failed/partial) run: re-queues unfinished requests and keeps existing rows')
    .argument('<runId>')
    .option('--quiet', 'no progress output')
    .option('--json', 'print the final { run, stats } as JSON only')
    .action(async (runId: string, opts: { quiet?: boolean; json?: boolean }) => {
      const c = ctx();
      const existing = c.app.getRun(runId);
      if (!existing) throw new CliError(`run ${runId} not found`);
      if (existing.status === 'running') throw new CliError(`run ${runId} is still running`);
      const watcher = new RunWatcher(c, opts);
      watcher.attach();
      let active;
      try { active = await c.app.resumeStoppedRun(runId, { trigger: 'cli-resume' }); }
      catch (e) { watcher.detach(); throw new CliError(`could not resume: ${(e as Error).message}`); }
      const { run, stats } = await watcher.wait(active);
      if (opts.json) c.out(json({ run: { ...run, recipeJson: undefined }, stats }));
      else if (!opts.quiet) printRunSummary(c, run, stats);
      c.exitCode = exitCodeFor(run.status);
    });
}
