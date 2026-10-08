// Word diffs grouped the way an editor marks changes. Used for Word tracked changes and the change view.
import { diffArrays } from 'diff';

/**
 * A word diff grouped the way an editor marks changes: neighbouring changed words become one
 * deletion followed by one insertion, instead of alternating word by word.
 */
export function changeBlocks(a: string, b: string): { value: string; added?: boolean; removed?: boolean }[] {
  const words = (t: string) => t.match(/\s+|[^\s]+/g) ?? [];
  const parts = diffArrays(words(a), words(b)).map((p) => ({ value: p.value.join(''), added: p.added, removed: p.removed }));
  const out: { value: string; added?: boolean; removed?: boolean }[] = [];
  let del = '';
  let ins = '';
  const flush = () => {
    // Spacing both sides share stays unchanged text.
    let lead = '';
    while (del && ins && del[0] === ins[0] && /\s/.test(del[0])) { lead += del[0]; del = del.slice(1); ins = ins.slice(1); }
    let trail = '';
    while (del && ins && del.at(-1) === ins.at(-1) && /\s/.test(del.at(-1)!)) { trail = del.at(-1) + trail; del = del.slice(0, -1); ins = ins.slice(0, -1); }
    if (lead) out.push({ value: lead });
    if (del) out.push({ value: del, removed: true });
    if (ins) out.push({ value: ins, added: true });
    if (trail) out.push({ value: trail });
    del = ''; ins = '';
  };
  parts.forEach((p, i) => {
    if (p.removed) del += p.value;
    else if (p.added) ins += p.value;
    else if ((del || ins) && /^\s+$/.test(p.value) && parts.slice(i + 1).some((q) => q.added || q.removed) && (parts[i + 1]?.added || parts[i + 1]?.removed)) {
      del += p.value; ins += p.value; // a space between two changes joins them
    } else { flush(); out.push(p); }
  });
  flush();
  return out;
}
