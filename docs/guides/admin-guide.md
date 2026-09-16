# Admin guide

For the person who looks after a Scrappia installation: keys, secrets, AI providers, proxies,
CAPTCHA services, data, backups, logs and security. Commands are shown for the CLI and the API;
the desktop app has the same options under **Settings**.

## Where everything is stored

One data folder holds it all:

| Location | Contents |
|---|---|
| `scrappia.db` | Recipes (with version history), runs, rows, request log, drift events, alerts, schedules, secrets, API keys, settings |
| `exports/` and any paths you configured | Exported files |
| `downloads/<run>/<field>/` | Downloaded images |
| `screenshots/<run>/` | Screenshots |
| `profiles/<name>/` | Browser profiles (cookies, logins) for recipes with a persistent session |

Default location: `~/.scrappia` (CLI and server) or `%APPDATA%\Scrappia\data` (desktop app).
Change it with `SCRAPPIA_HOME` or `--home`.

**Backup** = stop the server (or not; SQLite in WAL mode copies safely), copy the folder.
**Restore** = put the folder back.

## API keys

Keys are how programs and people authenticate to the server. Each key has a name and scopes:

- `read`: GET requests (recipes, runs, rows, datasets, events).
- `write`: everything else (create/run recipes, exports, settings, secrets).
- `admin`: implies both.

Create, list, revoke:

```
scrappia api-key create "reporting script" --scopes read
scrappia api-key list
scrappia api-key rm <id>
```

or via the API (`POST /api/api-keys`, `GET /api/api-keys`, `DELETE /api/api-keys/:id`). Keys are
stored hashed; the plaintext is shown once at creation. Give each person or integration its own key so
you can revoke one without affecting the others.

The bootstrap key (`SCRAPPIA_API_KEY` environment variable) only works while no keys exist. Once you
create one, remove the variable.

## Secrets vault

Anything sensitive (database passwords, Google service account JSON, Airtable tokens, proxy
credentials, CAPTCHA API keys, Slack webhook URLs, SMTP settings) goes in the vault, and recipes refer
to it by name. This keeps recipes shareable.

```
scrappia secrets set PG_MAIN            # prompts for the value, hidden
scrappia secrets set SLACK_ALERTS https://hooks.slack.com/services/...
scrappia secrets list
scrappia secrets rm PG_MAIN
```

API: `PUT /api/secrets/PG_MAIN` with `{"value":"..."}`; `GET /api/secrets` lists names only. Values are
never returned by the API or shown in the app.

Environment variables with the same name also work as secrets on the server, which is convenient in
Docker.

Formats expected by specific sinks and channels:

| Reference used by | Value |
|---|---|
| `postgres.connectionRef` | `postgres://user:pass@host:5432/dbname` |
| `mysql.connectionRef` | `mysql://user:pass@host:3306/dbname` |
| `mongodb.connectionRef` | `mongodb://user:pass@host:27017` |
| `google-sheets.credentialRef` | The full service-account JSON file contents (share the sheet with the service account's email), or an OAuth access token |
| `airtable.credentialRef` | Personal access token |
| `notion.credentialRef` | Integration token (share the database with the integration) |
| `s3.credentialRef` | `{"accessKeyId":"...","secretAccessKey":"...","region":"us-east-1","endpoint":"https://..."}` (endpoint only for R2/MinIO) |
| `webhook.secretRef` | Any string; used to sign requests |
| `email.smtpRef` | `{"host":"smtp.example.com","port":587,"user":"...","pass":"...","from":"scrappia@example.com"}` |
| `captcha.apiKeyRef` | The 2Captcha / CapSolver / Anti-Captcha API key |
| `proxy.pool` | Proxy URLs, one per line |

## AI providers

Scrappia works without AI. With a provider you get recipe generation, field suggestions, AI fields
and transforms, and self-healing selectors.

Add a provider:

```
# Anthropic (best quality, structured outputs)
scrappia secrets set ANTHROPIC_KEY sk-ant-...
scrappia ai add --name claude --kind anthropic --model claude-sonnet-5 --api-key-ref ANTHROPIC_KEY --default

# OpenAI or any compatible service
scrappia secrets set OPENAI_KEY sk-...
scrappia ai add --name openai --kind openai-compatible --base-url https://api.openai.com/v1 --model gpt-4o-mini --api-key-ref OPENAI_KEY

# Local, private: Ollama (install from https://ollama.com, then `ollama pull llama3.1`)
scrappia ai add --name local --kind openai-compatible --base-url http://localhost:11434 --model llama3.1

scrappia ai test claude
scrappia ai providers
```

Model guidance: `claude-sonnet-5` for everyday extraction, `claude-haiku-4-5` for cheap
classification, `claude-opus-5` for generating recipes on hard pages. Cost control: AI is only used
where a recipe asks for it, batches of up to 12 items go in one call, pages are converted to compact
markdown first, and self-healing runs at most once per field per run.

Privacy: with a cloud provider the page content of AI fields is sent to that provider. Use a local
model when that is not acceptable.

## Proxies

Add proxies per recipe under Engine, or keep a shared pool in a secret and reference it with
`engine.proxy.pool`. Formats:

```
http://user:pass@host:port
socks5://user:pass@host:port
http://user-country-us-session-{session}:pass@gateway:port    # provider sticky sessions
```

`rotate` is `session` (each worker keeps its proxy, rotated when blocked), `request` (new proxy every
request) or `none`. A proxy is retired after `maxErrors` consecutive failures and revived when all are
retired. Blocked responses (403/429, Cloudflare challenges) rotate the proxy, back off that host and
recycle the browser context automatically.

## CAPTCHA services

Under Engine → CAPTCHA choose `2captcha`, `capsolver` or `anticaptcha` and point `apiKeyRef` at the
secret holding the service's API key. With `autoDetect` on, Turnstile, reCAPTCHA v2/v3 and hCaptcha
widgets or challenge pages are solved automatically. `manual` waits for a person to solve it in the
visible browser (desktop runs). Solving costs money per CAPTCHA at the service; prefer better proxies
and lower concurrency first.

## Politeness and legal settings

- `engine.respectRobots` honours robots.txt. It is off by default because recipes are usually
  written for specific pages a person would visit anyway; turn it on for broad crawls.
- `engine.delayMs` and `jitterMs` space out requests to the same site; `perHostConcurrency` limits
  parallel requests per site (default 2).
- `engine.maxRequests` and `maxRows` are safety caps.
- Check the site's terms of service and your local law before scraping personal data.

## Schedules

Schedules live in recipes (`schedule.cron`) and are run by whichever process has the scheduler:
the desktop app while open, or the server. Do not run the desktop app and the server against the same
data folder at the same time with schedules on, or a recipe may run twice.

```
scrappia schedule list
scrappia schedule preview "0 9 * * 1-5" --tz Europe/Berlin
scrappia schedule add <recipeId> "0 */6 * * *" --tz UTC
scrappia serve-scheduler          # run the scheduler in the foreground (no API)
```

## Monitoring the service

- Health: `GET /health` returns `{ok, version, uptime, activeRuns}`; use it in uptime monitors.
- Logs: text by default, `SCRAPPIA_LOG_JSON=1` for JSON. Every request is logged with method, path,
  status and duration.
- Alerts: recipes with monitoring send failure and drift alerts to the configured channels; the
  desktop app shows unread alerts on Home. `GET /api/alerts?unread=1` lists them.
- Run history: `GET /api/runs`, `scrappia runs list`. Each run records stats (rows, pages, failed
  requests, drift, healed, AI tokens) and the request log with per-page status.

## Cleaning up

Old runs keep their rows in the database. Delete runs you no longer need:

```
scrappia runs list --limit 200
scrappia runs rm <runId>
```

or `DELETE /api/runs/:id`. Exported files are not deleted with the run.

## Security checklist

- Put HTTPS in front of the server (see the [Hosting guide](hosting-guide.md)).
- One API key per integration, `read` scope where possible.
- Keep secrets in the vault, not in recipes or environment files that get committed.
- Restrict `SCRAPPIA_CORS` to the origins that need browser access.
- Webhook deliveries are signed: verify `x-scrappia-signature` (`sha256=HMAC-SHA256(secret,
  "<x-scrappia-timestamp>.<body>")`) on the receiving side and reject old timestamps.
- Back up the data folder; it contains your API key hashes and secrets.
- Update regularly (`git pull && npm install && npm run build`).
