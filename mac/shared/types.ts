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
}

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
  | { type: 'stream'; laneId: string; messageId: string; text: string }
  | { type: 'steps'; laneId: string; steps: PlanStep[] }
  | { type: 'memories'; memories: Memory[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'pull'; progress: PullProgress };

export interface JarvisApi {
  platform: string;
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
  openExternal(url: string): Promise<void>;
  onEvent(listener: (e: JarvisEvent) => void): () => void;
}

export const RECOMMENDED_MODEL = 'qwen3:8b';
export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  model: RECOMMENDED_MODEL,
  autonomy: 'ask_every_change',
  maxParallel: 2,
};
