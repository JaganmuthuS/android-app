// Types shared by the main process (source of truth) and the renderer.

export type Autonomy = 'ask_every_change' | 'ask_if_risky' | 'autonomous';

export type LaneStatus =
  | 'idle' | 'planning' | 'awaiting_plan_approval' | 'running' | 'paused'
  | 'awaiting_review' | 'awaiting_gate' | 'done' | 'failed' | 'scheduled';

export interface Lane {
  id: string;
  title: string;
  status: LaneStatus;
  statusText: string;     // human status line for the lane list
  progress: number;       // 0..1, derived from plan steps
  autonomy: Autonomy;
  createdAt: number;
  updatedAt: number;
}

export type MessageKind = 'text' | 'plan' | 'log' | 'gate' | 'error';

export interface Message {
  id: string;
  laneId: string;
  role: 'user' | 'jarvis' | 'system';
  kind: MessageKind;
  /** text: {text}; log: {verb, what}; gate: {stepId, text, state}; error: {text}; plan: {scope} */
  payload: Record<string, unknown>;
  ts: number;
}

export type StepState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  laneId: string;
  index: number;
  text: string;
  state: StepState;
  requiresGate: boolean;
  note?: string;
}

export interface Memory {
  id: string;
  text: string;
  enabled: boolean;
  createdAt: number;
}

export interface Settings {
  ollamaUrl: string;
  model: string;
  autonomy: Autonomy;
  maxParallel: number;
  workspace: string | null;   // absolute path of the folder Jarvis works in
  webAccess: boolean;         // web search and page reading
  thinking: 'auto' | 'on' | 'off'; // let the model reason first: auto = for file work and plan steps
}

/** A page or file a lane read, numbered per lane so answers and documents can cite it as [n]. */
export interface Source {
  id: string;
  laneId: string;
  n: number;
  url: string;               // https://… or file:<workspace path>
  title: string;
  domain: string;
  kind: 'official' | 'reference' | 'web' | 'file';
  state: 'read' | 'cited' | 'failed';
  note: string;              // why it was not cited, or why it could not be read
  published?: string;
  ts: number;
}
export interface WebSearch { laneId: string; query: string; provider: string; results: number; ts: number }

export type ScopeMode = 'none' | 'read' | 'edit_ask' | 'edit_auto';

/** Access for one top-level folder of the workspace ('' is files at the top level). */
export interface FileScope { path: string; mode: ScopeMode }

export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'auto_applied';

export interface Change {
  id: string;
  laneId: string;
  stepIndex: number | null;
  filePath: string;          // relative to the workspace
  kind: 'edit' | 'create' | 'delete' | 'move' | 'mkdir';
  title: string;
  reason: string;
  before: string | null;     // text before (null: file did not exist)
  after: string | null;      // text after (null: file removed)
  moveTo?: string;
  status: ChangeStatus;
  risk: 'low' | 'high';
  ts: number;
  beforeBlob?: string;       // saved copies for Word, Excel and PowerPoint edits
  afterBlob?: string;
  detail?: string;           // JSON: Excel cell edits [{ref, before, after}]
}

export interface Checkpoint { id: string; laneId: string; stepIndex: number; label: string; ts: number }

export type TouchAction = 'read' | 'edited' | 'created' | 'moved' | 'deleted' | 'held' | 'denied';
export interface FileTouch { laneId: string; laneTitle: string; path: string; action: TouchAction; format: string; ts: number; detail?: string }

export interface UpdateInfo { version: string; tag: string; notes: string; url: string; assetId: number; assetName: string; size: number }
export interface UpdateState {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error';
  info?: UpdateInfo;
  progress?: number;
  error?: string;
  needsToken?: boolean;
  checkedAt?: number;
}

export interface DiagnosticLine { ok: boolean; label: string; detail?: string }

export interface AuditEntry { ts: number; laneId: string; tool: string; path: string; result: string }

export interface EngineStatus {
  reachable: boolean;
  version?: string;
  models: { name: string; size: number; params?: string }[];
  modelInstalled: boolean;
  error?: string;
}

export interface PullProgress {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  done: boolean;
  error?: string;
}

export interface UiState { laneId: string | null; tab: 'doc' | 'research' | 'files' }

/** Pushed from main to renderer whenever something changes. */
export type JarvisEvent =
  | { type: 'lanes'; lanes: Lane[] }
  | { type: 'messages'; laneId: string; messages: Message[] }
  | { type: 'message'; message: Message }
  | { type: 'stream'; laneId: string; messageId: string; text: string; thinking?: string }
  | { type: 'steps'; laneId: string; steps: PlanStep[] }
  | { type: 'memories'; memories: Memory[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'pull'; progress: PullProgress }
  | { type: 'scopes'; scopes: FileScope[] }
  | { type: 'changes'; laneId: string; changes: Change[] }
  | { type: 'checkpoints'; laneId: string; checkpoints: Checkpoint[] }
  | { type: 'touches'; touches: FileTouch[] }
  | { type: 'sources'; laneId: string; sources: Source[]; searches: WebSearch[] }
  | { type: 'update'; update: UpdateState };

export interface JarvisApi {
  platform: string;
  version: string;
  getUiState(): Promise<UiState>;
  setUiState(patch: Partial<UiState>): Promise<UiState>;
  listLanes(): Promise<Lane[]>;
  createLane(): Promise<Lane>;
  deleteLane(laneId: string): Promise<void>;
  listMessages(laneId: string): Promise<Message[]>;
  listSteps(laneId: string): Promise<PlanStep[]>;
  send(laneId: string, text: string): Promise<void>;
  approvePlan(laneId: string): Promise<void>;
  updatePlan(laneId: string, steps: { text: string; requiresGate: boolean }[]): Promise<void>;
  approveGate(laneId: string): Promise<void>;
  skipGate(laneId: string): Promise<void>;
  stop(laneId: string): Promise<void>;
  resume(laneId: string): Promise<void>;
  setLaneAutonomy(laneId: string, autonomy: Autonomy): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  engineStatus(): Promise<EngineStatus>;
  pullModel(model: string): Promise<void>;
  listMemories(): Promise<Memory[]>;
  addMemory(text: string): Promise<void>;
  updateMemory(id: string, patch: { text?: string; enabled?: boolean }): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  deleteAllData(): Promise<void>;
  chooseWorkspace(): Promise<Settings | null>;
  listScopes(): Promise<FileScope[]>;
  setScope(path: string, mode: ScopeMode): Promise<void>;
  setAllScopes(mode: ScopeMode): Promise<void>;
  listChanges(laneId: string): Promise<Change[]>;
  decideChange(changeId: string, decision: 'accept' | 'reject' | 'undo'): Promise<void>;
  acceptAll(laneId: string): Promise<void>;
  listCheckpoints(laneId: string): Promise<Checkpoint[]>;
  restoreCheckpoint(checkpointId: string): Promise<void>;
  listTouches(): Promise<FileTouch[]>;
  listSources(laneId: string): Promise<{ sources: Source[]; searches: WebSearch[] }>;
  exportAudit(): Promise<string | null>;
  diagnose(): Promise<{ version: string; lines: DiagnosticLine[] }>;
  openPrivacySettings(): Promise<void>;
  checkForUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  updateStatus(): Promise<UpdateState & { hasToken: boolean; packaged: boolean }>;
  setGithubToken(token: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onEvent(listener: (e: JarvisEvent) => void): () => void;
}

export const RECOMMENDED_MODEL = 'qwen3:8b';
export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  model: RECOMMENDED_MODEL,
  autonomy: 'ask_every_change',
  maxParallel: 2,
  workspace: null,
  webAccess: true,
  thinking: 'auto',
};
