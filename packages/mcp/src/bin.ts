#!/usr/bin/env node
/**
 * scrappia-mcp: run the Scrappia MCP server over stdio (default) or Streamable HTTP (--http <port>).
 * Nothing but MCP traffic may touch stdout in stdio mode, so all logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ScrappiaApp, Logger, type LogLevel } from '@scrappia/core';
import { createMcpServer } from './server.js';
import { startHttp } from './http.js';

function usage(): never {
  process.stderr.write(`scrappia-mcp [--http <port>] [--host <addr>] [--path </mcp>] [--home <dir>] [--log-level <level>]

  (default)          MCP over stdio, for Claude Desktop / Claude Code config "command"
  --http <port>      MCP over Streamable HTTP at http://<host>:<port>/mcp (stateless)
  --host <addr>      bind address for --http (default 127.0.0.1)
  --home <dir>       data directory (default $SCRAPPIA_HOME or ~/.scrappia)
  --log-level <lvl>  debug|info|warn|error (default warn), always written to stderr

Environment: SCRAPPIA_MCP_TOKEN  bearer token required by the HTTP transport when set.
`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opt: { http?: number; host?: string; path?: string; home?: string; logLevel?: string } = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { const v = args[++i]; if (v == null) usage(); return v; };
  if (a === '--http') { opt.http = Number(next()); if (!Number.isInteger(opt.http) || opt.http < 0) usage(); }
  else if (a === '--host') opt.host = next();
  else if (a === '--path') opt.path = next();
  else if (a === '--home') opt.home = next();
  else if (a === '--log-level') opt.logLevel = next();
  else if (a === '-h' || a === '--help') usage();
  else { process.stderr.write(`unknown argument ${a}\n`); usage(); }
}

const logger = new Logger((opt.logLevel as LogLevel) || (process.env.SCRAPPIA_LOG_LEVEL as LogLevel) || 'warn');
logger.on((e) => process.stderr.write(`[scrappia-mcp] ${e.level.toUpperCase()} ${e.scope ? `(${e.scope}) ` : ''}${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}\n`));
const app = new ScrappiaApp({ dataDir: opt.home ?? process.env.SCRAPPIA_HOME, logger });

let closing = false;
async function shutdown(code = 0) {
  if (closing) return; closing = true;
  for (const a of app.activeRuns()) a.runner.cancel();
  await Promise.allSettled(app.activeRuns().map((a) => a.promise));
  app.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

if (opt.http != null) {
  const token = process.env.SCRAPPIA_MCP_TOKEN || undefined;
  const server = await startHttp(app, { port: opt.http, host: opt.host, path: opt.path, token });
  const addr = server.address() as { address: string; port: number };
  process.stderr.write(`scrappia-mcp listening on http://${addr.address}:${addr.port}${opt.path ?? '/mcp'} (${token ? 'bearer token required' : 'no auth'}; data dir ${app.dataDir})\n`);
  if (!token && opt.host && opt.host !== '127.0.0.1' && opt.host !== 'localhost') process.stderr.write('warning: HTTP transport bound to a non-loopback address without SCRAPPIA_MCP_TOKEN\n');
} else {
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown(0);
  await server.connect(transport);
  process.stderr.write(`scrappia-mcp ready on stdio (data dir ${app.dataDir})\n`);
}
