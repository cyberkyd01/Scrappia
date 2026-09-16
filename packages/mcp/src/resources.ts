import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScrappiaApp } from '@scrappia/core';

export const ROWS_RESOURCE_LIMIT = 500;

export function registerResources(server: McpServer, app: ScrappiaApp) {
  server.registerResource(
    'recipe',
    new ResourceTemplate('scrappia://recipes/{id}', {
      list: async () => ({ resources: app.listRecipes().map((r) => ({ uri: `scrappia://recipes/${r.id}`, name: r.name, description: `recipe ${r.id} v${r.version}`, mimeType: 'application/json' })) }),
      complete: { id: async (value) => app.listRecipes().map((r) => r.id).filter((id) => id.startsWith(value)) },
    }),
    { title: 'Saved recipe', description: 'Full JSON of a saved recipe (scrappia://recipes/{id}).', mimeType: 'application/json' },
    async (uri, { id }) => {
      const { recipe } = app.getRecipe(String(id));
      if (!recipe) throw new Error(`recipe "${id}" not found`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...recipe, id }, null, 2) }] };
    },
  );

  server.registerResource(
    'run-rows',
    new ResourceTemplate('scrappia://runs/{id}/rows', {
      list: async () => ({ resources: app.listRuns({ limit: 50 }).map((r) => ({ uri: `scrappia://runs/${r.id}/rows`, name: `${r.recipeName} (${r.status})`, description: `run ${r.id}, ${(r.stats as { rows?: number }).rows ?? 0} rows, ${new Date(r.startedAt).toISOString()}`, mimeType: 'application/x-ndjson' })) }),
    }),
    { title: 'Run rows', description: `Rows of a run as JSON Lines, first ${ROWS_RESOURCE_LIMIT} rows (scrappia://runs/{id}/rows). Use the get_rows tool to page further.`, mimeType: 'application/x-ndjson' },
    async (uri, { id }) => {
      const run = app.getRun(String(id));
      if (!run) throw new Error(`run "${id}" not found`);
      const rows = app.rows(run.id, undefined, { limit: ROWS_RESOURCE_LIMIT });
      return { contents: [{ uri: uri.href, mimeType: 'application/x-ndjson', text: rows.map((r) => JSON.stringify(r)).join('\n') }] };
    },
  );
}
