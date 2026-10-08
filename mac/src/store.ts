import { create } from 'zustand';
import { api } from './api';
import type {
  Autonomy, Change, Checkpoint, EngineStatus, Source, WebSearch, UpdateState, FileScope, FileTouch, JarvisEvent, Lane, Memory, Message, PlanStep, PullProgress, ScopeMode, Settings, UiState,
} from '../shared/types';

type Tab = UiState['tab'];

interface State {
  ready: boolean;
  lanes: Lane[];
  laneId: string | null;
  tab: Tab;
  messages: Record<string, Message[]>;
  steps: Record<string, PlanStep[]>;
  streams: Record<string, string>;
  thoughts: Record<string, string>;
  drafts: Record<string, string>;
  memories: Memory[];
  settings: Settings | null;
  engine: EngineStatus | null;
  pull: PullProgress | null;
  settingsOpen: boolean;
  toast: string | null;
  scopes: FileScope[];
  changes: Record<string, Change[]>;
  checkpoints: Record<string, Checkpoint[]>;
  touches: FileTouch[];
  sources: Record<string, { sources: Source[]; searches: WebSearch[] }>;
  focusedSource: number | null;
  focusedChange: string | null;
  cpSel: string | null;
  checkOnOpen: boolean;
  update: UpdateState & { hasToken?: boolean; packaged?: boolean };
}

interface Actions {
  init(): Promise<void>;
  selectLane(id: string): Promise<void>;
  setTab(t: Tab): void;
  newLane(): Promise<void>;
  deleteLane(id: string): Promise<void>;
  setDraft(v: string): void;
  send(): Promise<void>;
  approvePlan(): Promise<void>;
  savePlan(steps: { text: string; requiresGate: boolean }[]): Promise<boolean>;
  approveGate(): Promise<void>;
  skipGate(): Promise<void>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  setAutonomy(a: Autonomy): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  refreshEngine(): Promise<void>;
  pullModel(model: string): Promise<void>;
  addMemory(text: string): Promise<void>;
  updateMemory(id: string, patch: { text?: string; enabled?: boolean }): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  deleteAllData(): Promise<void>;
  openSettings(open: boolean): void;
  showError(e: unknown): void;
  chooseWorkspace(): Promise<void>;
  setScope(path: string, mode: ScopeMode): Promise<void>;
  setAllScopes(mode: ScopeMode): Promise<void>;
  refreshScopes(): Promise<void>;
  decideChange(id: string, d: 'accept' | 'reject' | 'undo'): Promise<void>;
  acceptAll(): Promise<void>;
  focusChange(id: string): void;
  focusSource(n: number): void;
  openExternal(url: string): void;
  pickCheckpoint(id: string): void;
  restore(): Promise<void>;
  exportAudit(): Promise<void>;
  notice(msg: string): void;
  checkForUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  setGithubToken(token: string): Promise<boolean>;
}

export type Store = State & Actions;

export const useStore = create<Store>((set, get) => {
  const guard = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e) { get().showError(e); return undefined; }
  };
  const laneId = () => get().laneId;

  const onEvent = (e: JarvisEvent) => {
    switch (e.type) {
      case 'lanes': {
        set({ lanes: e.lanes });
        const cur = get().laneId;
        if (cur && !e.lanes.some((l) => l.id === cur)) void ensureLane();
        break;
      }
      case 'message':
        set((s) => s.messages[e.message.laneId]
          ? { messages: { ...s.messages, [e.message.laneId]: [...s.messages[e.message.laneId], e.message] } }
          : {});
        break;
      case 'messages':
        set((s) => {
          const streams = { ...s.streams };
          e.messages.forEach((m) => { delete streams[m.id]; });
          return { messages: { ...s.messages, [e.laneId]: e.messages }, streams };
        });
        break;
      case 'stream': set((s) => ({ streams: { ...s.streams, [e.messageId]: e.text }, ...(e.thinking ? { thoughts: { ...s.thoughts, [e.messageId]: e.thinking } } : {}) })); break;
      case 'steps': set((s) => ({ steps: { ...s.steps, [e.laneId]: e.steps } })); break;
      case 'memories': set({ memories: e.memories }); break;
      case 'settings': set({ settings: e.settings }); break;
      case 'pull':
        set({ pull: e.progress });
        if (e.progress.done) void get().refreshEngine();
        break;
      case 'scopes': set({ scopes: e.scopes }); break;
      case 'changes': set((s) => ({ changes: { ...s.changes, [e.laneId]: e.changes } })); break;
      case 'checkpoints': set((s) => ({ checkpoints: { ...s.checkpoints, [e.laneId]: e.checkpoints } })); break;
      case 'touches': set({ touches: e.touches }); break;
      case 'sources': set((s) => ({ sources: { ...s.sources, [e.laneId]: { sources: e.sources, searches: e.searches } } })); break;
      case 'update': set((s) => ({ update: { ...s.update, ...e.update, info: e.update.info ?? (e.update.state === 'none' ? undefined : s.update.info), error: e.update.error } })); break;
    }
  };

  const loadLane = async (id: string) => {
    if (!api) return;
    const [messages, steps, changes, checkpoints, sources] = await Promise.all([api.listMessages(id), api.listSteps(id), api.listChanges(id), api.listCheckpoints(id), api.listSources(id)]);
    set((s) => ({
      messages: { ...s.messages, [id]: messages }, steps: { ...s.steps, [id]: steps }, sources: { ...s.sources, [id]: sources },
      changes: { ...s.changes, [id]: changes }, checkpoints: { ...s.checkpoints, [id]: checkpoints },
    }));
  };

  /** Keep a valid lane selected; create the first one on a fresh install. */
  const ensureLane = async () => {
    if (!api) return;
    let lanes = get().lanes;
    if (!lanes.length) { await api.createLane(); lanes = await api.listLanes(); set({ lanes }); }
    const id = lanes.some((l) => l.id === get().laneId) ? get().laneId! : lanes[0].id;
    await get().selectLane(id);
  };

  return {
    ready: false, lanes: [], laneId: null, tab: 'doc', messages: {}, steps: {}, streams: {}, thoughts: {}, drafts: {},
    memories: [], settings: null, engine: null, pull: null, settingsOpen: false, toast: null,
    scopes: [], changes: {}, checkpoints: {}, touches: [], sources: {}, focusedSource: null, focusedChange: null, cpSel: null, checkOnOpen: false,
    update: { state: 'idle' },

    async init() {
      if (!api) return;
      api.onEvent(onEvent);
      const [ui, lanes, settings, memories, scopes, touches] = await Promise.all([
        api.getUiState(), api.listLanes(), api.getSettings(), api.listMemories(), api.listScopes(), api.listTouches(),
      ]);
      set({ lanes, settings, memories, scopes, touches, tab: ui.tab, laneId: ui.laneId });
      await ensureLane();
      set({ ready: true });
      const u = await api.updateStatus().catch(() => null);
      if (u) set({ update: u });
      // Folders made in Finder show up as soon as you come back to Jarvis.
      window.addEventListener('focus', () => { void get().refreshScopes(); });
      await get().refreshEngine();
    },
    async selectLane(id) {
      set({ laneId: id, focusedChange: null, focusedSource: null, cpSel: null });
      void api?.setUiState({ laneId: id });
      await guard(() => loadLane(id));
    },
    setTab(tab) { set({ tab }); void api?.setUiState({ tab }); },
    async newLane() {
      const lane = await guard(() => api!.createLane());
      if (lane) { set((s) => ({ lanes: s.lanes.some((l) => l.id === lane.id) ? s.lanes : [...s.lanes, lane] })); await get().selectLane(lane.id); }
    },
    async deleteLane(id) { await guard(() => api!.deleteLane(id)); },
    setDraft(v) { const id = laneId(); if (id) set((s) => ({ drafts: { ...s.drafts, [id]: v } })); },
    async send() {
      const id = laneId();
      if (!id) return;
      const text = (get().drafts[id] ?? '').trim();
      if (!text) return;
      set((s) => ({ drafts: { ...s.drafts, [id]: '' } }));
      try { await api!.send(id, text); } catch (e) {
        get().showError(e);
        set((s) => ({ drafts: { ...s.drafts, [id]: text } }));
      }
    },
    async approvePlan() { const id = laneId(); if (id) await guard(() => api!.approvePlan(id)); },
    async savePlan(steps) {
      const id = laneId();
      if (!id) return false;
      try { await api!.updatePlan(id, steps); return true; } catch (e) { get().showError(e); return false; }
    },
    async approveGate() { const id = laneId(); if (id) await guard(() => api!.approveGate(id)); },
    async skipGate() { const id = laneId(); if (id) await guard(() => api!.skipGate(id)); },
    async stop() { const id = laneId(); if (id) await guard(() => api!.stop(id)); },
    async resume() { const id = laneId(); if (id) await guard(() => api!.resume(id)); },
    async setAutonomy(a) {
      await get().saveSettings({ autonomy: a });
      const id = laneId();
      if (id) await guard(() => api!.setLaneAutonomy(id, a));
    },
    async saveSettings(patch) {
      const s = await guard(() => api!.setSettings(patch));
      if (s) { set({ settings: s }); if (patch.model || patch.ollamaUrl) await get().refreshEngine(); }
    },
    async refreshEngine() {
      const engine = await guard(() => api!.engineStatus());
      if (engine) set({ engine });
    },
    async pullModel(model) {
      set({ pull: { model, status: 'Starting download…', done: false } });
      await guard(() => api!.pullModel(model));
    },
    async addMemory(text) { if (text.trim()) await guard(() => api!.addMemory(text)); },
    async updateMemory(id, patch) { await guard(() => api!.updateMemory(id, patch)); },
    async deleteMemory(id) { await guard(() => api!.deleteMemory(id)); },
    async deleteAllData() {
      await guard(() => api!.deleteAllData());
      set({ messages: {}, steps: {}, streams: {}, thoughts: {}, drafts: {} });
      await ensureLane();
    },
    openSettings(open) { set({ settingsOpen: open }); if (open) void get().refreshEngine(); },
    async chooseWorkspace() {
      const s = await guard(() => api!.chooseWorkspace());
      if (s) { set({ settings: s }); const scopes = await guard(() => api!.listScopes()); if (scopes) set({ scopes }); }
    },
    async setScope(p, mode) { await guard(() => api!.setScope(p, mode)); },
    async setAllScopes(mode) { await guard(() => api!.setAllScopes(mode)); },
    async refreshScopes() {
      if (!get().settings?.workspace) return;
      const scopes = await guard(() => api!.listScopes());
      if (scopes) set({ scopes });
    },
    async decideChange(id, d) { set({ focusedChange: id }); await guard(() => api!.decideChange(id, d)); },
    async acceptAll() { const id = laneId(); if (id) await guard(() => api!.acceptAll(id)); },
    focusChange(id) { set({ focusedChange: id, tab: 'doc' }); void api?.setUiState({ tab: 'doc' }); },
    focusSource(n) { set({ focusedSource: n, tab: 'research' }); void api?.setUiState({ tab: 'research' }); },
    openExternal(url) { void guard(() => api!.openExternal(url)); },
    pickCheckpoint(id) { set((s) => ({ cpSel: s.cpSel === id ? null : id })); },
    async restore() {
      const id = get().cpSel;
      if (!id) return;
      set({ cpSel: null });
      await guard(() => api!.restoreCheckpoint(id));
    },
    async exportAudit() {
      const file = await guard(() => api!.exportAudit());
      if (file) get().notice(`Audit log saved to ${file}`);
    },
    async checkForUpdate() { await guard(() => api!.checkForUpdate()); },
    async installUpdate() { await guard(() => api!.installUpdate()); },
    async setGithubToken(token) {
      try { await api!.setGithubToken(token); set((s) => ({ update: { ...s.update, hasToken: !!token.trim() } })); return true; }
      catch (e) { get().showError(e); return false; }
    },
    notice(msg) {
      set({ toast: msg });
      setTimeout(() => { if (get().toast === msg) set({ toast: null }); }, 5000);
    },
    showError(e) {
      const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      set({ toast: msg });
      setTimeout(() => { if (get().toast === msg) set({ toast: null }); }, 6000);
    },
  };
});

/* ---------- selectors ---------- */

export const currentLane = (s: State) => s.lanes.find((l) => l.id === s.laneId) ?? null;
export const isBusy = (lane: Lane | null) => !!lane && (lane.status === 'planning' || lane.status === 'running');
export const isWaiting = (lane: Lane) => lane.status === 'awaiting_plan_approval' || lane.status === 'awaiting_gate';
export const engineReady = (s: State) => !!s.engine?.reachable && !!s.engine.modelInstalled;
const EMPTY_CHANGES: Change[] = [];
const EMPTY_CPS: Checkpoint[] = [];
const EMPTY_SOURCES = { sources: [] as Source[], searches: [] as WebSearch[] };
export const laneSources = (s: State) => (s.laneId ? s.sources[s.laneId] ?? EMPTY_SOURCES : EMPTY_SOURCES);
export const laneChanges = (s: State) => (s.laneId ? s.changes[s.laneId] ?? EMPTY_CHANGES : EMPTY_CHANGES);
export const laneCheckpoints = (s: State) => (s.laneId ? s.checkpoints[s.laneId] ?? EMPTY_CPS : EMPTY_CPS);
