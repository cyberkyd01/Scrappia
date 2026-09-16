import { Hono } from 'hono';
import { z } from 'zod';
import type { AppSettings, ScrappiaApp } from '@scrappia/core';
import type { AppEnv } from '../types.js';
import { ApiError, notFound } from '../errors.js';
import { parseBody } from '../util.js';
import { SCOPES } from '../auth.js';

const MASK = '***';

const ProviderSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(['anthropic', 'openai-compatible']),
  /** Secret ref (name in /api/secrets or env var) or a literal key. Literal keys are never returned. */
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

const SettingsSchema = z.object({
  ai: z.object({ providers: z.array(ProviderSchema).default([]), default: z.string().optional() }).default({ providers: [] }),
  defaults: z.object({ outDir: z.string().optional(), headless: z.boolean().optional() }).default({}),
});

const SecretName = z.string().regex(/^[A-Za-z0-9_.\-]{1,128}$/, 'secret names may contain letters, digits, "_", "." and "-"');
const SecretBody = z.object({ value: z.string().min(1) });

const ApiKeyBody = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.enum(SCOPES as [string, ...string[]])).min(1).default(['read', 'write']),
});

/** A provider `apiKey` is a reference when it names a stored secret or an env var; otherwise it is a literal and gets masked. */
function isSecretRef(app: ScrappiaApp, ref: string): boolean {
  return app.storage.getSecret(ref) !== undefined || process.env[ref] !== undefined;
}

export function sanitizeSettings(app: ScrappiaApp, s: AppSettings) {
  return {
    ...s,
    ai: {
      ...s.ai,
      providers: s.ai.providers.map((p) => ({ ...p, apiKey: p.apiKey ? (isSecretRef(app, p.apiKey) ? p.apiKey : MASK) : undefined })),
    },
    aiConfigured: app.ai() !== undefined,
  };
}

export function settingsRoutes(app: ScrappiaApp) {
  const r = new Hono<AppEnv>();

  // ---------- settings ----------
  r.get('/settings', (c) => c.json({ settings: sanitizeSettings(app, app.settings) }));

  r.put('/settings', async (c) => {
    const body = await parseBody(c, SettingsSchema);
    const current = app.settings;
    // A masked apiKey means "keep what is stored" for a provider of the same name.
    const providers = body.ai.providers.map((p) => {
      if (p.apiKey !== MASK) return p;
      const prev = current.ai.providers.find((x) => x.name === p.name);
      return { ...p, apiKey: prev?.apiKey };
    });
    if (body.ai.default && !providers.some((p) => p.name === body.ai.default)) {
      throw new ApiError(400, 'validation_error', `ai.default "${body.ai.default}" does not match any provider name`);
    }
    const next: AppSettings = { ai: { providers, default: body.ai.default }, defaults: body.defaults };
    app.saveSettings(next);
    return c.json({ settings: sanitizeSettings(app, app.settings) });
  });

  // ---------- secrets (values are write-only) ----------
  r.get('/secrets', (c) => c.json({ names: app.storage.listSecretNames() }));

  r.get('/secrets/:name', (c) => {
    const name = c.req.param('name');
    if (app.storage.getSecret(name) !== undefined) return c.json({ name, exists: true, source: 'store' });
    if (process.env[name] !== undefined) return c.json({ name, exists: true, source: 'env' });
    throw notFound('secret', name);
  });

  r.put('/secrets/:name', async (c) => {
    const name = SecretName.safeParse(c.req.param('name'));
    if (!name.success) throw new ApiError(400, 'validation_error', name.error.issues[0]?.message ?? 'invalid secret name');
    const body = await parseBody(c, SecretBody);
    const existed = app.storage.getSecret(name.data) !== undefined;
    app.setSecret(name.data, body.value);
    return c.json({ name: name.data, exists: true, source: 'store' }, existed ? 200 : 201);
  });

  r.delete('/secrets/:name', (c) => {
    const name = c.req.param('name');
    if (app.storage.getSecret(name) === undefined) throw notFound('secret', name);
    app.storage.deleteSecret(name);
    return c.json({ ok: true, name });
  });

  // ---------- api keys ----------
  r.get('/api-keys', (c) => c.json({ keys: app.storage.listApiKeys() }));

  r.post('/api-keys', async (c) => {
    const body = await parseBody(c, ApiKeyBody);
    const key = app.createApiKey(body.name, body.scopes.join(','));
    const rec = app.verifyApiKey(key);
    return c.json({ id: rec?.id, name: body.name, scopes: body.scopes, key, note: 'Store this key now; it is not retrievable later.' }, 201);
  });

  r.delete('/api-keys/:id', (c) => {
    const id = c.req.param('id');
    if (!app.storage.listApiKeys().some((k) => k.id === id)) throw notFound('api key', id);
    app.storage.deleteApiKey(id);
    return c.json({ ok: true, id });
  });

  return r;
}
