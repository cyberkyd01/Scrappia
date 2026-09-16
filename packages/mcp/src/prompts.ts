import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer) {
  server.registerPrompt('build_scraper', {
    title: 'Build a scraper for a site',
    description: 'Turn a URL and a goal into a saved, tested Scrappia recipe: fastest via the copilot (copilot_start + copilot_turn: describe what you want; it builds, verifies and runs), or step by step with fetch_page_markdown / preview_extract / save_recipe / run_recipe.',
    argsSchema: { url: z.string().describe('page to scrape (a listing page when there are many items)'), goal: z.string().optional().describe('what data to extract, e.g. "name, price and link of every product, all pages"') },
  }, ({ url, goal }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Build a Scrappia recipe for ${url}.
Goal: ${goal ?? 'extract the main repeating records on the page with their most useful fields'}.

Fastest path: the Scrappia Copilot. Call copilot_start({ url }) and then copilot_turn({ sessionId, message: "<goal>" }) describing what you want; the copilot inspects the page, builds the recipe, verifies it with previews and a test run, and runs it (check actions, recipe and runId in the result; answer its questions with further copilot_turn calls, then copilot_end). Use it when an AI provider is configured; fall back to the manual steps below when it is not or when you want full control.

Manual workflow, calling the Scrappia tools:

1. Inspect the page. Call fetch_page_markdown(url) to understand the content, then fetch_page_html(url, raw=true) when you need class names / attributes for selectors. If the Markdown shows almost no content the page is JavaScript-rendered: plan for engine.mode "browser".
2. Draft a recipe. Start from get_example("books-toscrape") as a template. Use one template (e.g. "listing") with list.selector = the repeating record element and fields with selectors RELATIVE to the record. Field types: text, href (absolute link), src (image), attr (+attr), html, email, regex (+pattern). Add transforms such as {"type":"currency"} or {"type":"integer"} for numbers. Give each field 2-3 selector candidates when possible (most specific first) so the recipe self-heals. Set output.keys to a unique field (usually the url) so rows dedupe and diffs work. If a "next" link exists add pagination {"type":"next","selector":[{"value":"..."}]}; for "load more" buttons or infinite scroll use type "loadMore" / "scroll" (browser mode).
3. Test quickly. Call preview_extract(recipe) and read the field report: every field should be "ok" with emptyValues 0. Fix selectors and repeat until it is right. If listMatched is 0, re-check the record selector with fetch_page_html; if the page needs JavaScript, set engine.mode "browser" and test with run_recipe(recipe, maxRequests: 1, dryRun: true) instead.
4. Detail pages (optional). When each record links to a page with more data, add a second template and list.follow = [{"field":"url","template":"detail","mode":"merge"}] and test with run_recipe(maxRequests: 3, dryRun: true).
5. Save: validate_recipe then save_recipe(recipe, id). Report the id.
6. Run: run_recipe(recipeId, maxRequests: 5) as a trial, check drift and rows, then run_recipe(recipeId) for the full crawl. Offer export_run for CSV/XLSX/JSONL and set_schedule for recurring monitoring.

Be conservative with crawl size: use maxRequests during testing and respect the site's terms.`,
      },
    }],
  }));
}
