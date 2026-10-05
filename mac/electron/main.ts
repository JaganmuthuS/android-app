import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_BOUNDS = { width: 1440, height: 900 };
const MIN_SIZE = { width: 1180, height: 720 };

type Bounds = { x?: number; y?: number; width: number; height: number };
type WindowState = { bounds: Bounds; maximized: boolean };
type UiState = { lane: number; tab: 'doc' | 'research' | 'files'; autonomy: 0 | 1 | 2 };

const stateFile = (name: string) => path.join(app.getPath('userData'), name);

function readJson<T>(name: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(stateFile(name), 'utf8')) };
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(stateFile(name), JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`Could not save ${name}:`, err);
  }
}

/** Keep a restored window on a connected display; fall back to the default size otherwise. */
function visibleBounds(b: Bounds): Bounds {
  if (b.x === undefined || b.y === undefined) return b;
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x! >= w.x - 50 && b.y! >= w.y - 50 && b.x! < w.x + w.width - 100 && b.y! < w.y + w.height - 100);
  return onScreen ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const saved = readJson<WindowState>('window-state.json', { bounds: DEFAULT_BOUNDS, maximized: false });
  const bounds = visibleBounds(saved.bounds);
  const win = new BrowserWindow({
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
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const save = () => {
    if (win.isDestroyed()) return;
    writeJson('window-state.json', { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };
  let timer: NodeJS.Timeout | undefined;
  const saveSoon = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('close', save);

  // Links open in the default browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  return win;
}

const UI_DEFAULTS: UiState = { lane: 0, tab: 'doc', autonomy: 0 };

ipcMain.handle('ui-state:get', () => readJson<UiState>('ui-state.json', UI_DEFAULTS));
ipcMain.handle('ui-state:set', (_e, patch: Partial<UiState>) => {
  const next = { ...readJson<UiState>('ui-state.json', UI_DEFAULTS), ...sanitizeUi(patch) };
  writeJson('ui-state.json', next);
  return next;
});

function sanitizeUi(patch: Partial<UiState>): Partial<UiState> {
  const out: Partial<UiState> = {};
  if (Number.isInteger(patch.lane) && patch.lane! >= 0 && patch.lane! < 50) out.lane = patch.lane;
  if (patch.tab === 'doc' || patch.tab === 'research' || patch.tab === 'files') out.tab = patch.tab;
  if (patch.autonomy === 0 || patch.autonomy === 1 || patch.autonomy === 2) out.autonomy = patch.autonomy;
  return out;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
