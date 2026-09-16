# Troubleshooting and FAQ

## Installation

**`npm install` fails with EISDIR / symlink errors.**
Your project folder is on a drive that cannot create links (exFAT, some USB drives). Scrappia
handles this: run `npm install` again; the `postinstall` step writes stub packages instead of links.
If it still fails, move the folder to your main drive.

**`node: command not found` or an old version.**
Install Node.js 22 or newer from https://nodejs.org and reopen the terminal.

**`npx patchright install chromium` is slow or fails.**
It downloads about 150 MB. Retry on a stable connection. Behind a corporate proxy set
`HTTPS_PROXY=http://proxy:port` first. On Linux servers use `--with-deps` to install system
libraries.

**"SQLite is an experimental feature" warning.**
Harmless. Node prints it because Scrappia uses the built-in SQLite module.

**The desktop app does not open, `npx electron` says "Cannot find module 'electron'".**
Your terminal has `ELECTRON_RUN_AS_NODE` set. Run `set ELECTRON_RUN_AS_NODE=` (Windows) or
`unset ELECTRON_RUN_AS_NODE` and try again.

## Recording

**Clicking in the browser window does nothing.**
A Pick mode is on: clicks are captured, not performed. Click **Off** (or press Escape in the browser)
to browse normally.

**The wrong list was detected.**
Use **try another list**, or **Capture more content** to move up one level, or click on a different
part of a record (text usually works better than icons). **Auto-detect lists** shows all candidates.

**Fields are empty in the preview.**
The selector matched nothing in most records. Choose another candidate in the field editor (each
shows its match count when you click **Test**), or re-pick the element from a record where it is
visible.

**The page needs me to log in every time.**
Turn on **Persist session** in Engine settings so cookies are kept, and record the login as actions
for unattended runs (see the User guide).

## Running

**Rows are missing or the run stops early.**
Look at the Run monitor's log and the request list. Common causes: a block page (see below), the
"next" selector stopped matching (drift event), or `maxRequests` / `maxRows` caps in the recipe.

**Everything works in the recorder but the run returns nothing.**
The recorder is a real browser; a run in `auto` mode starts with plain HTTP and switches to the
browser only when it detects a JS-rendered page. If the site renders with JavaScript in a way the
detector misses, set the recipe's engine mode to `browser`.

**"blocked (cloudflare-challenge)" or 403 / 429 errors.**
The site is protecting itself. In order of cost: lower `concurrency` and raise `delayMs`; set mode to
`browser`; add residential proxies with `rotate: session`; configure a CAPTCHA service. Scrappia
already rotates proxies and backs off on blocks automatically.

**A CAPTCHA appears in a desktop run.**
Solve it in the browser window; the run continues. For unattended runs configure a solver service
in Engine → CAPTCHA.

**Runs are slow.**
Prefer `http` or `auto` mode; the browser is 10 to 50 times slower. Raise `concurrency` (4 to 8 on a
laptop). Block images/fonts/media (default in browser mode). Reduce `delayMs` if the site tolerates
it.

**Excel shows numbers as text.**
Add a `number` or `currency` transform to the field so the value is stored as a number.

**Dates are in the wrong format.**
Add a `date` transform with `inputFormat` (for example `DD/MM/YYYY`) and `outputFormat`.

**Duplicate rows.**
Set **key fields** under Output (for example the product URL). Rows with the same key are merged.

## Server

**401 Unauthorized.**
Send `Authorization: Bearer <key>`. If you still use the bootstrap key from the environment, note
that it stops working after the first real key is created. Create a key and use that.

**403 Forbidden.**
The key lacks the scope (`write` for anything that is not a GET).

**The event stream (`/events`) disconnects behind Nginx.**
Add `proxy_buffering off; proxy_read_timeout 1h;` to the location block.

**Scheduled runs happen twice.**
Two processes share the data folder with schedulers on (desktop app + server, or two server
replicas). Start extra replicas with `SCRAPPIA_NO_SCHEDULER=1`.

**Chromium crashes inside Docker.**
Keep `shm_size: 1gb` in docker-compose.yml. Lower `concurrency` in browser-mode recipes.

## Data and privacy

**Where are my recipes?**
In `scrappia.db` inside the data folder (see the Admin guide). Export them as JSON from the app or
`scrappia recipes export`.

**Does Scrappia send my data anywhere?**
No. Only the AI features send page content to the provider you configured, and only for the fields
or actions that use AI. Use a local model (Ollama) to keep everything on your machine.

**Is scraping legal?**
It depends on the site, the data and where you are. Public, non-personal data for your own analysis
is usually fine; check the site's terms, respect robots.txt where appropriate, do not overload
servers, and be careful with personal data.

## Getting help

Open an issue on GitHub with: what you did, what you expected, what happened, the recipe (remove
anything private), and the log (`--log-level debug` in the CLI or the Run monitor log).
