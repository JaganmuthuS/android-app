// A stand-in for Ollama's HTTP API, so end-to-end tests run without a real model.
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface FakeOllama { url: string; installed: string[]; chats: { think: boolean; keepAlive?: string; messages: number }[]; close(): Promise<void> }

const PLAN = {
  kind: 'plan', title: 'Board summary', scope: 'Finance (read) · Board (write)',
  steps: [
    { text: 'Collect the September figures', gated: false },
    { text: 'Draft a three-line summary', gated: false },
    { text: 'Email the summary to the board', gated: true },
  ],
};

const FILE_PLAN = {
  kind: 'plan', title: 'Revenue update', scope: 'Finance (read) · Board (write)',
  steps: [
    { text: 'Read Finance/Sept-close.csv', gated: false },
    { text: 'Update the revenue sentence in Board/Q3-Board.md', gated: false },
    { text: 'Email the board report to the board', gated: true },
  ],
};

export async function startFakeOllama(opts: { installed?: string[]; chunkMs?: number } = {}): Promise<FakeOllama> {
  const state = { installed: opts.installed ?? [], chats: [] as FakeOllama['chats'] };
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

    // A tiny stand-in for the web: a DuckDuckGo results page and one article.
    const host = `http://${req.headers.host}`;
    if (req.url?.startsWith('/ddg/html/')) {
      res.setHeader('content-type', 'text/html');
      return res.end(`<html><body><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`${host}/page/rates`)}&amp;rut=1">Key ECB interest rates</a>
        <a class="result__snippet">The deposit facility rate is 2.00%.</a></div></body></html>`);
    }
    if (req.url === '/page/rates') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><head><title>Key ECB interest rates</title><meta property="article:published_time" content="2026-09-11"></head><body><main><h1>Key ECB interest rates</h1><p>The deposit facility rate is 2.00% from 11 June 2026.</p></main></body></html>');
    }
    if (req.url === '/api/version') return json({ version: '0.12.0-test' });
    if (req.url === '/api/show') return json({ capabilities: ['completion', 'tools'] });
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
      const { model, messages, tools } = JSON.parse(body) as { model: string; messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
      const canPlan = !!tools?.some((t) => t.function.name === 'propose_plan');
      if (!state.installed.includes(model)) { res.statusCode = 404; return json({ error: `model "${model}" not found` }); }
      state.chats.push({ think: !!(JSON.parse(body) as { think?: boolean }).think, keepAlive: (JSON.parse(body) as { keep_alive?: string }).keep_alive, messages: messages.length });
      if (!messages.length) return json({ model, done: true, done_reason: 'load' }); // loading the model ahead of time
      const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
      const last = messages.at(-1)!;
      const request = users.filter((u) => !u.startsWith('Decide how') && !u.startsWith('Carry out') && !u.startsWith('All steps')).at(-1) ?? '';
      const call = (name: string, args: object) => stream([{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }, { done: true }]);
      const say = (text: string) => stream([...(text.match(/\S+\s*/g) ?? [text]).map((w) => ({ message: { role: 'assistant', content: w }, done: false })), { done: true }]);

      if (tools && /Use the list_dir tool/.test(last.content)) return call('list_dir', { path: '.' });
      const thinks = !!(JSON.parse(body) as { think?: boolean }).think;
      if (/Q3\.docx|memo\.docx/i.test(request)) {
        const done = messages.filter((m) => m.role === 'tool');
        const thought = (t: string) => ({ message: { role: 'assistant', content: '', thinking: t }, done: false });
        const callWith = (pre: object[], name: string, args: object) => stream([...pre, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }, { done: true }]);
        const why = thinks ? [thought('Paragraph 2 holds the revenue sentence. '), thought('I will rewrite it with the September figure.')] : [];
        if (/memo\.docx/i.test(request)) {
          if (!done.length) return callWith(why, 'write_file', { path: 'Board/Memo.docx', content: '# Board memo\nRevenue rose **3.1%**.\n- Costs flat', reason: 'You asked for a memo' });
          return say('Board/Memo.docx is ready for your review.');
        }
        if (!done.length) return callWith(why, 'read_file', { path: 'Board/Q3.docx' });
        if (done.length === 1) return call('docx_edit_paragraph', { path: 'Board/Q3.docx', paragraph: 2, content: 'Net revenue was €4.82M, 3.1% above the June forecast.', reason: 'Sept close, row 2' });
        return say('Paragraph 2 now has the September figures, as a tracked change.');
      }
      if (/deposit rate/i.test(request)) {
        const done = messages.filter((m) => m.role === 'tool');
        if (done.length === 0) return call('web_search', { query: 'ECB deposit facility rate' });
        if (done.length === 1) return call('fetch_url', { url: done[0].content.match(/http:\/\/\S+\/page\/rates/)![0] });
        return say('The ECB deposit facility rate is 2.00% [1], unchanged since June.');
      }
      if (/workbook/i.test(request)) {
        const done = messages.filter((m) => m.role === 'tool').length;
        if (done === 0) return call('xlsx_write_cells', { path: 'Board/close.xlsx', sheet: 'Summary', cells: { B2: 4.82 }, reason: 'September close' });
        if (done === 1) return call('replace_text', { path: 'Board/Q3.docx', find: 'slightly ahead of', replace: '3.1% above', reason: 'Exact figures' });
        if (done === 2) return call('read_file', { path: 'Board/memo.pdf' });
        return say('Both files are updated and waiting for your review.');
      }
      if (canPlan && last.role === 'user' && !/diary|folder/i.test(request)) {
        const plan = /revenue/i.test(request) ? FILE_PLAN : /report|summary|board/i.test(request) ? PLAN : null;
        if (plan) return call('propose_plan', { title: plan.title, scope: plan.scope, steps: plan.steps.map((st) => st.text) });
      }
      if (last.role === 'tool') {
        if (last.content.startsWith('ERROR')) return say('I could not open that file: Jarvis has no access to it.');
        return say(`Done. ${last.content.slice(0, 60)}`);
      }
      if (tools && last.content.startsWith('Carry out step 1') && /revenue/i.test(request)) return call('read_file', { path: 'Finance/Sept-close.csv' });
      if (tools && last.content.startsWith('Carry out step 2') && /revenue/i.test(request)) {
        return call('replace_text', { path: 'Board/Q3-Board.md', find: '€4.61M, slightly ahead of', replace: '€4.82M, 3.1% above', reason: 'Source: Finance/Sept-close.csv, row 2' });
      }
      if (tools && /diary/i.test(request) && last.role === 'user' && !last.content.startsWith('All steps')) return call('read_file', { path: 'Personal/diary.md' });
      if (tools && /folder/i.test(request) && last.role === 'user') {
        const m = request.match(/called (\S+)/);
        return call('create_folder', { path: m ? m[1] : 'Notes/2026', reason: 'You asked for it' });
      }
      if (last.content.startsWith('Carry out step')) return say(`Finished: ${last.content.split('"')[1]}.`);
      if (last.content.startsWith('All steps are finished')) return say('The summary is drafted and the email step was handled. Should I file the draft in Board?');
      return say('Paris is the capital of France.');
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    installed: state.installed,
    chats: state.chats,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
