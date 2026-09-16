/**
 * Hand-written OpenAPI 3.1 document for the Scrappia REST API.
 * Keep in sync with the routes under ./routes. Served at GET /api/openapi.json; rendered by GET /docs.
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) });
const arr = (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, Schema>, required?: string[], extra: Schema = {}): Schema => ({ type: 'object', properties, ...(required?.length ? { required } : {}), ...extra });
const anyObj = (description?: string): Schema => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) });

const json = (schema: Schema, description: string, extra: Schema = {}) => ({ description, content: { 'application/json': { schema } }, ...extra });
const errorResponse = (description: string) => json(ref('Error'), description);
const ERR = {
  400: errorResponse('Validation error (`validation_error`, `invalid_json`, `invalid_recipe`) or precondition (`ai_not_configured`, `invalid_cron`).'),
  401: errorResponse('Missing or invalid API key.'),
  403: errorResponse('API key lacks the required scope.'),
  404: errorResponse('Unknown id.'),
  409: errorResponse('Conflict (e.g. `run_active`, `run_not_active`, `already_exists`).'),
  429: errorResponse('Rate limit exceeded; see `Retry-After`.'),
};
const AUTH = { security: [{ bearerAuth: [] }, { apiKeyHeader: [] }] };

const pathId = (name: string, description: string) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const runIdParam = pathId('id', 'Run id');
const recipeIdParam = pathId('id', 'Recipe id');
const q = (name: string, schema: Schema, description: string) => ({ name, in: 'query', required: false, schema, description });
const rowsParams = [
  q('dataset', { type: 'string' }, 'Dataset name; omit for all datasets of the run.'),
  q('format', { type: 'string', enum: ['json', 'csv', 'jsonl'], default: 'json' }, 'Response format. `csv` and `jsonl` are streamed and unbounded unless `limit` is set.'),
  q('limit', { type: 'integer', minimum: 1, maximum: 10000 }, 'Page size (json default 1000; csv/jsonl default unlimited).'),
  q('offset', { type: 'integer', minimum: 0, default: 0 }, 'Rows to skip.'),
];
const rowsResponses = {
  200: {
    description: 'Rows of the run.',
    content: {
      'application/json': { schema: ref('RowsPage') },
      'text/csv': { schema: { type: 'string' }, example: 'title,price,url\r\n"A Light in the Attic",51.77,https://example.com/a\r\n' },
      'application/x-ndjson': { schema: { type: 'string' }, example: '{"title":"A Light in the Attic","price":51.77}\n' },
    },
  },
  400: ERR[400], 401: ERR[401], 404: ERR[404],
};

const RUN_STATUS = ['running', 'succeeded', 'partial', 'failed', 'cancelled'];
const REQUEST_STATUS = ['pending', 'running', 'done', 'failed', 'skipped'];
const RUN_EVENT_TYPES = ['run.start', 'run.progress', 'run.done', 'request.start', 'request.done', 'rows', 'drift', 'alert', 'log', 'export.done', 'captcha.needed'];

export function buildOpenApi(opts: { version: string; serverUrl?: string }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Scrappia API',
      version: opts.version,
      summary: 'Run, schedule and monitor Scrappia scraping recipes; read datasets; stream run events.',
      description: [
        '## Authentication',
        'Send an API key as `Authorization: Bearer <key>` or `x-api-key: <key>`. Keys are created with `POST /api/api-keys` and carry scopes:',
        '`read` (GET requests), `write` (everything else), `admin` (both).',
        '',
        'Bootstrap: while **no** API keys exist in storage, the `SCRAPPIA_API_KEY` environment value is accepted (a warning is logged). If neither exists, unauthenticated requests are accepted from loopback addresses only.',
        '',
        '`GET /health`, `GET /docs` and `GET /api/openapi.json` never require a key.',
        '',
        '## Errors',
        'Every failure is `{ "error": { "code": string, "message": string, "details"?: any } }`. Validation failures return `400` with `details` listing zod issues (or recipe error strings for `invalid_recipe`).',
        '',
        '## Rate limiting',
        'Requests are limited per API key with a token bucket (default 600/min, `SCRAPPIA_RATE_LIMIT`). Exceeding it yields `429` with `Retry-After`, plus `X-RateLimit-Limit` / `X-RateLimit-Remaining` on every response.',
        '',
        '## Server-Sent Events',
        '`GET /api/runs/{id}/events` and `GET /api/events` stream `RunEvent`s: `event:` is the event type, `data:` is the JSON event, `id:` increments. A `: ping` comment is sent every 15 s. The per-run stream closes after `run.done` (sent immediately for already-finished runs). The first message is `event: ready`.',
        '',
        '## Webhook signatures',
        'Webhook sinks (`sinks[].type = "webhook"`) and webhook alert channels POST JSON with these headers:',
        '- `x-scrappia-run`: run id (sinks only)',
        '- `x-scrappia-timestamp`: unix epoch milliseconds, present when a `secretRef` is configured',
        '- `x-scrappia-signature`: `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, present when a `secretRef` is configured',
        '',
        'Verify by recomputing `HMAC_SHA256(secret, timestamp + "." + rawBody)` and comparing with a constant-time check; reject stale timestamps to prevent replay.',
      ].join('\n'),
      license: { name: 'Apache-2.0' },
    },
    servers: [{ url: opts.serverUrl ?? '/', description: 'This server' }],
    tags: [
      { name: 'System' }, { name: 'Recipes' }, { name: 'Runs' }, { name: 'Datasets' }, { name: 'Events' },
      { name: 'Settings' }, { name: 'Secrets' }, { name: 'API keys' }, { name: 'Schedules' }, { name: 'Alerts' }, { name: 'AI' }, { name: 'Reference' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key as bearer token.' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
      schemas: {
        Error: obj({ error: obj({ code: str('Stable machine-readable code.'), message: str(), details: { description: 'Optional structured details (validation issues, recipe errors).' } }, ['code', 'message']) }, ['error']),
        Ok: obj({ ok: bool(), id: str() }, ['ok']),
        Recipe: anyObj('A Scrappia recipe (see packages/core/src/recipe/schema.ts). Minimum: `name`, `entry.urls`, `entry.template`, `templates`.'),
        RecipeRecord: obj({ id: str(), name: str(), version: int('Increments on every save.'), json: ref('Recipe'), createdAt: int('epoch ms'), updatedAt: int('epoch ms') }, ['id', 'name', 'version', 'json', 'createdAt', 'updatedAt']),
        RecipeVersion: obj({ version: int(), createdAt: int(), note: str(), json: ref('Recipe') }, ['version', 'createdAt', 'json']),
        ValidationResult: obj({ valid: bool(), errors: arr(str()), recipe: ref('Recipe') }, ['valid', 'errors']),
        RunOptions: obj({ trigger: str('Free-form trigger label (default `api`).'), maxRequests: int('Hard cap on requests for this run.'), dryRun: bool('Extract without writing sinks / monitors.') }),
        AdHocRun: { oneOf: [ref('Recipe'), obj({ recipe: ref('Recipe'), trigger: str(), maxRequests: int(), dryRun: bool() }, ['recipe'])], description: 'Either a bare recipe or `{ recipe, ...RunOptions }`.' },
        RunStats: obj({
          requests: obj({ total: int(), done: int(), failed: int(), pending: int(), running: int(), skipped: int() }),
          rows: int(), rowsByDataset: { type: 'object', additionalProperties: { type: 'integer' } }, pages: int(), bytes: int(), httpFetches: int(), browserFetches: int(),
          drift: int(), healed: int(), validationFlags: int(), validationDrops: int(), startedAt: int(), finishedAt: int(), elapsedMs: int(), rowsPerMinute: { type: 'number' }, aiCalls: int(), aiTokens: int(),
          exports: arr(ref('ExportResult')), monitor: obj({ added: int(), removed: int(), changed: int() }),
        }, undefined, { additionalProperties: true }),
        Run: obj({
          id: str(), recipeId: str('Absent for ad-hoc runs.'), recipeName: str(), recipeJson: ref('Recipe'), status: str(undefined, { enum: RUN_STATUS }),
          startedAt: int('epoch ms'), finishedAt: int('epoch ms'), stats: ref('RunStats'), error: str(), trigger: str(),
        }, ['id', 'recipeName', 'status', 'startedAt', 'stats', 'trigger']),
        RunAccepted: obj({ runId: str(), run: ref('Run') }, ['runId', 'run']),
        RunDetail: obj({
          run: ref('Run'), active: bool('True while the run is executing in this process.'), stats: ref('RunStats'),
          queue: obj(Object.fromEntries(REQUEST_STATUS.map((s) => [s, int()]))),
          datasets: arr(obj({ dataset: str(), rows: int() })),
        }, ['run', 'active', 'stats', 'queue', 'datasets']),
        RowsPage: obj({ runId: str(), dataset: { type: ['string', 'null'] }, rows: arr(anyObj()), total: int('Total rows matching (ignores limit/offset).'), offset: int(), limit: int() }, ['runId', 'rows', 'total', 'offset', 'limit']),
        Request: obj({
          id: str(), runId: str(), url: str(), uniqueKey: str(), template: str(), method: str(undefined, { enum: ['GET', 'POST'] }), body: str(), status: str(undefined, { enum: REQUEST_STATUS }),
          depth: int(), attempts: int(), parentId: str(), context: anyObj(), error: str(), createdAt: int(),
        }, ['id', 'runId', 'url', 'template', 'status']),
        DriftEvent: obj({
          id: str(), runId: str(), recipeId: str(), template: str(), field: str(),
          kind: str(undefined, { enum: ['field-missing', 'list-empty', 'fallback-candidate', 'healed', 'heal-failed', 'validation'] }), detail: anyObj(), pageUrl: str(), createdAt: int(),
        }, ['id', 'runId', 'template', 'kind', 'detail', 'createdAt']),
        Diff: obj({
          runId: str(), against: str('The run compared against.'), dataset: { type: ['string', 'null'] },
          summary: obj({ added: int(), removed: int(), changed: int(), unchanged: int() }),
          added: arr(anyObj()), removed: arr(anyObj()), changed: arr(anyObj('`{ key, before, after, changes }`')), unchanged: int(),
        }, ['runId', 'against', 'summary', 'added', 'removed', 'changed', 'unchanged']),
        Sink: anyObj('A sink config from the recipe schema (`type` discriminated: csv, tsv, json, jsonl, xlsx, xml, parquet, sqlite, postgres, mysql, mongodb, google-sheets, airtable, notion, s3, webhook, stdout).'),
        ExportResult: obj({ type: str(), rows: int(), target: str(), error: str() }, ['type', 'rows', 'target']),
        RunEvent: obj({ type: str(undefined, { enum: RUN_EVENT_TYPES }) }, ['type'], { additionalProperties: true, description: 'See packages/core/src/engine/events.ts for the per-type payloads.' }),
        AiProvider: obj({ name: str(), kind: str(undefined, { enum: ['anthropic', 'openai-compatible'] }), apiKey: str('Secret ref (name of a stored secret or env var) or literal key. Literal keys are returned masked as `***`; sending `***` back keeps the stored value.'), baseUrl: str(), model: str(), effort: str(undefined, { enum: ['low', 'medium', 'high'] }) }, ['name', 'kind', 'model']),
        Settings: obj({ ai: obj({ providers: arr(ref('AiProvider')), default: str('Provider name used by default.') }), defaults: obj({ outDir: str(), headless: bool() }), aiConfigured: bool('Read-only: whether an AI provider is usable.') }),
        SecretStatus: obj({ name: str(), exists: bool(), source: str(undefined, { enum: ['store', 'env'] }) }, ['name', 'exists']),
        ApiKey: obj({ id: str(), name: str(), scopes: arr(str(undefined, { enum: ['read', 'write', 'admin'] })), createdAt: int(), lastUsedAt: int() }, ['id', 'name', 'scopes', 'createdAt']),
        ApiKeyCreated: obj({ id: str(), name: str(), scopes: arr(str()), key: str('Plaintext key, shown once.'), note: str() }, ['name', 'scopes', 'key']),
        Schedule: obj({ id: str(), recipeId: str(), recipeName: { type: ['string', 'null'] }, cron: str(), tz: str(), enabled: bool(), skipIfRunning: bool(), lastRunAt: int(), nextRunAt: int(), lastRunAtIso: { type: ['string', 'null'] }, nextRunAtIso: { type: ['string', 'null'] }, createdAt: int() }, ['id', 'recipeId', 'cron', 'enabled']),
        Alert: obj({ id: str(), runId: str(), recipeId: str(), kind: str(), title: str(), body: str(), detail: anyObj(), createdAt: int(), read: bool() }, ['id', 'kind', 'title', 'body', 'createdAt', 'read']),
        Preview: obj({ url: str(), status: int(), records: arr(anyObj()), page: anyObj(), listMatched: int(), fieldMatches: anyObj() }),
      },
    },
    paths: {
      '/health': {
        get: { tags: ['System'], summary: 'Liveness + basic status (no auth)', security: [], responses: { 200: json(obj({ ok: bool(), version: str(), uptime: { type: 'number', description: 'seconds' }, activeRuns: int() }, ['ok', 'version', 'uptime', 'activeRuns']), 'Server is up.') } },
      },
      '/docs': { get: { tags: ['Reference'], summary: 'Interactive API reference (HTML, no auth)', security: [], responses: { 200: { description: 'HTML page.', content: { 'text/html': { schema: { type: 'string' } } } } } } },
      '/api/openapi.json': { get: { tags: ['Reference'], summary: 'This document (no auth)', security: [], responses: { 200: json(anyObj(), 'OpenAPI 3.1 document.') } } },

      '/api/recipes': {
        get: { tags: ['Recipes'], summary: 'List recipes', ...AUTH, responses: { 200: json(obj({ recipes: arr(ref('RecipeRecord')) }), 'All recipes.'), 401: ERR[401] } },
        post: {
          tags: ['Recipes'], summary: 'Create a recipe', ...AUTH,
          parameters: [q('note', { type: 'string' }, 'Version note.')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('Recipe') } } },
          responses: { 201: json(obj({ recipe: ref('RecipeRecord') }), 'Created (version 1). A recipe with a `schedule` is registered with the scheduler.'), 400: ERR[400], 401: ERR[401], 403: ERR[403], 409: ERR[409] },
        },
      },
      '/api/recipes/validate': {
        post: { tags: ['Recipes'], summary: 'Validate a recipe without saving', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: ref('Recipe') } } }, responses: { 200: json(ref('ValidationResult'), 'Always 200; check `valid`. On success `recipe` is the normalized recipe with defaults applied.'), 401: ERR[401] } },
      },
      '/api/recipes/{id}': {
        parameters: [recipeIdParam],
        get: { tags: ['Recipes'], summary: 'Get a recipe', ...AUTH, responses: { 200: json(obj({ recipe: ref('RecipeRecord') }), 'Recipe.'), 401: ERR[401], 404: ERR[404] } },
        put: { tags: ['Recipes'], summary: 'Replace a recipe (new version)', ...AUTH, parameters: [q('note', { type: 'string' }, 'Version note.')], requestBody: { required: true, content: { 'application/json': { schema: ref('Recipe') } } }, responses: { 200: json(obj({ recipe: ref('RecipeRecord') }), 'Updated; `version` incremented.'), 400: ERR[400], 401: ERR[401], 404: ERR[404] } },
        delete: { tags: ['Recipes'], summary: 'Delete a recipe (and its schedule)', ...AUTH, responses: { 200: json(ref('Ok'), 'Deleted.'), 401: ERR[401], 404: ERR[404], 409: ERR[409] } },
      },
      '/api/recipes/{id}/versions': { parameters: [recipeIdParam], get: { tags: ['Recipes'], summary: 'Version history', ...AUTH, responses: { 200: json(obj({ id: str(), versions: arr(ref('RecipeVersion')) }), 'All saved versions.'), 401: ERR[401], 404: ERR[404] } } },
      '/api/recipes/{id}/run': {
        parameters: [recipeIdParam],
        post: { tags: ['Runs'], summary: 'Start a run of a saved recipe', ...AUTH, requestBody: { required: false, content: { 'application/json': { schema: ref('RunOptions') } } }, responses: { 202: json(ref('RunAccepted'), 'Run started; poll `GET /api/runs/{id}` or subscribe to `/api/runs/{id}/events`.'), 400: ERR[400], 401: ERR[401], 404: ERR[404] } },
      },
      '/api/recipes/{id}/preview': {
        parameters: [recipeIdParam],
        post: { tags: ['Recipes'], summary: 'Fetch one page over HTTP and extract with the entry template (no browser, nothing stored)', ...AUTH, requestBody: { required: false, content: { 'application/json': { schema: obj({ url: str('Page to preview (default: first entry URL).') }) } } }, responses: { 200: json(ref('Preview'), 'Extraction preview.'), 400: ERR[400], 401: ERR[401], 404: ERR[404] } },
      },
      '/api/recipes/{id}/dataset/latest': {
        parameters: [recipeIdParam],
        get: {
          tags: ['Datasets'], summary: 'Rows of the latest succeeded/partial run (the recipe as an API endpoint)', ...AUTH, parameters: rowsParams,
          responses: { ...rowsResponses, 200: { ...rowsResponses[200], headers: { 'X-Scrappia-Run': { schema: { type: 'string' }, description: 'Run id the rows come from.' }, 'X-Scrappia-Run-Status': { schema: { type: 'string' } }, 'X-Scrappia-Run-Finished': { schema: { type: 'string', format: 'date-time' } } } }, 404: errorResponse('Unknown recipe, or no succeeded/partial run yet (`no_dataset`).') },
        },
      },

      '/api/runs': {
        get: {
          tags: ['Runs'], summary: 'List runs', ...AUTH,
          parameters: [q('recipeId', { type: 'string' }, 'Filter by recipe.'), q('status', { type: 'string', enum: RUN_STATUS }, 'Filter by status.'), q('limit', { type: 'integer', minimum: 1, maximum: 1000, default: 50 }, 'Max results, newest first.')],
          responses: { 200: json(obj({ runs: arr(ref('Run')) }), 'Runs, newest first.'), 400: ERR[400], 401: ERR[401] },
        },
        post: { tags: ['Runs'], summary: 'Start an ad-hoc run from a recipe body', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: ref('AdHocRun') } } }, responses: { 202: json(ref('RunAccepted'), 'Run started.'), 400: ERR[400], 401: ERR[401], 403: ERR[403] } },
      },
      '/api/runs/{id}': {
        parameters: [runIdParam],
        get: { tags: ['Runs'], summary: 'Run detail: record, stats, queue counts, datasets', ...AUTH, responses: { 200: json(ref('RunDetail'), 'Run detail.'), 401: ERR[401], 404: ERR[404] } },
        delete: { tags: ['Runs'], summary: 'Delete a run and its rows/requests/drift', ...AUTH, responses: { 200: json(ref('Ok'), 'Deleted.'), 401: ERR[401], 404: ERR[404], 409: ERR[409] } },
      },
      '/api/runs/{id}/cancel': { parameters: [runIdParam], post: { tags: ['Runs'], summary: 'Cancel an active run', ...AUTH, responses: { 200: json(obj({ ok: bool(), runId: str(), action: str() }), 'Cancellation requested; status becomes `cancelled` once the run winds down.'), 401: ERR[401], 404: ERR[404], 409: ERR[409] } } },
      '/api/runs/{id}/pause': { parameters: [runIdParam], post: { tags: ['Runs'], summary: 'Pause an active run', ...AUTH, responses: { 200: json(obj({ ok: bool(), runId: str(), action: str() }), 'Paused.'), 401: ERR[401], 404: ERR[404], 409: ERR[409] } } },
      '/api/runs/{id}/resume': { parameters: [runIdParam], post: { tags: ['Runs'], summary: 'Resume a paused run', ...AUTH, responses: { 200: json(obj({ ok: bool(), runId: str(), action: str() }), 'Resumed.'), 401: ERR[401], 404: ERR[404], 409: ERR[409] } } },
      '/api/runs/{id}/retry': { parameters: [runIdParam], post: { tags: ['Runs'], summary: 'Resume a stopped run (requeues unfinished requests, keeps rows)', ...AUTH, requestBody: { required: false, content: { 'application/json': { schema: obj({ trigger: str() }) } } }, responses: { 202: json(ref('RunAccepted'), 'Run resumed under the same id.'), 401: ERR[401], 404: ERR[404], 409: ERR[409] } } },
      '/api/runs/{id}/rows': { parameters: [runIdParam], get: { tags: ['Datasets'], summary: 'Rows of a run (json page, or streamed csv / jsonl)', ...AUTH, parameters: rowsParams, responses: rowsResponses } },
      '/api/runs/{id}/drift': { parameters: [runIdParam], get: { tags: ['Runs'], summary: 'Selector drift / self-healing events', ...AUTH, responses: { 200: json(obj({ runId: str(), drift: arr(ref('DriftEvent')) }), 'Drift events.'), 401: ERR[401], 404: ERR[404] } } },
      '/api/runs/{id}/requests': {
        parameters: [runIdParam],
        get: { tags: ['Runs'], summary: 'Request log', ...AUTH, parameters: [q('status', { type: 'string', enum: REQUEST_STATUS }, 'Filter by status.'), q('limit', { type: 'integer', minimum: 1, maximum: 10000, default: 200 }, 'Max results.')], responses: { 200: json(obj({ runId: str(), counts: anyObj(), requests: arr(ref('Request')) }), 'Requests.'), 400: ERR[400], 401: ERR[401], 404: ERR[404] } },
      },
      '/api/runs/{id}/diff': {
        parameters: [runIdParam],
        get: {
          tags: ['Datasets'], summary: 'Added / removed / changed rows versus a previous run', ...AUTH,
          parameters: [q('against', { type: 'string' }, 'Run id to compare with (default: previous run of the same recipe).'), q('dataset', { type: 'string' }, 'Restrict to one dataset.'), q('fields', { type: 'string' }, 'Comma-separated fields to compare (default all).'), q('thresholdPercent', { type: 'number' }, 'Ignore numeric changes smaller than this percentage.')],
          responses: { 200: json(ref('Diff'), 'Diff result.'), 400: ERR[400], 401: ERR[401], 404: errorResponse('Unknown run, or no previous run (`no_previous_run`).') },
        },
      },
      '/api/runs/{id}/export': {
        parameters: [runIdParam],
        post: { tags: ['Datasets'], summary: 'Export a finished run to ad-hoc sinks', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: obj({ sinks: arr(ref('Sink')) }, ['sinks']) } } }, responses: { 200: json(obj({ runId: str(), exports: arr(ref('ExportResult')) }), 'Per-sink results (errors are reported per sink, not as HTTP failures).'), 400: ERR[400], 401: ERR[401], 404: ERR[404] } },
      },
      '/api/runs/{id}/events': {
        parameters: [runIdParam],
        get: { tags: ['Events'], summary: 'SSE stream of one run (closes after run.done)', ...AUTH, responses: { 200: { description: '`text/event-stream` of RunEvent objects.', content: { 'text/event-stream': { schema: ref('RunEvent'), example: 'event: ready\nid: 1\ndata: {"time":1700000000000}\n\nevent: rows\nid: 2\ndata: {"type":"rows","runId":"...","dataset":"default","rows":[...],"pageUrl":"..."}\n\n: ping\n\n' } } }, 401: ERR[401], 404: ERR[404] } },
      },
      '/api/events': {
        get: { tags: ['Events'], summary: 'SSE stream of all runs', ...AUTH, parameters: [q('runId', { type: 'string' }, 'Only events of this run.'), q('types', { type: 'string' }, 'Comma-separated event types to include.')], responses: { 200: { description: '`text/event-stream` of RunEvent objects; never closes on its own.', content: { 'text/event-stream': { schema: ref('RunEvent') } } }, 401: ERR[401] } },
      },

      '/api/settings': {
        get: { tags: ['Settings'], summary: 'Get settings (secrets masked)', ...AUTH, responses: { 200: json(obj({ settings: ref('Settings') }), 'Settings.'), 401: ERR[401] } },
        put: { tags: ['Settings'], summary: 'Replace settings', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: ref('Settings') } } }, responses: { 200: json(obj({ settings: ref('Settings') }), 'Saved settings (masked).'), 400: ERR[400], 401: ERR[401], 403: ERR[403] } },
      },
      '/api/secrets': { get: { tags: ['Secrets'], summary: 'List secret names', ...AUTH, responses: { 200: json(obj({ names: arr(str()) }), 'Names only.'), 401: ERR[401] } } },
      '/api/secrets/{name}': {
        parameters: [pathId('name', 'Secret name (letters, digits, `_`, `.`, `-`).')],
        get: { tags: ['Secrets'], summary: 'Check that a secret exists (never returns the value)', ...AUTH, responses: { 200: json(ref('SecretStatus'), 'Exists in the store or as an env var.'), 401: ERR[401], 404: ERR[404] } },
        put: { tags: ['Secrets'], summary: 'Create or replace a secret', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: obj({ value: str() }, ['value']) } } }, responses: { 200: json(ref('SecretStatus'), 'Replaced.'), 201: json(ref('SecretStatus'), 'Created.'), 400: ERR[400], 401: ERR[401], 403: ERR[403] } },
        delete: { tags: ['Secrets'], summary: 'Delete a stored secret', ...AUTH, responses: { 200: json(obj({ ok: bool(), name: str() }), 'Deleted.'), 401: ERR[401], 404: ERR[404] } },
      },
      '/api/api-keys': {
        get: { tags: ['API keys'], summary: 'List API keys (no secrets)', ...AUTH, responses: { 200: json(obj({ keys: arr(ref('ApiKey')) }), 'Keys.'), 401: ERR[401] } },
        post: { tags: ['API keys'], summary: 'Create an API key (plaintext returned once)', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: obj({ name: str(), scopes: arr(str(undefined, { enum: ['read', 'write', 'admin'] }), 'Default `["read","write"]`.') }, ['name']) } } }, responses: { 201: json(ref('ApiKeyCreated'), 'Created. Once any key exists the bootstrap `SCRAPPIA_API_KEY` is no longer accepted.'), 400: ERR[400], 401: ERR[401], 403: ERR[403] } },
      },
      '/api/api-keys/{id}': { parameters: [pathId('id', 'Key id')], delete: { tags: ['API keys'], summary: 'Revoke an API key', ...AUTH, responses: { 200: json(ref('Ok'), 'Revoked.'), 401: ERR[401], 404: ERR[404] } } },

      '/api/schedules': { get: { tags: ['Schedules'], summary: 'List schedules (derived from recipes with a `schedule` block)', ...AUTH, responses: { 200: json(obj({ schedules: arr(ref('Schedule')) }), 'Schedules.'), 401: ERR[401] } } },
      '/api/schedules/next': { get: { tags: ['Schedules'], summary: 'Next fire time of every enabled schedule', ...AUTH, responses: { 200: json(obj({ next: arr(obj({ scheduleId: str(), recipeId: str(), recipeName: { type: ['string', 'null'] }, next: { type: ['string', 'null'], format: 'date-time' } })) }), 'Sorted by next fire time.'), 401: ERR[401] } } },
      '/api/schedules/preview': { post: { tags: ['Schedules'], summary: 'Validate a cron expression and list upcoming fire times', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: obj({ cron: str('5- or 6-field cron expression.'), tz: str('IANA timezone.'), count: int('Default 5, max 50.') }, ['cron']) } } }, responses: { 200: json(obj({ cron: str(), tz: { type: ['string', 'null'] }, next: arr(str(undefined, { format: 'date-time' })) }), 'Upcoming fire times.'), 400: ERR[400], 401: ERR[401] } } },

      '/api/alerts': { get: { tags: ['Alerts'], summary: 'List alerts', ...AUTH, parameters: [q('unread', { type: 'string', enum: ['1', '0', 'true', 'false'] }, 'Only unread alerts.'), q('limit', { type: 'integer', default: 100 }, 'Max results.')], responses: { 200: json(obj({ alerts: arr(ref('Alert')) }), 'Alerts, newest first.'), 400: ERR[400], 401: ERR[401] } } },
      '/api/alerts/read': { post: { tags: ['Alerts'], summary: 'Mark alerts as read', ...AUTH, requestBody: { required: false, content: { 'application/json': { schema: obj({ ids: arr(str()), all: bool('Mark everything read (also the default when `ids` is empty).') }) } } }, responses: { 200: json(obj({ ok: bool(), ids: {} }), 'Marked.'), 400: ERR[400], 401: ERR[401] } } },

      '/api/examples': { get: { tags: ['Reference'], summary: 'Bundled example recipes', ...AUTH, responses: { 200: json(obj({ examples: arr(obj({ name: str(), recipe: ref('Recipe') })) }), 'Examples.'), 401: ERR[401] } } },
      '/api/sink-types': { get: { tags: ['Reference'], summary: 'Registered sink types', ...AUTH, responses: { 200: json(obj({ types: arr(str()) }), 'Sink type names.'), 401: ERR[401] } } },

      '/api/ai/generate': {
        post: { tags: ['AI'], summary: 'Generate a recipe draft from a URL and a natural-language instruction', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: obj({ url: str(undefined, { format: 'uri' }), instruction: str('e.g. "product name, price and link for every item, follow next page"'), provider: str('Provider name from settings.'), timeoutMs: int('Fetch timeout (default 30000).') }, ['url', 'instruction']) } } }, responses: { 200: json(obj({ recipe: ref('Recipe'), valid: bool('Whether the draft passes recipe validation.'), errors: arr(str()), fetched: obj({ url: str(), status: int(), bytes: int() }) }), 'Draft recipe. Review before saving.'), 400: errorResponse('`ai_not_configured` or validation error.'), 401: ERR[401], 502: errorResponse('The page could not be fetched (`fetch_failed`).') } },
      },
      '/api/ai/ask': {
        post: { tags: ['AI'], summary: 'Ask a question about a page (optionally structured with a JSON schema)', ...AUTH, requestBody: { required: true, content: { 'application/json': { schema: obj({ url: str(undefined, { format: 'uri' }), question: str(), schema: anyObj('JSON schema for structured output.'), provider: str(), timeoutMs: int() }, ['url', 'question']) } } }, responses: { 200: json(obj({ answer: { description: 'String, or JSON when `schema` was given.' }, fetched: obj({ url: str(), status: int(), bytes: int() }), usage: obj({ calls: int(), inputTokens: int(), outputTokens: int() }) }), 'Answer.'), 400: errorResponse('`ai_not_configured` or validation error.'), 401: ERR[401], 502: errorResponse('The page could not be fetched (`fetch_failed`).') } },
      },
    },
  };
}

/** Minimal HTML page rendering the OpenAPI document with Scalar (loaded from jsDelivr). */
export function docsHtml(specUrl = '/api/openapi.json'): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scrappia API</title>
  <style>body{margin:0}</style>
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', { url: ${JSON.stringify(specUrl)}, theme: 'kepler', hideModels: false });
  </script>
  <noscript>JavaScript is required. The raw spec is at <a href="${specUrl}">${specUrl}</a>.</noscript>
</body>
</html>
`;
}
