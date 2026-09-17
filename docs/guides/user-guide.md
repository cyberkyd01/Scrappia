# User guide: the desktop app

This guide explains everything you can do in the Scrappia desktop app. It assumes you followed
[Getting started](getting-started.md) and have the app open.

## The four screens

- **Home**: your saved recipes, the templates gallery, and the history of runs.
- **Recorder**: where you build or edit a recipe by clicking on a live web page.
- **Run monitor**: live progress of a run, the rows as they arrive, and the exported files.
- **Settings**: AI providers, the secrets vault, default folders, and browser installation.

## How scraping works in Scrappia

Think of a recipe as a set of instructions for a very patient assistant:

1. "Go to these start pages."
2. "On a page like this, every box that looks like this is one record. From each record, take
   these fields."
3. "Then click 'next' and repeat until there is no next page."
4. "For each record, also open its link and take these extra fields from the detail page."
5. "Put everything in this Excel file, and tell me if anything changed since last time."

Each "page like this" is a **template**. Most recipes have one or two templates: a listing and a
detail page.

## Prefer to talk instead of click?

The **Copilot** panel at the bottom of the recorder builds recipes from a sentence, or guides you
through picking elements step by step. It is the fastest way to get a working scraper. See the
[Copilot guide](copilot-guide.md). Everything below still applies: whatever Copilot builds appears
in the template tree and can be edited by hand.

## The recorder, button by button

When you open the recorder, two windows appear: the Scrappia window with the panels, and a
browser window showing the site. Everything you click in the browser window while a **Pick** mode is
on is captured instead of acting on the page.

Top bar:

- **URL box, Go, Back, Reload**: navigate the browser window. You can also just use the browser
  window directly (type in search boxes, log in, open menus) as long as no Pick mode is on.
- **Pick field**: the next click captures a single element (a title, a price, a link, an image).
- **Pick list**: the next click captures a repeating record (a product card, a table row, a search
  result). Scrappia finds all the similar records automatically.
- **Pick action**: the next click records an interaction (a button to click, a box to type in)
  that must happen before extraction, for example closing a cookie banner.
- **Off**: clicks act on the page normally again. Press Escape in the browser to do the same.
- **Auto-detect lists**: no clicking needed. Scrappia scans the page and shows the biggest
  repeating structures it can find. Use **try another list** if the first guess is wrong.
- **AI suggest**: asks your configured AI provider to propose fields for the selected list. Needs an
  AI provider in Settings.

Under the buttons, the **Runs start at** line shows the address a run will begin from. You can
browse freely in the browser window: as soon as you capture something, this follows the page you
captured from, and until then it warns you that it points somewhere else with a **Use this page**
button. If you set the start URLs yourself under Settings, the line reads **pinned** and Scrappia
leaves them alone.

Left panel, the **template tree**: every template, its list, its fields, its follow links, its
pagination and its actions. Click any item to edit it on the right.

Right panel, the **capture panel**: appears after a pick. It shows the element you clicked, the
selector candidates Scrappia generated (the top one is used; the others are fallbacks that make
your recipe survive site changes), and the choices below.

Bottom panel, the **data preview**: the rows the current template would extract from the page in
front of you. Each column shows how many rows were empty and which selector candidate matched, so
you can spot problems before running. **Test run (5 pages)** runs the whole recipe for a few pages
without exporting; its tab shows the status, page and row counts, and a short log of every page
fetched with its HTTP status, so a run that produces nothing tells you why (see
[Troubleshooting](troubleshooting.md)). Runs started from the desktop reuse the cookies and user
agent of the recorder browser, so anything you accepted or logged into while recording carries over.

## Capturing data

### A list of records

1. Click **Pick list**, then click anywhere inside one record on the page (for example on a product
   name).
2. The capture panel shows how many records were found (for example "20 records") and a list of
   suggested fields with sample values and coverage (how many records have that field).
3. Tick the fields you want, rename them if you like, and click **Set as list**.

If the wrong thing was detected (say, the whole page instead of the cards), click **try another
list** to cycle through the alternatives, or click **Capture more content** to move up to the parent
element, or **Off** and try clicking a different part of a record.

### A single field

Click **Pick field**, click the element, then in the capture panel:

- **Name**: the column name.
- **Type**: what to take from the element. `text` is the visible text. `href` is the link address.
  `src` is the image address. `attr` takes any attribute. `email` and `phone` pull those out of the
  text. `regex` extracts a pattern. `html` keeps the formatting. `image` downloads the picture to
  your disk. `screenshot` saves a picture of the element or page.
- **Scope**: "record" means "inside each record of the list" (the usual choice when a list exists);
  "page" means "once per page" (titles, breadcrumbs, a total count).
- **Transforms**: optional clean-up steps applied in order. Common ones:
  - `currency` turns "$1,299.99" into the number 1299.99.
  - `number`, `integer`, `boolean`, `date` convert types.
  - `regex` keeps only the part that matches a pattern.
  - `replace`, `split`, `trim`, `prefix`, `suffix`, `default` edit text.
  - `template` builds a value from other fields, for example `{{value}} ({{currency}})`.
  - `ai` asks the AI to rewrite, classify, translate or summarise the value.
- **Required**: flag rows where this field is empty.

Click **Capture as field**. If a list exists and the element is inside a record, the field is added
to the list; otherwise it becomes a page field.

### Text that follows a label

Detail pages often show "SKU: ABC-123" where the position changes from page to page. Pick the label
("SKU"), then in the field editor tick **following text**. Scrappia captures whatever comes after the
label.

### Tables

Pick the table and choose type `table`. The whole table becomes one value with one object per row,
using the header cells as keys. Exports flatten this into columns.

## Going to other pages

### Next page

Click **Pick field**, click the site's **Next** link or button, then choose **Set as next page**.
Scrappia follows it until there is no next page, or until no new rows appear. You can cap the number
of pages in the pagination editor.

### Numbered page links (1, 2, 3, ...)

Pick one of the numbered links and choose **Set as next page**, then change the pagination type to
**page links** in the editor. All numbered links are followed.

A "Next" button that is not a link (JavaScript pagination) works the same way: Scrappia notices
there is no link address and clicks the button in the page instead. Disabled buttons on the last
page end the run cleanly.

Tip for big shops (Amazon, eBay and similar): after **Set as next page**, open the pagination
entry in the template tree and check the selector. Prefer a short, stable class such as
`a.s-pagination-next` over a long label that contains a page number, so it matches on every page.

### "Load more" buttons

Pick the button and choose **Set as load more**. Scrappia scrolls to the bottom, presses the button
and waits for the new rows, repeating until the button disappears, becomes disabled, or nothing new
arrives. No page count needed. Because such buttons often have no stable selector, the button's own
label is stored as a fallback, so the recipe keeps working when the styling changes.

Pages whose content sits in an inner panel (the window itself does not scroll) are handled the same
way: Scrappia finds the element that actually scrolls.

### Infinite scroll

Choose **Infinite scroll** from the capture panel or the pagination editor. Scrappia scrolls until
nothing new loads.

### Page numbers in the URL

If pages look like `?page=1`, `?page=2`, set pagination type **URL pattern** with the template
`https://site.com/list?page={{page}}`. Scrappia stops at the first empty page.

## Detail pages ("follow this link")

To take extra fields from each record's own page:

1. With a list set, click **Pick field** and click the record's title link.
2. Choose **Follow this link → new template**. Scrappia adds the link as a field, creates a new
   template (for example "detail"), and navigates the browser to the first detail page.
3. Now pick fields on the detail page as usual (they are page fields of the new template).
4. Come back to the listing template in the tree when you want to continue there.

In the follow editor you choose how detail data is combined:

- **merge**: detail fields become extra columns on the listing row (most common).
- **nest**: detail data is stored as a sub-object inside the row (for JSON output).
- **separate**: detail rows go to their own dataset with a `_parentKey` column.

Follows can be chained (category page → listing → detail) and limited per page.

## Categories and sub-categories

Open the category page, click **Pick field**, click one category link and choose **Follow this
link → new template**, then set the target template to your listing template. All category links
matched by the selector are followed. Turn on **Add category path** in the recipe settings under
Output to get a column with the category each row came from.

## Keywords (search terms)

Open recipe settings, **General**, and add a keyword list, for example `q` with values
`laptop`, `phone`, `tablet`. Then use `{{q}}` anywhere a value should be substituted:

- in a start URL: `https://site.com/search?q={{q}}`
- in a "type" action: type `{{q}}` into the search box and submit.

With two lists Scrappia tries every combination by default; choose **row-wise** to pair them up
line by line. Turn on **Add keyword columns** under Output to see which keyword produced each row.

## Sites that need a login

1. In the recorder's browser window, log in normally. Scrappia's recorder keeps a persistent profile,
   so you stay logged in next time.
2. For runs that must log in by themselves (scheduled runs on a server), record the login as
   actions: **Pick action** on the username box → type action with your username; on the password
   box → type action (store the password as a secret and reference it); on the sign-in button →
   click action. Add a **wait for** action on something that only appears after login.
3. Under Engine settings, turn on **Persist session** so cookies are kept between runs.

## Actions before extraction

Use **Pick action** or **Add action** for anything that must happen on the page first: click
"Accept cookies", choose an option in a dropdown, hover a menu, scroll a panel, press a key, wait
for a spinner to disappear, run a small script. **Run this action in browser** tests it live.

## Recipe settings

Open with the gear button in the recorder.

- **General**: name, description, tags, start URLs (one per line), keywords.
- **Engine**: fetch mode (`auto` is HTTP first and switches to the browser only when needed; `browser`
  forces the real browser; `http` never uses a browser), headless, concurrency (how many pages at
  once), delay between requests, proxies (one per line), respect robots.txt, blocked resources,
  CAPTCHA provider, session persistence.
- **Output**: key fields (what makes a row unique, used to remove duplicates and for change
  detection; leave empty to keep every row, including ones whose values happen to be identical),
  validation rules (flag, drop or fail on bad values), extra columns (page URL, time,
  keyword, category), flatten nested data.
- **Outputs (sinks)**: where the data goes. Add as many as you want. Each has a mode: **overwrite**
  the file, **append** to it, or **upsert** (update rows with the same key, add new ones).
- **Monitor**: turn on to compare each run with the previous one and be alerted about added,
  removed or changed rows, layout drift, failures or empty results. Channels: desktop, webhook,
  Slack, Discord, Telegram, ntfy, email. Desktop alerts appear in the **Alerts** card on Home with
  an unread count, an "Open run" button and "Mark read".
- **Schedule**: a cron expression such as `0 */6 * * *` (every 6 hours) with a timezone. The
  preview shows the next run times. Scheduled runs happen while the desktop app is open; use the
  server for always-on scheduling.
- **AI**: which AI provider to use and whether self-healing is allowed.
- **JSON**: the raw recipe. You can paste a recipe from a colleague here.

## Exports

Available sinks: Excel (xlsx), CSV, TSV, JSON, JSON Lines, XML, Parquet, SQLite, PostgreSQL, MySQL,
MongoDB, Google Sheets, Airtable, Notion, S3-compatible storage, webhook, and the screen.

Files are written under your data folder unless you give a full path. Paths can contain
`{{date}}`, `{{datetime}}`, `{{recipe}}`, `{{run}}` and `{{dataset}}`.

Database and cloud sinks never store passwords in the recipe. Put the connection string or token
in **Settings → Secrets** and reference it by name. See the [Admin guide](admin-guide.md).

You can also export any past run from the Run monitor with **Export…**, choosing a new file and
format.

## Running

**Run** starts immediately. The Run monitor shows rows, pages, speed, pending and failed requests,
how many pages used the browser, drift events, and the log. You can **Pause**, **Resume** and
**Cancel**. A cancelled run can be **Resumed** later from Home; it continues where it stopped.

If a site shows a CAPTCHA and no solver service is configured, a banner asks you to solve it in the
browser window; the run continues afterwards.

## When a site changes its layout

Every field keeps several selector candidates. When the first stops matching, the next is tried and
a **drift** event is logged. When none match and an AI provider is configured, Scrappia asks the AI
for a replacement, verifies it on the page, uses it, and logs a **healed** event. Either way the Run
monitor and the monitor alerts tell you, and **Open recipe to fix** takes you straight to the field.

## AI features

Configure a provider in Settings (Anthropic, OpenAI, or a local model through Ollama or LM Studio
so nothing leaves your machine). Then:

- **AI suggest** in the recorder proposes fields for a list.
- Field type `ai` extracts something from the element's text with an instruction, for example
  "the delivery time in days as a number".
- Transform `ai` rewrites values ("translate to English", "classify as positive or negative").
- Self-healing repairs broken selectors.
- From the command line or API, **generate** builds a whole recipe from a URL and a sentence.

## Sharing recipes

**Export JSON** writes the recipe to a file; **Import JSON** on Home reads one. Recipes contain no
passwords or API keys, only the names of secrets, so they are safe to share. Recipes from the
webscraper.io browser extension can be imported through the CLI (`scrappia recipes add` accepts a
sitemap JSON) with best-effort conversion.
