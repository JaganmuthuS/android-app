import { contextBridge, ipcRenderer } from 'electron';

type UiState = { lane: number; tab: 'doc' | 'research' | 'files'; autonomy: 0 | 1 | 2 };

contextBridge.exposeInMainWorld('jarvis', {
  platform: process.platform,
  getUiState: (): Promise<UiState> => ipcRenderer.invoke('ui-state:get'),
  setUiState: (patch: Partial<UiState>): Promise<UiState> => ipcRenderer.invoke('ui-state:set', patch),
});
