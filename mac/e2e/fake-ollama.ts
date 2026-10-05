// A stand-in for Ollama's HTTP API, so end-to-end tests run without a real model.
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface FakeOllama { url: string; installed: string[]; close(): Promise<void> }

const PLAN = {
  kind: 'plan', title: 'Board summary', scope: 'Finance (read) · Board (write)',
  steps: [
    { text: 'Collect the September figures', gated: false },
    { text: 'Draft a three-line summary', gated: false },
    { text: 'Email the summary to the board', gated: true },
  ],
};

export async function startFakeOllama(opts: { installed?: string[]; chunkMs?: number } = {}): Promise<FakeOllama> {
  const state = { installed: opts.installed ?? [] };
  const chunkMs = opts.chunkMs ?? 15;

  const server = http.createServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
    const json = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const stream = async (lines: object[]) => {
      res.setHeader('content-type', 'application/x-ndjson');
      for (const l of lines) {
        if (res.destroyed) return;
        res.write(JSON.stringify(l) + '\n');
        await new Promise((r) => setTimeout(r, chunkMs));
      }
      res.end();
    };

    if (req.url === '/api/version') return json({ version: '0.12.0-test' });
    if (req.url === '/api/tags') return json({ models: state.installed.map((name) => ({ name, size: 5.2e9, details: { parameter_size: '8.2B' } })) });
    if (req.url === '/api/pull') {
      const { model } = JSON.parse(body);
      const total = 5_200_000_000;
      res.setHeader('content-type', 'application/x-ndjson');
      for (const l of [{ status: 'pulling manifest' }, ...[0.25, 0.5, 0.75, 1].map((f) => ({ status: 'pulling layer', total, completed: Math.round(total * f) }))]) {
        res.write(JSON.stringify(l) + '\n');
        await new Promise((r) => setTimeout(r, chunkMs));
      }
      state.installed.push(model); // like Ollama: installed before "success" is reported
      res.end(JSON.stringify({ status: 'success' }) + '\n');
      return;
    }
    if (req.url === '/api/chat') {
      const { model, messages, format } = JSON.parse(body);
      if (!state.installed.includes(model)) { res.statusCode = 404; return json({ error: `model "${model}" not found` }); }
      const last: string = messages.at(-1).content;
      const firstUser: string = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
      let text: string;
      if (format) text = JSON.stringify(/report|summary|board/i.test(messages.filter((m: { role: string }) => m.role === 'user').at(-2)?.content ?? firstUser) ? PLAN : { kind: 'answer', title: 'Quick question' });
      else if (last.startsWith('Carry out step')) text = `Finished: ${last.split('"')[1]}.`;
      else if (last.startsWith('All steps are finished')) text = 'The summary is drafted and the email step was handled. Should I file the draft in Board?';
      else text = 'Paris is the capital of France.';
      const words = text.match(/\S+\s*/g) ?? [text];
      return stream([...words.map((w) => ({ message: { role: 'assistant', content: w }, done: false })), { done: true }]);
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    installed: state.installed,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
