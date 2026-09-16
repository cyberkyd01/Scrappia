# Copilot guide: let the AI build the scraper with you

Copilot is a chat panel at the bottom of the recorder. You describe what you want in plain words and
it builds the recipe, checks it against the live page, and runs it. It can do the whole job from one
message, or work with you step by step: it turns on element picking, you click, it turns your clicks
into fields, and it asks what comes next.

## Before you start

Copilot needs an AI provider. Open **Settings → AI providers** and add one:

- **Anthropic** (recommended): paste your API key as a secret and choose a model such as
  `claude-sonnet-5`.
- **OpenAI or any compatible service**: base URL, model and key.
- **Local and private**: install Ollama (https://ollama.com), run `ollama pull llama3.1`, and add a
  provider with base URL `http://localhost:11434` and model `llama3.1`. Nothing leaves your computer.

Click **Test** to confirm the provider answers. The chat panel shows a setup hint until a provider
exists.

## Option 1: one message does everything

Open a site in the recorder, then type for example:

> Scrape all products with name, price, rating and the description from each product page, follow
> the next-page links, save to an Excel file, and run it.

Copilot will:

1. Look at the page and detect the repeating records.
2. Set the list and the fields, then run a preview and show you the record count and any empty fields.
3. Open one detail page, define the extra fields, and set the follow rule.
4. Set next-page pagination and check that the selector matches.
5. Add the export and the row key for de-duplication.
6. Run a short test (a few pages), report rows, drift and sample data.
7. Ask for your go-ahead, or start immediately if you already said "run it".

You see each step as a small grey chip in the chat ("set_list: 20 records", "test_run: 40 rows, 2
pages"). The template tree and the data preview update live, so you can inspect and correct anything
by hand at any time.

## Option 2: interactive, click by click

This is the flow for pages where you want to choose exactly what to capture.

1. You: **Let's start scraping** (there is a quick button for it).
2. Copilot: "Good. If you're ready, tell me and I'll enable the selectors so you can choose the
   structured elements we need."
3. You: **ready**. Copilot switches the browser window into picking mode and tells you what to click,
   for example "click one product card". A banner in the chat shows it is waiting.
4. You click in the browser window. Copilot receives the element and everything similar to it,
   proposes fields (title, price, url, image…), sets the list, previews it, and asks:
   "Do we need to click into each product for more details, go to the next page, or is this enough?"
5. You answer in words ("open each product and get the description", "next page", "scroll to load
   more", "search these keywords: …", "export to Google Sheets", "run every morning at 7"). When it needs
   another click from you, it turns picking back on and says what to click.
6. When you are satisfied: **Run it**. Copilot tests first, then starts the full run and switches the
   app to the Run monitor. When the run finishes it summarises the result in the chat.

Say **I'm done picking** at any time to stop picking mode, or press Escape in the browser window.

## The panel

- Open or hide it with the **Copilot** button in the recorder's top bar. **Ctrl+/** focuses the
  chat input. Drag the panel's top edge to resize it; the size and open state are remembered.
- The header has a provider selector (switching keeps the conversation), **Cancel** while it is
  working, and **Reset** to start a fresh conversation.
- Quick replies under the input: **Let's start scraping**, **I'm done picking**, **Detail pages**,
  **Next page**, **Run it**, **Save recipe**.
- Enter sends, Shift+Enter adds a line.
- When Copilot starts a run the app switches to the Run monitor; **← Back to recorder** returns
  with the conversation and the recipe intact, and Copilot posts a summary when the run finishes.

## What Copilot can change

Everything a recipe contains: start URLs and keyword lists, templates, lists and fields (types,
attributes, transforms), detail-page follows, pagination of every kind, pre-extraction actions (close
cookie banners, type into search boxes, wait for content), engine settings (browser or HTTP mode,
concurrency, delays, proxies, CAPTCHA provider, persistent login session), output settings (row keys,
validation, extra columns), exports of all types, monitoring and alert channels, schedules, and the AI
settings of the recipe itself. It also saves recipes to your library.

It cannot see or type secrets. When an export needs credentials it asks you to add the secret in
**Settings → Secrets** and tells you the name to use.

## Tips

- Be concrete about the columns you want and where they live ("the price on the listing, the
  description on the product page").
- If the detected list is wrong, say so ("that's the sidebar, I mean the product cards") or pick the
  right element yourself.
- Ask it to verify: "preview again", "test 5 pages", "show me a sample row".
- You can mix modes freely: let it do the listing automatically, then pick the "load more" button
  yourself.
- **Settings → AI providers → Copilot instructions** lets you give standing rules, for example
  "always add a timestamp column and export to CSV in D:\data".

## Using Copilot without the desktop app

The same copilot is available on the server (`POST /api/copilot/sessions`, then `.../turn`) and as
MCP tools (`copilot_start`, `copilot_turn`) for AI agents. Without a browser it cannot use element
picking, but it detects lists, builds, previews, tests and runs recipes from a description. See the
[API guide](api-guide.md) and the [MCP guide](mcp-guide.md).

## How it stays reliable

- Every change Copilot makes is validated against the recipe schema; invalid changes are rejected
  and it corrects itself.
- After setting fields it always runs a preview and reports empty fields instead of assuming.
- A full run only starts after a test run, and only when you asked for it or agreed.
- Each turn is limited to a handful of steps, so it cannot loop forever; it reports and asks instead.
- Works with any provider because every reply is structured JSON, including local models.
