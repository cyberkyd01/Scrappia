# Command line guide

The `scrappia` command runs the same engine as the desktop app from a terminal. Use it for scripts,
cron jobs, CI pipelines, or servers without a screen.

## Running it

After `npm run build` in the project folder:

```
node apps/cli/dist/index.js --help
```

To type just `scrappia` instead, link it once: `npm link ./apps/cli` (or add an alias). The
examples below assume that.

Every command accepts `--home <folder>` (data folder; default `~/.scrappia`) and
`--log-level debug|info|warn|error`. Most list and show commands accept `--json` for machine-readable
output.

## Run a scraper

```
scrappia run books.json                           # run a recipe file, exports as configured in it
scrappia run books.json --out books.xlsx          # export to a file instead (format from extension)
scrappia run books.json --pages 2                 # only the first 2 pages
scrappia run books.json --max-requests 20         # hard cap on pages fetched (trial runs)
scrappia run books.json --mode browser --headed   # force the visible browser
scrappia run books.json --concurrency 8           # more parallel pages
scrappia run books.json --dry-run                 # extract only, no exports or alerts
scrappia run example:books-toscrape --out b.csv   # run a bundled example
scrappia run recipe:X6wLZN42NoC6                  # run a recipe saved in the local store
scrappia run books.json --json --quiet            # print only a JSON summary (for scripts)
```

While running, a progress line shows rows, pages, pending, failed, rows per minute and elapsed
time. Press Ctrl+C once to cancel gracefully (the run can be resumed), twice to force quit.

Exit codes: `0` succeeded, `2` partial (some pages failed), `1` failed or cancelled.

Resume a cancelled or crashed run: `scrappia resume <runId>`.

## Check a recipe before running

```
scrappia validate books.json          # lists every problem with its JSON path
scrappia preview books.json           # fetches the first page and prints the records it finds
scrappia preview books.json --url https://site.com/page/3
```

The preview also prints a field report: which selector candidate matched, how many matches, and
which fields came back empty.

## Manage saved recipes

```
scrappia recipes list
scrappia recipes add books.json --note "first version"
scrappia recipes show <id>
scrappia recipes show <id> --versions
scrappia recipes export <id> books.json
scrappia recipes rm <id>
```

Saving the same id again creates a new version; older versions stay available.

## Look at results

```
scrappia runs list
scrappia runs list --recipe <recipeId> --status succeeded --limit 10
scrappia runs show <runId>
scrappia runs rows <runId> --limit 50                       # table on screen
scrappia runs rows <runId> --format csv > rows.csv
scrappia runs rows <runId> --format jsonl --dataset detail
scrappia runs drift <runId>                                  # selector drift / healing events
scrappia runs rm <runId>
```

Export any past run to any format:

```
scrappia export <runId> --out data.xlsx
scrappia export <runId> --out data.csv --mode upsert --key url
scrappia export <runId> --out data.db --format sqlite --table products
```

Compare two runs:

```
scrappia diff <olderRunId> <newerRunId>
scrappia diff <a> <b> --fields price,stock --threshold 5     # only price/stock changes over 5%
```

## Schedules

```
scrappia schedule preview "0 9 * * 1-5" --tz America/New_York
scrappia schedule add <recipeId> "0 */6 * * *" --tz UTC
scrappia schedule list
scrappia schedule rm <scheduleId>
scrappia serve-scheduler                  # keep running and execute schedules (Ctrl+C to stop)
```

Cron format: `minute hour day month weekday`. `0 */6 * * *` is every 6 hours; `30 8 * * 1` is
Mondays at 08:30.

## Secrets, AI, keys, examples

```
scrappia secrets set NAME            # prompts, hidden
scrappia secrets list
scrappia ai add --name local --kind openai-compatible --base-url http://localhost:11434 --model llama3.1
scrappia ai test local
scrappia ai generate https://example.com/products "product name, price and rating" --out products.json
scrappia api-key create "zapier" --scopes read
scrappia examples list
scrappia examples copy books-toscrape my-books.json
scrappia browsers install            # (re)install the scraping browser
```

## Using it from scripts

```
#!/bin/sh
scrappia run prices.json --out "prices-$(date +%F).csv" --json --quiet > result.json || echo "run had problems"
```

Or use Windows Task Scheduler / cron to call the command on a timetable when you do not want the
built-in scheduler.
