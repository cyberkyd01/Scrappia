# AI agents guide (MCP)

Scrappia includes an MCP server, which lets AI assistants such as Claude Desktop, Claude Code and
other MCP-capable tools build, run and read scrapers by talking to you in plain language. You say
"get me the prices of all laptops on this page every morning" and the assistant creates the recipe,
tests it, saves it and schedules it.

## Set up with Claude Desktop

1. Build Scrappia (see [Getting started](getting-started.md)).
2. Open Claude Desktop → Settings → Developer → **Edit config**. Add:

   ```json
   {
     "mcpServers": {
       "scrappia": {
         "command": "node",
         "args": ["C:\\path\\to\\Scrappia\\packages\\mcp\\dist\\bin.js"]
       }
     }
   }
   ```

   On macOS/Linux use a normal path such as `/Users/you/Scrappia/packages/mcp/dist/bin.js`.
   Add `"env": {"SCRAPPIA_HOME": "..."}` to use a specific data folder, or `"--home", "..."` in args.

3. Restart Claude Desktop. A tools icon shows "scrappia" with 24 tools.

## Set up with Claude Code

```
claude mcp add scrappia -- node /path/to/Scrappia/packages/mcp/dist/bin.js
```

## Remote (HTTP) mode

To connect from another machine or a hosted agent:

```
SCRAPPIA_MCP_TOKEN=some-long-secret node packages/mcp/dist/bin.js --http 8790
```

Clients connect to `http://host:8790/mcp` with `Authorization: Bearer some-long-secret`.

## What the assistant can do

| Tool | Purpose |
|---|---|
| `fetch_page_markdown`, `fetch_page_html` | Look at a page to understand its structure |
| `preview_extract` | Try selectors on one page without a browser, get a match report |
| `scrape_page` | One-off extraction of fields from a URL |
| `generate_recipe` | Build a recipe from a URL and a sentence (needs an AI provider) |
| `validate_recipe`, `save_recipe`, `get_recipe`, `list_recipes`, `delete_recipe` | Manage recipes |
| `run_recipe`, `get_run`, `list_runs`, `cancel_run` | Run and monitor |
| `get_rows`, `get_drift`, `diff_runs`, `export_run` | Read results, changes, export |
| `set_schedule`, `list_schedules`, `list_alerts` | Automate and check alerts |
| `list_examples`, `get_example`, `ask_page` | Reference and Q&A about a page |

There is also a `build_scraper` prompt that walks the assistant through the recommended flow: look at
the page, try an extraction, fix selectors, save, run.

## Example conversation

> Build a scraper for https://books.toscrape.com that collects title, price and rating of every
> book across all pages, run it, and show me the five cheapest.

The assistant fetches the page, previews an extraction on `article.product_pod`, adds a next-page
rule, saves the recipe, runs it with `run_recipe`, then reads rows with `get_rows` and answers.

> Schedule it daily at 7am Berlin time and alert me on Slack when prices change.

The assistant calls `set_schedule` and edits the recipe's monitor. You provide the Slack webhook URL
as a secret (`scrappia secrets set SLACK_ALERTS ...`), the recipe only references its name.

## Safety notes

- The MCP server runs with the same data folder and permissions as the CLI; whoever controls the
  assistant controls your recipes and can read your scraped data.
- In HTTP mode always set `SCRAPPIA_MCP_TOKEN` and put HTTPS in front.
- Runs started by an agent obey the same caps (`maxRequests`, `maxRows`) as everything else; the
  `run_recipe` tool defaults to waiting up to 5 minutes, then returns a run id you can check later.
