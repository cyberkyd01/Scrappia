# API guide: connecting Scrappia to other software

The server exposes a REST API. Anything that can make web requests (Zapier, Make, n8n, Google Apps
Script, Python, Excel Power Query, your own app) can start scrapers and read results.

Base URL: `http://localhost:8788/api` locally, or `https://your-domain/api` when hosted.
Interactive documentation with every endpoint, request and response: **`/docs`** on your server.

## Authentication

Send your API key in a header on every request:

```
Authorization: Bearer <your key>
```

(`x-api-key: <your key>` also works.) Get a key from the [Admin guide](admin-guide.md).

## The five things most people need

### 1. Get the latest data of a recipe (dataset as API)

```
GET /api/recipes/<recipeId>/dataset/latest
GET /api/recipes/<recipeId>/dataset/latest?format=csv
GET /api/recipes/<recipeId>/dataset/latest?format=jsonl&dataset=detail
```

Returns the rows of the most recent successful run. Point Google Sheets (`IMPORTDATA` with the CSV
URL and key as a query is not supported; use Apps Script with the header), Power BI, or a
dashboard at this.

### 2. Start a run

```
POST /api/recipes/<recipeId>/run
Content-Type: application/json

{ "trigger": "zapier", "maxRequests": 100 }
```

Response `202` with `{ "id": "<runId>", ... }`. The run happens in the background.

### 3. Check a run

```
GET /api/runs/<runId>
```

`status` is `running`, `succeeded`, `partial`, `failed` or `cancelled`. `stats` has rows, pages,
failed requests, drift events and export results.

### 4. Read rows

```
GET /api/runs/<runId>/rows?limit=500&offset=0
GET /api/runs/<runId>/rows?format=csv
GET /api/runs/<runId>/diff            # what changed versus the previous run of the same recipe
```

### 5. Get notified instead of polling

Two options, both configured in the recipe:

- A **webhook sink** posts the rows to your URL in batches as the run finishes
  (`{"type":"webhook","url":"https://...","batchSize":100,"secretRef":"HOOK_SECRET"}`).
- A **monitor** with a webhook channel posts alerts about added/removed/changed rows, drift, or
  failures.

Webhook requests carry `x-scrappia-signature: sha256=<hex>` where hex is HMAC-SHA256 of
`"<x-scrappia-timestamp>.<raw body>"` with your secret. Verify it before trusting the payload.

Alternatively subscribe to the live event stream (Server-Sent Events):

```
GET /api/runs/<runId>/events        # one run; closes when it finishes
GET /api/events                     # everything
```

Events include `run.start`, `run.progress`, `rows`, `drift`, `alert`, `export.done`, `run.done`.

## Zapier / Make / n8n recipes

**Scrape on a schedule and send new rows to Slack, a sheet or a CRM**

1. In Scrappia, give the recipe a schedule and a webhook sink pointing at a "Catch hook" trigger
   (Zapier Webhooks, Make Custom Webhook, n8n Webhook node).
2. The hook receives `{ event: "rows", rows: [...] , last: true|false }` per batch. Loop over
   `rows` in your automation.

**Trigger a scrape from a form or button**

1. Automation step: HTTP request, `POST https://your-domain/api/recipes/<id>/run` with the
   Authorization header.
2. Wait step (a minute or two), then HTTP request `GET .../dataset/latest` and use the rows.

**Only act on changes**

Enable the recipe's monitor with a webhook channel. You get one request per run describing added,
removed and changed rows with before/after values.

## Full endpoint list

| Method and path | What |
|---|---|
| `GET /health` | Liveness (no auth) |
| `GET /docs`, `GET /api/openapi.json` | Documentation (no auth) |
| `GET/POST /api/recipes`, `GET/PUT/DELETE /api/recipes/:id` | Recipes |
| `GET /api/recipes/:id/versions` | Version history |
| `POST /api/recipes/validate` | Check a recipe, returns problems |
| `POST /api/recipes/:id/run` | Start a run (202) |
| `POST /api/recipes/:id/preview` | Fast HTTP-only extraction of one page |
| `GET /api/recipes/:id/dataset/latest` | Latest rows (json, csv, jsonl) |
| `POST /api/runs` | Run an inline recipe without saving it |
| `GET /api/runs`, `GET/DELETE /api/runs/:id` | Runs |
| `POST /api/runs/:id/cancel`, `/pause`, `/resume`, `/retry` | Control |
| `GET /api/runs/:id/rows`, `/drift`, `/requests`, `/diff` | Results and diagnostics |
| `POST /api/runs/:id/export` | Export a run to sinks given in the body |
| `GET /api/runs/:id/events`, `GET /api/events` | Live events (SSE) |
| `GET/PUT /api/settings` | Settings (secret values are masked) |
| `GET /api/secrets`, `GET/PUT/DELETE /api/secrets/:name` | Secrets (write-only values) |
| `GET/POST /api/api-keys`, `DELETE /api/api-keys/:id` | API keys |
| `GET /api/schedules`, `GET /api/schedules/next`, `POST /api/schedules/preview` | Schedules |
| `GET /api/alerts`, `POST /api/alerts/read` | Alerts |
| `GET /api/examples`, `GET /api/sink-types` | Reference data |
| `POST /api/ai/generate`, `POST /api/ai/ask` | AI: recipe from a sentence, question about a page |
| `POST /api/copilot/sessions`, `GET/DELETE /api/copilot/sessions/:id`, `POST /api/copilot/sessions/:id/turn` | Copilot: conversational scraper builder (`?stream=1` streams progress as SSE) |

Errors are always `{ "error": { "code": "...", "message": "..." } }` with the matching HTTP status.
Rate limit: 600 requests per minute per key by default; `429` with `Retry-After` when exceeded.

## Code examples

Python:

```python
import requests, time
API = "https://your-domain/api"; H = {"Authorization": "Bearer sk_..."}
run = requests.post(f"{API}/recipes/RECIPE_ID/run", headers=H, json={}).json()
while requests.get(f"{API}/runs/{run['id']}", headers=H).json()["status"] == "running":
    time.sleep(5)
rows = requests.get(f"{API}/runs/{run['id']}/rows?limit=1000", headers=H).json()["rows"]
```

JavaScript:

```js
const res = await fetch('https://your-domain/api/recipes/RECIPE_ID/dataset/latest', { headers: { Authorization: 'Bearer sk_...' } });
const { rows } = await res.json();
```

curl:

```
curl -H "Authorization: Bearer sk_..." "https://your-domain/api/recipes/RECIPE_ID/dataset/latest?format=csv" -o latest.csv
```
