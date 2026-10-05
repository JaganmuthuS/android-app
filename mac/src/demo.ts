// Pure state and view model for the Phase 1 board-report walkthrough. No timers or I/O here.
import {
  CHANGES, GATED_STEP, GREETING, OTHER_LANES, PLAN_INTRO, PLAN_INTRO_AUTO, REQUEST, SOURCES, STEPS, SUMMARY_SEGMENTS, TIMES, TOTAL_STEPS,
} from './mock';

export type Autonomy = 0 | 1 | 2;
export type Tab = 'doc' | 'research' | 'files';
export type Decision = 'accepted' | 'rejected' | 'auto';
export type ChangeStatus = 'none' | 'pending' | Decision;

export interface DemoState {
  sent: boolean;
  planShown: boolean;
  approved: boolean;
  step: number;          // completed steps, 0..4
  running: boolean;
  exportOk: boolean;
  dec: Record<string, Decision>;
  autonomy: Autonomy;
  tab: Tab;
  lane: number;
  extra: { role: 'user' | 'jarvis'; text: string }[];
  draft: string;
  cpSel: number | null;
  restored: boolean;
  voice: boolean;
}

export const initialState = (): DemoState => ({
  sent: false, planShown: false, approved: false, step: 0, running: false, exportOk: false,
  dec: {}, autonomy: 0, tab: 'doc', lane: 0, extra: [], draft: REQUEST, cpSel: null, restored: false, voice: false,
});

/* ---------- reducers ---------- */

/** Finish the next plan step. Under "ask if risky" and "autonomous" its changes are auto-applied. */
export function completeStep(s: DemoState): DemoState {
  if (s.step >= STEPS.length) return s;
  const step = s.step + 1;
  const dec = { ...s.dec };
  if (s.autonomy > 0) CHANGES.filter((c) => c.at === step).forEach((c) => { dec[c.id] = 'auto'; });
  const finished = step >= STEPS.length;
  return { ...s, step, dec, running: !finished, exportOk: s.exportOk || (finished && s.autonomy === 2) };
}

export function decide(s: DemoState, id: string, v: Decision | undefined): DemoState {
  const dec = { ...s.dec };
  if (v) dec[id] = v; else delete dec[id];
  return { ...s, dec };
}

export function acceptAll(s: DemoState): DemoState {
  const dec = { ...s.dec };
  CHANGES.filter((c) => c.at <= s.step && !dec[c.id]).forEach((c) => { dec[c.id] = 'accepted'; });
  return { ...s, dec };
}

/** Roll back to the selected checkpoint: drop later decisions and reopen the plan at that step. */
export function restore(s: DemoState): DemoState {
  if (s.cpSel === null || s.cpSel >= s.step || s.running) return s;
  const at = s.cpSel;
  const dec: Record<string, Decision> = {};
  Object.entries(s.dec).forEach(([k, v]) => { if (CHANGES.find((c) => c.id === k)!.at <= at) dec[k] = v; });
  return { ...s, step: at, dec, exportOk: false, cpSel: null, restored: true, tab: 'doc' };
}

export function approveExport(s: DemoState): DemoState {
  return pendingCount(s) > 0 || s.step < STEPS.length ? s : { ...s, exportOk: true };
}

/* ---------- selectors ---------- */

export function changeStatus(s: DemoState, id: string): ChangeStatus {
  const c = CHANGES.find((x) => x.id === id)!;
  if (c.at > s.step) return 'none';
  return s.dec[id] ?? 'pending';
}

export const availableChanges = (s: DemoState) => CHANGES.filter((c) => c.at <= s.step);
export const pendingCount = (s: DemoState) => availableChanges(s).filter((c) => !s.dec[c.id]).length;
export const isDone = (s: DemoState) => s.exportOk && s.step >= STEPS.length;
const isOn = (st: ChangeStatus) => st === 'accepted' || st === 'auto';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'plan' }
  | { kind: 'log'; verb: string; what: string }
  | { kind: 'gate' };

export function chatItems(s: DemoState): ChatItem[] {
  const out: ChatItem[] = [{ kind: 'text', text: GREETING }];
  if (s.sent) out.push({ kind: 'user', text: REQUEST });
  if (s.planShown) {
    out.push({ kind: 'text', text: s.autonomy === 2 ? PLAN_INTRO_AUTO : PLAN_INTRO });
    out.push({ kind: 'plan' });
  }
  STEPS.forEach((st, i) => { if (s.step > i) out.push({ kind: 'log', verb: st.log[0], what: st.log[1] }); });
  if (s.step >= 2) out.push({ kind: 'text', text: 'Table 2 is updated. Net revenue was €4.82M, 3.1% above the June forecast. I left three wording changes in the document for you to review instead of rewriting your paragraph.' });
  if (s.step >= 4) {
    out.push({ kind: 'text', text: 'Section 4.2 is drafted with three citations. I skipped one trade-press source because its cost figures are unsourced.' });
    out.push({ kind: 'gate' });
  }
  if (isDone(s)) {
    out.push({ kind: 'log', verb: 'Exported', what: 'Board/Out/Q3-Board.pdf · 12 pages · fonts embedded' });
    out.push({ kind: 'text', text: 'Exported. The PDF uses the Board v4 template and tracked changes are flattened. Should I send it to the board distribution list or leave it in Board/Out?' });
  }
  s.extra.forEach((m) => out.push(m.role === 'user' ? { kind: 'user', text: m.text } : { kind: 'text', text: m.text }));
  return out;
}

export type StepState = 'queued' | 'running' | 'done' | 'gate';
export function planSteps(s: DemoState): { text: string; state: StepState; note: string }[] {
  const done = isDone(s);
  return [
    ...STEPS.map((st, i) => {
      const d = s.step > i;
      const r = s.running && s.step === i;
      return { text: st.text, state: (d ? 'done' : r ? 'running' : 'queued') as StepState, note: d ? 'done' : r ? 'working' : '' };
    }),
    { text: GATED_STEP, state: (done ? 'done' : 'gate') as StepState, note: done ? 'done' : 'needs your approval' },
  ];
}
export const planProgress = (s: DemoState) => `${Math.min(s.step + (isDone(s) ? 1 : 0), TOTAL_STEPS)} of ${TOTAL_STEPS}`;

export type SegView = { t: string; look: 'plain' | 'ins' | 'del' };
export function summarySegments(s: DemoState): SegView[] {
  return SUMMARY_SEGMENTS.filter((g) => {
    if (!g.c) return true;
    const st = changeStatus(s, g.c);
    if (st === 'none' || st === 'rejected') return g.k === 'del';
    if (isOn(st)) return g.k === 'ins';
    return true;
  }).map((g) => ({ t: g.t, look: g.c && changeStatus(s, g.c) === 'pending' ? g.k! : 'plain' }));
}

export function tableRows(s: DemoState) {
  const upd = s.step >= 2;
  const hl = upd && !isDone(s);
  return [
    { k: 'Net revenue', q2: '4.37', q3: upd ? '4.82' : '—', d: upd ? '+10.3%' : '—', changed: hl, strong: upd },
    { k: 'Gross margin', q2: '61%', q3: upd ? '61%' : '—', d: upd ? '0 pts' : '—', changed: false, strong: false },
    { k: 'Operating cost', q2: '2.10', q3: upd ? '2.18' : '—', d: upd ? '+4.0%' : '—', changed: hl, strong: upd },
  ];
}

export type SectionView = 'placeholder' | 'drafting' | 'pending' | 'text';
export function section42(s: DemoState): SectionView {
  const c4 = changeStatus(s, 'c4');
  if (s.step === 3 && s.running) return 'drafting';
  if (s.step < 4 || c4 === 'rejected') return 'placeholder';
  return c4 === 'pending' ? 'pending' : 'text';
}

export interface LaneView { title: string; status: string; pct: number; wait: boolean; last?: string; when?: string }
export function lanes(s: DemoState): LaneView[] {
  const done = isDone(s);
  const pending = pendingCount(s);
  const main: LaneView = {
    title: 'Q3 Board Report',
    status: done ? 'Done · PDF exported'
      : !s.sent ? 'Idle'
      : !s.approved ? 'Waiting for plan approval'
      : s.running ? `Working · step ${s.step + 1} of ${TOTAL_STEPS}`
      : pending ? `${pending} change${pending > 1 ? 's' : ''} to review`
      : s.step >= STEPS.length ? 'Waiting for export approval'
      : 'Paused',
    pct: done ? 100 : s.step * 20,
    wait: (s.planShown && !s.approved) || (!s.running && s.step >= STEPS.length && !done),
  };
  const others = OTHER_LANES.map((l, i) => i === 0
    ? { ...l, pct: s.step >= 3 ? 100 : 64, status: s.step >= 3 ? 'Done · 14 of 14 sources' : 'Reading 9 of 14 sources', wait: false }
    : { ...l, pct: l.pct ?? 0, wait: !!l.wait });
  return [main, ...others];
}

export interface FileRow { path: string; action: string; tone: 'neutral' | 'accent' | 'outline'; fmt: string; lane: string }
export function files(s: DemoState): FileRow[] {
  const out: FileRow[] = [];
  if (s.step >= 1) out.push({ path: 'Finance/Sept-close.xlsx', action: 'Read', tone: 'neutral', fmt: 'Excel', lane: 'Board report' });
  if (s.step >= 2) out.push({ path: 'Board/Q3-Board.docx', action: 'Edited · tracked', tone: 'accent', fmt: 'Word', lane: 'Board report' });
  if (s.step >= 3) out.push({ path: 'Legal/AI-Act-memo-2026-05.pdf', action: 'Read', tone: 'neutral', fmt: 'PDF', lane: 'EU AI Act' });
  if (isDone(s)) out.push({ path: 'Board/Out/Q3-Board.pdf', action: 'Created', tone: 'outline', fmt: 'PDF', lane: 'Board report' });
  out.push({ path: 'Legal/Acme-MSA-v3.docx', action: 'Redlined · held', tone: 'accent', fmt: 'Word', lane: 'Contract redlines' });
  return out;
}

export function sources(s: DemoState) {
  return SOURCES.map((x) => {
    const cited = !!x.used && s.step >= 4;
    return { ...x, state: x.skip ? 'Not cited' : cited ? 'Cited in 4.2' : 'Read', tone: (x.skip ? 'outline' : cited ? 'accent' : 'neutral') as FileRow['tone'] };
  });
}
export const readLabel = (s: DemoState) => (s.step >= 3 ? '14 of 14 read' : '9 of 14 read');

export function checkpoints(s: DemoState) {
  if (!s.approved) return [];
  return Array.from({ length: s.step + 1 }, (_, i) => ({ index: i, time: TIMES[i], label: i === 0 ? 'Before edits' : STEPS[i - 1].cp }));
}
export const canRestore = (s: DemoState) => s.cpSel !== null && s.cpSel < s.step && !s.running;

export function tabCounts(s: DemoState, fileCount: number): Record<Tab, string> {
  const p = pendingCount(s);
  return { doc: p ? `${p} to review` : '', research: s.step >= 3 ? '14 sources' : '9 / 14', files: String(fileCount) };
}

export function gateNote(s: DemoState) {
  if (isDone(s)) return 'Approved';
  const p = pendingCount(s);
  return p ? `Review ${p} open change${p > 1 ? 's' : ''} first` : 'All changes reviewed';
}

export const thinkingText = (s: DemoState) =>
  !s.planShown ? 'Reading the request and checking folder access…' : `Step ${s.step + 1}: ${STEPS[s.step]?.text ?? ''}`;
export const isThinking = (s: DemoState) => (s.sent && !s.planShown) || s.running;
