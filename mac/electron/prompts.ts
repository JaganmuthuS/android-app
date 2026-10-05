// Instructions and output formats for the local model.
import type { ToolSpec } from './ollama';
import type { FileScope, Memory } from '../shared/types';

const MODE_LABEL = { none: 'no access', read: 'read only', edit_ask: 'edit, user reviews every change', edit_auto: 'edit' } as const;

export function workspaceSummary(root: string | null, scopes: FileScope[]): string {
  if (!root) return 'No workspace folder is chosen yet, so you cannot use files. If the user asks for file work, tell them to choose a workspace folder with "Workspace" in the title bar.';
  const lines = scopes.map((s) => `- ${s.path ? `${s.path}/` : 'the main folder itself (top-level files and new top-level folders)'}: ${MODE_LABEL[s.mode]}`);
  return `The workspace folder is ${root}. Paths in tools are relative to it. Folder access:\n${lines.join('\n')}\nNever try folders with no access; ask the user to grant access instead.`;
}

export function systemPrompt(memories: Memory[], now = new Date(), workspace = ''): string {
  const active = memories.filter((m) => m.enabled);
  return [
    'You are JARVIS, a desktop agent on the user\'s Mac that works on documents, folders and research.',
    'Tone: neutral and professional. Short sentences. Exact figures. No hedging words, no exclamation marks, no emoji, no butler persona.',
    'Cite a source for every number and claim you state. If you have no source, say so plainly.',
    'Ask instead of guessing when a request is ambiguous.',
    'You can list, read and search files, create folders, and create or edit text and Markdown files, using the tools. To make a folder, use create_folder; never write an empty file in its place. Read a file before you describe or change it. Never invent file contents.',
    'Your edits are never applied directly: each one is staged as a change the user reviews, unless their autonomy setting applies it. Keep the existing structure and wording of files; change only what the task needs.',
    'You cannot read Excel, PowerPoint or PDF files or edit Word files yet, and you cannot browse the web yet. Say so when a task needs them.',
    workspace,
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
  return `Carry out step ${index + 1} of ${total}: "${text}".\nUse the file tools when the step involves files. Then write only the result of this step, in at most 120 words, naming the files you used.`;
}

const tool = (name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[]): ToolSpec =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const TOOLS: ToolSpec[] = [
  tool('list_dir', 'List the files and folders in a workspace folder. Use "." for the top level, which also shows each folder\'s access.', { path: { type: 'string', description: 'Folder path relative to the workspace' } }, ['path']),
  tool('read_file', 'Read a text, Markdown, CSV, JSON or Word (.docx) file.', { path: { type: 'string', description: 'File path relative to the workspace' } }, ['path']),
  tool('search_files', 'Find files whose name or text contains a word or phrase.', { query: { type: 'string', description: 'Word or phrase to find' }, path: { type: 'string', description: 'Folder to search, "." for everything readable' } }, ['query']),
  tool('replace_text', 'Change part of a text or Markdown file. "find" must be copied exactly from the file and appear once. Preferred over write_file for edits.', {
    path: { type: 'string', description: 'File path' }, find: { type: 'string', description: 'Exact existing text' }, replace: { type: 'string', description: 'New text' }, reason: { type: 'string', description: 'Why, citing the source of any figure' },
  }, ['path', 'find', 'replace', 'reason']),
  tool('write_file', 'Create a new text or Markdown file, or replace a whole small file.', {
    path: { type: 'string', description: 'File path, e.g. Notes/summary.md' }, content: { type: 'string', description: 'Full file content' }, reason: { type: 'string', description: 'Why' },
  }, ['path', 'content', 'reason']),
  tool('create_folder', 'Create a new folder (and any missing parent folders) inside the workspace.', {
    path: { type: 'string', description: 'Folder path, e.g. Notes/2026' }, reason: { type: 'string', description: 'Why' },
  }, ['path', 'reason']),
  tool('move_file', 'Move or rename a file inside the workspace.', { from: { type: 'string', description: 'Current path' }, to: { type: 'string', description: 'New path' }, reason: { type: 'string', description: 'Why' } }, ['from', 'to', 'reason']),
  tool('delete_file', 'Move a file to the Trash. Always waits for the user.', { path: { type: 'string', description: 'File path' }, reason: { type: 'string', description: 'Why' } }, ['path', 'reason']),
];
export const MAX_TOOL_ROUNDS = 8;
export const SUMMARY_INSTRUCTION = 'All steps are finished. In two or three sentences, tell the user what was done and what, if anything, needs their decision next. End with one short question about the next action.';
