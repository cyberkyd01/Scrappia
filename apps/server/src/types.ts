import type { Context } from 'hono';

/** Identity attached to every authenticated request. */
export interface AuthInfo {
  id: string;
  name: string;
  scopes: string[];
  /** `key` = stored API key, `bootstrap` = SCRAPPIA_API_KEY env, `loopback` = unauthenticated local request. */
  kind: 'key' | 'bootstrap' | 'loopback';
}

export type AppEnv = { Variables: { auth: AuthInfo } };

export type AppContext = Context<AppEnv>;
