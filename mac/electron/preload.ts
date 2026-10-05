import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { JarvisApi, JarvisEvent } from '../shared/types';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: JarvisApi = {
  platform: process.platform,
  getUiState: call('ui:get') as JarvisApi['getUiState'],
  setUiState: call('ui:set') as JarvisApi['setUiState'],
  listLanes: call('lanes:list') as JarvisApi['listLanes'],
  createLane: call('lanes:create') as JarvisApi['createLane'],
  deleteLane: call('lanes:delete') as JarvisApi['deleteLane'],
  setLaneAutonomy: call('lanes:autonomy') as JarvisApi['setLaneAutonomy'],
  listMessages: call('messages:list') as JarvisApi['listMessages'],
  listSteps: call('steps:list') as JarvisApi['listSteps'],
  send: call('chat:send') as JarvisApi['send'],
  approvePlan: call('plan:approve') as JarvisApi['approvePlan'],
  updatePlan: call('plan:update') as JarvisApi['updatePlan'],
  approveGate: call('gate:approve') as JarvisApi['approveGate'],
  skipGate: call('gate:skip') as JarvisApi['skipGate'],
  stop: call('lane:stop') as JarvisApi['stop'],
  resume: call('lane:resume') as JarvisApi['resume'],
  getSettings: call('settings:get') as JarvisApi['getSettings'],
  setSettings: call('settings:set') as JarvisApi['setSettings'],
  engineStatus: call('engine:status') as JarvisApi['engineStatus'],
  pullModel: call('engine:pull') as JarvisApi['pullModel'],
  listMemories: call('memory:list') as JarvisApi['listMemories'],
  addMemory: call('memory:add') as JarvisApi['addMemory'],
  updateMemory: call('memory:update') as JarvisApi['updateMemory'],
  deleteMemory: call('memory:delete') as JarvisApi['deleteMemory'],
  deleteAllData: call('data:deleteAll') as JarvisApi['deleteAllData'],
  openExternal: call('open:external') as JarvisApi['openExternal'],
  chooseWorkspace: call('workspace:choose') as JarvisApi['chooseWorkspace'],
  listScopes: call('scopes:list') as JarvisApi['listScopes'],
  setScope: call('scopes:set') as JarvisApi['setScope'],
  setAllScopes: call('scopes:setAll') as JarvisApi['setAllScopes'],
  listChanges: call('changes:list') as JarvisApi['listChanges'],
  decideChange: call('changes:decide') as JarvisApi['decideChange'],
  acceptAll: call('changes:acceptAll') as JarvisApi['acceptAll'],
  listCheckpoints: call('checkpoints:list') as JarvisApi['listCheckpoints'],
  restoreCheckpoint: call('checkpoints:restore') as JarvisApi['restoreCheckpoint'],
  listTouches: call('touches:list') as JarvisApi['listTouches'],
  exportAudit: call('audit:export') as JarvisApi['exportAudit'],
  onEvent(listener) {
    const h = (_e: IpcRendererEvent, ev: JarvisEvent) => listener(ev);
    ipcRenderer.on('jarvis:event', h);
    return () => { ipcRenderer.removeListener('jarvis:event', h); };
  },
};

contextBridge.exposeInMainWorld('jarvis', api);
