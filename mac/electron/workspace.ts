// The only way the agent touches the disk: scope checks, file tools, staged changes, checkpoints.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import type { Db } from './db';
import type { Autonomy, Change, FileScope, ScopeMode, TouchAction } from '../shared/types';

export class ScopeError extends Error {
  constructor(message: string, public scopePath: string, public needs: ScopeMode) { super(message); }
}
export class WorkspaceError extends Error {}
/** macOS (not Jarvis's folder access) refused: the app needs permission in System Settings. */
export class OsPermissionError extends WorkspaceError {}

export const isOsDenied = (e: unknown) => ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '');
export function osDeniedMessage(where: string) {
  return `macOS is not letting JARVIS open ${where}. Open System Settings → Privacy & Security → Files and Folders (or Full Disk Access), allow JARVIS, then quit and reopen JARVIS.`;
}

type Op = 'read' | 'write';
export interface ToolContext { laneId: string; stepIndex: number | null; autonomy: Autonomy }

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yml', '.yaml', '.log', '.ini', '.toml', '.rtf', '.tex', '.js', '.ts', '.py', '.css', '.sql', '.sh']);
const LATER_EXT: Record<string, string> = { '.xlsx': 'Excel', '.xls': 'Excel', '.pptx': 'PowerPoint', '.ppt': 'PowerPoint', '.pdf': 'PDF', '.doc': 'old Word' };
const SKIP_DIRS = new Set(['node_modules', '.git', '.jarvis']);
const MAX_READ = 60_000;
const RISKY_PATH = /financ|legal|contract|invoice|budget|board|payroll|tax/i;
const DIR_MARK = 'dir:';

/** Local models sometimes use other names for the same tool or argument. */
const TOOL_ALIASES: Record<string, string> = {
  mkdir: 'create_folder', make_folder: 'create_folder', create_directory: 'create_folder', make_directory: 'create_folder', new_folder: 'create_folder',
  list_files: 'list_dir', list_folder: 'list_dir', ls: 'list_dir', list_directory: 'list_dir',
  read: 'read_file', open_file: 'read_file', write: 'write_file', create_file: 'write_file', save_file: 'write_file',
  edit_file: 'replace_text', rename_file: 'move_file', move: 'move_file', rename: 'move_file', remove_file: 'delete_file', delete: 'delete_file',
  search: 'search_files', find_files: 'search_files',
};
const PATH_TOOLS = new Set(['read_file', 'write_file', 'replace_text', 'delete_file', 'create_folder']);
const ARG_ALIASES: Record<string, string[]> = {
  path: ['path', 'file', 'file_path', 'filepath', 'filename', 'file_name', 'folder', 'folder_path', 'folder_name', 'dir', 'directory', 'directory_path', 'name', 'target_path'],
  from: ['from', 'source', 'src', 'old_path', 'from_path'],
  to: ['to', 'destination', 'dest', 'new_path', 'to_path', 'target'],
  content: ['content', 'contents', 'text', 'body', 'data'],
  find: ['find', 'old', 'old_text', 'search', 'old_string'],
  replace: ['replace', 'new', 'new_text', 'replacement', 'new_string'],
  query: ['query', 'q', 'pattern', 'term', 'keyword'],
  reason: ['reason', 'why', 'explanation', 'description'],
};
function normaliseArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, names] of Object.entries(ARG_ALIASES)) {
    if (out[key] != null && out[key] !== '') continue;
    const hit = names.find((n) => a[n] != null && a[n] !== '');
    if (hit) out[key] = a[hit];
  }
  return out;
}

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

  /** True when macOS refused to list the workspace the last time we tried. */
  osBlocked = false;

  root(): string | null {
    const w = this.db.getSettings().workspace;
    return w && fs.existsSync(w) ? w : null;
  }

  /** Make sure every top-level folder has an access row. New folders start with no access. */
  syncScopes(): FileScope[] {
    const root = this.root();
    if (!root) return [];
    const have = new Map(this.db.listScopes().map((s) => [s.path, s.mode]));
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map((d) => d.name);
    } catch (e) {
      if (isOsDenied(e)) { this.osBlocked = true; return this.db.listScopes(); }
      throw e;
    }
    this.osBlocked = false;
    if (!have.has('')) this.db.setScope('', 'none');
    const inherit = have.get('') ?? 'none';
    for (const p of dirs) if (!have.has(p)) this.db.setScope(p, inherit);
    const keep = new Set(['', ...dirs]);
    return this.db.listScopes().filter((s) => keep.has(s.path));
  }

  setRoot(dir: string) {
    this.db.setSettings({ workspace: dir });
    this.db.clearScopes();
    this.syncScopes();
    this.changed('scopes');
  }

  setAll(mode: ScopeMode) {
    for (const s of this.syncScopes()) this.db.setScope(s.path, mode);
    this.changed('scopes');
  }

  private isDir(rel: string) {
    const root = this.root();
    try { return !!root && fs.statSync(path.join(root, rel)).isDirectory(); } catch { return false; }
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
    let cleaned = String(rel ?? '').trim().replace(/^["'`]|["'`]$/g, '').replace(/^(\.\/)+/, '') || '.';
    if (cleaned === '~' || cleaned.startsWith('~/')) cleaned = path.join(os.homedir(), cleaned.slice(1));
    // Models often repeat the workspace's own name ("MyFolder/Notes" when MyFolder is the workspace).
    const own = path.basename(rootReal);
    const head = cleaned.split(/[\\/]/)[0];
    if (!path.isAbsolute(cleaned) && head === own && !fs.existsSync(path.join(rootReal, own))) {
      cleaned = cleaned.slice(own.length).replace(/^[\\/]+/, '') || '.';
    }
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
    // A top-level folder that doesn't exist yet would be created inside the main folder, so the main folder's access applies.
    const known = this.db.listScopes().some((x) => x.path === scope);
    const mode = known || !scope || fs.existsSync(path.join(rootReal, scope)) ? this.modeFor(scope) : this.modeFor('');
    const label = scope ? `${scope}/` : 'the main folder (top level)';
    const fix = scope ? '' : ' Set "Main folder" in Folder access, or use Set all.';
    if (op === 'read' && mode === 'none') throw new ScopeError(`Jarvis has no access to ${label}${relative && scope !== relative ? ` (needed for ${relative})` : ''}.${fix}`, scope, 'read');
    if (op === 'write' && (mode === 'none' || mode === 'read')) {
      throw new ScopeError(`${label} is ${mode === 'read' ? 'read only' : 'not accessible'}, so Jarvis can't change ${relative || 'it'}.${fix}`, scope, 'edit_ask');
    }
    return { abs: real, rel: relative, scope };
  }

  /** Readable files (two levels deep), so the model knows what exists before it calls a tool. */
  overview(limit = 80): string {
    const root = this.root();
    if (!root) return '';
    const out: string[] = [];
    let rootReal: string;
    try { rootReal = fs.realpathSync(root); } catch { return ''; }
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= limit) return;
        if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
        const rel = path.relative(rootReal, path.join(dir, d.name));
        try { this.resolve(rel, 'read'); } catch { continue; }
        out.push(d.isDirectory() ? `${rel}/` : rel);
        if (d.isDirectory() && depth < 2) walk(path.join(dir, d.name), depth + 1);
      }
    };
    walk(rootReal, 1);
    return out.length ? `Files Jarvis can read right now (partial list):\n${out.join('\n')}${out.length >= limit ? '\n…' : ''}` : '';
  }

  /** Read files the user names in a message (by path or file name), so a small model has them in front of it. */
  async attachMentioned(laneId: string, text: string, maxFiles = 3, maxChars = 12_000): Promise<string> {
    const root = this.root();
    if (!root) return '';
    const wanted = new Set((text.match(/[\w./~-]+\.[A-Za-z0-9]{1,6}\b/g) ?? []).map((t) => t.replace(/^\.\//, '')));
    if (!wanted.size) return '';
    const rootReal = fs.realpathSync(root);
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        if (found.length >= maxFiles || d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
        const rel = path.relative(rootReal, path.join(dir, d.name));
        if (d.isDirectory()) { if (depth < 4) walk(path.join(dir, d.name), depth + 1); continue; }
        if (wanted.has(rel) || wanted.has(d.name)) found.push(rel);
      }
    };
    walk(rootReal, 1);
    const parts: string[] = [];
    for (const rel of found) {
      try {
        const { result } = await this.exec('read_file', { path: rel }, { laneId, stepIndex: null, autonomy: 'ask_every_change' });
        parts.push(`--- ${rel} ---\n${result.slice(0, maxChars)}`);
      } catch { /* not readable: the model will be told when it tries */ }
    }
    return parts.length ? `The user mentioned these files; their current content:\n${parts.join('\n\n')}` : '';
  }

  /** Plain checks of what the OS and folder access allow, for Settings → Check file access. */
  diagnose(): { ok: boolean; label: string; detail?: string }[] {
    const out: { ok: boolean; label: string; detail?: string }[] = [];
    const root = this.db.getSettings().workspace;
    if (!root) return [{ ok: false, label: 'Workspace folder', detail: 'None chosen. Click "Workspace" in the title bar.' }];
    if (!fs.existsSync(root)) return [{ ok: false, label: 'Workspace folder', detail: `${root} no longer exists. Choose it again.` }];
    out.push({ ok: true, label: 'Workspace folder', detail: root });
    try {
      fs.readdirSync(root);
      out.push({ ok: true, label: 'macOS lets JARVIS open the workspace' });
    } catch (e) {
      out.push({ ok: false, label: 'macOS lets JARVIS open the workspace', detail: isOsDenied(e) ? osDeniedMessage('the workspace folder') : (e as Error).message });
      return out;
    }
    for (const s of this.syncScopes()) {
      const name = s.path ? `${s.path}/` : 'Main folder';
      const abs = path.join(root, s.path);
      if (s.mode === 'none') { out.push({ ok: true, label: `${name}: no access (by your choice)` }); continue; }
      try { fs.readdirSync(abs); } catch (e) {
        out.push({ ok: false, label: `${name}: read`, detail: isOsDenied(e) ? osDeniedMessage(name) : (e as Error).message });
        continue;
      }
      if (s.mode === 'read') { out.push({ ok: true, label: `${name}: read` }); continue; }
      const probe = path.join(abs, `.jarvis-check-${process.pid}`);
      try {
        fs.writeFileSync(probe, 'check');
        fs.rmSync(probe);
        out.push({ ok: true, label: `${name}: read and write${s.mode === 'edit_ask' ? ' (changes wait for your Accept)' : ''}` });
      } catch (e) {
        out.push({ ok: false, label: `${name}: write`, detail: isOsDenied(e) ? osDeniedMessage(name) : (e as Error).message });
      }
    }
    return out;
  }

  /* ---------- tools ---------- */

  async exec(rawName: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<{ result: string; log?: [string, string] }> {
    const name = TOOL_ALIASES[rawName] ?? rawName;
    const args = normaliseArgs(rawArgs ?? {});
    const p = (k: string) => String(args[k] ?? '');
    const target = p('path') || p('from') || '.';
    if (PATH_TOOLS.has(name) && !p('path')) {
      const msg = `${name} needs a "path" argument, e.g. {"path": "Notes/2026"}.`;
      this.db.addAudit(ctx.laneId, name, '(none)', `error: ${msg}`);
      throw new WorkspaceError(msg);
    }
    try {
      const out = await this.run(name, args, ctx).catch((err) => {
        throw isOsDenied(err) ? new OsPermissionError(osDeniedMessage(target === '.' ? 'the workspace folder' : target)) : err;
      });
      this.db.addAudit(ctx.laneId, name, target, 'ok');
      return out;
    } catch (e) {
      const denied = e instanceof ScopeError;
      this.db.addAudit(ctx.laneId, name, target, `${denied ? 'denied' : 'error'}: ${(e as Error).message}`);
      if (denied) { this.touch(ctx.laneId, target, 'denied', (e as Error).message); }
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
      case 'create_folder': return this.stageFolder(ctx, s('path'), s('reason'));
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

  private async stageFolder(ctx: ToolContext, rel: string, reason: string) {
    if (!rel || rel === '.') throw new WorkspaceError('create_folder needs a folder path, e.g. Notes/2026.');
    const r = this.resolve(rel, 'write');
    if (fs.existsSync(r.abs)) {
      if (fs.statSync(r.abs).isDirectory()) return { result: `The folder ${r.rel}/ already exists.` };
      throw new WorkspaceError(`${r.rel} already exists as a file.`);
    }
    if (this.db.listChanges(ctx.laneId).some((c) => c.kind === 'mkdir' && c.filePath === r.rel && c.status === 'pending')) {
      return { result: `Creating ${r.rel}/ is already waiting for the user's review.` };
    }
    const change = this.db.addChange({
      laneId: ctx.laneId, stepIndex: ctx.stepIndex, filePath: r.rel, kind: 'mkdir', title: `New folder ${r.rel}/`,
      reason: reason.trim() || 'No reason given.', before: null, after: null, status: 'pending', risk: 'low',
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
    const verb = change.kind === 'create' || change.kind === 'mkdir' ? 'Created' : change.kind === 'delete' ? 'Deleted' : change.kind === 'move' ? 'Moved' : 'Edited';
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
    this.db.addSnapshot(cp.id, rel, this.capture(abs));
    this.changed({ checkpoints: laneId });
  }

  /** What a checkpoint stores for a path: a content hash, a folder marker, or null when it doesn't exist. */
  private capture(abs: string): string | null {
    if (!fs.existsSync(abs)) return null;
    if (fs.statSync(abs).isDirectory()) return DIR_MARK;
    return this.putBlob(fs.readFileSync(abs));
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
    if (c.kind === 'mkdir') {
      if (exists && fs.statSync(r.abs).isDirectory()) return;
      if (exists) throw conflict();
      this.snapshot(c.laneId, c.filePath);
      fs.mkdirSync(r.abs, { recursive: true });
      this.touch(c.laneId, `${c.filePath}/`, 'created');
      if (!c.filePath.includes(path.sep) && !c.filePath.includes('/')) this.changed('scopes');
      return;
    }
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
    } else if (c.kind === 'mkdir') {
      if (!fs.existsSync(r.abs)) return;
      if (fs.readdirSync(r.abs).length) throw new WorkspaceError(`${c.filePath}/ is no longer empty, so it can't be removed. Use a checkpoint instead.`);
      this.snapshot(c.laneId, c.filePath);
      fs.rmdirSync(r.abs);
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
      if (h && h !== DIR_MARK && !fs.existsSync(path.join(this.blobDir, h))) throw new WorkspaceError(`The saved copy of ${rel} is missing, so this checkpoint can't be restored.`);
    }
    const undoCp = this.db.addCheckpoint(cp.laneId, cp.stepIndex, `Before restore to ${hhmm(cp.ts)}`);
    // Folders are restored before the files inside them; removals happen deepest first.
    const ordered = [...targets].sort(([a], [b]) => a.length - b.length);
    for (const [rel] of ordered) this.db.addSnapshot(undoCp.id, rel, this.capture(path.join(rootReal, rel)));
    for (const [rel, h] of ordered) {
      const abs = path.join(rootReal, rel);
      if (h === DIR_MARK) fs.mkdirSync(abs, { recursive: true });
      else if (h) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(path.join(this.blobDir, h)));
      }
    }
    for (const [rel, h] of [...ordered].reverse()) {
      const abs = path.join(rootReal, rel);
      if (h === null && fs.existsSync(abs)) await this.trash(abs);
    }
    this.db.deleteChangesAfter(cp.laneId, cp.ts);
    for (const c of this.db.listChanges(cp.laneId)) {
      if (c.ts >= cp.ts && (c.status === 'accepted' || c.status === 'auto_applied')) this.db.updateChange(c.id, { status: 'rejected' });
    }
    this.changed({ changes: cp.laneId });
    this.changed({ checkpoints: cp.laneId });
    return { stepIndex: cp.stepIndex, laneId: cp.laneId, label: hhmm(cp.ts) };
  }

  touch(laneId: string, rel: string, action: TouchAction, detail = '') {
    const shown = rel === '.' || rel === '' ? '(main folder)' : rel;
    const isDir = rel.endsWith('/') || rel === '.' || rel === '' || (!path.extname(rel) && this.isDir(rel));
    this.db.addTouch(laneId, shown, action, isDir ? 'Folder' : formatOf(rel.split(' → ')[0]), detail);
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
