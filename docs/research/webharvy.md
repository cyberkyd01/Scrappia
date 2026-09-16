# WebHarvy Inventory (research, Sept 2026)

Windows-only desktop scraper with embedded Chromium, XML configs, perpetual license
(Single $99, Site $699). Latest 8.1 (Sept 2026): LLM extraction (8.0) + MCP server (8.1).

## Interaction model
1. Browse to a URL in the built-in browser (log in, search, open categories manually).
2. Click "Start" (config mode). Hover highlights elements. Click -> Capture window:
   Capture Text / target URL / email / Image / HTML / following Text, More Options,
   Follow this link, Set as Next Page link, Click.
3. Name the field -> OK. Pattern detection auto-finds all similar items (CSS selectors,
   tunable: accuracy Strict..Low, min items in list = 10, DOM search levels = 2).
4. Detail pages: click a link -> "Follow this link" -> click fields on detail page -> appended as columns.
5. Pagination: next link / "load next page set" / "show more" / scroll / URL list /
   %%pagenumber%% token / custom JS.
6. Stop -> Save XML -> Start-Mine -> Miner window (page count or all) -> Export.

Linear, mode-based (browse -> configure -> mine -> export). No workflow graph, no
conditionals, no per-field pipeline. Corrections = re-click or hand-edit XML.

## Features
- Capture types: text, URL, email, image (download or src), HTML, following text,
  sub-text, regex (capture groups, multi-match), custom data (page URL, screenshot,
  datetime, constant), AI extract, input text, run JS, select dropdown, open popup,
  open frame, scroll list, click, page scroll/reload/back.
- Capture More Content (walk up to parent), Disable Pattern Detection for detail pages.
- Categories: select category links, multi-level tree, tag rows with category path.
- Keywords: list, CSV, file import; substitute into URL/POST, or type into search box;
  multiple keyword lists, row-wise submission; tag rows with keyword; blank row on no data.
- Start URL/POST data/custom headers. Login: manual session, scripted, or basic-auth URL.
- Mining: page count or all; pause/resume; 1-10 parallel threads (link following only);
  auto save; exact dedup; random pauses ("human emulation"); load timeout 30s; script wait 5s;
  link retry.
- Browser: embedded Chromium; proxies HTTP/SOCKS4/5 with auth + list + rotation + test;
  custom UA; disable images/popups/cookies; separate engine for links; clear cache.
- AI (8.0): provider = Ollama / LM Studio / OpenAI / Anthropic / any OpenAI-compatible;
  "Extract with AI" on region or page, text or HTML, NL prompt -> column.
- MCP server (8.1): control WebHarvy from Claude Desktop.
- Export: XLSX (default), CSV, TSV, XML, JSON; MySQL, MSSQL, Oracle, PostgreSQL;
  modes append/overwrite/update (upsert keyed on first column).
- Images: named from URL or column, per-column folders, WebP.
- Scheduler: writes Windows Task Scheduler entries (5 min .. monthly).
- CLI: `webharvy <config.xml> <pages|-1> <exportfile> [append|overwrite|update]`
  and a db variant.

## Config file
One XML per site: StartURL (+headers, postdata), URL list, keywords, category links,
fields each with type/name/selector/pattern/regex/heading, MinerOptions, MineParams.
20+ field types (Text, Image, URL, HTML, Link_Follow, Link_NextPage, Auto_Scroll,
Input_Text, Select, Custom...). No schema published.

## Gaps (what it cannot do)
Platform: Windows only; no cloud; no web UI; no team/collab/versioning; no REST API;
no webhooks; no Sheets/Airtable/Zapier.
Anti-bot: no CAPTCHA solving; BYO proxies; no fingerprint randomization beyond UA.
Scale: one browser per page sequence; slow (reviews: 15 pages = 6-8h; 20k rows = 48h);
load-more/scroll/JS pagination cannot "mine all pages" (must guess count).
Data: flat rows only (no nested JSON); exact-match dedup only; transforms = regex,
substring, following text, LLM; no conditionals/loops; misalignment on empty fields;
upsert only on first column.
UX: learning curve past simple lists; dated ribbon; knob-tuning trial-and-error;
display scaling must be 100%; scheduled runs omit pages sometimes.
AI: per-field only; no auto-config from a prompt; cloud LLM sends page content out.
License: 1 yr updates; 3 PCs max non-simultaneous; trial 15 days / 2 pages.
