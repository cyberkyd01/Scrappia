import { Cron } from 'croner';
import type { Storage, ScheduleRecord } from '../storage/types.js';
import { Logger, rootLogger } from '../util/logger.js';

export interface SchedulerOptions {
  storage: Storage;
  /** Start a run for a recipe id; resolves when the run finishes. */
  runRecipe: (recipeId: string, trigger: string) => Promise<unknown>;
  logger?: Logger;
  /** Poll interval to pick up schedule changes made elsewhere (ms). */
  refreshMs?: number;
}

/** Cron scheduler backed by the schedules table; safe to restart (state lives in storage). */
export class Scheduler {
  private jobs = new Map<string, { cron: Cron; rec: ScheduleRecord }>();
  private running = new Set<string>();
  private timer?: NodeJS.Timeout;
  private log: Logger;

  constructor(private opts: SchedulerOptions) { this.log = (opts.logger ?? rootLogger).child('scheduler'); }

  start() {
    this.reload();
    this.timer = setInterval(() => this.reload(), this.opts.refreshMs ?? 30_000);
    this.log.info('scheduler started', { jobs: this.jobs.size });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const j of this.jobs.values()) j.cron.stop();
    this.jobs.clear();
  }

  /** Sync in-memory cron jobs with the schedules table. */
  reload() {
    const wanted = new Map(this.opts.storage.listSchedules().map((s) => [s.id, s]));
    for (const [id, j] of this.jobs) {
      const w = wanted.get(id);
      if (!w || !w.enabled || w.cron !== j.rec.cron || w.tz !== j.rec.tz) { j.cron.stop(); this.jobs.delete(id); }
    }
    for (const s of wanted.values()) {
      if (!s.enabled || this.jobs.has(s.id)) continue;
      try {
        const cron = new Cron(s.cron, { timezone: s.tz, protect: true }, () => this.fire(s));
        this.jobs.set(s.id, { cron, rec: s });
        const next = cron.nextRun();
        this.opts.storage.touchSchedule(s.id, s.lastRunAt ?? 0, next ? +next : undefined);
      } catch (e) { this.log.error('invalid schedule', { id: s.id, cron: s.cron, error: (e as Error).message }); }
    }
  }

  private async fire(s: ScheduleRecord) {
    if (s.skipIfRunning && this.running.has(s.recipeId)) { this.log.info('skipping scheduled run: previous still running', { recipeId: s.recipeId }); return; }
    this.running.add(s.recipeId);
    const started = Date.now();
    try {
      this.log.info('scheduled run starting', { recipeId: s.recipeId });
      await this.opts.runRecipe(s.recipeId, 'schedule');
    } catch (e) { this.log.error('scheduled run failed', { recipeId: s.recipeId, error: (e as Error).message }); }
    finally {
      this.running.delete(s.recipeId);
      const next = this.jobs.get(s.id)?.cron.nextRun();
      this.opts.storage.touchSchedule(s.id, started, next ? +next : undefined);
    }
  }

  nextRuns(): Array<{ scheduleId: string; recipeId: string; next?: Date }> {
    return Array.from(this.jobs.values()).map((j) => ({ scheduleId: j.rec.id, recipeId: j.rec.recipeId, next: j.cron.nextRun() ?? undefined }));
  }

  /** Validate a cron expression and report the next few runs. */
  static preview(expr: string, tz?: string, n = 5): Date[] {
    const c = new Cron(expr, { timezone: tz });
    const out = c.nextRuns(n);
    c.stop();
    return out;
  }
}
