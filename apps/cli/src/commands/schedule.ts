import type { Command } from 'commander';
import { Scheduler } from '@scrappia/core';
import type { CliContext } from '../context.js';
import { CliError, parseIntOpt } from '../context.js';
import { json, table, fmtDate, fmtDuration, statusColor } from '../ui.js';

function previewCron(expr: string, tz?: string, n = 5): Date[] {
  try { return Scheduler.preview(expr, tz, n); }
  catch (e) { throw new CliError(`invalid cron expression "${expr}": ${(e as Error).message}`); }
}

export function registerScheduleCommands(program: Command, ctx: () => CliContext) {
  const schedule = program.command('schedule').description('Cron schedules for saved recipes (executed by `scrappia serve-scheduler` or the server)')
    .addHelpText('after', `
Cron syntax: "min hour day month weekday" (5 fields) or with leading seconds (6 fields), e.g.
  "0 */6 * * *"      every 6 hours
  "30 8 * * 1-5"     08:30 on weekdays
  "@hourly"          nicknames: @yearly @monthly @weekly @daily @hourly`);

  schedule.command('list').description('List schedules with their next run time').option('--json').action((opts: { json?: boolean }) => {
    const c = ctx();
    const list = c.app.storage.listSchedules();
    const rows = list.map((s) => {
      let next: Date | undefined;
      try { next = previewCron(s.cron, s.tz, 1)[0]; } catch { next = undefined; }
      return { id: s.id, recipe: c.app.getRecipe(s.recipeId).record?.name ?? s.recipeId, recipeId: s.recipeId, cron: s.cron, tz: s.tz ?? 'local', enabled: s.enabled, next: s.enabled ? fmtDate(next ? +next : undefined) : '-', last: fmtDate(s.lastRunAt) };
    });
    if (opts.json) { c.out(json(rows)); return; }
    if (!rows.length) { c.out('no schedules. Add one with: scrappia schedule add <recipeId> "0 * * * *"\n'); return; }
    c.out(table(rows, ['id', 'recipe', 'cron', 'tz', 'enabled', 'next', 'last'], { painter: c.paint }));
  });

  schedule.command('add').description('Create or replace the schedule of a saved recipe')
    .argument('<recipeId>')
    .argument('<cron>', 'cron expression (quote it)')
    .option('--tz <zone>', 'IANA time zone, e.g. Europe/Berlin (default: local)')
    .option('--no-skip-if-running', 'allow overlapping runs')
    .option('--disabled', 'create disabled')
    .action((recipeId: string, cron: string, opts: { tz?: string; skipIfRunning: boolean; disabled?: boolean }) => {
      const c = ctx();
      if (!c.app.getRecipe(recipeId).record) throw new CliError(`recipe ${recipeId} not found (save it first with: scrappia recipes add <file>)`);
      const next = previewCron(cron, opts.tz, 3);
      const existing = c.app.storage.listSchedules().find((s) => s.recipeId === recipeId);
      const rec = c.app.storage.upsertSchedule({ id: existing?.id, recipeId, cron, tz: opts.tz, enabled: !opts.disabled, skipIfRunning: opts.skipIfRunning !== false });
      c.app.scheduler.reload();
      c.ok(`${existing ? 'updated' : 'created'} schedule ${rec.id}: ${cron}${opts.tz ? ' ' + opts.tz : ''}`);
      c.out(`next runs: ${next.map((d) => fmtDate(+d)).join(', ')}\n`);
    });

  schedule.command('rm').description('Delete a schedule (by schedule id or recipe id)').argument('<id>').action((id: string) => {
    const c = ctx();
    const s = c.app.storage.listSchedules().find((x) => x.id === id || x.recipeId === id);
    if (!s) throw new CliError(`schedule ${id} not found`);
    c.app.storage.deleteSchedule(s.id);
    c.app.scheduler.reload();
    c.ok(`deleted schedule ${s.id}`);
  });

  schedule.command('preview').description('Validate a cron expression and print the next run times')
    .argument('<cron>')
    .option('--tz <zone>')
    .option('--count <n>', 'how many', parseIntOpt('--count'), 5)
    .option('--json')
    .action((cron: string, opts: { tz?: string; count: number; json?: boolean }) => {
      const c = ctx();
      const next = previewCron(cron, opts.tz, opts.count);
      if (opts.json) { c.out(json({ cron, tz: opts.tz ?? null, next: next.map((d) => d.toISOString()) })); return; }
      c.out(`${cron}${opts.tz ? ' (' + opts.tz + ')' : ''}\n` + next.map((d) => `  ${fmtDate(+d)}  ${c.paint.dim(d.toISOString())}`).join('\n') + '\n');
    });

  program.command('serve-scheduler').description('Run the cron scheduler in the foreground until Ctrl+C (executes saved schedules)')
    .action(async () => {
      const c = ctx();
      const app = c.app;
      const p = c.paint;
      app.scheduler.start();
      const jobs = app.scheduler.nextRuns();
      c.out(`scheduler running with ${jobs.length} schedule(s); data dir ${app.dataDir}\n`);
      for (const j of jobs) c.out(`  ${app.getRecipe(j.recipeId).record?.name ?? j.recipeId}  next ${fmtDate(j.next ? +j.next : undefined)}\n`);
      if (!jobs.length) c.warn('no enabled schedules; add one with `scrappia schedule add` (this process picks up changes every 30s)');
      const off = app.on((e) => {
        if (e.type === 'run.start') c.out(`${p.dim(fmtDate(Date.now()))} ${p.cyan('start')} ${e.run.recipeName} (${e.run.id})\n`);
        else if (e.type === 'run.done') c.out(`${p.dim(fmtDate(Date.now()))} ${statusColor(p, e.run.status)} ${e.run.recipeName} (${e.run.id}) ${e.stats.rows} rows in ${fmtDuration(e.stats.elapsedMs)}\n`);
        else if (e.type === 'alert') c.out(`${p.dim(fmtDate(Date.now()))} ${p.magenta('alert')} ${e.title}\n`);
      });
      await new Promise<void>((resolve) => {
        const stop = () => { c.out('\nstopping scheduler…\n'); for (const a of app.activeRuns()) a.runner.cancel(); off(); resolve(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
      await Promise.allSettled(app.activeRuns().map((a) => a.promise));
    });
}
