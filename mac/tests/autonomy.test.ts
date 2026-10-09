import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../electron/agent';
import { parseCsv, runAnalysis } from '../electron/compute';
import { Db } from '../electron/db';
import { OllamaError, type ChatMessage, type Ollama, type ToolCall } from '../electron/ollama';
import { isDeep, route } from '../electron/router';
import { Workspace } from '../electron/workspace';
import { DEFAULT_SETTINGS } from '../shared/types';

describe('model routing', () => {
  const s = { ...DEFAULT_SETTINGS, model: 'qwen3:8b', fastModel: 'qwen3:4b', thinking: 'auto' as const };
  it('sends routine requests to the fast model and deep work to the reasoning model', () => {
    expect(route(s, 'Hi, what time zone is Tokyo in?', null)).toEqual({ model: 'qwen3:4b', deep: false, think: false });
    expect(route(s, 'Create a folder called Invoices', null).model).toBe('qwen3:4b');
    for (const t of ['Research the best laptops for video editing', 'Write a Python script that renames photos', 'Rewrite paragraph 3 of Report.docx', 'What is the average revenue in sales.csv?', 'Compare these two contracts']) {
      expect(route(s, t, null)).toMatchObject({ model: 'qwen3:8b', deep: true, think: true });
    }
    expect(route(s, 'ok', 2).model).toBe('qwen3:8b'); // plan steps always reason
    expect(isDeep('x'.repeat(300), null)).toBe(true);
  });
  it('uses one model when no fast model is set or it is missing, and follows the thinking setting', () => {
    expect(route({ ...s, fastModel: '' }, 'Hi', null).model).toBe('qwen3:8b');
    expect(route(s, 'Hi', null, false).model).toBe('qwen3:8b');
    expect(route({ ...s, thinking: 'on' }, 'Hi', null).think).toBe(true);
    expect(route({ ...s, thinking: 'off' }, 'Research X', null).think).toBe(false);
  });
});

describe('analyze_data sandbox', () => {
  it('computes exactly with helpers', () => {
    const rows = parseCsv('Region;Revenue\nNorth;"1 200"\nSouth;800\nNorth;400\n');
    expect(rows).toEqual([{ Region: 'North', Revenue: 1200 }, { Region: 'South', Revenue: 800 }, { Region: 'North', Revenue: 400 }]);
    expect(runAnalysis('sum(rows.map(r => r.Revenue))', rows)).toBe('2400');
    expect(JSON.parse(runAnalysis('const g = groupBy(rows, "Region"); return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, sum(v.map(r => r.Revenue))]));', rows))).toEqual({ North: 1600, South: 800 });
    expect(runAnalysis('round((4.82 - 4.61) / 4.61 * 100, 2)')).toBe('4.56');
    expect(parseCsv('a,b\n"x, y",2\n')).toEqual([{ a: 'x, y', b: 2 }]);
  });
  it('cannot reach Node, files, the network or JARVIS, and stops runaway code', () => {
    for (const evil of [
      'process.exit(1)', 'require("fs")', 'this.constructor.constructor("return process")()',
      'rows.constructor.constructor("return process")()', '({}).constructor.constructor("return process")()',
      'eval("1+1")', 'new Function("return 1")()', 'fetch("https://example.com")', 'globalThis.process',
    ]) {
      let out = '';
      try { out = runAnalysis(evil, [{ a: 1 }]); } catch (e) { out = (e as Error).message; }
      expect(out).not.toMatch(/"?(pid|versions|argv)"?/);
      expect(typeof (globalThis as { process?: unknown }).process).toBe('object'); // still here
    }
    expect(() => runAnalysis('while (true) {}')).toThrow(/longer than 3 s/);
  });
});

/* ---------- agent: parallel reads, no repeated calls, fast-model fallback ---------- */

function workspaceSetup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auto-')));
  fs.mkdirSync(path.join(root, 'Notes'));
  fs.writeFileSync(path.join(root, 'Notes/a.md'), '# A\n');
  fs.writeFileSync(path.join(root, 'Notes/b.md'), '# B\n');
  fs.writeFileSync(path.join(root, 'Notes/sales.csv'), 'Region,Revenue\nNorth,1200\nSouth,800\n');
  const db = new Db(':memory:');
  const ws = new Workspace(db, fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-blobs-')), async (abs) => fs.rmSync(abs, { force: true }));
  ws.setRoot(root);
  db.setScope('Notes', 'edit_auto');
  return { root, db, ws };
}

type Round = { model: string; messages: ChatMessage[]; think?: boolean };

describe('agent speed and autonomy', () => {
  it('runs independent reads together, answers repeated calls from memory, applies and verifies edits', async () => {
    const { root, db, ws } = workspaceSetup();
    const calls: Round[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const call = (name: string, args: object): ToolCall => ({ function: { name, arguments: args as Record<string, unknown> } });
    const model = {
      async round(o: Round) {
        calls.push(o);
        const tools = o.messages.filter((m) => m.role === 'tool');
        if (tools.length === 0) return { content: '', thinking: '', toolCalls: [call('read_file', { path: 'Notes/a.md' }), call('read_file', { path: 'Notes/b.md' }), call('analyze_data', { path: 'Notes/sales.csv', code: 'sum(rows.map(r => r.Revenue))' })] };
        if (tools.length === 3) return { content: '', thinking: '', toolCalls: [call('read_file', { path: 'Notes/a.md' })] };
        if (tools.length === 4) return { content: '', thinking: '', toolCalls: [call('write_file', { path: 'Notes/summary.md', content: '# Summary\nTotal 2000\n', reason: 'asked' })] };
        return { content: 'Wrote Notes/summary.md.', thinking: '', toolCalls: [] };
      },
    };
    // Measure overlap of the three reads.
    const exec = ws.exec.bind(ws);
    ws.exec = async (...a: Parameters<typeof ws.exec>) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 20)); try { return await exec(...a); } finally { inFlight--; } };
    const agent = new Agent(db, model as unknown as Ollama, () => {}, () => {}, ws);
    const lane = db.createLane('New lane', 'autonomous');
    await agent.send(lane.id, 'Summarise the notes and the sales total in Notes/summary.md');

    expect(maxInFlight).toBe(3);
    const toolMsgs = calls.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolMsgs[2]).toContain('Result (computed from 2 rows of Notes/sales.csv):\n2000');
    expect(toolMsgs[3]).toMatch(/^\(Same as your earlier read_file call; nothing changed since\.\)/);
    expect(toolMsgs[4]).toMatch(/^Applied and verified on disk/);
    expect(fs.readFileSync(path.join(root, 'Notes/summary.md'), 'utf8')).toBe('# Summary\nTotal 2000\n');
    expect(db.getLane(lane.id)?.status).toBe('idle'); // nothing waits for review
    expect(db.listChanges(lane.id)[0].status).toBe('auto_applied');
    expect(db.listMessages(lane.id).filter((m) => m.role === 'jarvis').at(-1)!.payload.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('falls back to the reasoning model when the fast model is not downloaded', async () => {
    const db = new Db(':memory:');
    db.setSettings({ model: 'qwen3:8b', fastModel: 'qwen3:4b' });
    const used: string[] = [];
    const model = {
      async round(o: Round) {
        used.push(o.model);
        if (o.model === 'qwen3:4b') throw new OllamaError('not downloaded', true);
        return { content: 'Hello.', thinking: '', toolCalls: [] };
      },
    };
    const agent = new Agent(db, model as unknown as Ollama, () => {});
    const lane = db.createLane('New lane', 'autonomous');
    await agent.send(lane.id, 'Hi');
    await agent.send(lane.id, 'Hello again');
    expect(used).toEqual(['qwen3:4b', 'qwen3:8b', 'qwen3:8b']);
    expect(db.listMessages(lane.id).filter((m) => m.role === 'jarvis').map((m) => m.payload.model)).toEqual(['qwen3:8b', 'qwen3:8b']);
  });
});
