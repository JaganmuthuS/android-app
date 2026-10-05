import { create } from 'zustand';
import { bridge } from './bridge';
import * as demo from './demo';
import { FOLLOW_UP } from './mock';

const STEP_MS = 1600;

interface Actions {
  hydrate(): Promise<void>;
  setDraft(v: string): void;
  send(): void;
  approvePlan(): void;
  resume(): void;
  decide(id: string, v: demo.Decision | undefined): void;
  acceptAll(): void;
  approveExport(): void;
  selectLane(i: number): void;
  setTab(t: demo.Tab): void;
  setAutonomy(a: demo.Autonomy): void;
  toggleVoice(): void;
  pickCheckpoint(i: number): void;
  restore(): void;
}

export type Store = demo.DemoState & Actions;

let timer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<Store>((set, get) => {
  const persist = () => {
    const { lane, tab, autonomy } = get();
    void bridge.setUiState({ lane, tab, autonomy });
  };

  const run = () => {
    clearTimeout(timer);
    set({ running: true, restored: false, cpSel: null });
    const tick = () => {
      if (get().step >= 4) { set({ running: false }); return; }
      timer = setTimeout(() => {
        set((s) => demo.completeStep(s));
        if (get().running) tick();
      }, STEP_MS);
    };
    tick();
  };

  return {
    ...demo.initialState(),

    async hydrate() {
      const ui = await bridge.getUiState();
      const lane = Math.min(Math.max(ui.lane, 0), demo.lanes(get()).length - 1);
      set({ lane, tab: ui.tab, autonomy: ui.autonomy });
    },
    setDraft: (draft) => set({ draft }),
    send() {
      const text = get().draft.trim();
      if (!text) return;
      if (!get().sent) {
        set({ sent: true, draft: '' });
        timer = setTimeout(() => {
          set({ planShown: true });
          if (get().autonomy === 2) { set({ approved: true }); run(); }
        }, 1100);
      } else {
        set((s) => ({ draft: '', extra: [...s.extra, { role: 'user', text }] }));
        setTimeout(() => set((s) => ({ extra: [...s.extra, { role: 'jarvis', text: FOLLOW_UP }] })), 900);
      }
    },
    approvePlan() { set({ approved: true }); run(); },
    resume: () => run(),
    decide: (id, v) => set((s) => demo.decide(s, id, v)),
    acceptAll: () => set((s) => demo.acceptAll(s)),
    approveExport: () => set((s) => demo.approveExport(s)),
    selectLane(i) { set((s) => ({ lane: i, tab: i === 1 ? 'research' : s.tab })); persist(); },
    setTab(tab) { set({ tab }); persist(); },
    setAutonomy(autonomy) { set({ autonomy }); persist(); },
    toggleVoice: () => set((s) => ({ voice: !s.voice })),
    pickCheckpoint: (i) => set((s) => ({ cpSel: s.cpSel === i ? null : i })),
    restore: () => set((s) => demo.restore(s)),
  };
});
