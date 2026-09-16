# Scrappia guides

Start here. Each guide is written for people who have never used a scraper or a terminal before.
Technical details are kept to the end of each page.

| Guide | Read it when you want to... |
|---|---|
| [Getting started](getting-started.md) | Install Scrappia on your own computer and scrape your first page in 10 minutes |
| [User guide (desktop app)](user-guide.md) | Build scrapers by clicking: lists, detail pages, next pages, logins, keywords, exports, schedules, alerts, AI |
| [Hosting guide](hosting-guide.md) | Run Scrappia on a server so it works 24/7, with Docker or without, with HTTPS |
| [Admin guide](admin-guide.md) | Manage API keys, secrets, AI providers, proxies, CAPTCHA services, backups, updates and logs |
| [Command line guide](cli-guide.md) | Run and schedule scrapers from a terminal or a script |
| [API guide](api-guide.md) | Connect Scrappia to other software: Zapier, Make, n8n, Google Sheets, your own code |
| [AI agents (MCP) guide](mcp-guide.md) | Let Claude Desktop or Claude Code build and run scrapers for you |
| [Troubleshooting and FAQ](troubleshooting.md) | Something is not working |

If you only read one page, read [Getting started](getting-started.md).

## Words used in these guides

- **Recipe**: the saved instructions for one scraper (which site, which fields, how to go to the
  next page, where to export). Recipes are plain JSON files you can share.
- **Template**: one kind of page inside a recipe, for example "listing page" and "product page".
- **Field**: one column of your result, for example "price".
- **Run**: one execution of a recipe. Every run keeps its own rows, log and statistics.
- **Sink**: an export destination such as an Excel file, Google Sheet or database.
- **Recorder**: the desktop screen where you click on a web page to build a recipe.
- **Selector**: the address of an element on a page. Scrappia generates these for you.
