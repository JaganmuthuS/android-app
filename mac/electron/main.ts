import { app, BrowserWindow, dialog, ipcMain, net, Notification, safeStorage, screen, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent';
import { NEW_LANE_TITLE } from './agent';
import { Db } from './db';
import { Ollama } from './ollama';
import { Workspace } from './workspace';
import { Research } from './research';
import { SWAP_SCRIPT, Updater, bundleVersion } from './updater';
import type { JarvisEvent, ScopeMode, Settings, UiState, UpdateState } from '../shared/types';
import { RECOMMENDED_FAST_MODEL } from '../shared/types';

const DEFAULT_BOUNDS = { width: 1440, height: 900 };
const MIN_SIZE = { width: 1180, height: 720 };

type Bounds = { x?: number; y?: number; width: number; height: number };
type WindowState = { bounds: Bounds; maximized: boolean };

let win: BrowserWindow | null = null;
let db: Db;
let agent: Agent;
let ollama: Ollama;
let workspace: Workspace;
let research: Research;
let updater: Updater;
let update: UpdateState = { state: 'idle' };
const setUpdate = (u: UpdateState) => { update = u; emit({ type: 'update', update }); };

/*
 * GitHub token for private repositories. It lives in a file only your macOS account can read (mode 600)
 * rather than the Keychain: an ad-hoc signed app counts as a new app after every update, so the Keychain
 * asked for your Mac password each time. The token only needs read access to one repository.
 */
const tokenFile = () => path.join(app.getPath('userData'), 'github-token');
function githubToken(): string | null {
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (t) return t;
  } catch { /* none saved in the file yet */ }
  // Moving a token saved by 0.4–0.5 out of the Keychain: one last Keychain prompt, then never again.
  const stored = db.getKv<string | null>('githubToken', null);
  if (!stored || db.getKv('githubTokenMigrated', false)) return null;
  db.setKv('githubTokenMigrated', true);
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const t = safeStorage.decryptString(Buffer.from(stored, 'base64'));
    writeToken(t);
    db.setKv('githubToken', null);
    return t;
  } catch { return null; }
}
function writeToken(t: string) {
  fs.writeFileSync(tokenFile(), t, { mode: 0o600 });
  fs.chmodSync(tokenFile(), 0o600);
}
function saveGithubToken(token: string) {
  const t = token.trim();
  if (!t) { fs.rmSync(tokenFile(), { force: true }); db.setKv('githubToken', null); return; }
  if (!/^[\w-]{20,255}$/.test(t)) throw new Error('That does not look like a GitHub token.');
  writeToken(t);
  db.setKv('githubToken', null);
  db.setKv('githubTokenMigrated', true);
}

async function checkForUpdate(): Promise<UpdateState> {
  if (update.state === 'downloading' || update.state === 'installing') return update;
  setUpdate({ ...update, state: 'checking' });
  const res = await updater.check();
  setUpdate(res);
  return res;
}

/** Download, unpack, verify, then quit and let a small script swap the app and reopen it. */
async function installUpdate() {
  if (update.state !== 'available' || !update.info) throw new Error('There is no update to install.');
  const info = update.info;
  if (!process.env.JARVIS_UPDATE_DRYRUN && (process.platform !== 'darwin' || !app.isPackaged)) {
    throw new Error('Updates install only in the JARVIS app itself.');
  }
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  try {
    setUpdate({ state: 'downloading', info, progress: 0 });
    const zip = await updater.download(info, (progress) => setUpdate({ state: 'downloading', info, progress }));
    setUpdate({ state: 'installing', info, progress: 1 });
    if (process.env.JARVIS_UPDATE_DRYRUN) return; // tests stop before touching the app
    if (!bundle.endsWith('.app')) throw new Error('JARVIS is not running from an app bundle.');
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch {
      throw new Error(`JARVIS can't replace itself in ${path.dirname(bundle)}. Move JARVIS into Applications and try again.`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-update-'));
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', zip, tmp], (err) => (err ? reject(new Error('The update could not be unpacked.')) : resolve())));
    const fresh = path.join(tmp, 'JARVIS.app');
    const v = bundleVersion(fresh);
    if (v !== info.version) throw new Error(`The download contained version ${v ?? 'unknown'} instead of ${info.version}.`);
    const script = path.join(tmp, 'swap.sh');
    fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    spawn('/bin/bash', [script, bundle, fresh, String(process.pid), tmp], { detached: true, stdio: 'ignore' }).unref();
    fs.rmSync(zip, { force: true });
    app.quit();
  } catch (e) {
    setUpdate({ state: 'error', info, error: (e as Error).message });
    throw e;
  }
}

const emit = (e: JarvisEvent) => { if (win && !win.isDestroyed()) win.webContents.send('jarvis:event', e); };

/** Keep a restored window on a connected display; fall back to the default size otherwise. */
function visibleBounds(b: Bounds): Bounds {
  if (b.x === undefined || b.y === undefined) return b;
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x! >= w.x - 50 && b.y! >= w.y - 50 && b.x! < w.x + w.width - 100 && b.y! < w.y + w.height - 100);
  return onScreen ? b : { width: b.width, height: b.height };
}

let lastWarm = 0;
/** Keep the model loaded so the first answer doesn't wait for it: at launch, when JARVIS comes to the front, after a download. */
async function warmModel(force = false) {
  if (!force && Date.now() - lastWarm < 10 * 60 * 1000) return;
  lastWarm = Date.now();
  const s = db.getSettings();
  const status = await ollama.status(s.model);
  if (!status.reachable) return;
  const installed = (m: string) => status.models.some((x) => x.name === m || x.name === `${m}:latest`);
  // The fast model first: it answers most quick requests. Both fit in memory on a 16 GB Mac.
  for (const m of [s.fastModel, s.model]) if (m && installed(m)) await ollama.warm(m);
}

/**
 * 0.6 defaults, once: work autonomously (edits apply at once, with backups and Undo; deleting and
 * sending still ask), and on Macs with 16 GB or more, a fast model for routine requests.
 */
async function upgradeTo06() {
  if (db.getKv('defaults-0.6', false) || process.env.JARVIS_KEEP_DEFAULTS === '1') return;
  db.setKv('defaults-0.6', true);
  const memory = Number(process.env.JARVIS_TEST_MEMORY_GB) * 1024 ** 3 || os.totalmem();
  const big = memory >= 15 * 1024 ** 3;
  db.setSettings({ autonomy: 'autonomous', ...(big && !db.getSettings().fastModel ? { fastModel: RECOMMENDED_FAST_MODEL } : {}) });
  for (const lane of db.listLanes()) db.updateLane(lane.id, { autonomy: 'autonomous' });
  for (const sc of db.listScopes()) if (sc.mode === 'edit_ask') db.setScope(sc.path, 'edit_auto');
  emit({ type: 'settings', settings: db.getSettings() });
  emit({ type: 'lanes', lanes: db.listLanes() });
  emit({ type: 'scopes', scopes: workspace.syncScopes() });
  await ensureFastModel();
}

/** Download the fast model in the background if it is set but missing (once per model). */
async function ensureFastModel() {
  const s = db.getSettings();
  if (!s.fastModel || s.fastModel === s.model || db.getKv(`pulled-${s.fastModel}`, false)) return;
  const status = await ollama.status(s.fastModel);
  if (!status.reachable) return;
  if (status.modelInstalled) { db.setKv(`pulled-${s.fastModel}`, true); return; }
  db.setKv(`pulled-${s.fastModel}`, true);
  await ollama.pull(s.fastModel, (progress) => emit({ type: 'pull', progress }))
    .then(() => warmModel(true))
    .catch(() => db.setKv(`pulled-${s.fastModel}`, false));
}

function createWindow() {
  const saved = db.getKv<WindowState>('window', { bounds: DEFAULT_BOUNDS, maximized: false });
  const bounds = visibleBounds(saved.bounds);
  win = new BrowserWindow({
    ...bounds,
    width: Math.max(bounds.width, MIN_SIZE.width),
    height: Math.max(bounds.height, MIN_SIZE.height),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'JARVIS',
    backgroundColor: '#f3f2f2',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 19 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--jarvis-version=${app.getVersion()}`],
    },
  });
  const w = win;
  if (saved.maximized) w.maximize();
  w.once('ready-to-show', () => w.show());

  const save = () => { if (!w.isDestroyed()) db.setKv('window', { bounds: w.getNormalBounds(), maximized: w.isMaximized() }); };
  let timer: NodeJS.Timeout | undefined;
  const saveSoon = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  w.on('resize', saveSoon);
  w.on('move', saveSoon);
  w.on('close', save);
  w.on('closed', () => { if (win === w) win = null; });

  // Links open in the default browser; the app window never navigates away.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => { if (url !== w.webContents.getURL()) e.preventDefault(); });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
}

function notify(title: string, body: string) {
  if (win?.isFocused() || !Notification.isSupported()) return;
  new Notification({ title: `JARVIS · ${title}`, body }).show();
}

/** Every IPC handler goes through here so errors come back as plain messages. */
function handle(channel: string, fn: (...args: never[]) => unknown) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      throw new Error((err as Error).message);
    }
  });
}

const str = (v: unknown, max = 20000) => { if (typeof v !== 'string') throw new Error('Expected text.'); return v.slice(0, max); };

function registerIpc() {
  handle('ui:get', () => db.getKv<UiState>('ui', { laneId: null, tab: 'doc' }));
  handle('ui:set', (patch: Partial<UiState>) => {
    const cur = db.getKv<UiState>('ui', { laneId: null, tab: 'doc' });
    const next: UiState = {
      laneId: patch.laneId === null || typeof patch.laneId === 'string' ? patch.laneId : cur.laneId,
      tab: patch.tab === 'doc' || patch.tab === 'research' || patch.tab === 'files' ? patch.tab : cur.tab,
    };
    db.setKv('ui', next);
    return next;
  });

  handle('lanes:list', () => db.listLanes());
  handle('lanes:create', () => {
    const lane = db.createLane(NEW_LANE_TITLE, db.getSettings().autonomy);
    agent.emitLanes();
    return lane;
  });
  handle('lanes:delete', (id: string) => agent.deleteLane(str(id)));
  handle('lanes:autonomy', (id: string, a: Settings['autonomy']) => {
    if (!['ask_every_change', 'ask_if_risky', 'autonomous'].includes(a)) throw new Error('Unknown autonomy level.');
    db.updateLane(str(id), { autonomy: a });
    agent.emitLanes();
  });
  handle('messages:list', (id: string) => db.listMessages(str(id)));
  handle('steps:list', (id: string) => db.listSteps(str(id)));

  // Long-running agent work is started here and reported through events.
  const fireAndReport = (p: Promise<void>) => p.catch((e) => console.error(e));
  handle('chat:send', (id: string, text: string) => {
    const lane = db.getLane(str(id));
    if (!lane) throw new Error('That lane no longer exists.');
    if (lane.status === 'planning' || lane.status === 'running') throw new Error('Jarvis is still working in this lane. Stop it first, or wait for the current step to finish.');
    void fireAndReport(agent.send(id, str(text)));
  });
  handle('plan:approve', (id: string) => { void fireAndReport(agent.approvePlan(str(id))); });
  handle('plan:update', (id: string, steps: { text: string; requiresGate: boolean }[]) => {
    if (!Array.isArray(steps)) throw new Error('Expected a list of steps.');
    agent.updatePlan(str(id), steps.map((s) => ({ text: str(s.text, 500), requiresGate: !!s.requiresGate })));
  });
  handle('gate:approve', (id: string) => { void fireAndReport(agent.approveGate(str(id))); });
  handle('gate:skip', (id: string) => { void fireAndReport(agent.skipGate(str(id))); });
  handle('lane:stop', (id: string) => agent.stop(str(id)));
  handle('lane:resume', (id: string) => { void fireAndReport(agent.resume(str(id))); });

  handle('settings:get', () => db.getSettings());
  handle('settings:set', (patch: Partial<Settings>) => {
    const clean: Partial<Settings> = {};
    if (typeof patch.ollamaUrl === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(patch.ollamaUrl)) clean.ollamaUrl = patch.ollamaUrl;
    if (typeof patch.model === 'string' && /^[\w.:/-]{1,100}$/.test(patch.model)) clean.model = patch.model;
    if (['ask_every_change', 'ask_if_risky', 'autonomous'].includes(patch.autonomy as string)) clean.autonomy = patch.autonomy;
    if (Number.isInteger(patch.maxParallel) && patch.maxParallel! >= 1 && patch.maxParallel! <= 4) clean.maxParallel = patch.maxParallel;
    if (typeof patch.webAccess === 'boolean') clean.webAccess = patch.webAccess;
    if (['auto', 'on', 'off'].includes(patch.thinking as string)) clean.thinking = patch.thinking;
    if (typeof patch.fastModel === 'string' && /^[\w.:/-]{0,100}$/.test(patch.fastModel)) clean.fastModel = patch.fastModel;
    const modelChanged = (clean.model && clean.model !== db.getSettings().model) || (clean.fastModel && clean.fastModel !== db.getSettings().fastModel);
    const s = db.setSettings(clean);
    emit({ type: 'settings', settings: s });
    if (modelChanged) void ensureFastModel().then(() => warmModel(true));
    return s;
  });
  handle('engine:status', () => ollama.status(db.getSettings().model));
  handle('engine:pull', (model: string) => {
    const m = str(model, 100);
    void ollama.pull(m, (progress) => { emit({ type: 'pull', progress }); if (progress.done && !progress.error) void warmModel(true); })
      .catch((e) => emit({ type: 'pull', progress: { model: m, status: '', done: true, error: (e as Error).message || 'Download failed.' } }));
  });

  handle('memory:list', () => db.listMemories());
  handle('memory:add', (text: string) => { db.addMemory(str(text, 500).trim()); emit({ type: 'memories', memories: db.listMemories() }); });
  handle('memory:update', (id: string, patch: { text?: string; enabled?: boolean }) => {
    db.updateMemory(str(id), { text: patch.text === undefined ? undefined : str(patch.text, 500), enabled: patch.enabled === undefined ? undefined : !!patch.enabled });
    emit({ type: 'memories', memories: db.listMemories() });
  });
  handle('memory:delete', (id: string) => { db.deleteMemory(str(id)); emit({ type: 'memories', memories: db.listMemories() }); });

  handle('workspace:choose', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose the folder Jarvis works in',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    workspace.setRoot(res.filePaths[0]);
    const choice = await dialog.showMessageBox(win!, {
      type: 'question',
      message: `What may Jarvis do in “${path.basename(res.filePaths[0])}”?`,
      detail: 'This applies to the folder and every folder inside it. You can change any folder later in Folder access.',
      buttons: ['Edit (changes apply at once; every change can be undone)', 'Edit, but ask me before every change', 'Read only', 'Nothing yet, I will choose per folder'],
      defaultId: 0,
      cancelId: 3,
    });
    workspace.setAll((['edit_auto', 'edit_ask', 'read', 'none'] as const)[choice.response] ?? 'none');
    const s = db.getSettings();
    emit({ type: 'settings', settings: s });
    return s;
  });
  handle('scopes:list', () => workspace.syncScopes());
  handle('scopes:set', (p: string, mode: ScopeMode) => {
    if (!['none', 'read', 'edit_ask', 'edit_auto'].includes(mode)) throw new Error('Unknown access level.');
    const scope = str(p, 300);
    if (!workspace.syncScopes().some((x) => x.path === scope)) throw new Error('That folder is not in the workspace.');
    db.setScope(scope, mode);
    emit({ type: 'scopes', scopes: workspace.syncScopes() });
  });
  handle('scopes:setAll', (mode: ScopeMode) => {
    if (!['none', 'read', 'edit_ask', 'edit_auto'].includes(mode)) throw new Error('Unknown access level.');
    workspace.setAll(mode);
  });
  handle('changes:list', (id: string) => db.listChanges(str(id)));
  handle('changes:decide', async (id: string, decision: 'accept' | 'reject' | 'undo') => {
    if (!['accept', 'reject', 'undo'].includes(decision)) throw new Error('Unknown decision.');
    const c = await workspace.decide(str(id), decision);
    agent.changesUpdated(c.laneId);
  });
  handle('changes:acceptAll', async (laneId: string) => {
    const errors: string[] = [];
    for (const c of db.listChanges(str(laneId)).filter((x) => x.status === 'pending')) {
      try { await workspace.decide(c.id, 'accept'); } catch (e) { errors.push((e as Error).message); }
    }
    agent.changesUpdated(laneId);
    if (errors.length) throw new Error(errors.join(' '));
  });
  handle('checkpoints:list', (id: string) => db.listCheckpoints(str(id)));
  handle('checkpoints:restore', (id: string) => agent.restoreCheckpoint(str(id)));
  handle('touches:list', () => db.listTouches());
  handle('sources:list', (laneId: string) => ({ sources: db.listSources(str(laneId, 100)), searches: db.listSearches(str(laneId, 100)) }));
  handle('diagnose', async () => {
    const lines = workspace.diagnose();
    const s = db.getSettings();
    const status = await ollama.status(s.model);
    lines.push({ ok: status.reachable, label: 'Ollama is running', detail: status.reachable ? `version ${status.version}` : 'Open the Ollama app.' });
    if (status.reachable) {
      lines.push({ ok: status.modelInstalled, label: `Model ${s.model} is downloaded`, detail: status.modelInstalled ? undefined : 'Download it in Settings.' });
      if (status.modelInstalled) {
        const caps = await ollama.capabilities(s.model);
        const tools = caps.length ? caps.includes('tools') : null;
        lines.push({ ok: tools !== false, label: `${s.model} can use file tools`, detail: tools === null ? 'Ollama did not say; update Ollama to check.' : tools ? undefined : 'Choose qwen3:8b or qwen3:4b in Settings.' });
        if (tools !== false) {
          try {
            const res = await ollama.round({
              model: s.model,
              messages: [{ role: 'system', content: 'You can call tools.' }, { role: 'user', content: 'List the files at the top of the workspace. Use the list_dir tool with path ".".' }],
              tools: [{ type: 'function', function: { name: 'list_dir', description: 'List files in a folder', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder' } }, required: ['path'] } } }],
              signal: AbortSignal.timeout(90_000),
            });
            const used = res.toolCalls.length > 0;
            lines.push({ ok: used, label: 'The model actually calls file tools', detail: used ? `called ${res.toolCalls[0].function.name}` : `It answered in text instead: “${res.content.slice(0, 120)}”. Try qwen3:8b.` });
          } catch (e) {
            lines.push({ ok: false, label: 'The model actually calls file tools', detail: (e as Error).message });
          }
        }
      }
    }
    if (s.webAccess) lines.push(await research.probe());
    else lines.push({ ok: true, label: 'Web research is off', detail: 'Turn it on in Settings → Behaviour.' });
    return { version: app.getVersion(), lines };
  });
  handle('update:check', () => checkForUpdate());
  handle('update:install', () => installUpdate());
  handle('update:status', () => ({ ...update, hasToken: !!githubToken(), packaged: app.isPackaged }));
  handle('update:token', async (t: string) => { saveGithubToken(str(t, 300)); await checkForUpdate(); });
  handle('open:privacy', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'));
  handle('audit:export', async () => {
    const res = await dialog.showSaveDialog(win!, { title: 'Export the audit log', defaultPath: `jarvis-audit-${new Date().toISOString().slice(0, 10)}.csv` });
    if (res.canceled || !res.filePath) return null;
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lanes = new Map(db.listLanes().map((l) => [l.id, l.title]));
    const rows = db.listAudit().map((a) => [new Date(a.ts).toISOString(), lanes.get(a.laneId) ?? a.laneId, a.tool, a.path, a.result].map(q).join(','));
    fs.writeFileSync(res.filePath, ['time,lane,tool,path,result', ...rows].join('\n'));
    return res.filePath;
  });

  handle('data:deleteAll', () => {
    for (const l of db.listLanes()) agent.stop(l.id);
    db.deleteAll();
    agent.emitLanes();
    emit({ type: 'memories', memories: [] });
    emit({ type: 'settings', settings: db.getSettings() });
  });
  handle('open:external', (url: string) => {
    const u = str(url, 2000);
    if (!/^https:\/\//.test(u)) throw new Error('Only web links can be opened.');
    return shell.openExternal(u);
  });
}

app.whenReady().then(() => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  db = new Db(path.join(app.getPath('userData'), 'jarvis.db'));
  ollama = new Ollama(() => process.env.JARVIS_OLLAMA_URL || db.getSettings().ollamaUrl);
  workspace = new Workspace(db, path.join(app.getPath('userData'), 'snapshots'), (abs) => shell.trashItem(abs), (what) => {
    if (what === 'scopes') emit({ type: 'scopes', scopes: workspace.syncScopes() });
    else if (what === 'touches') emit({ type: 'touches', touches: db.listTouches() });
    else if ('changes' in what) emit({ type: 'changes', laneId: what.changes, changes: db.listChanges(what.changes) });
    else emit({ type: 'checkpoints', laneId: what.checkpoints, checkpoints: db.listCheckpoints(what.checkpoints) });
  });
  if (process.env.JARVIS_WORKSPACE && !db.getSettings().workspace) workspace.setRoot(process.env.JARVIS_WORKSPACE);
  // Chromium's network stack: uses the Mac's proxy settings and certificates.
  research = new Research(db, emit, {
    fetch: (url, init) => net.fetch(url, init),
    searchUrl: process.env.JARVIS_SEARCH_URL,
    wikipediaUrl: process.env.JARVIS_WIKIPEDIA_URL,
    allowPrivate: process.env.JARVIS_ALLOW_LOCAL_WEB === '1',
  });
  agent = new Agent(db, ollama, emit, notify, workspace, research);
  updater = new Updater({
    current: app.getVersion(),
    arch: process.arch,
    token: githubToken,
    downloadDir: path.join(app.getPath('userData'), 'updates'),
    apiBase: process.env.JARVIS_UPDATE_API,
  });
  // Look for updates shortly after launch and every six hours.
  setTimeout(() => { void checkForUpdate(); }, 8_000);
  setInterval(() => { void checkForUpdate(); }, 6 * 60 * 60 * 1000);
  agent.recover();
  registerIpc();
  createWindow();
  void upgradeTo06().then(() => warmModel(true));
  app.on('browser-window-focus', () => { void warmModel(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { try { db?.close(); } catch { /* already closed */ } });
