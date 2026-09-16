import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScrappiaApp } from '@scrappia/core';
import { registerTools, type ToolOptions } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export const MCP_SERVER_NAME = 'scrappia';
export const MCP_SERVER_VERSION = '0.1.0';

export interface McpServerOptions extends ToolOptions {
  name?: string;
  version?: string;
}

export const INSTRUCTIONS = `Scrappia is a web scraper. Recipes (JSON) describe what to extract: an entry URL, templates with a list selector + fields (each field has ranked selector candidates), pagination, follow links, transforms and sinks.
Typical workflow: fetch_page_markdown / fetch_page_html to inspect a page -> draft a recipe (get_example for a template) -> preview_extract until every field reports "ok" -> save_recipe -> run_recipe (use maxRequests for trials) -> get_rows / export_run. scrape_page is a one-call shortcut for a single page. Use the build_scraper prompt for the guided version.`;

/** Create an MCP server exposing the given ScrappiaApp. Connect it to any transport (stdio, in-memory, HTTP). */
export function createMcpServer(app: ScrappiaApp, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: opts.name ?? MCP_SERVER_NAME, version: opts.version ?? MCP_SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, app, opts);
  registerResources(server, app);
  registerPrompts(server);
  return server;
}
