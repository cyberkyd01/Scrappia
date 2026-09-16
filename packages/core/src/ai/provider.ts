/**
 * LLM providers behind one interface: Anthropic (native structured outputs) and any
 * OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, vLLM, OpenRouter...).
 */
import { fetch } from 'undici';

export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LlmCompleteOptions {
  messages: LlmMessage[];
  /** JSON schema to enforce; result is parsed JSON when set. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface LlmResult { text: string; json?: unknown; inputTokens?: number; outputTokens?: number; model: string }

export interface LlmProvider {
  readonly name: string;
  readonly kind: 'anthropic' | 'openai-compatible';
  complete(opts: LlmCompleteOptions): Promise<LlmResult>;
  test(): Promise<{ ok: boolean; error?: string; models?: string[] }>;
}

export interface LlmProviderConfig {
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  /** Secret ref or literal key. Ollama/LM Studio need none. */
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** Anthropic effort hint for extraction workers. */
  effort?: 'low' | 'medium' | 'high';
}

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  anthropicFast: 'claude-haiku-4-5',
  anthropicBest: 'claude-opus-5',
  ollama: 'llama3.1',
  openai: 'gpt-4o-mini',
};

export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;
  constructor(public readonly name: string, private apiKey: string, private model: string, private effort: 'low' | 'medium' | 'high' = 'low', private baseUrl?: string) {}

  private async client() {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: this.apiKey, baseURL: this.baseUrl });
  }

  async complete(opts: LlmCompleteOptions): Promise<LlmResult> {
    const client = await this.client();
    const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = opts.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const model = opts.model ?? this.model;
    const params: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages,
      temperature: opts.temperature ?? 0,
    };
    if (opts.schema) {
      params.output_config = { format: { type: 'json_schema', schema: strictSchema(opts.schema) }, effort: this.effort };
    } else {
      params.output_config = { effort: this.effort };
    }
    // The SDK types lag the API for output_config on some versions; call through the raw method.
    let res: { content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number }; model: string };
    try {
      res = (await (client.messages.create as (p: unknown, o?: unknown) => Promise<typeof res>)(params, { signal: opts.signal })) as typeof res;
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/output_config|effort|json_schema/i.test(msg)) {
        // older API/model without structured outputs: fall back to prompt-based JSON
        delete params.output_config;
        if (opts.schema) params.system = `${system}\n\nRespond with ONLY a JSON document matching this JSON schema, no prose:\n${JSON.stringify(opts.schema)}`;
        res = (await (client.messages.create as (p: unknown, o?: unknown) => Promise<typeof res>)(params, { signal: opts.signal })) as typeof res;
      } else throw e;
    }
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    return { text, json: opts.schema ? parseJsonLoose(text) : undefined, inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens, model: res.model };
  }

  async test() {
    try {
      const r = await this.complete({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 5 });
      return { ok: /ok/i.test(r.text) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly kind = 'openai-compatible' as const;
  constructor(public readonly name: string, private baseUrl: string, private model: string, private apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    if (!/\/v1$/.test(this.baseUrl) && !/\/api$/.test(this.baseUrl)) this.baseUrl += '/v1';
  }

  async complete(opts: LlmCompleteOptions): Promise<LlmResult> {
    const model = opts.model ?? this.model;
    const messages = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    if (opts.schema) {
      const sys = messages.find((m) => m.role === 'system');
      const hint = `Respond with ONLY a JSON document matching this JSON schema, no prose, no code fences:\n${JSON.stringify(opts.schema)}`;
      if (sys) sys.content += `\n\n${hint}`; else messages.unshift({ role: 'system', content: hint });
    }
    const body: Record<string, unknown> = { model, messages, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 4096 };
    if (opts.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: opts.schema, strict: false } };
    const doFetch = (b: Record<string, unknown>) => fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }, body: JSON.stringify(b), signal: opts.signal });
    let res = await doFetch(body);
    if (!res.ok && opts.schema) {
      // servers that reject response_format (older Ollama etc.) -> plain json_object or nothing
      const b2 = { ...body, response_format: { type: 'json_object' } };
      res = await doFetch(b2);
      if (!res.ok) { delete (body as { response_format?: unknown }).response_format; res = await doFetch(body); }
    }
    if (!res.ok) throw new Error(`LLM ${this.name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number }; model?: string };
    const text = j.choices?.[0]?.message?.content ?? '';
    return { text, json: opts.schema ? parseJsonLoose(text) : undefined, inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens, model: j.model ?? model };
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {} });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const j = (await res.json()) as { data?: Array<{ id: string }> };
      return { ok: true, models: j.data?.map((m) => m.id) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
}

export function createProvider(cfg: LlmProviderConfig, resolveSecret: (ref: string) => string | undefined = () => undefined): LlmProvider {
  const key = cfg.apiKey ? resolveSecret(cfg.apiKey) ?? cfg.apiKey : undefined;
  if (cfg.kind === 'anthropic') {
    const k = key ?? process.env.ANTHROPIC_API_KEY;
    if (!k) throw new Error(`Anthropic provider "${cfg.name}" has no API key`);
    return new AnthropicProvider(cfg.name, k, cfg.model || DEFAULT_MODELS.anthropic, cfg.effort ?? 'low', cfg.baseUrl);
  }
  return new OpenAICompatibleProvider(cfg.name, cfg.baseUrl ?? 'http://localhost:11434', cfg.model || DEFAULT_MODELS.ollama, key ?? process.env.OPENAI_API_KEY);
}

/** Anthropic structured outputs require additionalProperties:false on every object and no min/max keywords. */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== 'object') return s;
    const o = { ...(s as Record<string, unknown>) };
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'default', 'minItems', 'maxItems']) delete o[k];
    if (o.type === 'object') { o.additionalProperties = false; if (o.properties && !o.required) o.required = Object.keys(o.properties as object); }
    for (const k of Object.keys(o)) if (typeof o[k] === 'object') o[k] = walk(o[k]);
    return o;
  };
  return walk(schema) as Record<string, unknown>;
}

export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* continue */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* continue */ } }
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const endObj = t.lastIndexOf('}'); const endArr = t.lastIndexOf(']');
    const end = Math.max(endObj, endArr);
    if (end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* give up */ } }
  }
  return undefined;
}
