// SQLite storage (Node's built-in driver, so there is no native module to rebuild).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';
import type {
  AuditEntry, Autonomy, Source, WebSearch, Change, ChangeStatus, Checkpoint, FileScope, FileTouch, Lane, LaneStatus, Memory, Message, MessageKind, PlanStep, ScopeMode, Settings, StepState, TouchAction,
} from '../shared/types';
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
CREATE TABLE IF NOT EXISTS scopes (path TEXT PRIMARY KEY, mode TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE, step_index INTEGER,
  file_path TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, reason TEXT NOT NULL,
  before TEXT, after TEXT, move_to TEXT, status TEXT NOT NULL, risk TEXT NOT NULL, ts INTEGER NOT NULL,
  before_blob TEXT, after_blob TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS changes_lane ON changes(lane_id, ts);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL, label TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoint_files (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  path TEXT NOT NULL, sha TEXT, PRIMARY KEY (checkpoint_id, path)
);
CREATE TABLE IF NOT EXISTS touches (
  lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE, path TEXT NOT NULL,
  action TEXT NOT NULL, format TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE, n INTEGER NOT NULL,
  url TEXT NOT NULL, title TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', published TEXT, ts INTEGER NOT NULL, UNIQUE (lane_id, url)
);
CREATE TABLE IF NOT EXISTS searches (
  lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE, query TEXT NOT NULL, provider TEXT NOT NULL, results INTEGER NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, lane_id TEXT NOT NULL, tool TEXT NOT NULL, path TEXT NOT NULL, result TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // 0.3.1 databases have no touches.detail column yet.
    const cols = this.db.prepare('PRAGMA table_info(touches)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'detail')) this.db.exec("ALTER TABLE touches ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
    // 0.3.x databases: changes to binary files need the saved copies and cell details.
    const ccols = (this.db.prepare('PRAGMA table_info(changes)').all() as { name: string }[]).map((c) => c.name);
    for (const col of ['before_blob', 'after_blob', 'detail']) if (!ccols.includes(col)) this.db.exec(`ALTER TABLE changes ADD COLUMN ${col} TEXT`);
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

  /* ---------- folder scopes ---------- */
  listScopes(): FileScope[] { return this.all('SELECT * FROM scopes ORDER BY path').map((r) => ({ path: String(r.path), mode: r.mode as ScopeMode })); }
  setScope(path: string, mode: ScopeMode) {
    this.run('INSERT INTO scopes(path, mode) VALUES(?, ?) ON CONFLICT(path) DO UPDATE SET mode = excluded.mode', path, mode);
  }
  clearScopes() { this.run('DELETE FROM scopes'); }

  /* ---------- changes ---------- */
  private toChange(r: Row): Change {
    return {
      id: String(r.id), laneId: String(r.lane_id), stepIndex: r.step_index == null ? null : Number(r.step_index), filePath: String(r.file_path),
      kind: r.kind as Change['kind'], title: String(r.title), reason: String(r.reason),
      before: r.before == null ? null : String(r.before), after: r.after == null ? null : String(r.after),
      moveTo: r.move_to == null ? undefined : String(r.move_to), status: r.status as ChangeStatus, risk: r.risk as Change['risk'], ts: Number(r.ts),
      beforeBlob: r.before_blob == null ? undefined : String(r.before_blob), afterBlob: r.after_blob == null ? undefined : String(r.after_blob),
      detail: r.detail == null ? undefined : String(r.detail),
    };
  }
  listChanges(laneId: string): Change[] { return this.all('SELECT * FROM changes WHERE lane_id = ? ORDER BY ts, rowid', laneId).map((r) => this.toChange(r)); }
  getChange(id: string): Change | undefined { const r = this.get('SELECT * FROM changes WHERE id = ?', id); return r && this.toChange(r); }
  pendingChangeFor(laneId: string, filePath: string): Change | undefined {
    const r = this.get("SELECT * FROM changes WHERE lane_id = ? AND file_path = ? AND status = 'pending' ORDER BY ts DESC LIMIT 1", laneId, filePath);
    return r && this.toChange(r);
  }
  addChange(c: Omit<Change, 'id' | 'ts'>): Change {
    const id = randomUUID();
    const ts = Date.now();
    this.run('INSERT INTO changes(id, lane_id, step_index, file_path, kind, title, reason, before, after, move_to, status, risk, ts, before_blob, after_blob, detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, c.laneId, c.stepIndex, c.filePath, c.kind, c.title, c.reason, c.before, c.after, c.moveTo ?? null, c.status, c.risk, ts,
      c.beforeBlob ?? null, c.afterBlob ?? null, c.detail ?? null);
    return this.getChange(id)!;
  }
  updateChange(id: string, patch: Partial<Pick<Change, 'title' | 'reason' | 'after' | 'status' | 'risk' | 'kind' | 'afterBlob' | 'detail'>>) {
    const cols: Record<string, string> = { title: 'title', reason: 'reason', after: 'after', status: 'status', risk: 'risk', kind: 'kind', afterBlob: 'after_blob', detail: 'detail' };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      this.run(`UPDATE changes SET ${cols[k]} = ? WHERE id = ?`, v as string | null, id);
    }
  }
  deleteChangesAfter(laneId: string, ts: number) { this.run("DELETE FROM changes WHERE lane_id = ? AND ts >= ? AND status = 'pending'", laneId, ts); }

  /* ---------- checkpoints ---------- */
  private toCheckpoint(r: Row): Checkpoint { return { id: String(r.id), laneId: String(r.lane_id), stepIndex: Number(r.step_index), label: String(r.label), ts: Number(r.ts) }; }
  listCheckpoints(laneId: string): Checkpoint[] { return this.all('SELECT * FROM checkpoints WHERE lane_id = ? ORDER BY ts, rowid', laneId).map((r) => this.toCheckpoint(r)); }
  getCheckpoint(id: string): Checkpoint | undefined { const r = this.get('SELECT * FROM checkpoints WHERE id = ?', id); return r && this.toCheckpoint(r); }
  addCheckpoint(laneId: string, stepIndex: number, label: string): Checkpoint {
    const id = randomUUID();
    // keep checkpoints strictly ordered even within one millisecond
    const last = this.get('SELECT MAX(ts) AS t FROM checkpoints WHERE lane_id = ?', laneId);
    const ts = Math.max(Date.now(), Number(last?.t ?? 0) + 1);
    this.run('INSERT INTO checkpoints(id, lane_id, step_index, label, ts) VALUES(?,?,?,?,?)', id, laneId, stepIndex, label, ts);
    return this.getCheckpoint(id)!;
  }
  latestCheckpoint(laneId: string): Checkpoint | undefined {
    const r = this.get('SELECT * FROM checkpoints WHERE lane_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1', laneId);
    return r && this.toCheckpoint(r);
  }
  hasSnapshot(checkpointId: string, path: string) { return !!this.get('SELECT 1 FROM checkpoint_files WHERE checkpoint_id = ? AND path = ?', checkpointId, path); }
  addSnapshot(checkpointId: string, path: string, sha: string | null) {
    this.run('INSERT OR IGNORE INTO checkpoint_files(checkpoint_id, path, sha) VALUES(?,?,?)', checkpointId, path, sha);
  }
  /** For every file changed at or after `ts` in this lane: its content at that moment (the earliest snapshot). */
  snapshotsSince(laneId: string, ts: number): Map<string, string | null> {
    const rows = this.all(`SELECT f.path, f.sha FROM checkpoint_files f JOIN checkpoints c ON c.id = f.checkpoint_id
      WHERE c.lane_id = ? AND c.ts >= ? ORDER BY c.ts DESC, c.rowid DESC`, laneId, ts);
    const out = new Map<string, string | null>();
    for (const r of rows) out.set(String(r.path), r.sha == null ? null : String(r.sha)); // later rows (earlier checkpoints) win
    return out;
  }

  /* ---------- file activity and audit ---------- */
  addTouch(laneId: string, path: string, action: TouchAction, format: string, detail = '') {
    this.run('INSERT INTO touches(lane_id, path, action, format, ts, detail) VALUES(?,?,?,?,?,?)', laneId, path, action, format, Date.now(), detail);
  }
  listTouches(): FileTouch[] {
    return this.all(`SELECT t.*, l.title AS lane_title FROM touches t JOIN lanes l ON l.id = t.lane_id ORDER BY t.ts DESC, t.rowid DESC LIMIT 500`).map((r) => ({
      laneId: String(r.lane_id), laneTitle: String(r.lane_title), path: String(r.path), action: r.action as TouchAction, format: String(r.format), ts: Number(r.ts), detail: String(r.detail ?? ''),
    }));
  }
  addAudit(laneId: string, tool: string, path: string, result: string) {
    this.run('INSERT INTO audit(ts, lane_id, tool, path, result) VALUES(?,?,?,?,?)', Date.now(), laneId, tool, path, result.slice(0, 500));
  }
  listAudit(): AuditEntry[] {
    return this.all('SELECT * FROM audit ORDER BY ts, rowid').map((r) => ({ ts: Number(r.ts), laneId: String(r.lane_id), tool: String(r.tool), path: String(r.path), result: String(r.result) }));
  }

  /* ---------- research sources ---------- */
  private toSource(r: Row): Source {
    return {
      id: String(r.id), laneId: String(r.lane_id), n: Number(r.n), url: String(r.url), title: String(r.title), domain: String(r.domain),
      kind: r.kind as Source['kind'], state: r.state as Source['state'], note: String(r.note), published: r.published == null ? undefined : String(r.published), ts: Number(r.ts),
    };
  }
  listSources(laneId: string): Source[] { return this.all('SELECT * FROM sources WHERE lane_id = ? ORDER BY n', laneId).map((r) => this.toSource(r)); }
  findSource(laneId: string, url: string): Source | undefined { const r = this.get('SELECT * FROM sources WHERE lane_id = ? AND url = ?', laneId, url); return r && this.toSource(r); }
  /** Add a source with the lane's next number, or update the one already listed for this address (it keeps its number). */
  upsertSource(laneId: string, s: Pick<Source, 'url' | 'title' | 'domain' | 'kind' | 'state' | 'note'> & { published?: string }): Source {
    const prev = this.findSource(laneId, s.url);
    if (prev) {
      this.run('UPDATE sources SET title = ?, kind = ?, state = ?, note = ?, published = ?, ts = ? WHERE id = ?', s.title, s.kind, s.state, s.note, s.published ?? prev.published ?? null, Date.now(), prev.id);
      return this.findSource(laneId, s.url)!;
    }
    const n = Number(this.get('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM sources WHERE lane_id = ?', laneId)!.n);
    this.run('INSERT INTO sources(id, lane_id, n, url, title, domain, kind, state, note, published, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      randomUUID(), laneId, n, s.url, s.title.slice(0, 300), s.domain, s.kind, s.state, s.note, s.published ?? null, Date.now());
    return this.findSource(laneId, s.url)!;
  }
  updateSource(id: string, patch: { state?: Source['state']; note?: string }) {
    if (patch.state !== undefined) this.run('UPDATE sources SET state = ? WHERE id = ?', patch.state, id);
    if (patch.note !== undefined) this.run('UPDATE sources SET note = ? WHERE id = ?', patch.note, id);
  }
  addSearch(laneId: string, query: string, provider: string, results: number) {
    this.run('INSERT INTO searches(lane_id, query, provider, results, ts) VALUES(?,?,?,?,?)', laneId, query, provider, results, Date.now());
  }
  listSearches(laneId: string): WebSearch[] {
    return this.all('SELECT * FROM searches WHERE lane_id = ? ORDER BY ts, rowid', laneId).map((r) => ({ laneId: String(r.lane_id), query: String(r.query), provider: String(r.provider), results: Number(r.results), ts: Number(r.ts) }));
  }

  deleteAll() {
    this.db.exec('DELETE FROM sources; DELETE FROM searches; DELETE FROM messages; DELETE FROM plan_steps; DELETE FROM changes; DELETE FROM checkpoint_files; DELETE FROM checkpoints; DELETE FROM touches; DELETE FROM audit; DELETE FROM lanes; DELETE FROM memories; DELETE FROM scopes; DELETE FROM kv;');
  }
}
