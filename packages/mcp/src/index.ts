/**
 * @scrappia/mcp: Model Context Protocol server exposing Scrappia recipes, runs, datasets and
 * quick page-extraction tools to AI agents (Claude Desktop, Claude Code, any MCP client).
 */
export { createMcpServer, INSTRUCTIONS, MCP_SERVER_NAME, MCP_SERVER_VERSION, type McpServerOptions } from './server.js';
export { startHttp, type HttpOptions } from './http.js';
export { registerTools, fieldReport, type ToolOptions } from './tools.js';
export { registerResources, ROWS_RESOURCE_LIMIT } from './resources.js';
export { registerPrompts } from './prompts.js';
export { CopilotSessionStore, copilotStoreFor, startCopilotSession, AppCopilotHost, type CopilotStoreOptions, type CopilotSessionRecord } from './copilot.js';
