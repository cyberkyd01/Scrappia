# Tech stack research (Sept 2026, versions read from npm/PyPI on 2026-09-15)

## Browser automation / stealth
- Playwright 1.63 (Chromium 153). Default headless = headless-shell (fingerprints as HeadlessChrome).
  Use `channel: 'chromium'` for new headless, headed for recording. Never headless-shell on protected targets.
- patchright 1.63 (npm): Playwright fork removing Runtime.enable leak, --enable-automation, isolated world.
  Drop-in, tracks upstream. Best choice for a TS engine (25/31 Cloudflare targets pass).
- nodriver (Python) best pass rate but no Playwright API. camoufox (Firefox fork) Python-only.
- rebrowser-playwright abandoned. playwright-extra stealth legacy/detectable.
- Fingerprints: `fingerprint-generator` + `fingerprint-injector` 2.1.88 (Apify).
- HTTP-only fetch with TLS impersonation: `impit` 0.14.5 (Rust, Chrome/Firefox profiles) or `got-scraping` 4.2.1.

## Crawling
- Crawlee JS 3.18 stable, 4.0 RC (Node 22+, ESM, zod 4). Has RequestQueue, AutoscaledPool,
  SessionPool (proxy+cookies+fingerprint+error score), Router, hooks. Opinionated storage.
- Scrapy 2.19 (Python). Colly 2.2 (Go, HTTP-only).
- Helpers: p-queue 9.3, p-retry 8, bottleneck 2.19 (per-domain token buckets).

## Selector generation / pattern detection
- @medv/finder 4.0.2: shortest unique selector; predicate filters for stable classes; seedMinLength 4-5.
- css-selector-generator 3.9.4: multi-element input (one selector matching all), ranked alternatives,
  blacklist generated classes (/^css-/, /^sc-/, /^_/, /^[a-z]+-[0-9a-f]{5,}$/).
- Playwright role/text locator heuristics for action selectors. Own getXPath (~30 lines).
- Strategy: 3-5 candidates per element, score (uniqueness, depth, no generated classes, no nth-child),
  store all, fall through at run time = self-healing.
- List detection: MDR (Mining Data Records, Liu et al.): walk ancestors of clicked element, compute
  structural signature (tag path + class set + child count) of siblings, pick shallowest ancestor with
  >=2 similar siblings and large area; generalise selector; align fields across records by path;
  allow gaps for ads. Optional LLM assist on ambiguous regions.

## LLM extraction
- Pattern to copy (Crawl4AI / Kadoa): LLM generates selectors ONCE on a sample page, deterministic runs,
  LLM again only on drift (0/many matches, empty rows, validation failure). Per-page LLM only for one-offs.
- Cleaning: @mozilla/readability 0.6 + linkedom 0.18 / happy-dom 20; turndown 7.2 for markdown
  (60-80% fewer tokens than HTML); strip script/style/svg/noscript/comments/inline styles; send 2-3 sample
  records not the page; ARIA snapshot for navigation reasoning.
- Anthropic SDK @anthropic-ai/sdk 0.126. Models: claude-opus-5 ($5/$25, 1M ctx), claude-sonnet-5 ($2/$10),
  claude-haiku-4-5 ($1/$5). Structured outputs GA: `output_config: { format: { type: 'json_schema', schema } }`
  (additionalProperties:false, no recursion, no min/max). `client.messages.parse` + `zodOutputFormat`.
  `output_config.effort: 'low'` for extraction workers. Prompt caching on system+schema. Batches API 50% off.
- OpenAI-compatible endpoints (Ollama, LM Studio) for local/private extraction.

## Desktop shell
- Electron 44.4 (Chromium 152, Node 24). electron-vite 5, electron-builder 26.
- Tauri 2: native webviews expose no CDP cross-platform; not viable for controllable scraping browser.
- Octoparse = Electron + custom Chromium. Recommended architecture: Electron UI + separate
  patchright-launched headed Chromium with `addInitScript` overlay + `exposeBinding` RPC + CDPSession
  (Overlay.highlightNode, DOM.getBoxModel). Same engine binary runs in server mode.

## Scheduling / queue / storage
- Desktop: node:sqlite (Node 22.13+ unflagged, Electron 44 has Node 24) or better-sqlite3 13 (needs rebuild).
  WAL mode. croner 10 for cron (TZ, DST-correct). SQLite claim pattern `UPDATE ... RETURNING` for queue.
- Server: Postgres 16 + pg-boss 12 (SKIP LOCKED, cron singleton, retries), or BullMQ 6 with Redis.
- API: hono 4.13 or fastify 5.12; tRPC 11.

## Export
- exceljs 4.4 (streaming), papaparse 5.7 (CSV), native JSONL, hyparquet-writer 0.16 (Parquet),
  pg 8.23, mysql2 3.24, mongodb 7.6, googleapis 181 (Sheets v4), airtable 0.12 (10 rec/req, 5 rps),
  @notionhq/client 5.26 (3 rps), @aws-sdk/client-s3, undici fetch + HMAC for webhooks.
- Design: sinks consume an async iterator of rows so every format streams.

## Anti-bot
- Proxy URL shape `http://user-country-XX-session-<id>:pass@gateway:port`; sticky session via username.
  proxy-chain 3.0 for auth proxies -> local anonymous (Chromium cannot take proxy auth on CLI), per-context.
  On 403/429/challenge retire the session, not the URL.
- CAPTCHA: 2Captcha (@2captcha/captcha-solver 1.3.9), CapSolver (capsolver-npm 2.1), Anti-Captcha REST.
  Common createTask/getTaskResult polling; types TurnstileTaskProxyless, RecaptchaV2/V3, HCaptcha, FunCaptcha,
  DataDome, ImageToText. Inject token via page.evaluate into widget callback.
- FlareSolverr weak on Turnstile; Byparr is maintained fork. Optional plugin.
- Backoff: per-domain buckets, exp backoff full jitter cap 60s, honour Retry-After, adaptive concurrency.
- robots-parser 3.0.1; per-project "respect robots" switch.

## Change detection
- Normalise -> sha256 row hash; microdiff 1.6 for structural diffs; diff 9 (jsdiff) for text.
  Key rows by a user-chosen unique field; classify added/removed/changed; thresholds (price > x%).
- Notify: nodemailer 10, @slack/webhook 8, Discord/Teams/Telegram via fetch, ntfy; digest/debounce.
