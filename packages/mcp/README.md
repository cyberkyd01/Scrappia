# @scrappia/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents (Claude Desktop,
Claude Code, Cursor, any MCP client) build, test, run and read Scrappia scrapers. It wraps the same
`ScrappiaApp` facade the CLI, server and desktop app use, so recipes and run history are shared with them
through the data directory (`$SCRAPPIA_HOME`, default `~/.scrappia`).

```
node packages/mcp/dist/bin.js                     # stdio (default)
node packages/mcp/dist/bin.js --http 8765          # Streamable HTTP at http://127.0.0.1:8765/mcp
scrappia-mcp --home /data/scrappia --log-level info
```

Build first: `npm run build --prefix packages/core && npm run build --prefix packages/mcp`.

## Client configuration

Claude Desktop (`claude_desktop_config.json`) and Claude Code (`.mcp.json` in the project, or
`claude mcp add scrappia -- node <abs path>/packages/mcp/dist/bin.js`):

```json
{
  "mcpServers": {
    "scrappia": {
      "command": "node",
      "args": ["<abs path>/packages/mcp/dist/bin.js"],
      "env": { "SCRAPPIA_HOME": "<abs path>/.scrappia", "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

`env` is optional: `SCRAPPIA_HOME` picks the data directory, and an LLM key (or `OLLAMA_HOST`) enables the
`generate_recipe` / `ask_page` tools and self-healing selectors. Providers can also be configured once with
`scrappia ai add` and `scrappia secrets set`.

HTTP transport (remote agents, several clients at once):

```bash
SCRAPPIA_MCP_TOKEN=change-me scrappia-mcp --http 8765 --host 0.0.0.0
```

```json
{ "mcpServers": { "scrappia": { "type": "http", "url": "http://host:8765/mcp", "headers": { "Authorization": "Bearer change-me" } } } }
```

The HTTP transport is stateless (a fresh protocol session per request, shared app state), answers
`GET /health`, and requires `Authorization: Bearer $SCRAPPIA_MCP_TOKEN` on every request when the variable
is set. Without a token it should only be bound to localhost.

## Tools

| Tool | Purpose |
|---|---|
| `list_recipes`, `get_recipe`, `save_recipe`, `delete_recipe`, `validate_recipe` | Manage recipes in the store; `save_recipe`/`validate_recipe` return zod issues with JSON paths |
| `run_recipe` | Run a saved (`recipeId`) or inline recipe; waits by default (`timeoutSeconds`, default 300) and returns the run summary, drift and the first rows; `maxRequests` for trials, `dryRun` to skip sinks |
| `get_run`, `list_runs`, `cancel_run`, `get_rows`, `get_drift`, `diff_runs` | Run history, paging through rows, selector-drift diagnostics, change detection between two runs |
| `preview_extract` | Fetch one page over HTTP and run the entry template: records + per-field report (matched candidate, element count, empty values). The fast selector-iteration loop |
| `scrape_page` | One-call extraction from a URL with `fields` (+ optional `listSelector`), no recipe authoring needed; `mode` http/browser/auto |
| `fetch_page_markdown`, `fetch_page_html` | Look at a page as compact Markdown or cleaned HTML (`raw: true` keeps class names) |
| `generate_recipe`, `ask_page` | LLM-backed: draft a recipe from an instruction, answer a question from page content (need an AI provider) |
| `export_run` | Write a run's rows to sinks (csv, xlsx, json, jsonl, xml, parquet, sqlite, postgres, mysql, mongodb, webhook, ...) |
| `list_examples`, `get_example` | Bundled example recipes to start from |
| `list_schedules`, `set_schedule`, `list_alerts` | Cron schedules (`set_schedule` with `enabled`/`remove`) and monitoring alerts |

Every tool returns JSON text (and `structuredContent`); failures come back as `isError` results with a
message rather than protocol errors, so agents can recover.

## Resources and prompts

* `scrappia://recipes/{id}`: recipe JSON (listable, id completion).
* `scrappia://runs/{id}/rows`: first 500 rows of a run as JSON Lines (listable: last 50 runs).
* Prompt `build_scraper(url, goal?)`: guided workflow: `fetch_page_markdown` -> draft from `get_example` ->
  `preview_extract` loop -> `save_recipe` -> `run_recipe` trial -> full run / `export_run` / `set_schedule`.

## Embedding

```ts
import { ScrappiaApp } from '@scrappia/core';
import { createMcpServer, startHttp } from '@scrappia/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const app = new ScrappiaApp({ dataDir: '/data/scrappia' });
await createMcpServer(app).connect(new StdioServerTransport());
// or: await startHttp(app, { port: 8765, token: process.env.SCRAPPIA_MCP_TOKEN });
```

## Development

```
npm run typecheck --prefix packages/mcp
npm run test --prefix packages/mcp     # SDK Client over InMemoryTransport + HTTP transport, fixture site, in-memory SQLite
npm run build --prefix packages/mcp
```
