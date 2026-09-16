# Competitor Landscape (research, Sept 2026)

## Key takeaways for Scrappia

Durable user wishlist across all tools (G2 / Capterra / Trustpilot / Reddit):
1. Self-healing selectors + breakage alerts with one-click retrain (top complaint everywhere).
2. Predictable pricing (WebHarvy's one-time license is praised; credits are hated).
3. Built-in unblocking / CAPTCHA (not a separate proxy bill).
4. Optional cloud/server scheduling; Mac/Linux/web access (WebHarvy is Windows-only, no cloud).
5. Natural-language -> typed schema extraction, with local-LLM privacy option.
6. Speed: HTTP-first fetching, parallelism (WebHarvy: 20k rows took 48h; ParseHub eats CPU/RAM).
7. Sheets / Airtable / Notion / Zapier / webhook delivery; turn any scrape into a REST API.
8. Data quality: validation rules, dedup, preview before running.

## Top ~27 distinctive features (who has them)

1. NL -> typed schema extraction (Firecrawl, Kadoa, ScrapeGraphAI, Thunderbit, Simplescraper, Zyte, Stagehand)
2. Self-healing on layout change, vision-grounded (Kadoa, Import.io, Browse.ai)
3. One-click auto-detect lists/tables + cycle candidates (Instant Data Scraper, Octoparse, Thunderbit)
4. Unblocking as a single switch: proxies + fingerprints + retries (Bright Data, Zyte, Scrapeless, Crawlee)
5. Integrated CAPTCHA solving (Bright Data, Scrapeless, Zyte, Octoparse, Axiom via 2Captcha)
6. Change monitoring with diff alerts (Browse.ai, Kadoa, Hexomatic, webscraper.io)
7. Cloud execution + scheduling + parallel runs (Octoparse, Browse.ai, Apify, Axiom)
8. One-click subpage/detail enrichment (Thunderbit, Bardeen, Simplescraper, Octoparse)
9. Scrape -> REST API endpoint + completion webhooks (Simplescraper, Browse.ai, Apify)
10. Native Sheets / Airtable / Notion sync (Browse.ai, Thunderbit, Bardeen)
11. Zapier / Make / n8n connectors (Browse.ai, Axiom, Hexomatic, Apify)
12. Template / recipe marketplace (Apify Store, Data Miner 50k recipes auto-filtered by site)
13. MCP server / AI-agent access (Firecrawl, Apify, WebHarvy has this)
14. LLM-ready Markdown output + crawl/map whole site (Firecrawl)
15. In-pipeline AI transforms: summarize, classify, translate, label (Thunderbit, Hexomatic)
16. Data-quality validation rules + alerting (Kadoa, webscraper.io, Import.io)
17. Multi-step browser workflows / RPA (Axiom, Bardeen, Browse.ai, WebHarvy)
18. Login incl. 2FA/TOTP + persistent profiles (Axiom, Scrapeless, Crawlee)
19. Warehouse delivery: S3, GCS, Snowflake, BigQuery, SFTP, SQL DB (Kadoa, Bright Data, WebHarvy SQL)
20. Pay per success / transparent per-row pricing (Zyte, Scrapeless)
21. Local-first / self-host / local LLM (WebHarvy, Firecrawl, ScrapeGraphAI + Ollama)
22. Geo-targeted scraping (Bright Data, Browse.ai, Zyte)
23. Agentic "scrape with a goal" (Bardeen, Stagehand, Browser Use)
24. Team workspaces, versioning, audit logs, SSO (Apify, Kadoa, Import.io)
25. Regex / JS post-processing per column (webscraper.io, WebHarvy, ParseHub)
26. Live view of running browser + screenshots (Scrapeless, Browserbase, WebHarvy)
27. PDF / image / email / phone extractors (Thunderbit, ScrapeGraphAI, Hexomatic)

## Feature matrix

Legend: Y native, P partial, N no.

| Tool | Visual | Cloud | Local | Sched | API | Webhooks | Integrations | Proxy | CAPTCHA | JS | Scroll | Login | AI | AutoDetect | Monitor | Team | Templates | OSS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WebHarvy | Y | N | Y (Win) | Y | N | N | N | P | N | Y | Y | Y | Y (BYO key, MCP) | Y | N | N | N | N |
| Octoparse | Y | Y | Y | Y | Y | Y | Zapier, Sheets | Y | Y | Y | Y | Y | P | Y | N | P | Y | N |
| ParseHub | Y | Y | Y | Y | Y | Y | Dropbox/S3 | Y | N | Y | Y | Y | N | N | N | P | P | N |
| Browse.ai | Y | Y | N | Y | Y | Y | 7k apps | Y | Y | Y | Y | Y | P | Y | Y | Y | Y | N |
| Apify | P | Y | P | Y | Y | Y | Many | Y | P | Y | Y | Y | P | N | P | Y | Y | Y (Crawlee) |
| Bright Data | P | Y | N | Y | Y | Y | Warehouses | Y | Y | Y | Y | Y | P | N | P | Y | Y | N |
| Firecrawl | N | Y | Y | N | Y | Y | LLM frameworks | Y | P | Y | P | P | Y | N | N | Y | N | Y |
| Import.io | Y | Y | N | Y | Y | Y | BI | Y | Y | Y | Y | Y | Y | Y | Y | Y | P | N |
| webscraper.io | Y | Y | Y (ext) | Y | Y | Y | Sheets, S3 | Y | N | Y | Y | Y | P | N | Y | P | P | P |
| Instant Data Scraper | Y | N | Y | N | N | N | N | N | N | Y | Y | Y | P | Y | N | N | N | N |
| Simplescraper | Y | Y | Y | Y | Y | Y | Zapier, Sheets | Y | P | Y | Y | Y | Y | Y | N | P | P | N |
| Bardeen | Y | Y | Y | Y | P | P | 100+ | N | N | Y | Y | Y | Y | Y | P | Y | Y | N |
| Axiom.ai | Y | Y | Y | Y | Y | Y | Zapier, Sheets | N | P | Y | Y | Y (TOTP) | P | Y | N | P | Y | N |
| Hexomatic | Y | Y | N | Y | Y | Y | Zapier, Slack | Y | Y | Y | Y | P | Y | Y | Y | P | Y | N |
| Data Miner | Y | N | Y | N | N | N | Sheets | N | N | Y | P | Y | N | Y | N | N | Y (50k) | N |
| Zyte | N | Y | Y | Y | Y | P | GitHub | Y | Y | Y | Y | Y | Y | Y | N | Y | N | Y (Scrapy) |
| Crawlee | N | P | Y | N | - | - | - | Y | N | Y | DIY | Y | P | N | N | Git | N | Y |
| Kadoa | Y | Y | N | Y | Y | Y | Warehouses, MCP | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | N |
| Thunderbit | Y | Y | Y | Y | N | N | Sheets, Notion | P | N | Y | Y | Y | Y | Y | N | N | Y | N |
| Scrapeless | N | Y | N | N | Y | P | n8n, Make, MCP | Y | Y | Y | Y | Y | P | N | N | P | P | P |
| ScrapeGraphAI | N | Y | Y | N | Y | N | LangChain, MCP | P | N | Y | P | P | Y | N | N | N | N | Y |

## Common complaints
- Scrapers break on layout change (Browse.ai, webscraper.io, Octoparse, Apify, Data Miner).
- Opaque credit pricing (Firecrawl, Browse.ai, Thunderbit, Apify).
- Blocked / CAPTCHA (Octoparse cloud, webscraper.io, Browse.ai).
- Slow / resource hogs (ParseHub, WebHarvy 48h for 20k rows, Octoparse crashes).
- Learning curve for non-trivial workflows (Octoparse, webscraper.io, Apify, Zyte).
- Billing/support conduct (Octoparse auto-renew, Bright Data KYC).
- Data quality: infinite scroll misses items, duplicates, garbage rows.

Sources: vendor sites, G2, Capterra, Trustpilot, Chrome Web Store (see original research transcript).
