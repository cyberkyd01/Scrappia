/**
 * A scripted OpenAI-compatible chat server for tests and demos. The `script` decides what the
 * "model" answers from the conversation so far. Exercises the real OpenAICompatibleProvider path.
 */
import { createServer, type Server } from 'node:http';

export interface MockChatRequest { model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown }
export type MockScript = (req: MockChatRequest, calls: number) => unknown | string;

export async function startMockLlm(script: MockScript, port = 0): Promise<{ url: string; close: () => Promise<void>; requests: MockChatRequest[] }> {
  const requests: MockChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url?.endsWith('/models')) return json(200, { data: [{ id: 'mock-1' }] });
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as MockChatRequest;
          requests.push(parsed);
          const out = script(parsed, requests.length);
          const content = typeof out === 'string' ? out : JSON.stringify(out);
          json(200, { id: 'mock', model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: Math.ceil(content.length / 4) } });
        } catch (e) { json(500, { error: (e as Error).message }); }
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { url, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/** Helper for scripts: the last user message text. */
export function lastUser(req: MockChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i].role === 'user') return req.messages[i].content;
  return '';
}

/** Helper: parse a named tool's JSON result from the MOST RECENT tool-results block only. */
export function toolResult(req: MockChatRequest, tool: string): Record<string, unknown> | undefined {
  const last = lastUser(req);
  if (!last.startsWith('[Tool results]')) return undefined;
  const line = last.split('\n').find((l) => l.startsWith(`${tool}: `));
  if (!line) return undefined;
  try { return JSON.parse(line.slice(tool.length + 2).replace(/…\(truncated\)$/, '')); } catch { return undefined; }
}

/** Build a copilot turn object. */
export const turn = (reply: string, calls: Array<[string, Record<string, unknown>]> = [], done = false) => ({ reply, calls: calls.map(([tool, args]) => ({ tool, args: JSON.stringify(args) })), done });
