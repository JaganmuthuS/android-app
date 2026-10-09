// Picks the model for each request without an extra model call: a small fast model for routine
// requests, the reasoning model (with thinking) for research, code, documents, data and plan steps.
import type { Settings } from '../shared/types';

export interface Route { model: string; deep: boolean; think: boolean }

const DEEP = new RegExp([
  // research and reasoning
  'research', 'investigat', 'analy[sz]', 'compar', 'evaluat', 'assess', 'explain why', 'why does', 'why is', 'pros and cons', 'trade-?offs?', 'strategy', 'recommend', 'decide', 'decision', 'review', 'critique', 'latest', 'current', 'news',
  // code
  'code', 'script', 'function', 'program', 'debug', 'bug', 'refactor', 'python', 'javascript', 'typescript', 'swift', 'java\\b', 'sql', 'regex', 'html', 'css', 'api', 'algorithm',
  // documents and writing
  'docx', 'xlsx', 'pptx', 'pdf', 'document', 'report', 'memo', 'letter', 'essay', 'proposal', 'paragraph', 'draft', 'rewrite', 'revise', 'edit', 'proofread', 'reword', 'format', 'summari[sz]', 'translate', 'restructure',
  // data
  'data', 'spreadsheet', 'excel', 'csv', 'table', 'chart', 'calculat', 'statistic', 'average', 'total', 'forecast', 'budget', 'formula',
].map((w) => `\\b${w}`).join('|'), 'i');

/** Deep work: anything long, multi-part, or in the categories above. Routine: greetings, quick facts, folder chores. */
export function isDeep(text: string, stepIndex: number | null): boolean {
  if (stepIndex !== null) return true;
  const t = text.trim();
  if (t.length > 280 || t.split('\n').length > 3) return true;
  if (/\b(then|and then|after that|also)\b.*\b(then|and|also)\b/i.test(t) && t.length > 120) return true;
  return DEEP.test(t);
}

export function route(settings: Settings, text: string, stepIndex: number | null, fastAvailable = true): Route {
  const deep = isDeep(text, stepIndex);
  const fast = settings.fastModel && settings.fastModel !== settings.model && fastAvailable ? settings.fastModel : '';
  const model = deep || !fast ? settings.model : fast;
  const think = settings.thinking === 'on' ? true : settings.thinking === 'off' ? false : deep;
  return { model, deep, think };
}
