// SQLite storage (Node's built-in driver, so there is no native module to rebuild).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';
import type { Autonomy, Lane, LaneStatus, Memory, Message, MessageKind, PlanStep, Settings, StepState } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, status_text TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0, autonomy TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_lane ON messages(lane_id, ts);
CREATE TABLE IF NOT EXISTS plan_steps (
  id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, requires_gate INTEGER NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS steps_lane ON plan_steps(lane_id, idx);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private get(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private run(sql: string, ...args: (string | number | null)[]) {
    this.db.prepare(sql).run(...args);
  }

  /* ---------- settings and UI state ---------- */
  getKv<T>(key: string, fallback: T): T {
    const r = this.get('SELECT value FROM kv WHERE key = ?', key);
    if (!r) return fallback;
    try { return JSON.parse(String(r.value)) as T; } catch { return fallback; }
  }
  setKv(key: string, value: unknown) {
    this.run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }
  getSettings(): Settings { return { ...DEFAULT_SETTINGS, ...this.getKv<Partial<Settings>>('settings', {}) }; }
  setSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch };
    this.setKv('settings', next);
    return next;
  }

  /* ---------- lanes ---------- */
  private toLane(r: Row): Lane {
    return {
      id: String(r.id), title: String(r.title), status: r.status as LaneStatus, statusText: String(r.status_text),
      progress: Number(r.progress), autonomy: r.autonomy as Autonomy, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  }
  listLanes(): Lane[] { return this.all('SELECT * FROM lanes ORDER BY created_at').map((r) => this.toLane(r)); }
  getLane(id: string): Lane | undefined { const r = this.get('SELECT * FROM lanes WHERE id = ?', id); return r && this.toLane(r); }
  createLane(title: string, autonomy: Autonomy): Lane {
    const now = Date.now();
    const id = randomUUID();
    this.run('INSERT INTO lanes(id, title, status, status_text, progress, autonomy, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
      id, title, 'idle', 'Idle', 0, autonomy, now, now);
    return this.getLane(id)!;
  }
  updateLane(id: string, patch: Partial<Pick<Lane, 'title' | 'status' | 'statusText' | 'progress' | 'autonomy'>>) {
    const cols: Record<string, string> = { title: 'title', status: 'status', statusText: 'status_text', progress: 'progress', autonomy: 'autonomy' };
    const sets: string[] = [];
    const args: (string | number)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      args.push(v as string | number);
    }
    if (!sets.length) return;
    this.run(`UPDATE lanes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, Date.now(), id);
  }
  deleteLane(id: string) { this.run('DELETE FROM lanes WHERE id = ?', id); }

  /* ---------- messages ---------- */
  private toMessage(r: Row): Message {
    return { id: String(r.id), laneId: String(r.lane_id), role: r.role as Message['role'], kind: r.kind as MessageKind, payload: JSON.parse(String(r.payload)), ts: Number(r.ts) };
  }
  listMessages(laneId: string): Message[] {
    return this.all('SELECT * FROM messages WHERE lane_id = ? ORDER BY ts, rowid', laneId).map((r) => this.toMessage(r));
  }
  addMessage(laneId: string, role: Message['role'], kind: MessageKind, payload: Record<string, unknown>): Message {
    const id = randomUUID();
    const ts = Date.now();
    this.run('INSERT INTO messages(id, lane_id, role, kind, payload, ts) VALUES(?,?,?,?,?,?)', id, laneId, role, kind, JSON.stringify(payload), ts);
    return { id, laneId, role, kind, payload, ts };
  }
  updateMessage(id: string, payload: Record<string, unknown>) {
    this.run('UPDATE messages SET payload = ? WHERE id = ?', JSON.stringify(payload), id);
  }
  getMessage(id: string): Message | undefined { const r = this.get('SELECT * FROM messages WHERE id = ?', id); return r && this.toMessage(r); }

  /* ---------- plan steps ---------- */
  private toStep(r: Row): PlanStep {
    return {
      id: String(r.id), laneId: String(r.lane_id), index: Number(r.idx), text: String(r.text), state: r.state as StepState,
      requiresGate: Number(r.requires_gate) === 1, note: r.note == null ? undefined : String(r.note),
    };
  }
  listSteps(laneId: string): PlanStep[] { return this.all('SELECT * FROM plan_steps WHERE lane_id = ? ORDER BY idx', laneId).map((r) => this.toStep(r)); }
  replaceSteps(laneId: string, steps: { text: string; requiresGate: boolean }[]): PlanStep[] {
    this.run('DELETE FROM plan_steps WHERE lane_id = ?', laneId);
    steps.forEach((s, i) => this.run('INSERT INTO plan_steps(id, lane_id, idx, text, state, requires_gate) VALUES(?,?,?,?,?,?)',
      randomUUID(), laneId, i, s.text, 'queued', s.requiresGate ? 1 : 0));
    return this.listSteps(laneId);
  }
  updateStep(id: string, patch: { state?: StepState; note?: string | null }) {
    if (patch.state !== undefined) this.run('UPDATE plan_steps SET state = ? WHERE id = ?', patch.state, id);
    if (patch.note !== undefined) this.run('UPDATE plan_steps SET note = ? WHERE id = ?', patch.note, id);
  }

  /* ---------- memories ---------- */
  private toMemory(r: Row): Memory { return { id: String(r.id), text: String(r.text), enabled: Number(r.enabled) === 1, createdAt: Number(r.created_at) }; }
  listMemories(): Memory[] { return this.all('SELECT * FROM memories ORDER BY created_at').map((r) => this.toMemory(r)); }
  addMemory(text: string) { this.run('INSERT INTO memories(id, text, enabled, created_at) VALUES(?,?,1,?)', randomUUID(), text, Date.now()); }
  updateMemory(id: string, patch: { text?: string; enabled?: boolean }) {
    if (patch.text !== undefined) this.run('UPDATE memories SET text = ? WHERE id = ?', patch.text, id);
    if (patch.enabled !== undefined) this.run('UPDATE memories SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id);
  }
  deleteMemory(id: string) { this.run('DELETE FROM memories WHERE id = ?', id); }

  deleteAll() { this.db.exec('DELETE FROM messages; DELETE FROM plan_steps; DELETE FROM lanes; DELETE FROM memories; DELETE FROM kv;'); }
}
