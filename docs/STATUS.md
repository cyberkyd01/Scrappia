# Project status (2026-09-16)

## Verified in this environment (Windows 11, Node 22.17)

| Area | Evidence |
|---|---|
| Core engine | 68 tests: schema, transforms, DOM extractor, HTTP runner (pagination, follows, categories, keywords, retries, validation, exports, robots, drift, cancel/resume, POST), browser runner (JS pages, load-more, infinite scroll, login actions, click pagination, main-world scripts, screenshots/images), AI (batching, self-healing with a fake LLM), monitor/diff/alerts (signed webhooks), scheduler, sinks, migrations |
| Real sites | `books-toscrape` (HTTP, next links + detail merge: 20 rows / 4 pages / 3 s) and `quotes-infinite-scroll` (stealth browser: 60 rows / 6 scroll steps) |
| Inspector overlay | 31 jsdom tests + live smoke on books.toscrape.com (20-record list detected with title/price/url/image fields, pick flow, highlight, regionHtml) |
| Server | 19 tests (auth, scopes, rate limit, CRUD, runs, rows json/csv/jsonl, SSE, dataset-as-API, diff, export, keys, secrets, schedules, alerts) + real boot with `/health`, `/docs`, OpenAPI 3.1 |
| CLI | 13 tests + real network run, `recipe:<id>` / `example:<name>` sources |
| MCP | 12 tests (24 tools, resources, prompt, Streamable HTTP with bearer) + stdio JSON-RPC smoke |
| Desktop | typecheck, 14 unit tests, electron-vite build, 10 s launch, and an end-to-end CDP-driven smoke: recorder opens the headed stealth browser, overlay detects lists, preview extracts 20 records, actions run, dry run completes inside Electron |
| Root | `npm run typecheck`, `npm run build`, `npm test` all green across the six packages |

## Not yet exercised (needs an external environment)

- `electron-builder` packaging (installers). Config is in `apps/desktop/electron-builder.yml`.
- Docker image build (`Dockerfile`, `docker-compose.yml`); Docker is not installed on this machine.
- Live credentials for Google Sheets, Airtable, Notion, S3, Postgres, MySQL, MongoDB sinks and for
  2Captcha / CapSolver / Anti-Captcha. The request shapes follow each vendor's public API and are
  unit-tested for error handling only.
- Anthropic / OpenAI-compatible providers against a real endpoint (the fake provider covers the
  contract; `scrappia ai test <name>` verifies a real one).
- Email alerts against a real SMTP server.
- macOS / Linux runs (the code has no Windows-specific paths beyond the packaging config).

## Known limitations / next steps

- HTTP mode uses browser-like headers but not TLS fingerprint impersonation. Adding `impit` or
  `got-scraping` behind the fetch interface is the next anti-bot step for hostile targets.
- Fingerprint injection is a light navigator patch; a full `fingerprint-generator` integration would
  randomise screen/WebGL/fonts per session.
- The desktop recorder docks the Chromium window beside the app window; true re-parenting into the
  Electron window (as Octoparse does) is a Windows-only enhancement.
- Team features on the server (users, roles, audit log) are represented only by scoped API keys.
- A web-based recorder (same overlay over CDP against a server-side browser) is designed but not built.
