import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent';
import { NEW_LANE_TITLE } from './agent';
import { Db } from './db';
import { Ollama } from './ollama';
import { Workspace } from './workspace';
import type { JarvisEvent, ScopeMode, Settings, UiState } from '../shared/types';

const DEFAULT_BOUNDS = { width: 1440, height: 900 };
const MIN_SIZE = { width: 1180, height: 720 };

type Bounds = { x?: number; y?: number; width: number; height: number };
type WindowState = { bounds: Bounds; maximized: boolean };

let win: BrowserWindow | null = null;
let db: Db;
let agent: Agent;
let ollama: Ollama;
let workspace: Workspace;

const emit = (e: JarvisEvent) => { if (win && !win.isDestroyed()) win.webContents.send('jarvis:event', e); };

/** Keep a restored window on a connected display; fall back to the default size otherwise. */
function visibleBounds(b: Bounds): Bounds {
  if (b.x === undefined || b.y === undefined) return b;
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x! >= w.x - 50 && b.y! >= w.y - 50 && b.x! < w.x + w.width - 100 && b.y! < w.y + w.height - 100);
  return onScreen ? b : { width: b.width, height: b.height };
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
    const s = db.setSettings(clean);
    emit({ type: 'settings', settings: s });
    return s;
  });
  handle('engine:status', () => ollama.status(db.getSettings().model));
  handle('engine:pull', (model: string) => {
    const m = str(model, 100);
    void ollama.pull(m, (progress) => emit({ type: 'pull', progress }))
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
  agent = new Agent(db, ollama, emit, notify, workspace);
  agent.recover();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { try { db?.close(); } catch { /* already closed */ } });
