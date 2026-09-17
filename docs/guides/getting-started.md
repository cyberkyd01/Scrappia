# Getting started

This page takes you from nothing to a working scraper on your own computer. It works on Windows,
macOS and Linux. Budget about 15 minutes, most of it waiting for downloads.

## 1. Install Node.js

Scrappia runs on Node.js, a free program from the makers of JavaScript.

1. Open https://nodejs.org in your browser.
2. Download the **LTS** version (22 or newer) and run the installer. Accept the defaults.
3. To check it worked, open a terminal:
   - Windows: press the Windows key, type `cmd`, press Enter.
   - macOS: open **Terminal** from Applications, Utilities.
   - Linux: open your terminal app.

   Type the line below and press Enter. You should see a version number starting with `v22` or higher.

   ```
   node --version
   ```

## 2. Get Scrappia

Option A, with Git (recommended so you can update later):

```
git clone https://github.com/cyberkyd01/Scrappia.git
cd Scrappia
```

Option B, without Git: on the GitHub page click the green **Code** button, then **Download ZIP**.
Unzip it, then in the terminal `cd` into the unzipped folder.

## 3. Install and build

Still in the terminal, inside the Scrappia folder, run these three lines one at a time. The first
one downloads about 400 MB of libraries, the second downloads the browser Scrappia uses for
scraping, the third compiles the project.

```
npm install
npx patchright install chromium
npm run build
```

If a line prints red text and stops, see [Troubleshooting](troubleshooting.md).

## 4. Open the desktop app

Double-click **Start Scrappia.cmd** in the Scrappia folder (Windows). The first time it also runs the
setup from step 3 if that has not been done. You can right-click the file and choose **Send to →
Desktop (create shortcut)** to get a Scrappia icon on your Desktop.

From a terminal on any system:

```
npx electron apps/desktop
```

A window titled **Scrappia** opens.

## 5. Your first scraper (2 minutes)

We will scrape a practice bookshop that exists for exactly this purpose.

1. In the app, click **Templates** and choose **Books to Scrape**. Click **Use**. This loads a
   ready-made recipe.
2. Click **Run**. The **Run monitor** screen opens and rows appear as they are scraped: title,
   price, rating, stock, URL, image, description.
3. When the status says **succeeded**, click **Open file** next to the export. An Excel file opens
   with the results.

You just ran a scraper that visits list pages, follows the "next" link, opens every book's detail
page and merges the description into each row.

## 6. Build one yourself (5 minutes)

1. Click **New recipe**. Enter `https://quotes.toscrape.com` and press **Open recorder**.
2. A second window opens with the site inside it. This is Scrappia's own browser. You can browse
   in it normally (log in, search, scroll) before you start clicking things to capture.
3. In the Scrappia window, click **Pick list**, then in the browser window click on any quote.
   Scrappia highlights all 10 quotes on the page and shows suggested fields: text, author, tags.
4. Tick the fields you want and click **Set as list**. The **Data preview** at the bottom now shows
   10 rows.
5. Click **Pick field**, then click the **Next →** button on the page. In the capture panel choose
   **Set as next page**.
6. Click **Save**, give it a name, then **Run**.

You now have your own recipe with pagination. The [User guide](user-guide.md) explains every
button in the recorder, how to open detail pages, handle "load more" buttons and infinite scroll,
type keywords into search boxes, log in, and export to Google Sheets, databases and more.

## What got installed where

- The program: the folder you unzipped or cloned.
- Your recipes, run results and browser profiles: a folder called `.scrappia` in your user
  directory (`C:\Users\<you>\.scrappia` on Windows, `~/.scrappia` elsewhere). The desktop app uses
  its own copy under your application data folder (`%APPDATA%\Scrappia\data` on Windows). Back this
  up if you care about your recipes, or export them as JSON from the app.

## Next steps

- Want it to run every hour even when your computer is off? See the [Hosting guide](hosting-guide.md).
- Want to send data to Zapier, Sheets or your own app? See the [API guide](api-guide.md).
- Want Claude to build scrapers for you? See the [MCP guide](mcp-guide.md).
