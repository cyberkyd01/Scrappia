import { describe, it, expect } from 'vitest';
import { Scheduler } from './index.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Logger } from '../util/logger.js';

describe('Scheduler', () => {
  it('previews cron expressions', () => {
    const runs = Scheduler.preview('0 9 * * 1-5', 'UTC', 3);
    expect(runs).toHaveLength(3);
    for (const d of runs) { expect(d.getUTCHours()).toBe(9); expect([1, 2, 3, 4, 5]).toContain(d.getUTCDay()); }
    expect(() => Scheduler.preview('not a cron')).toThrow();
  });

  it('loads schedules from storage and fires them', async () => {
    const storage = new SqliteStorage();
    storage.upsertSchedule({ recipeId: 'r1', cron: '* * * * * *', enabled: true, skipIfRunning: true });
    storage.upsertSchedule({ recipeId: 'r2', cron: '0 0 1 1 *', enabled: false, skipIfRunning: true });
    const fired: string[] = [];
    let block: () => void = () => { };
    const scheduler = new Scheduler({ storage, logger: new Logger('error'), refreshMs: 100_000, runRecipe: async (id) => { fired.push(id); await new Promise<void>((r) => { block = r; }); } });
    scheduler.start();
    expect(scheduler.nextRuns().map((n) => n.recipeId)).toEqual(['r1']);
    await new Promise((r) => setTimeout(r, 2500));
    expect(fired).toEqual(['r1']); // second tick skipped because the first is still running
    block();
    await new Promise((r) => setTimeout(r, 50));
    scheduler.stop();
    const s = storage.listSchedules().find((x) => x.recipeId === 'r1')!;
    expect(s.lastRunAt).toBeGreaterThan(0);
  });

  it('reload picks up changes', () => {
    const storage = new SqliteStorage();
    const scheduler = new Scheduler({ storage, logger: new Logger('error'), runRecipe: async () => { } });
    scheduler.start();
    expect(scheduler.nextRuns()).toHaveLength(0);
    storage.upsertSchedule({ recipeId: 'r1', cron: '0 * * * *', enabled: true, skipIfRunning: true });
    scheduler.reload();
    expect(scheduler.nextRuns()).toHaveLength(1);
    scheduler.stop();
  });
});
