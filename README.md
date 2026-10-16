# Scrappia

Scrappia is a production-grade visual web scraper. Point and click in a real browser to build a
recipe, then run it on your desktop, from the command line, on a server with a REST API, on a
schedule, or from an AI agent over MCP. It covers everything WebHarvy does and fills the gaps its
users (and users of Octoparse, ParseHub, Browse.ai, Apify and Firecrawl) complain about.

> **Deploying to a server?** Follow the step-by-step VPS guide: **[DEPLOY.md](DEPLOY.md)**
>
> **Installing?** Follow the step-by-step guide: **[INSTALL.md](INSTALL.md)**

## What it does

- **Visual recorder**: click elements in a stealth Chromium window; Scrappia detects the repeating
  records, proposes fields, generates ranked selectors and previews the data live.
- **Self-healing selectors**: every field keeps 3-5 ranked selector candidates. At run time the
  engine falls through to the next candidate, logs drift, and (optionally) asks an LLM to repair
  a selector and verifies the fix before using it. You get an alert instead of a silently broken scrape.
- **HTTP-first, browser when needed**: `auto` mode fetches with impersonated headers and upgrades to
  a real browser only when the page is JS-rendered or challenged. Per-host rate limits, jittered
  delays, retries with backoff, proxy pools with sticky sessions and retirement, CAPTCHA solver
  plugins (2Captcha, CapSolver, Anti-Captcha, or manual in headed mode), robots.txt switch.
- **All the navigation patterns**: next links, numbered page links, load-more buttons, infinite
  scroll, URL patterns, URL lists, custom JS pagination; detail-page following (merge, nest or
  separate dataset); multi-level category traversal; keyword lists (product or row-wise) substituted
  into URLs, POST bodies and typed into search boxes; login flows with persistent profiles.
- **Typed, clean data**: transforms pipeline (regex, split, number/currency/date parsing, templates,
  maps, JS, AI), validation rules (flag, drop or fail), key-based dedupe and upsert, provenance
  columns, flat or nested JSON output.
- **Copilot**: a chat panel in the recorder. Describe what you want and it detects the records, sets
  the fields, adds pagination and detail pages, verifies with previews and a test run, exports and
  runs. Or work interactively: it turns on element picking, you click, it turns your clicks into fields
  and asks what is next. Works with Anthropic, OpenAI-compatible APIs or a local model.
- **AI where it helps**: natural-language recipe generation from a sample page, field suggestions,
  per-field AI extraction and transforms, self-healing. Works with Anthropic (structured outputs)
  or any OpenAI-compatible endpoint including local Ollama / LM Studio, so nothing has to leave
  your machine.
- **Every export**: CSV, TSV, JSON, JSONL, XLSX, XML, Parquet, SQLite, PostgreSQL, MySQL, MongoDB,
  Google Sheets, Airtable, Notion, S3-compatible storage, signed webhooks, stdout. Append, overwrite
  or upsert by key.
- **Monitoring**: diff each run against the previous one (added / removed / changed rows, numeric
  thresholds) and alert via webhook, Slack, Discord, Telegram, ntfy or email.
- **Run anywhere**: desktop app (Windows, macOS, Linux), `scrappia` CLI, Hono REST API with SSE
  events and a "dataset as API" endpoint, built-in cron scheduler, Docker image, MCP server for
  Claude and other agents.

## Documentation

- **[Guides](docs/guides/README.md)**: getting started, the desktop user guide, hosting on a server,
  administration, command line, API integrations, AI agents (MCP), troubleshooting. Written for
  non-technical readers first.
- [Recipe reference](docs/RECIPE.md): every key in a recipe file.
- [Architecture](docs/ARCHITECTURE.md) and the [competitive research](docs/research/) that drove the design.
- [Project status](docs/STATUS.md): what is verified and what is not.

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Engine: recipe schema, crawler, extractor, transforms, storage, sinks, scheduler, monitoring, AI |
| `packages/inspector` | In-page overlay injected into the recording browser (selector generation, list detection) |
| `packages/mcp` | MCP server exposing recipes, runs and datasets as tools |
| `apps/cli` | `scrappia` command line |
| `apps/server` | REST API + scheduler + workers |
| `apps/desktop` | Electron desktop app (recorder, run monitor, settings) |
| `docs/` | Architecture, recipe reference, research |

## Quick start

Requirements: Node 22.13+ (uses the built-in SQLite; no native build step).

```bash
npm install                      # installs everything at the root and links local packages
npx patchright install chromium  # stealth Chromium for browser mode and the recorder
npm run build
```

Run an example recipe from the CLI:

```bash
node apps/cli/dist/index.js examples copy books-toscrape books.json
node apps/cli/dist/index.js run books.json --out books.xlsx
```

Start the desktop app in development:

```bash
npm run dev:desktop
```

Start the API server:

```bash
SCRAPPIA_API_KEY=change-me node apps/server/dist/index.js
# then open http://localhost:8788/docs
```

## Recipes

A recipe is a JSON document. This one scrapes a paginated catalog and merges detail pages into
each row:

```json
{
  "name": "Books",
  "entry": { "urls": ["https://books.toscrape.com/catalogue/page-1.html"], "template": "listing" },
  "templates": {
    "listing": {
      "list": {
        "selector": [{ "value": "article.product_pod" }],
        "fields": [
          { "name": "title", "type": "attr", "attr": "title", "selector": [{ "value": "h3 a" }] },
          { "name": "price", "selector": [{ "value": ".price_color" }], "transforms": [{ "type": "currency" }] },
          { "name": "url", "type": "href", "selector": [{ "value": "h3 a" }] }
        ],
        "follow": [{ "field": "url", "template": "detail", "mode": "merge" }]
      },
      "pagination": { "type": "next", "selector": [{ "value": "li.next a" }] }
    },
    "detail": {
      "fields": [{ "name": "description", "selector": [{ "value": "#product_description ~ p" }] }]
    }
  },
  "output": { "keys": ["url"] },
  "sinks": [{ "type": "xlsx", "path": "books.xlsx" }]
}
```

The full reference is in [docs/RECIPE.md](docs/RECIPE.md).

## Development

```bash
npm run typecheck   # all packages
npm test            # all packages (browser tests need the Chromium install above)
npm run build
```

The repository can live on a drive without symlink support (exFAT): all dependencies are installed
once at the root and `scripts/link-packages.mjs` links or stubs the local packages.

## License

Apache-2.0

---

## ⭐ Support

Please give stars and if possible Buy me a coffee (USDT-TRC20) - `TA216k3WgWTrKnUKxZrSDNGzSJj3eHtEcH`

Telegram: [@Cyberkyd](https://t.me/Cyberkyd)
