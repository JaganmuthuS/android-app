// Instructions and output formats for the local model.
import type { Memory } from '../shared/types';

export function systemPrompt(memories: Memory[], now = new Date()): string {
  const active = memories.filter((m) => m.enabled);
  return [
    'You are JARVIS, a desktop agent on the user\'s Mac that works on documents, folders and research.',
    'Tone: neutral and professional. Short sentences. Exact figures. No hedging words, no exclamation marks, no emoji, no butler persona.',
    'Cite a source for every number and claim you state. If you have no source, say so plainly.',
    'Ask instead of guessing when a request is ambiguous.',
    'Current limitation of this version: you cannot open, read or change files and you cannot browse the web yet. When a step needs a file or the web, say exactly which file or search you would need, then do the part you can do with the information in the conversation.',
    `Today is ${now.toDateString()}.`,
    active.length ? `The user asked you to remember:\n${active.map((m) => `- ${m.text}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** JSON schema for the first reply to a request: answer directly, or propose a plan. */
export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['answer', 'plan'] },
    title: { type: 'string', description: 'Short lane title, 2 to 5 words' },
    scope: { type: 'string', description: 'For a plan: the folders or sources it touches, e.g. "Finance (read) · Board (write)"' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, gated: { type: 'boolean' } },
        required: ['text', 'gated'],
      },
    },
  },
  required: ['kind', 'title'],
};

export const TRIAGE_INSTRUCTION = [
  'Decide how to handle the latest user message.',
  '- If it is a question or a short request you can answer in one reply, use kind "answer" and no steps.',
  '- If it is a task with several parts (documents, folders, research, drafting), use kind "plan" with 3 to 8 short imperative steps, each one action.',
  'Set "gated": true on any step that sends, emails, exports outside the working folder, deletes, publishes or overwrites originals.',
  'Reply with JSON only.',
].join('\n');

const GATE_WORDS = /\b(send|sends|email|e-mail|mail|export|publish|post|upload|share|delete|remove|erase|overwrite|replace the original)\b/i;
export const needsGate = (text: string, flagged: boolean) => flagged || GATE_WORDS.test(text);

export interface Triage { kind: 'answer' | 'plan'; title: string; scope?: string; steps: { text: string; requiresGate: boolean }[] }

export function parseTriage(raw: string): Triage {
  let j: { kind?: string; title?: string; scope?: string; steps?: { text?: string; gated?: boolean }[] } = {};
  try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { /* fall through to answer */ }
  const steps = (j.steps ?? [])
    .map((s) => ({ text: String(s.text ?? '').trim(), requiresGate: needsGate(String(s.text ?? ''), !!s.gated) }))
    .filter((s) => s.text)
    .slice(0, 8);
  const kind = j.kind === 'plan' && steps.length >= 2 ? 'plan' : 'answer';
  return { kind, title: String(j.title ?? '').trim().slice(0, 60), scope: j.scope ? String(j.scope).trim() : undefined, steps: kind === 'plan' ? steps : [] };
}

export const PLAN_INTRO = 'Here is my plan. I will not touch any file until you approve it, and every edit will wait in the change list for review.';
export const PLAN_INTRO_AUTO = 'Running the plan below. I will report each step.';

export function stepInstruction(index: number, total: number, text: string) {
  return `Carry out step ${index + 1} of ${total}: "${text}".\nWrite only the result of this step, in at most 120 words. If it needs a file or the web, say which one and continue with what you can do.`;
}
export const SUMMARY_INSTRUCTION = 'All steps are finished. In two or three sentences, tell the user what was done and what, if anything, needs their decision next. End with one short question about the next action.';
