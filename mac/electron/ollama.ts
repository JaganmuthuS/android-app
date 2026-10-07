// Minimal client for a local Ollama server (https://ollama.com). Everything stays on this Mac.
import type { EngineStatus, PullProgress } from '../shared/types';

export interface ToolCall { function: { name: string; arguments: Record<string, unknown> } }
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_name?: string }
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: object } }

/** Ollama's default context is only a few thousand tokens; file contents need more room. */
export const CONTEXT_TOKENS = 16384;

export class OllamaError extends Error {}

const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');

export class Ollama {
  constructor(private baseUrl: () => string) {}

  private url(path: string) { return this.baseUrl().replace(/\/+$/, '') + path; }

  async status(model: string): Promise<EngineStatus> {
    try {
      const [v, t] = await Promise.all([
        fetch(this.url('/api/version'), { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ version?: string }>),
        fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ models?: { name: string; size: number; details?: { parameter_size?: string } }[] }>),
      ]);
      const models = (t.models ?? []).map((m) => ({ name: m.name, size: m.size, params: m.details?.parameter_size }));
      const want = model.includes(':') ? model : `${model}:latest`;
      return { reachable: true, version: v.version, models, modelInstalled: models.some((m) => m.name === want || m.name === model) };
    } catch (e) {
      return { reachable: false, models: [], modelInstalled: false, error: (e as Error).message };
    }
  }

  /** What the model can do, e.g. ["completion", "tools"]. Empty when Ollama is too old to say. */
  async capabilities(model: string): Promise<string[]> {
    try {
      const r = await fetch(this.url('/api/show'), { method: 'POST', body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
      const j = (await r.json()) as { capabilities?: string[] };
      return j.capabilities ?? [];
    } catch { return []; }
  }

  /** Download a model, reporting progress as it goes. */
  async pull(model: string, onProgress: (p: PullProgress) => void): Promise<void> {
    const res = await fetch(this.url('/api/pull'), { method: 'POST', body: JSON.stringify({ model, stream: true }) });
    if (!res.ok || !res.body) throw new OllamaError(`Download failed (${res.status}).`);
    await readLines(res.body, (line) => {
      const j = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
      if (j.error) throw new OllamaError(j.error);
      onProgress({ model, status: j.status ?? '', completed: j.completed, total: j.total, done: j.status === 'success' });
    });
  }

  /** Stream a chat reply. `onText` receives the whole visible text so far. */
  async chat(opts: { model: string; messages: ChatMessage[]; signal?: AbortSignal; onText?: (text: string) => void; format?: object; temperature?: number }): Promise<string> {
    return (await this.round(opts)).content;
  }

  /** One model turn, which may end in tool calls instead of (or as well as) text. */
  async round(opts: {
    model: string; messages: ChatMessage[]; signal?: AbortSignal; onText?: (text: string) => void;
    format?: object; temperature?: number; tools?: ToolSpec[];
  }): Promise<{ content: string; toolCalls: ToolCall[] }> {
    let res: Response;
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        signal: opts.signal,
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          stream: true,
          think: false,
          format: opts.format,
          tools: opts.tools,
          options: { temperature: opts.temperature ?? 0.4, num_ctx: CONTEXT_TOKENS },
        }),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new OllamaError('Jarvis cannot reach Ollama. Open the Ollama app, then try again.');
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      let msg = body;
      try { msg = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* plain text */ }
      if (res.status === 404) throw new OllamaError(`The model "${opts.model}" is not downloaded yet. Open Settings to download it.`);
      if (/does not support tools/i.test(msg)) throw new OllamaError(`The model "${opts.model}" can't use tools, so it can't work with files. Choose qwen3:8b or qwen3:4b in Settings.`);
      throw new OllamaError(`Ollama returned an error: ${msg || res.status}`);
    }
    let raw = '';
    const toolCalls: ToolCall[] = [];
    await readLines(res.body, (line) => {
      const j = JSON.parse(line) as { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string };
      if (j.error) throw new OllamaError(j.error);
      if (j.message?.tool_calls?.length) toolCalls.push(...j.message.tool_calls);
      raw += j.message?.content ?? '';
      if (j.message?.content) opts.onText?.(stripThinking(raw).trimStart());
    });
    return { content: stripThinking(raw).trim(), toolCalls };
  }
}

async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}
