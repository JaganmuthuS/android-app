// Calculations and data analysis: the model writes a short JavaScript snippet, which runs in an empty
// sandbox (no files, network, timers or Node APIs) with a time limit. Data goes in as JSON text and is
// parsed inside the sandbox, so no object from JARVIS itself is reachable from the snippet.
import * as vm from 'vm';

export class ComputeError extends Error {}

const TIMEOUT_MS = 3000;
const MAX_OUTPUT = 20_000;

/** Parse CSV (quoted fields, commas or semicolons) into rows of objects keyed by the header line. */
export function parseCsv(text: string): Record<string, string | number>[] {
  const lines: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : text.includes('\t') && !text.includes(',') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) lines.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) lines.push(row);
  const [head, ...body] = lines;
  if (!head) return [];
  const keys = head.map((h, i) => h.trim() || `col${i + 1}`);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => {
    const v = (r[i] ?? '').trim();
    const n = Number(v.replace(/[,\s](?=\d{3}\b)/g, ''));
    return [k, v !== '' && Number.isFinite(n) && /^-?[\d.,\s]+$/.test(v) ? n : v];
  })));
}

/**
 * Run `code` with `rows` (the data) in scope. The snippet's last expression, or a value it returns,
 * is the result. Helpers: sum, avg, min, max, median, round, groupBy, sortBy, unique, count.
 */
export function runAnalysis(code: string, rows: unknown[] = []): string {
  if (!code.trim()) throw new ComputeError('analyze_data needs "code": JavaScript using rows, e.g. sum(rows.map(r => r.Revenue)).');
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const prelude = `
    const rows = JSON.parse(__data);
    const nums = (a) => a.map(Number).filter((x) => Number.isFinite(x));
    const sum = (a) => nums(a).reduce((s, x) => s + x, 0);
    const avg = (a) => { const n = nums(a); return n.length ? sum(n) / n.length : NaN; };
    const min = (a) => Math.min(...nums(a));
    const max = (a) => Math.max(...nums(a));
    const median = (a) => { const n = nums(a).sort((x, y) => x - y); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; };
    const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
    const groupBy = (a, f) => a.reduce((g, x) => { const k = typeof f === 'function' ? f(x) : x[f]; (g[k] = g[k] || []).push(x); return g; }, {});
    const sortBy = (a, f, desc = false) => [...a].sort((x, y) => { const p = typeof f === 'function' ? f(x) : x[f]; const q = typeof f === 'function' ? f(y) : y[f]; return (p > q ? 1 : p < q ? -1 : 0) * (desc ? -1 : 1); });
    const unique = (a) => [...new Set(a)];
    const count = (a, f) => a.filter(f).length;
  `;
  // The result is the value of the last statement, as in a console; code with `return` runs as a function.
  const body = /\breturn\b/.test(code) ? `(() => { ${code} })()` : code;
  let out: unknown;
  try {
    vm.runInContext(`var __data = ${JSON.stringify(JSON.stringify(rows))};`, ctx);
    const value = vm.runInContext(`${prelude}\n${body}`, ctx, { timeout: TIMEOUT_MS, displayErrors: false });
    (ctx as Record<string, unknown>).__out = value;
    out = vm.runInContext(`JSON.stringify(__out === undefined ? null : __out, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v, 2)`, ctx, { timeout: TIMEOUT_MS, displayErrors: false });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/timed out/i.test(msg)) throw new ComputeError(`The calculation took longer than ${TIMEOUT_MS / 1000} s. Simplify it.`);
    throw new ComputeError(`The code failed: ${msg}`);
  }
  const text = typeof out === 'string' ? out : String(out);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[… output cut at ${MAX_OUTPUT} characters]` : text;
}
