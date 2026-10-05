// Typed access to the preload bridge. In a plain browser (design preview) it falls back to localStorage.
import type { Autonomy, Tab } from './demo';

export interface UiState { lane: number; tab: Tab; autonomy: Autonomy }

interface JarvisBridge {
  platform: string;
  getUiState(): Promise<UiState>;
  setUiState(patch: Partial<UiState>): Promise<UiState>;
}

declare global {
  interface Window { jarvis?: JarvisBridge }
}

const KEY = 'jarvis.ui-state';

export const bridge: JarvisBridge = window.jarvis ?? {
  platform: 'web',
  async getUiState() {
    try { return { lane: 0, tab: 'doc', autonomy: 0, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { return { lane: 0, tab: 'doc', autonomy: 0 }; }
  },
  async setUiState(patch) {
    const next = { ...(await this.getUiState()), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    return next;
  },
};

export const isMacApp = bridge.platform === 'darwin';
