# Recipe reference

A recipe is a JSON document validated by the zod schema in `packages/core/src/recipe/schema.ts`.
Unknown keys are rejected; defaults are applied on parse. `version` is `1`.

## Top level

| Key | Type | Notes |
|---|---|---|
| `name` | string | Required |
| `description`, `tags` | | Optional metadata |
| `entry` | `{ urls[], template, method?, body? }` | Start URLs and the template that handles them. `method` GET or POST; `body` for POST |
| `keywords` | `{ name: string[] }` | Substituted as `{{name}}` in entry URLs (URL-encoded), POST bodies and `type` action text. Use `{{raw:name}}` for unencoded |
| `keywordMode` | `product` \| `zip` | Cartesian product (default) or row-wise |
| `templates` | `{ name: Template }` | At least the entry template |
| `engine` | EngineConfig | Fetching, concurrency, anti-bot |
| `output` | OutputConfig | Keys, dedupe, validation, provenance |
| `sinks` | Sink[] | Export destinations |
| `monitor` | MonitorConfig | Change detection and alerts |
| `schedule` | `{ cron, tz?, enabled?, skipIfRunning? }` | Cron schedule |
| `ai` | `{ provider?, selfHeal?, model? }` | AI provider name from settings; self-healing on by default |

## Template

A template describes one kind of page.

| Key | Notes |
|---|---|
| `actions` | Steps executed before extraction (forces browser mode) |
| `fields` | Page-level fields; produce one row per page (or merge into the parent row when reached via a follow) |
| `list` | Repeating records: `{ selector, fields, follow, minItems, filter, limit }` |
| `follow` | Page-level follows (e.g. category links): `[{ selector \| field, template, mode, limit, method }]` |
| `pagination` | See below |
| `mode` | Force `http` or `browser` for this template |
| `waitFor` | Selector to wait for before extracting (browser) |
| `dataset` | Emit rows into a named dataset |

### Selectors

Every selector is an array of candidates, tried in order:

```json
[{ "kind": "css", "value": "[data-testid=price]" }, { "kind": "xpath", "value": "//span[@class='price']" }]
```

Kinds: `css` (default), `xpath`, `text` (element whose text equals the value; combine with
`following: true` to capture the text after a label), `role` (`button[name=Next]`), `auto`.
`:scope` refers to the record element itself.

### Field

| Key | Notes |
|---|---|
| `name` | Column name |
| `type` | `text` (default), `html`, `innerHtml`, `attr` (+`attr`), `href`, `src`, `email`, `phone`, `regex` (+`pattern`, `flags`, `source`), `constant` (+`value`), `pageUrl`, `pageTitle`, `timestamp`, `image` (downloads, +`downloadDir`, `fileName`), `screenshot`, `count`, `exists`, `ai` (+`prompt`, `schema`), `json`, `table` |
| `multiple` | Capture all matches as an array |
| `scope` | `record` (default) or `document` |
| `ancestor` | Walk up N parents before extracting ("capture more content") |
| `transforms` | Pipeline, see below |
| `required` | Flags rows where the value is empty |

### Transforms

`trim`, `lowercase`, `uppercase`, `collapseWhitespace`, `stripHtml`, `regex` (`pattern`, `group`,
`all`, `join`), `replace`, `split` (`separator`, `index`), `substring`, `prefix`, `suffix`, `default`,
`number` (`decimal`, `thousands`), `integer`, `boolean` (`truthy`), `currency`, `date` (`inputFormat`
tokens YYYY MM DD HH mm ss, `outputFormat`), `absoluteUrl`, `urlParam`, `template` (`{{value}}`,
`{{otherField}}`, `{{pageUrl}}`), `map` (`mapping`, `fallback`), `hash`, `js` (`code` with `value`,
`row`, `ctx`), `ai` (`prompt`, `schema`).

### Actions

`click` (`selector`, `optional`, `all`), `type` (`selector`, `text`, `submit`, `clear`), `select`,
`hover`, `scroll` (`selector`, `times`, `untilNoChange`, `delayMs`), `wait` (`ms`), `waitFor`
(`selector`, `state`, `timeoutMs`), `waitForNetworkIdle`, `script` (`code`), `press` (`key`), `frame`
(`selector`), `goBack`, `reload`, `screenshot`, `setCookie`, `solveCaptcha`, `repeat` (`actions`,
`whileSelector`, `max`, `delayMs`).

### Pagination

| type | Keys | Notes |
|---|---|---|
| `next` | `selector`, `maxPages`, `stopWhenNoNewRows`, `method` (`auto`/`href`/`click`) | Follows the next link; `click` paginates in one tab |
| `pageLinks` | `selector`, `maxPages` | Numbered page links |
| `loadMore` | `selector`, `maxClicks`, `delayMs`, `stopWhenNoNewRows` | Clicks until gone / no new rows |
| `scroll` | `maxScrolls`, `delayMs`, `selector`, `stopWhenNoNewRows` | Infinite scroll |
| `urlPattern` | `template` with `{{page}}`, `start`, `step`, `maxPages`, `stopWhenNoNewRows` | Stops on the first empty page |
| `urlList` | `urls` | |
| `script` | `code`, `maxPages`, `delayMs` | Return `false` to stop |

`maxPages: -1` means all pages. With `stopWhenNoNewRows` the engine stops when a page adds no new
rows, so load-more and scroll pagination never need a page count.

### Follow

`{ field: "url", template: "detail", mode: "merge" }` follows the URL in a record field.
`{ selector: [...], template: "listing" }` follows links matched on the page.
Modes: `merge` adds the detail fields as columns on the parent row; `nest` stores them under a key
named after the template; `separate` writes them to their own dataset with a `_parentKey` column.

## Engine

| Key | Default | Notes |
|---|---|---|
| `mode` | `auto` | `http`, `browser`, or `auto` (HTTP first, browser on JS shells / challenges / empty lists) |
| `browser` | `patchright` | Stealth Playwright fork; `playwright` also supported |
| `headless`, `stealth`, `fingerprint` | true | |
| `concurrency` | 4 | Global workers |
| `perHostConcurrency` | 2 | Per host |
| `delayMs`, `jitterMs` | 250 / 250 | Spacing between requests to the same host |
| `timeoutMs` | 30000 | |
| `retries` | 3 | Exponential backoff with jitter |
| `userAgent`, `locale`, `timezone`, `viewport`, `headers`, `cookies` | | |
| `blockResources` | image, font, media | Browser mode |
| `respectRobots` | false | |
| `proxy` | `{ urls[], pool?, rotate: session\|request\|none, maxErrors, country? }` | `{session}` token in URLs becomes a sticky session id |
| `captcha` | `{ provider: none\|2captcha\|capsolver\|anticaptcha\|manual, apiKeyRef, autoDetect }` | |
| `session` | `{ persist, profile, clearEvery }` | Persistent profile keeps logins |
| `maxRequests`, `maxRows` | | Safety caps |

## Output

`keys` (row identity for dedupe/upsert/monitoring), `dedupe`, `validation` (`[{ field, rule, value,
action: flag|drop|fail }]` with rules `required`, `regex`, `min`, `max`, `minLength`, `maxLength`,
`url`, `email`, `number`, `enum`, `js`), `addPageUrl`, `addTimestamp`, `addKeyword`,
`addCategoryPath`, `blankRowWhenEmpty`, `columns`, `flatten`.

## Sinks

All sinks accept `mode` (`append` | `overwrite` | `upsert`), `key`, `dataset`, `enabled`. File paths
support `{{run}}`, `{{recipe}}`, `{{dataset}}`, `{{date}}`, `{{datetime}}`.

`csv`, `tsv`, `json`, `jsonl`, `xlsx`, `xml`, `parquet`, `sqlite` (`path`, `table`), `postgres`,
`mysql` (`connectionRef`, `table`), `mongodb` (`connectionRef`, `database`, `collection`),
`google-sheets` (`credentialRef` = service-account JSON or access token, `spreadsheetId`, `sheet`),
`airtable` (`credentialRef`, `baseId`, `table`), `notion` (`credentialRef`, `databaseId`), `s3`
(`credentialRef` = JSON with accessKeyId/secretAccessKey/region/endpoint, `bucket`, `keyTemplate`,
`format`), `webhook` (`url`, `secretRef`, `batchSize`, `headers`), `stdout`.

Credential references name secrets stored in the vault (`scrappia secrets set NAME`), never
literal values inside the recipe.

## Monitor

`{ enabled, fields[], thresholdPercent, on: [added, removed, changed, drift, failure, empty],
channels: [ webhook | email | slack | discord | telegram | ntfy | desktop ] }`.
Webhook alerts and webhook sinks are signed: `x-scrappia-signature: sha256=HMAC(secret, "<timestamp>.<body>")`.
