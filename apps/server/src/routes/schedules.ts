import { Hono } from 'hono';
import { z } from 'zod';
import { Scheduler, type ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { ApiError } from '../errors.js';
import { isoOrNull, parseBody, parseQuery } from '../util.js';

const PreviewBody = z.object({
  cron: z.string().min(1),
  tz: z.string().min(1).optional(),
  count: z.number().int().min(1).max(50).default(5),
});

const AlertsQuery = z.object({
  unread: z.enum(['1', 'true', '0', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const ReadBody = z.object({ ids: z.array(z.string().min(1)).optional(), all: z.boolean().optional() });

export function scheduleRoutes(app: ScrappiaApp) {
  const r = new Hono<AppEnv>();

  r.get('/schedules', (c) => {
    const schedules = app.storage.listSchedules().map((s) => ({
      ...s,
      recipeName: app.storage.getRecipe(s.recipeId)?.name ?? null,
      lastRunAtIso: isoOrNull(s.lastRunAt), nextRunAtIso: isoOrNull(s.nextRunAt),
    }));
    return c.json({ schedules });
  });

  r.get('/schedules/next', (c) => {
    const next = app.scheduler.nextRuns()
      .map((n) => ({ scheduleId: n.scheduleId, recipeId: n.recipeId, recipeName: app.storage.getRecipe(n.recipeId)?.name ?? null, next: isoOrNull(n.next) }))
      .sort((a, b) => (a.next ?? 'z').localeCompare(b.next ?? 'z'));
    return c.json({ next });
  });

  r.post('/schedules/preview', async (c) => {
    const body = await parseBody(c, PreviewBody);
    let dates: Date[];
    try { dates = Scheduler.preview(body.cron, body.tz, body.count); }
    catch (e) { throw new ApiError(400, 'invalid_cron', `Invalid cron expression: ${(e as Error).message}`); }
    return c.json({ cron: body.cron, tz: body.tz ?? null, next: dates.map((d) => d.toISOString()) });
  });

  return r;
}

export function alertRoutes(app: ScrappiaApp) {
  const r = new Hono<AppEnv>();

  r.get('/alerts', (c) => {
    const q = parseQuery(c, AlertsQuery);
    const unreadOnly = q.unread === '1' || q.unread === 'true';
    return c.json({ alerts: app.storage.listAlerts({ unreadOnly, limit: q.limit }) });
  });

  r.post('/alerts/read', async (c) => {
    const body = await parseBody(c, ReadBody, { optional: true });
    if (body.all || !body.ids?.length) app.storage.markAlertsRead();
    else app.storage.markAlertsRead(body.ids);
    return c.json({ ok: true, ids: body.all || !body.ids?.length ? 'all' : body.ids });
  });

  return r;
}
