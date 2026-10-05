// Minimal client for a local Ollama server (https://ollama.com). Everything stays on this Mac.
import type { EngineStatus, PullProgress } from '../shared/types';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

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
          options: { temperature: opts.temperature ?? 0.4 },
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
      throw new OllamaError(`Ollama returned an error: ${msg || res.status}`);
    }
    let raw = '';
    await readLines(res.body, (line) => {
      const j = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (j.error) throw new OllamaError(j.error);
      raw += j.message?.content ?? '';
      opts.onText?.(stripThinking(raw).trimStart());
    });
    return stripThinking(raw).trim();
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
