# Scrappia Architecture

Scrappia is a production-grade visual web scraper: a point-and-click desktop app (Windows, macOS,
Linux), a headless engine that runs the same recipes on a server, a CLI, a REST API, and an MCP
server. It targets everything WebHarvy does, plus the gaps that users of WebHarvy, Octoparse,
ParseHub, Browse.ai, Apify, Firecrawl and Kadoa complain about.

## Positioning and USPs

| Area | WebHarvy | Scrappia |
|---|---|---|
| Platform | Windows only, desktop | Windows / macOS / Linux desktop + server + CLI + REST + MCP |
| Config | XML, undocumented | Versioned JSON "Recipe" with a published zod schema |
| Selectors | One CSS selector per field | 3-5 ranked selector candidates per field, run-time fall-through (self-healing) + drift alerts + AI repair |
| Pattern detection | Similar-items heuristic, knob tuning | MDR-style record detection, auto-detect tables/lists, one-click "try another list" |
| Fetching | One embedded browser | HTTP-first with TLS impersonation, browser only when needed, per-domain concurrency, stealth Chromium (patchright) |
| Pagination | Must guess page count for scroll/load-more | All modes support "until no new items" stop condition |
| Data model | Flat rows, exact dedup | Flat or nested JSON, key-based dedup + upsert, typed fields, validation rules |
| Transforms | Regex + substring | Pipeline: regex, trim, split, number/date/currency parse, template, JS, AI |
| AI | Per-field prompt, BYO key | NL -> schema recipe generation, AI field suggestion, AI transforms, self-healing, local LLM (Ollama/LM Studio) or Anthropic/OpenAI-compatible |
| Anti-bot | BYO proxy list, manual CAPTCHA | Proxy pools with sticky sessions, session retirement, fingerprint injection, CAPTCHA solver plugins (2Captcha/CapSolver/Anti-Captcha), backoff, robots.txt switch |
| Export | XLSX/CSV/TSV/XML/JSON, 4 SQL DBs | + JSONL, Parquet, SQLite, MongoDB, Google Sheets, Airtable, Notion, S3, webhooks, REST API dataset access |
| Monitoring | None | Change detection (added/removed/changed rows), thresholds, alerts (email/Slack/Discord/Telegram/webhook) |
| Scheduling | Windows Task Scheduler | Built-in cron scheduler (desktop and server), run history, retries |
| Team | None | Server mode: projects, API keys, run history, dataset versioning |
| Extensibility | None | Plugin API: extractors, sinks, solvers, browser providers, transforms |
| Pricing model | One-time license | Open core; keep one-time-license friendly (no credits) |

## Monorepo layout

```
scrappia/
  package.json               npm workspaces, TypeScript 5, ESM, Node 22
  packages/
    core/                    engine: recipe schema, crawler, extractor, transforms, storage, sinks, scheduler, monitoring, AI
    inspector/               in-page overlay script injected into the scraping browser (bundled to a single IIFE)
    mcp/                     MCP server exposing recipes/runs/datasets as tools
  apps/
    cli/                     `scrappia` command
    server/                  Hono REST API + scheduler + workers (same engine)
    desktop/                 Electron app (React) that hosts the recorder and run monitor
  docs/
  examples/                  sample recipes + a fixture site used by tests
```

## Core concepts

- **Recipe**: a JSON document describing what to scrape. Versioned (`version: 1`), validated by zod.
- **Page template**: a named node of the recipe. Has optional pre-actions (click, type, scroll, wait,
  script, select), page-level fields, an optional list (record selector + fields), optional follow
  links to other templates, and optional pagination.
- **Field**: name, type (`text | attr | href | src | html | email | regex | constant | pageUrl |
  timestamp | image | screenshot | ai | count | exists`), one or more selector candidates,
  transforms, `required`, `multiple`.
- **Selector candidate**: `{ kind: 'css' | 'xpath' | 'text' | 'role', value, score }`. The runtime
  tries candidates in order and records which one matched (drift telemetry).
- **Run**: one execution of a recipe. Produces a dataset (rows), request log, drift events, stats.
- **Dataset**: rows stored in SQLite (local) or Postgres (server), versioned per run; exportable.
- **Sink**: an export destination that consumes an async iterator of rows.
- **Monitor**: compares the latest run to the previous one keyed by a field and raises alerts.

## Recipe schema (summary)

```jsonc
{
  "version": 1,
  "name": "Books",
  "entry": { "urls": ["https://example.com/catalog"], "template": "listing" },
  "keywords": { "q": ["laptop", "phone"] },            // substituted as {{q}} in urls / inputs
  "engine": {
    "mode": "auto",                                       // http | browser | auto
    "stealth": true, "headless": true,
    "concurrency": 4, "delayMs": 500, "jitterMs": 500,
    "timeoutMs": 30000, "retries": 3,
    "blockResources": ["image", "font", "media"],
    "respectRobots": false,
    "proxy": { "urls": ["http://user:pass@host:port"], "rotate": "session" },
    "session": { "persist": true, "profile": "default" }
  },
  "templates": {
    "listing": {
      "actions": [{ "type": "waitFor", "selector": ".product" }],
      "list": {
        "selector": [{ "kind": "css", "value": "article.product_pod" }],
        "fields": [
          { "name": "title", "type": "text", "selector": [{ "kind": "css", "value": "h3 a" }] },
          { "name": "price", "type": "text", "selector": [{ "kind": "css", "value": ".price_color" }],
            "transforms": [{ "type": "currency" }] },
          { "name": "url", "type": "href", "selector": [{ "kind": "css", "value": "h3 a" }] }
        ],
        "follow": { "field": "url", "template": "detail", "mode": "merge" }
      },
      "pagination": { "type": "next", "selector": [{ "kind": "css", "value": "li.next a" }],
                      "maxPages": -1, "stopWhenNoNewRows": true }
    },
    "detail": {
      "fields": [
        { "name": "description", "type": "text", "selector": [{ "kind": "css", "value": "#product_description ~ p" }] }
      ]
    }
  },
  "output": { "dedupe": { "keys": ["url"] }, "validation": [{ "field": "price", "rule": "required" }] },
  "sinks": [{ "type": "xlsx", "path": "books.xlsx", "mode": "upsert", "key": "url" }],
  "monitor": { "key": "url", "alerts": [{ "type": "webhook", "url": "https://..." }] },
  "schedule": { "cron": "0 */6 * * *", "tz": "UTC" }
}
```

## Engine pipeline

1. **Planner** expands entry URLs x keywords into seed requests, each tagged with a template.
2. **Request queue** (SQLite table, claim via `UPDATE ... RETURNING`) with per-domain rate limits.
3. **Fetcher** picks HTTP (impersonated TLS) or browser (patchright) by recipe mode or auto-heuristic
   (auto = try HTTP, fall back to browser when the template's list selector matches nothing or the
   page looks like a challenge / SPA shell).
4. **Page runner** executes template actions, resolves selectors (with candidate fall-through),
   extracts list records and page fields, applies transforms, enqueues follow links and next pages.
5. **Row assembler** merges follow-link results into parent rows (merge / nest / separate).
6. **Output stage**: validation, dedup/upsert, dataset write, sinks, monitor diff, alerts.
7. **Telemetry**: per-request log, drift events (which candidate matched, empty-field rates),
   run stats; used by the UI and by the AI repair loop.

## Browser layer

- `BrowserProvider` interface with `patchright` (default) and `playwright` implementations.
- Persistent contexts per session profile; fingerprint injection; proxy-chain for authenticated proxies.
- Recording mode: headed Chromium launched with `addInitScript(inspector.js)` and `exposeBinding`.
  The inspector overlay talks to the engine over that binding; the desktop UI talks to the engine
  over IPC. The same overlay runs in server mode over CDP (web recorder).

## Inspector overlay (packages/inspector)

Injected into every frame. Responsibilities:
- Hover highlight, click capture (suppresses page handlers while recording).
- Selector candidate generation (finder + css-selector-generator + XPath + text anchors).
- "Similar items" detection (MDR-style) and list/table auto-detect with candidate cycling.
- Field inference for a record (text, links, images, prices, dates).
- Highlight results of a selector across the page (preview), count matches.
- Emit events to the host: `element.picked`, `list.detected`, `preview.count`.

## AI layer

- `LlmProvider` interface: Anthropic (structured outputs) and OpenAI-compatible (Ollama, LM Studio,
  OpenAI, any endpoint). Configurable per project; local by default when available.
- Uses: (1) NL prompt -> recipe draft from a sample page, (2) suggest fields for a detected record,
  (3) per-field AI transform / extraction, (4) self-healing: when a field's candidates all fail on a
  run, send pruned HTML + previous sample values, get a new selector, verify, store, raise a drift alert.
- Token hygiene: readability + markdown, strip boilerplate, send 2-3 sample records, cache prompts.

## Storage

- Local: SQLite via `node:sqlite` (no native build). Tables: projects, recipes (versioned), runs,
  requests, rows, drift_events, alerts, schedules, api_keys.
- Server: Postgres via `pg`. Same repository interface.

## Sinks

csv, tsv, json, jsonl, xlsx, xml, parquet, sqlite, postgres, mysql, mongodb, google-sheets, airtable,
notion, s3, webhook, stdout. Modes: append, overwrite, upsert (by key).

## Security and compliance

- Recipes never embed secrets; credentials referenced by name from an encrypted local vault
  (desktop) or env/secret store (server).
- robots.txt respect is a per-project switch, default on for the crawl mode, off for user-driven
  single pages, always visible in the UI.
- Server API uses API keys with scopes; webhooks are HMAC-signed.
