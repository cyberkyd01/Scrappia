/**
 * Runs started from the desktop reuse the recorder browser's session (cookies, user agent) so a
 * headless run sees the same page the user saw while recording: consent banners accepted, logins,
 * region and currency choices. Recipe-level cookies/userAgent always win.
 */
import type { Recipe, RecipeInput } from '@scrappia/core';
import type { RecorderSession } from './recorder';

export async function withRecorderSession<T extends RecipeInput | Recipe | string>(recorder: RecorderSession, recipe: T): Promise<T> {
  if (typeof recipe === 'string') return recipe;
  const state = await recorder.sessionState().catch(() => null);
  if (!state) return recipe;
  const r = recipe as RecipeInput;
  const engine = { ...(r.engine ?? {}) } as NonNullable<RecipeInput['engine']>;
  const existing = engine.cookies ?? [];
  const merged = [...existing];
  for (const c of state.cookies) if (!existing.some((e) => e.name === c.name && (e.domain ?? '') === c.domain)) merged.push(c);
  engine.cookies = merged;
  if (!engine.userAgent && state.userAgent) engine.userAgent = state.userAgent;
  return { ...r, engine } as T;
}
