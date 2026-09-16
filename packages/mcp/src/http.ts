import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ScrappiaApp } from '@scrappia/core';
import { createMcpServer, type McpServerOptions } from './server.js';

export interface HttpOptions extends McpServerOptions {
  port: number;
  host?: string;
  /** Bearer token required on every request (SCRAPPIA_MCP_TOKEN). Unset = no auth (bind to localhost!). */
  token?: string;
  /** URL path, default /mcp (the root path is accepted too). */
  path?: string;
}

/**
 * Serve the MCP server over Streamable HTTP in stateless mode: every request gets a fresh
 * McpServer + transport bound to the shared ScrappiaApp, so there is no session bookkeeping
 * and any number of agents can connect concurrently.
 */
export function startHttp(app: ScrappiaApp, opts: HttpOptions): Promise<Server> {
  const path = opts.path ?? '/mcp';
  const host = opts.host ?? '127.0.0.1';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, activeRuns: app.activeRuns().length })); return; }
    if (url.pathname !== path && url.pathname !== '/') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found; MCP endpoint is ' + path); return; }
    if (opts.token) {
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!given || !safeEqual(given, opts.token)) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
    }
    const mcp = createMcpServer(app, opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => { }); mcp.close().catch(() => { }); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      app.log.error('mcp http request failed', { error: (e as Error).message });
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })); }
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
