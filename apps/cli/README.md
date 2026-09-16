# @scrappia/cli

`scrappia` runs Scrappia recipes headlessly, exports datasets, keeps run history, schedules recurring
scrapes and manages secrets/AI providers. It uses the same engine as the desktop app, server and MCP
server; recipes recorded in the desktop app run unchanged from the command line.

```
node apps/cli/dist/index.js --help        # from the checkout (after `npm run build --prefix apps/cli`)
npm run scrappia -- --help                # same, via the root package script
scrappia --help                           # when the package is linked/installed globally
```

Every command accepts `--home <dir>` (data directory, default `$SCRAPPIA_HOME` or `~/.scrappia`) and
`--log-level debug|info|warn|error` (default `warn`, or `$SCRAPPIA_LOG_LEVEL`). The data directory
holds the SQLite database (recipes, runs, rows, schedules, secrets), exports and browser profiles.

## Quick start

```bash
scrappia examples list                                   # bundled demo recipes
scrappia examples copy books-toscrape books.json         # copy one to edit
scrappia validate books.json                             # schema check + structure summary
scrappia preview books.json                              # HTTP-only extraction of the first page + field report
scrappia run books.json --pages 2 --out books.csv        # scrape 2 pages, export to CSV
scrappia runs list                                       # history
scrappia runs rows <runId> --limit 5                     # look at the data
scrappia export <runId> --out books.xlsx                 # export again in another format
```

Or run an example straight away: `scrappia run example:hacker-news-monitor --out hn.jsonl`.

## Commands

### run / resume

```
scrappia run <recipe.json> [--pages N] [--max-requests N] [--out <file>] [--format csv|tsv|json|jsonl|xlsx|xml|parquet|sqlite]
             [--mode http|browser|auto] [--headed] [--concurrency N] [--dry-run] [--quiet] [--json]
scrappia resume <runId> [--quiet] [--json]
```

* Validates the recipe first; zod issues are printed one per line with their JSON path.
* `--out` replaces the recipe's sinks with a single file sink (format from the extension or `--format`);
  the path is relative to the current directory.
* `--pages` caps pagination of the entry template (`maxPages`, `maxClicks` or `maxScrolls`).
* `--max-requests` is a hard cap on fetched pages (good for trial runs), `--dry-run` skips sinks,
  monitoring and alerts (rows are still stored and visible with `runs rows`).
* Progress line (rows, pages, pending, failed, rows/min, elapsed) is rewritten in place on a terminal and
  printed as plain `progress:` lines every 5 s otherwise; drift and alert events are printed as they happen.
* Ctrl+C cancels gracefully (the run becomes `cancelled` and can be resumed); a second Ctrl+C force quits.
* Exit code: `0` succeeded, `2` partial (some requests failed), `1` failed or cancelled.
* `--json` prints only `{ "run": {...}, "stats": {...} }` on stdout (progress and logs go to stderr), e.g.

```bash
scrappia run books.json --out books.csv --json | jq '.stats.rows'
```

### preview / validate

```
scrappia preview <recipe.json> [--url U] [--limit N] [--json]
scrappia validate <recipe.json> [--json]
```

`preview` fetches one page over HTTP (no browser), prints the extracted records with `console.table` and a
field report: which selector candidate matched, how many elements it matched, how many records were empty,
and a status (`ok`, `fallback #2`, `matched but empty`, `NO MATCH`). Exit code 2 when the list selector matched
nothing.

### recipes

```
scrappia recipes list | add <file> [--id id] [--note text] | show <id> [--versions] | info <id> | rm <id> | export <id> <file>
```

Saved recipes are what schedules, the REST server and the MCP server run by id. Adding under an existing
id creates a new version. A recipe with a `schedule` block registers its cron automatically.

### runs

```
scrappia runs list [--recipe id] [--status s] [--limit n]
scrappia runs show <runId>
scrappia runs rows <runId> [--dataset d] [--limit n] [--offset n] [--format table|json|jsonl|csv] [--columns a,b]
scrappia runs drift <runId>
scrappia runs rm <runId>
```

### export

```
scrappia export <runId> --out <file> [--format ...] [--mode append|overwrite|upsert --key field] [--dataset d] [--table t]
```

Re-exports stored rows of any finished run. Upsert mode needs `--key` (comma separated for composite keys).

### diff

```
scrappia diff <runIdA> <runIdB> [--fields a,b] [--threshold pct] [--dataset d] [--limit n] [--json]
```

Rows are matched by the recipe's `output.keys`; prints added / removed / changed / unchanged counts and
samples. `--threshold 5` ignores numeric changes below 5 %.

### schedule / serve-scheduler

```
scrappia schedule list
scrappia schedule add <recipeId> "0 */6 * * *" [--tz Europe/Berlin] [--no-skip-if-running] [--disabled]
scrappia schedule rm <scheduleId|recipeId>
scrappia schedule preview "30 8 * * 1-5" [--tz UTC] [--count 5]
scrappia serve-scheduler
```

`serve-scheduler` runs the cron scheduler in the foreground (prints run start/finish and alerts) until
Ctrl+C; it picks up schedule changes made by other processes every 30 s.

### secrets

```
scrappia secrets set <name> [value]      # value omitted: masked prompt on a TTY, or piped stdin
scrappia secrets list
scrappia secrets rm <name>
```

Recipes reference secrets by name (`connectionRef`, `secretRef`, `apiKeyRef`, proxy pools); environment
variables of the same name work as a fallback.

### ai

```
scrappia ai providers
scrappia ai add --name claude --kind anthropic --model claude-sonnet-5 --api-key-ref ANTHROPIC_API_KEY [--default]
scrappia ai add --name local --kind openai-compatible --base-url http://localhost:11434 --model llama3.1
scrappia ai test [name]
scrappia ai generate <url> "<instruction>" [--out recipe.json] [--provider name] [--save]
scrappia ai rm <name>
```

Without configured providers, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OLLAMA_HOST` in the environment are
picked up automatically. `generate` fetches the page, asks the model for a record selector + fields, validates
the draft, previews it and writes the recipe.

### examples, api-key, browsers, server

```
scrappia examples list | show <name> | copy <name> <file> [--force]
scrappia api-key create <name> [--scopes read,write] | list | rm <id>
scrappia browsers install [--with-deps]        # npx patchright install chromium
scrappia server                                # how to start @scrappia/server
```

## Development

```
npm run typecheck --prefix apps/cli
npm run test --prefix apps/cli        # vitest, in-process CLI against a fixture HTTP site and a temp home
npm run build --prefix apps/cli
```

`src/cli.ts` exports `runCli(argv, io)` so tests (and other tools) can drive the CLI without spawning a
process; `src/index.ts` is the thin bin entry.
