// The only way the agent touches the disk: scope checks, file tools, staged changes, checkpoints.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import type { Db } from './db';
import type { Autonomy, Change, FileScope, ScopeMode, TouchAction } from '../shared/types';

export class ScopeError extends Error {
  constructor(message: string, public scopePath: string, public needs: ScopeMode) { super(message); }
}
export class WorkspaceError extends Error {}

type Op = 'read' | 'write';
export interface ToolContext { laneId: string; stepIndex: number | null; autonomy: Autonomy }

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yml', '.yaml', '.log', '.ini', '.toml', '.rtf', '.tex', '.js', '.ts', '.py', '.css', '.sql', '.sh']);
const LATER_EXT: Record<string, string> = { '.xlsx': 'Excel', '.xls': 'Excel', '.pptx': 'PowerPoint', '.ppt': 'PowerPoint', '.pdf': 'PDF', '.doc': 'old Word' };
const SKIP_DIRS = new Set(['node_modules', '.git', '.jarvis']);
const MAX_READ = 60_000;
const RISKY_PATH = /financ|legal|contract|invoice|budget|board|payroll|tax/i;

export const formatOf = (p: string) => {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.docx') return 'Word';
  if (LATER_EXT[ext]) return LATER_EXT[ext];
  if (ext === '.md' || ext === '.markdown') return 'Markdown';
  if (ext === '.csv' || ext === '.tsv') return 'CSV';
  return ext ? ext.slice(1).toUpperCase() : 'File';
};
const isText = (p: string) => TEXT_EXT.has(path.extname(p).toLowerCase()) || path.extname(p) === '';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

export class Workspace {
  constructor(
    private db: Db,
    private blobDir: string,
    private trash: (absPath: string) => Promise<void>,
    private changed: (what: 'scopes' | 'touches' | { changes: string } | { checkpoints: string }) => void = () => {},
  ) {
    fs.mkdirSync(blobDir, { recursive: true });
  }

  root(): string | null {
    const w = this.db.getSettings().workspace;
    return w && fs.existsSync(w) ? w : null;
  }

  /** Make sure every top-level folder has an access row. New folders start with no access. */
  syncScopes(): FileScope[] {
    const root = this.root();
    if (!root) return [];
    const have = new Map(this.db.listScopes().map((s) => [s.path, s.mode]));
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map((d) => d.name);
    for (const p of ['', ...dirs]) if (!have.has(p)) this.db.setScope(p, 'none');
    const keep = new Set(['', ...dirs]);
    return this.db.listScopes().filter((s) => keep.has(s.path));
  }

  setRoot(dir: string) {
    this.db.setSettings({ workspace: dir });
    this.db.clearScopes();
    this.syncScopes();
    this.changed('scopes');
  }

  modeFor(scopePath: string): ScopeMode {
    return this.db.listScopes().find((s) => s.path === scopePath)?.mode ?? 'none';
  }

  /**
   * Resolve a workspace-relative path and check access. Symlinks are resolved first,
   * so a link cannot reach outside the workspace or into a folder without access.
   */
  resolve(rel: string, op: Op): { abs: string; rel: string; scope: string } {
    const root = this.root();
    if (!root) throw new WorkspaceError('No workspace folder is set. Choose one with "Workspace" in the title bar.');
    const rootReal = fs.realpathSync(root);
    const cleaned = String(rel ?? '').trim().replace(/^~\//, '').replace(/^(\.\/)+/, '') || '.';
    const candidate = path.isAbsolute(cleaned) ? cleaned : path.resolve(rootReal, cleaned);
    const real = realpathLoose(candidate);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new ScopeError(`${rel} is outside the workspace. Jarvis only works inside ${root}.`, '', op === 'read' ? 'read' : 'edit_ask');
    }
    const relative = path.relative(rootReal, real);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some((p) => SKIP_DIRS.has(p))) throw new ScopeError(`${relative} is a protected folder.`, parts[0], 'read');
    const isTopDir = parts.length === 1 && fs.existsSync(real) && fs.statSync(real).isDirectory();
    const scope = parts.length > 1 || isTopDir ? parts[0] : '';
    const mode = this.modeFor(scope);
    const label = scope ? `${scope}/` : 'the top level of the workspace';
    if (op === 'read' && mode === 'none') throw new ScopeError(`Jarvis has no access to ${label}.`, scope, 'read');
    if (op === 'write' && (mode === 'none' || mode === 'read')) {
      throw new ScopeError(`${label} is ${mode === 'read' ? 'read only' : 'not accessible'}, so Jarvis can't change ${relative || 'it'}.`, scope, 'edit_ask');
    }
    return { abs: real, rel: relative, scope };
  }

  /* ---------- tools ---------- */

  async exec(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ result: string; log?: [string, string] }> {
    const p = (k: string) => String(args[k] ?? '');
    const target = p('path') || p('from') || '.';
    try {
      const out = await this.run(name, args, ctx);
      this.db.addAudit(ctx.laneId, name, target, 'ok');
      return out;
    } catch (e) {
      const denied = e instanceof ScopeError;
      this.db.addAudit(ctx.laneId, name, target, `${denied ? 'denied' : 'error'}: ${(e as Error).message}`);
      if (denied) { this.touch(ctx.laneId, target, 'denied'); }
      throw e;
    }
  }

  private async run(name: string, a: Record<string, unknown>, ctx: ToolContext): Promise<{ result: string; log?: [string, string] }> {
    const s = (k: string) => (a[k] == null ? '' : String(a[k]));
    switch (name) {
      case 'list_dir': return this.listDir(s('path') || '.');
      case 'read_file': return this.readFile(s('path'), ctx);
      case 'search_files': return this.search(s('query'), s('path') || '.');
      case 'write_file': return this.stage(ctx, s('path'), s('content'), s('reason'));
      case 'replace_text': return this.replaceText(ctx, s('path'), s('find'), s('replace'), s('reason'));
      case 'move_file': return this.stageMove(ctx, s('from'), s('to'), s('reason'));
      case 'delete_file': return this.stageDelete(ctx, s('path'), s('reason'));
      default: throw new WorkspaceError(`Unknown tool ${name}.`);
    }
  }

  private listDir(rel: string) {
    const root = this.root();
    if (!root) throw new WorkspaceError('No workspace folder is set.');
    const atRoot = rel === '.' || rel === '' || rel === '/';
    // The top level is always listable so Jarvis can see which folders exist and what access each has.
    const abs = atRoot ? fs.realpathSync(root) : this.resolve(rel, 'read').abs;
    const scopes = new Map(this.syncScopes().map((x) => [x.path, x.mode]));
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
      .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name))
      .slice(0, 200)
      .map((d) => {
        if (d.isDirectory()) return atRoot ? `${d.name}/  [access: ${scopes.get(d.name) ?? 'none'}]` : `${d.name}/`;
        const size = fs.statSync(path.join(abs, d.name)).size;
        return `${d.name}  (${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`})`;
      });
    const header = atRoot ? `Workspace top level [files here: ${scopes.get('') ?? 'none'}]` : rel;
    return { result: `${header}\n${entries.join('\n') || '(empty)'}`, log: ['Listed', atRoot ? 'workspace' : `${rel}/ · ${entries.length} items`] as [string, string] };
  }

  /** Current content as this lane sees it: its own pending edit if there is one, else the file on disk. */
  private async currentText(laneId: string, rel: string, abs: string): Promise<string | null> {
    const pending = this.db.pendingChangeFor(laneId, rel);
    if (pending) return pending.after;
    if (!fs.existsSync(abs)) return null;
    return readText(abs);
  }

  private async readFile(rel: string, ctx: ToolContext) {
    if (!rel) throw new WorkspaceError('read_file needs a path.');
    const r = this.resolve(rel, 'read');
    const ext = path.extname(r.abs).toLowerCase();
    if (LATER_EXT[ext]) throw new WorkspaceError(`Jarvis can't read ${LATER_EXT[ext]} files yet. Excel, PowerPoint and PDF support arrives in the next update.`);
    if (!fs.existsSync(r.abs) && !this.db.pendingChangeFor(ctx.laneId, r.rel)) throw new WorkspaceError(`${r.rel} does not exist.`);
    if (fs.existsSync(r.abs) && fs.statSync(r.abs).isDirectory()) return this.listDir(r.rel);
    let text: string;
    if (ext === '.docx') text = await docxText(r.abs);
    else {
      const cur = await this.currentText(ctx.laneId, r.rel, r.abs);
      if (cur === null) throw new WorkspaceError(`${r.rel} does not exist.`);
      text = cur;
    }
    this.touch(ctx.laneId, r.rel, 'read');
    const lines = text.split('\n').length;
    const clipped = text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[… ${text.length - MAX_READ} more characters not shown]` : text;
    return { result: clipped, log: ['Read', `${r.rel} · ${lines} line${lines === 1 ? '' : 's'}`] as [string, string] };
  }

  private search(query: string, rel: string) {
    const root = this.root();
    if (!root) throw new WorkspaceError('No workspace folder is set.');
    if (!query.trim()) throw new WorkspaceError('search_files needs a query.');
    const q = query.toLowerCase();
    const base = rel === '.' || rel === '' ? fs.realpathSync(root) : this.resolve(rel, 'read').abs;
    const hits: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (hits.length >= 30 || scanned > 3000) return;
        if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
        const abs = path.join(dir, d.name);
        let r: { rel: string };
        try { r = this.resolve(path.relative(fs.realpathSync(root), abs), 'read'); } catch { continue; } // skip folders without access
        if (d.isDirectory()) { walk(abs); continue; }
        scanned++;
        if (d.name.toLowerCase().includes(q)) { hits.push(`${r.rel}  (name matches)`); continue; }
        if (!isText(abs) || fs.statSync(abs).size > 1_000_000) continue;
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const i = lines.findIndex((l) => l.toLowerCase().includes(q));
        if (i >= 0) hits.push(`${r.rel}:${i + 1}  ${lines[i].trim().slice(0, 140)}`);
      }
    };
    walk(base);
    return { result: hits.length ? hits.join('\n') : `No readable files match "${query}".`, log: ['Searched', `"${query}" · ${hits.length} match${hits.length === 1 ? '' : 'es'}`] as [string, string] };
  }

  private async replaceText(ctx: ToolContext, rel: string, find: string, replace: string, reason: string) {
    if (!find) throw new WorkspaceError('replace_text needs the exact text to find.');
    const r = this.resolve(rel, 'write');
    this.assertEditable(r.abs);
    const cur = await this.currentText(ctx.laneId, r.rel, r.abs);
    if (cur === null) throw new WorkspaceError(`${r.rel} does not exist. Use write_file to create it.`);
    const count = cur.split(find).length - 1;
    if (count === 0) throw new WorkspaceError(`The text to replace was not found in ${r.rel}. Read the file again and copy the exact text.`);
    if (count > 1) throw new WorkspaceError(`The text to replace appears ${count} times in ${r.rel}. Include more surrounding text so it matches once.`);
    return this.stage(ctx, r.rel, cur.replace(find, replace), reason, `“${short(find)}” → “${short(replace)}”`);
  }

  private assertEditable(abs: string) {
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.docx' || LATER_EXT[ext]) throw new WorkspaceError(`Editing ${formatOf(abs)} files arrives in the next update. Jarvis can write a Markdown or text file instead.`);
    if (!isText(abs)) throw new WorkspaceError(`Jarvis can only edit text files for now (${[...TEXT_EXT].slice(0, 6).join(', ')} …).`);
  }

  /** Record a text edit or new file as a reviewable change; apply it at once when autonomy allows. */
  async stage(ctx: ToolContext, rel: string, content: string, reason: string, titleOverride?: string) {
    if (!rel) throw new WorkspaceError('write_file needs a path.');
    const r = this.resolve(rel, 'write');
    this.assertEditable(r.abs);
    const pending = this.db.pendingChangeFor(ctx.laneId, r.rel);
    const before = pending ? pending.before : (fs.existsSync(r.abs) ? readText(r.abs) : null);
    if (before !== null && before === content) return { result: `${r.rel} already has this content. Nothing changed.` };
    const kind: Change['kind'] = before === null ? 'create' : 'edit';
    const title = titleOverride ?? (kind === 'create' ? `New file ${path.basename(r.rel)}` : `Edited ${path.basename(r.rel)}`);
    const risk = riskOf(kind, before, content, r.rel, this.modeFor(r.scope));
    const why = reason.trim() || 'No reason given.';
    let change: Change;
    if (pending) {
      this.db.updateChange(pending.id, { after: content, title, reason: why, risk: pending.risk === 'high' ? 'high' : risk });
      change = this.db.getChange(pending.id)!;
    } else {
      change = this.db.addChange({ laneId: ctx.laneId, stepIndex: ctx.stepIndex, filePath: r.rel, kind, title, reason: why, before, after: content, status: 'pending', risk });
    }
    return this.settle(ctx, change, r.scope);
  }

  private async stageMove(ctx: ToolContext, from: string, to: string, reason: string) {
    const a = this.resolve(from, 'write');
    const b = this.resolve(to, 'write');
    if (!fs.existsSync(a.abs)) throw new WorkspaceError(`${a.rel} does not exist.`);
    if (fs.existsSync(b.abs)) throw new WorkspaceError(`${b.rel} already exists. Choose another name.`);
    const change = this.db.addChange({
      laneId: ctx.laneId, stepIndex: ctx.stepIndex, filePath: a.rel, moveTo: b.rel, kind: 'move', title: `Move ${a.rel} → ${b.rel}`,
      reason: reason.trim() || 'No reason given.', before: null, after: null, status: 'pending', risk: this.modeFor(a.scope) === 'edit_ask' ? 'high' : 'low',
    });
    return this.settle(ctx, change, a.scope);
  }

  private async stageDelete(ctx: ToolContext, rel: string, reason: string) {
    const r = this.resolve(rel, 'write');
    if (!fs.existsSync(r.abs) || fs.statSync(r.abs).isDirectory()) throw new WorkspaceError(`${r.rel} is not a file.`);
    const change = this.db.addChange({
      laneId: ctx.laneId, stepIndex: ctx.stepIndex, filePath: r.rel, kind: 'delete', title: `Move ${path.basename(r.rel)} to the Trash`,
      reason: reason.trim() || 'No reason given.', before: null, after: null, status: 'pending', risk: 'high',
    });
    return this.settle(ctx, change, r.scope);
  }

  /** Decide whether a fresh change waits for review or is applied now, and tell the model which. */
  private async settle(ctx: ToolContext, change: Change, scope: string) {
    const folderAsks = this.modeFor(scope) === 'edit_ask';
    const auto = change.kind !== 'delete' && (
      ctx.autonomy === 'autonomous' ? !folderAsks
      : ctx.autonomy === 'ask_if_risky' ? change.risk === 'low' && !folderAsks
      : false);
    if (auto) {
      await this.apply(change);
      this.db.updateChange(change.id, { status: 'auto_applied' });
    } else {
      this.touch(ctx.laneId, change.filePath, 'held');
    }
    this.changed({ changes: ctx.laneId });
    const target = change.moveTo ? `${change.filePath} → ${change.moveTo}` : change.filePath;
    const verb = change.kind === 'create' ? 'Created' : change.kind === 'delete' ? 'Deleted' : change.kind === 'move' ? 'Moved' : 'Edited';
    return auto
      ? { result: `Applied: ${change.title} (${target}).`, log: [verb, `${target} · applied`] as [string, string] }
      : { result: `Staged for the user's review, not applied yet: ${change.title} (${target}). Continue; the user reviews changes in the change list.`, log: [verb, `${target} · held for review`] as [string, string] };
  }

  /* ---------- applying, undoing, restoring ---------- */

  async decide(changeId: string, decision: 'accept' | 'reject' | 'undo') {
    const c = this.db.getChange(changeId);
    if (!c) throw new WorkspaceError('That change no longer exists.');
    if (decision === 'accept') {
      if (c.status !== 'pending') return c;
      await this.apply(c);
      this.db.updateChange(c.id, { status: 'accepted' });
    } else if (decision === 'reject') {
      if (c.status !== 'pending') return c;
      this.db.updateChange(c.id, { status: 'rejected' });
    } else {
      if (c.status === 'accepted' || c.status === 'auto_applied') await this.revert(c);
      this.db.updateChange(c.id, { status: 'pending' });
    }
    this.changed({ changes: c.laneId });
    return this.db.getChange(c.id)!;
  }

  private ensureCheckpoint(laneId: string) {
    return this.db.latestCheckpoint(laneId) ?? this.db.addCheckpoint(laneId, 0, 'Before edits');
  }

  /** Save a file's current bytes (or its absence) in the lane's latest checkpoint, once per checkpoint. */
  private snapshot(laneId: string, rel: string) {
    const cp = this.ensureCheckpoint(laneId);
    if (this.db.hasSnapshot(cp.id, rel)) return;
    const abs = path.join(fs.realpathSync(this.root()!), rel);
    this.db.addSnapshot(cp.id, rel, fs.existsSync(abs) ? this.putBlob(fs.readFileSync(abs)) : null);
    this.changed({ checkpoints: laneId });
  }

  private putBlob(bytes: Buffer) {
    const h = sha(bytes);
    const file = path.join(this.blobDir, h);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return h;
  }

  private async apply(c: Change) {
    const r = this.resolve(c.filePath, 'write');
    const exists = fs.existsSync(r.abs);
    const conflict = () => new WorkspaceError(`${c.filePath} changed on disk after Jarvis prepared this change. Reject it and ask Jarvis again.`);
    if (c.kind === 'edit' && (!exists || readText(r.abs) !== c.before)) throw conflict();
    if (c.kind === 'create' && exists) throw conflict();
    if ((c.kind === 'delete' || c.kind === 'move') && !exists) throw conflict();
    this.snapshot(c.laneId, c.filePath);
    if (c.kind === 'edit' || c.kind === 'create') {
      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      fs.writeFileSync(r.abs, c.after ?? '', 'utf8');
      this.touch(c.laneId, c.filePath, c.kind === 'create' ? 'created' : 'edited');
    } else if (c.kind === 'delete') {
      await this.trash(r.abs);
      this.touch(c.laneId, c.filePath, 'deleted');
    } else {
      const to = this.resolve(c.moveTo!, 'write');
      if (fs.existsSync(to.abs)) throw new WorkspaceError(`${c.moveTo} already exists.`);
      this.snapshot(c.laneId, to.rel);
      fs.mkdirSync(path.dirname(to.abs), { recursive: true });
      fs.renameSync(r.abs, to.abs);
      this.touch(c.laneId, `${c.filePath} → ${c.moveTo}`, 'moved');
    }
  }

  private async revert(c: Change) {
    const r = this.resolve(c.filePath, 'write');
    const changedSince = () => new WorkspaceError(`${c.filePath} changed again after this edit, so it can't be undone safely. Use a checkpoint instead.`);
    if (c.kind === 'edit') {
      if (!fs.existsSync(r.abs) || readText(r.abs) !== c.after) throw changedSince();
      this.snapshot(c.laneId, c.filePath);
      fs.writeFileSync(r.abs, c.before ?? '', 'utf8');
    } else if (c.kind === 'create') {
      if (!fs.existsSync(r.abs) || readText(r.abs) !== c.after) throw changedSince();
      this.snapshot(c.laneId, c.filePath);
      await this.trash(r.abs);
    } else if (c.kind === 'move') {
      const to = this.resolve(c.moveTo!, 'write');
      if (!fs.existsSync(to.abs) || fs.existsSync(r.abs)) throw changedSince();
      this.snapshot(c.laneId, to.rel);
      fs.renameSync(to.abs, r.abs);
    } else {
      throw new WorkspaceError(`${c.filePath} is in the Trash. Put it back from the Trash in Finder, or restore a checkpoint.`);
    }
  }

  /** Put every file this lane changed since the checkpoint back as it was. Undoable: saves a checkpoint first. */
  async restore(checkpointId: string): Promise<{ stepIndex: number; laneId: string; label: string }> {
    const cp = this.db.getCheckpoint(checkpointId);
    if (!cp) throw new WorkspaceError('That checkpoint no longer exists.');
    const root = this.root();
    if (!root) throw new WorkspaceError('The workspace folder is missing.');
    const rootReal = fs.realpathSync(root);
    const targets = this.db.snapshotsSince(cp.laneId, cp.ts);
    // Check access and blobs before touching anything.
    for (const [rel, h] of targets) {
      this.resolve(rel, 'write');
      if (h && !fs.existsSync(path.join(this.blobDir, h))) throw new WorkspaceError(`The saved copy of ${rel} is missing, so this checkpoint can't be restored.`);
    }
    const undoCp = this.db.addCheckpoint(cp.laneId, cp.stepIndex, `Before restore to ${hhmm(cp.ts)}`);
    for (const [rel, h] of targets) {
      const abs = path.join(rootReal, rel);
      this.db.addSnapshot(undoCp.id, rel, fs.existsSync(abs) ? this.putBlob(fs.readFileSync(abs)) : null);
      if (h) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(path.join(this.blobDir, h)));
      } else if (fs.existsSync(abs)) {
        await this.trash(abs);
      }
    }
    this.db.deleteChangesAfter(cp.laneId, cp.ts);
    for (const c of this.db.listChanges(cp.laneId)) {
      if (c.ts >= cp.ts && (c.status === 'accepted' || c.status === 'auto_applied')) this.db.updateChange(c.id, { status: 'rejected' });
    }
    this.changed({ changes: cp.laneId });
    this.changed({ checkpoints: cp.laneId });
    return { stepIndex: cp.stepIndex, laneId: cp.laneId, label: hhmm(cp.ts) };
  }

  touch(laneId: string, rel: string, action: TouchAction) {
    this.db.addTouch(laneId, rel, action, formatOf(rel.split(' → ')[0]));
    this.changed('touches');
  }
}

/* ---------- helpers ---------- */

function realpathLoose(p: string): string {
  // For files that don't exist yet, resolve the nearest existing parent.
  let cur = p;
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

function readText(abs: string) { return fs.readFileSync(abs, 'utf8'); }

async function docxText(abs: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new WorkspaceError('This Word file has no readable text.');
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function short(s: string) { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 40 ? `${t.slice(0, 39)}…` : t; }

/** High risk: big edits, deletions, numbers in financial or legal files, or folders set to "edit · ask". */
export function riskOf(kind: Change['kind'], before: string | null, after: string, rel: string, mode: ScopeMode): 'low' | 'high' {
  if (mode === 'edit_ask') return 'high';
  if (kind === 'create') return 'low';
  const b = before ?? '';
  let i = 0;
  while (i < b.length && i < after.length && b[i] === after[i]) i++;
  let j = 0;
  while (j < b.length - i && j < after.length - i && b[b.length - 1 - j] === after[after.length - 1 - j]) j++;
  const removed = b.slice(i, b.length - j);
  const added = after.slice(i, after.length - j);
  if (removed.length + added.length > 200) return 'high';
  if (removed.length > added.length + 50) return 'high';
  if (RISKY_PATH.test(rel) && /\d/.test(removed + added)) return 'high';
  return 'low';
}
