// Sample workspace used by the Phase 1 shell. Real lanes, files and sources replace this in later phases.

export const REQUEST =
  'Update the Q3 board report with the September numbers from Finance/Sept-close.xlsx. Keep our Board v4 template, and add a short section 4.2 on the EU AI Act from the research lane.';

export interface Step { text: string; log: [verb: string, what: string]; cp: string }
export const STEPS: Step[] = [
  { text: 'Read Finance/Sept-close.xlsx', log: ['Opened', 'Finance/Sept-close.xlsx · 3 sheets, read-only'], cp: 'Read Sept-close' },
  { text: 'Update Table 2 and summary in Q3-Board.docx', log: ['Edited', 'Q3-Board.docx · Table 2, 4 cells · 3 wording edits held for review'], cp: 'Table 2 updated' },
  { text: 'Pull findings from lane 2 · EU AI Act', log: ['Read', '5 remaining sources · 14 of 14 done'], cp: 'Research merged' },
  { text: 'Draft section 4.2 with citations', log: ['Drafted', 'Section 4.2 · 62 words · 3 citations'], cp: 'Drafted 4.2' },
];
export const GATED_STEP = 'Export PDF to Board/Out';
export const TOTAL_STEPS = STEPS.length + 1;
export const TIMES = ['09:12', '09:13', '09:14', '09:16', '09:17'];

export interface ChangeDef { id: string; at: number; title: string; why: string }
export const CHANGES: ChangeDef[] = [
  { id: 'c1', at: 2, title: 'Net revenue €4.61M → €4.82M', why: 'Source: Sept-close.xlsx › Summary!C14.' },
  { id: 'c2', at: 2, title: '“slightly ahead of” → “3.1% above”', why: 'Memory: you prefer exact figures over hedging words.' },
  { id: 'c3', at: 2, title: 'Added sentence on operating cost', why: 'Past board reports note opex moves above 3%. Source: Summary!C22.' },
  { id: 'c4', at: 4, title: 'New section 4.2 · Regulatory outlook', why: 'From lane 2. Cites sources 1, 2 and 4.' },
];

export interface Segment { t: string; k?: 'ins' | 'del'; c?: string }
export const SUMMARY_SEGMENTS: Segment[] = [
  { t: 'Net revenue for the quarter was ' }, { t: '€4.61M', k: 'del', c: 'c1' }, { t: '€4.82M', k: 'ins', c: 'c1' },
  { t: ', ' }, { t: 'slightly ahead of', k: 'del', c: 'c2' }, { t: '3.1% above', k: 'ins', c: 'c2' },
  { t: ' the forecast set in June. Gross margin held at 61%' },
  { t: ', while operating cost rose 4% with the Lisbon office opening', k: 'ins', c: 'c3' },
  { t: '. Cash runway remains above 20 months.' },
];

export interface OtherLane { title: string; status: string; last: string; when: string; pct?: number; wait?: boolean }
export const OTHER_LANES: OtherLane[] = [
  { title: 'EU AI Act research', status: 'Reading sources', last: 'Searching EUR-Lex, the Commission’s guidance and your Legal folder. Findings feed section 4.2 of the board report.', when: 'just now' },
  { title: 'Vendor contract redlines', status: 'Waiting for you · 2 risky clauses', pct: 80, wait: true, last: 'Clauses 7.2 (unlimited liability) and 11.4 (36-month auto-renewal) conflict with your contract playbook. Redlines are drafted in Legal/Acme-MSA-v3.docx. I will not send them without your approval.', when: '14 min ago' },
  { title: 'File ~/Downloads', status: 'Scheduled · daily 18:00', pct: 0, last: 'Yesterday I moved 41 files into Invoices, Receipts and Archive. Three files I could not classify are in Downloads/Review.', when: 'yesterday' },
  { title: 'Weekly investor update', status: 'Done · draft in Mail', pct: 100, last: 'The draft is saved in Mail, not sent. Figures match the board report as of 09:14.', when: '1 h ago' },
];

export interface SourceDef { n: number; title: string; where: string; note: string; used?: boolean; skip?: boolean }
export const SOURCES: SourceDef[] = [
  { n: 1, title: 'Regulation (EU) 2024/1689, Art. 113', where: 'eur-lex.europa.eu · primary law', note: 'Application dates: GPAI obligations from 2 Aug 2025, most remaining provisions from 2 Aug 2026.', used: true },
  { n: 2, title: 'Annex III · high-risk use cases', where: 'eur-lex.europa.eu · primary law', note: 'Lists the high-risk categories. None match Northwind’s current products.', used: true },
  { n: 3, title: 'Commission guidelines on AI system definition', where: 'digital-strategy.ec.europa.eu', note: 'Clarifies scope for rule-based tools. Background only.' },
  { n: 4, title: 'Legal/AI-Act-memo-2026-05.pdf', where: 'Your Legal folder · internal', note: 'Counsel’s view: the document assistant is limited risk, transparency duties only.', used: true },
  { n: 5, title: 'Industry analysis of compliance cost', where: 'Trade press · secondary', note: 'Cost ranges for SMEs. Not cited: figures are not sourced.', skip: true },
];

export const SCOPES = [
  { path: 'Finance/', mode: 'Read only', tone: 'neutral' },
  { path: 'Board/', mode: 'Edit · ask', tone: 'accent' },
  { path: 'Legal/', mode: 'Edit · ask', tone: 'accent' },
  { path: 'Personal/', mode: 'No access', tone: 'outline' },
] as const;

export const MEMORY = ['Exact figures, no hedging words', 'Board documents use template Board v4', 'Never email outside @northwind.eu'];

export const WORKSPACE = '~/Work/Northwind';
export const GREETING = 'Good morning. Lane 3 is waiting on two contract clauses, and the Downloads job runs at 18:00. What should I work on?';
export const PLAN_INTRO = 'Here is my plan. I will not touch any file until you approve it, and every edit will wait in the change list for review.';
export const PLAN_INTRO_AUTO = 'Running the plan below. I will report each step.';
export const FOLLOW_UP = 'Noted. I have added this to the plan and will flag it in the change list before applying it.';
