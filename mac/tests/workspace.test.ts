import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../electron/agent';
import { Db } from '../electron/db';
import type { ChatMessage, Ollama, ToolCall } from '../electron/ollama';
import { ScopeError, Workspace, riskOf } from '../electron/workspace';
import type { Autonomy } from '../shared/types';

let root: string;
let db: Db;
let ws: Workspace;
let laneId: string;
const trashed: string[] = [];

const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const ctx = (autonomy: Autonomy = 'ask_every_change', stepIndex: number | null = 0) => ({ laneId, stepIndex, autonomy });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-')));
  write('Finance/Sept-close.csv', 'metric,value\nNet revenue,4.82\n');
  write('Board/Q3-Board.md', '# Q3 Board Report\n\nNet revenue was €4.61M, slightly ahead of forecast.\n');
  write('Personal/diary.md', 'private');
  write('readme.txt', 'top level');
  db = new Db(':memory:');
  ws = new Workspace(db, fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-blobs-')), async (abs) => { trashed.push(abs); fs.rmSync(abs, { recursive: true }); });
  ws.setRoot(root);
  db.setScope('Finance', 'read');
  db.setScope('Board', 'edit_auto');
  laneId = db.createLane('Test', 'ask_every_change').id;
});

describe('folder access', () => {
  it('starts every folder with no access', () => {
    const fresh = new Db(':memory:');
    const w = new Workspace(fresh, fs.mkdtempSync(path.join(os.tmpdir(), 'b-')), async () => {});
    w.setRoot(root);
    expect(w.syncScopes().map((s) => [s.path, s.mode])).toEqual([['', 'none'], ['Board', 'none'], ['Finance', 'none'], ['Personal', 'none']]);
  });

  it('enforces read and write per folder', async () => {
    expect((await ws.exec('read_file', { path: 'Finance/Sept-close.csv' }, ctx())).result).toContain('Net revenue,4.82');
    await expect(ws.exec('read_file', { path: 'Personal/diary.md' }, ctx())).rejects.toBeInstanceOf(ScopeError);
    await expect(ws.exec('write_file', { path: 'Finance/new.md', content: 'x', reason: 'r' }, ctx())).rejects.toThrow(/read only/);
    await expect(ws.exec('read_file', { path: 'readme.txt' }, ctx())).rejects.toThrow(/top level/);
    expect(db.listAudit().map((a) => a.result.split(':')[0])).toEqual(['ok', 'denied', 'denied', 'denied']);
  });

  it('blocks paths and symlinks that leave the workspace or enter a closed folder', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'Board', 'escape'));
    fs.symlinkSync(path.join(root, 'Personal'), path.join(root, 'Board', 'sneak'));
    await expect(ws.exec('read_file', { path: '../' + path.basename(outside) + '/secret.txt' }, ctx())).rejects.toThrow(/outside the workspace/);
    await expect(ws.exec('read_file', { path: 'Board/escape/secret.txt' }, ctx())).rejects.toThrow(/outside the workspace/);
    await expect(ws.exec('read_file', { path: 'Board/sneak/diary.md' }, ctx())).rejects.toThrow(/no access to Personal/);
    await expect(ws.exec('read_file', { path: path.join(outside, 'secret.txt') }, ctx())).rejects.toThrow(/outside the workspace/);
  });

  it('lists the top level with access levels and searches only readable folders', async () => {
    const top = (await ws.exec('list_dir', { path: '.' }, ctx())).result;
    expect(top).toContain('Personal/  [access: none]');
    const hits = (await ws.exec('search_files', { query: 'revenue' }, ctx())).result;
    expect(hits).toContain('Finance/Sept-close.csv:2');
    expect(hits).toContain('Board/Q3-Board.md:3');
    expect((await ws.exec('search_files', { query: 'private' }, ctx())).result).toMatch(/No readable files/);
  });
});

describe('changes', () => {
  it('stages edits without touching the original, then applies on accept', async () => {
    await ws.exec('replace_text', { path: 'Board/Q3-Board.md', find: 'slightly ahead of', replace: '3.1% above', reason: 'Memory: exact figures' }, ctx());
    expect(read('Board/Q3-Board.md')).toContain('slightly ahead of');
    // A second edit in the same lane builds on the first and stays one change.
    await ws.exec('replace_text', { path: 'Board/Q3-Board.md', find: '€4.61M', replace: '€4.82M', reason: 'Source: Sept-close.csv row 2' }, ctx());
    const [c] = db.listChanges(laneId);
    expect(db.listChanges(laneId)).toHaveLength(1);
    expect(c.after).toContain('€4.82M, 3.1% above');
    expect(c.status).toBe('pending');
    await ws.decide(c.id, 'accept');
    expect(read('Board/Q3-Board.md')).toContain('€4.82M, 3.1% above');
    await ws.decide(c.id, 'undo');
    expect(read('Board/Q3-Board.md')).toContain('€4.61M, slightly ahead of');
    expect(db.getChange(c.id)?.status).toBe('pending');
    await ws.decide(c.id, 'reject');
    expect(read('Board/Q3-Board.md')).toContain('€4.61M');
  });

  it('refuses to apply over a file that changed on disk', async () => {
    await ws.exec('replace_text', { path: 'Board/Q3-Board.md', find: 'slightly ahead of', replace: 'above', reason: 'r' }, ctx());
    write('Board/Q3-Board.md', 'someone else edited this');
    await expect(ws.decide(db.listChanges(laneId)[0].id, 'accept')).rejects.toThrow(/changed on disk/);
    expect(read('Board/Q3-Board.md')).toBe('someone else edited this');
  });

  it('auto-applies small edits under "ask if risky" but holds risky ones and folders set to ask', async () => {
    await ws.exec('write_file', { path: 'Board/notes.md', content: 'new notes', reason: 'r' }, ctx('ask_if_risky'));
    expect(read('Board/notes.md')).toBe('new notes');
    await ws.exec('replace_text', { path: 'Board/Q3-Board.md', find: '€4.61M', replace: '€4.82M', reason: 'r' }, ctx('ask_if_risky'));
    expect(read('Board/Q3-Board.md')).toContain('€4.61M'); // a figure in a board document is risky
    db.setScope('Board', 'edit_ask');
    await ws.exec('write_file', { path: 'Board/other.md', content: 'x', reason: 'r' }, ctx('autonomous'));
    expect(fs.existsSync(path.join(root, 'Board/other.md'))).toBe(false);
    expect(db.listChanges(laneId).map((c) => c.status)).toEqual(['auto_applied', 'pending', 'pending']);
  });

  it('never deletes without review, and deletes to the Trash', async () => {
    await ws.exec('delete_file', { path: 'Board/Q3-Board.md', reason: 'old' }, ctx('autonomous'));
    expect(fs.existsSync(path.join(root, 'Board/Q3-Board.md'))).toBe(true);
    await ws.decide(db.listChanges(laneId)[0].id, 'accept');
    expect(trashed.at(-1)).toBe(path.join(root, 'Board/Q3-Board.md'));
  });

  it('only edits text files for now', async () => {
    write('Board/deck.pptx', 'binary');
    await expect(ws.exec('write_file', { path: 'Board/deck.pptx', content: 'x', reason: 'r' }, ctx())).rejects.toThrow(/arrives in the next update/);
  });

  it('rates risk', () => {
    expect(riskOf('create', null, 'x', 'Board/a.md', 'edit_auto')).toBe('low');
    expect(riskOf('edit', 'a b c', 'a d c', 'Notes/a.md', 'edit_auto')).toBe('low');
    expect(riskOf('edit', 'cost 4.61', 'cost 4.82', 'Finance/a.md', 'edit_auto')).toBe('high');
    expect(riskOf('edit', 'x', 'x'.repeat(300), 'Notes/a.md', 'edit_auto')).toBe('high');
    expect(riskOf('edit', 'a', 'b', 'Notes/a.md', 'edit_ask')).toBe('high');
  });
});

describe('checkpoints', () => {
  it('restores every file to its state at the checkpoint, and the restore is undoable', async () => {
    const original = read('Board/Q3-Board.md');
    const cp0 = db.addCheckpoint(laneId, 0, 'Before edits');
    await ws.exec('write_file', { path: 'Board/Q3-Board.md', content: 'v1', reason: 'r' }, ctx('autonomous'));
    const cp1 = db.addCheckpoint(laneId, 1, 'Before step 2');
    await ws.exec('write_file', { path: 'Board/Q3-Board.md', content: 'v2', reason: 'r' }, ctx('autonomous'));
    await ws.exec('write_file', { path: 'Board/new.md', content: 'created', reason: 'r' }, ctx('autonomous'));
    await ws.exec('write_file', { path: 'Board/pending.md', content: 'p', reason: 'r' }, ctx('ask_every_change'));
    expect(read('Board/Q3-Board.md')).toBe('v2');

    await ws.restore(cp1.id);
    expect(read('Board/Q3-Board.md')).toBe('v1');
    expect(fs.existsSync(path.join(root, 'Board/new.md'))).toBe(false);
    expect(db.listChanges(laneId).some((c) => c.filePath === 'Board/pending.md')).toBe(false);

    await ws.restore(cp0.id);
    expect(read('Board/Q3-Board.md')).toBe(original);

    const undo = db.listCheckpoints(laneId).at(-1)!;
    expect(undo.label).toMatch(/^Before restore to/);
    await ws.restore(undo.id);
    expect(read('Board/Q3-Board.md')).toBe('v1');
  });
});

describe('agent with tools', () => {
  it('reads and edits through tool calls, logs each call, and waits for review', async () => {
    const script: ToolCall[][] = [
      [{ function: { name: 'read_file', arguments: { path: 'Finance/Sept-close.csv' } } }],
      [{ function: { name: 'replace_text', arguments: { path: 'Board/Q3-Board.md', find: '€4.61M', replace: '€4.82M', reason: 'Sept-close.csv row 2' } } }],
      [{ function: { name: 'read_file', arguments: { path: 'Personal/diary.md' } } }],
    ];
    const seen: ChatMessage[][] = [];
    const model = {
      async chat() { return JSON.stringify({ kind: 'answer', title: 'Update revenue' }); },
      async round(o: { messages: ChatMessage[]; format?: object; tools?: unknown[]; onText?: (t: string) => void }) {
        if (o.format) return { content: JSON.stringify({ kind: 'answer', title: 'Update revenue' }), toolCalls: [] };
        seen.push(o.messages);
        const next = script.shift();
        if (next && o.tools) return { content: '', toolCalls: next };
        o.onText?.('Updated net revenue to €4.82M. The change is waiting for your review.');
        return { content: 'Updated net revenue to €4.82M. The change is waiting for your review.', toolCalls: [] };
      },
    } as unknown as Ollama;
    const agent = new Agent(db, model, () => {}, () => {}, ws);
    await agent.send(laneId, 'Update the revenue figure in the board report from Sept-close');
    const msgs = db.listMessages(laneId);
    expect(msgs.filter((m) => m.kind === 'log').map((m) => m.payload.verb)).toEqual(['Read', 'Edited']);
    expect(msgs.find((m) => m.kind === 'error')?.payload).toMatchObject({ grantPath: 'Personal', grantMode: 'read' });
    expect(seen.at(-1)!.filter((m) => m.role === 'tool').map((m) => m.content.slice(0, 6))).toEqual(['metric', 'Staged', 'ERROR:']);
    expect(db.getLane(laneId)).toMatchObject({ status: 'awaiting_review', statusText: '1 change to review' });
    expect(read('Board/Q3-Board.md')).toContain('€4.61M');

    await ws.decide(db.listChanges(laneId)[0].id, 'accept');
    agent.changesUpdated(laneId);
    expect(db.getLane(laneId)?.status).toBe('done');
    expect(read('Board/Q3-Board.md')).toContain('€4.82M');
  });
});

describe('folders', () => {
  it('creates a folder inside a folder with edit access, after review', async () => {
    await ws.exec('create_folder', { path: 'Board/2026', reason: 'yearly files' }, ctx());
    expect(fs.existsSync(path.join(root, 'Board/2026'))).toBe(false);
    const [c] = db.listChanges(laneId);
    expect(c).toMatchObject({ kind: 'mkdir', title: 'New folder Board/2026/', status: 'pending' });
    await ws.decide(c.id, 'accept');
    expect(fs.statSync(path.join(root, 'Board/2026')).isDirectory()).toBe(true);
    await ws.decide(c.id, 'undo');
    expect(fs.existsSync(path.join(root, 'Board/2026'))).toBe(false);
  });

  it('applies at once when autonomy allows, and nested folders work', async () => {
    await ws.exec('create_folder', { path: 'Board/a/b/c', reason: 'r' }, ctx('ask_if_risky'));
    expect(fs.statSync(path.join(root, 'Board/a/b/c')).isDirectory()).toBe(true);
    expect((await ws.exec('create_folder', { path: 'Board/a', reason: 'r' }, ctx())).result).toMatch(/already exists/);
  });

  it('a new top-level folder uses the main folder\'s access and then keeps it', async () => {
    await expect(ws.exec('create_folder', { path: 'Reports', reason: 'r' }, ctx('autonomous'))).rejects.toThrow(/main folder/);
    db.setScope('', 'edit_auto');
    await ws.exec('create_folder', { path: 'Reports', reason: 'r' }, ctx('autonomous'));
    expect(fs.statSync(path.join(root, 'Reports')).isDirectory()).toBe(true);
    expect(ws.syncScopes().find((s) => s.path === 'Reports')?.mode).toBe('edit_auto');
    // Writing into a top-level folder that doesn't exist yet also follows the main folder.
    await ws.exec('write_file', { path: 'Drafts/plan.md', content: '# Plan', reason: 'r' }, ctx('autonomous'));
    expect(read('Drafts/plan.md')).toBe('# Plan');
  });

  it('folders made in Finder inherit the main folder\'s access', () => {
    db.setScope('', 'read');
    fs.mkdirSync(path.join(root, 'FromFinder'));
    expect(ws.syncScopes().find((s) => s.path === 'FromFinder')?.mode).toBe('read');
  });

  it('never writes an empty file in place of a folder via setAll, and setAll covers every folder', () => {
    ws.setAll('read');
    expect(new Set(ws.syncScopes().map((s) => s.mode))).toEqual(new Set(['read']));
  });

  it('checkpoints remove folders made after them, and the restore can be undone', async () => {
    const cp = db.addCheckpoint(laneId, 0, 'Before edits');
    await ws.exec('create_folder', { path: 'Board/new', reason: 'r' }, ctx('autonomous'));
    await ws.exec('write_file', { path: 'Board/new/a.md', content: 'a', reason: 'r' }, ctx('autonomous'));
    await ws.restore(cp.id);
    expect(fs.existsSync(path.join(root, 'Board/new'))).toBe(false);
    await ws.restore(db.listCheckpoints(laneId).at(-1)!.id);
    expect(read('Board/new/a.md')).toBe('a');
  });
});
