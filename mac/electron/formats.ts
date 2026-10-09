// Reading and editing Office files and PDFs. Edits change only what they must:
// Word and PowerPoint edits rewrite just the affected paragraph's XML, so the rest of
// the file (styles, numbering, images) stays byte-for-byte the same.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { changeBlocks } from '../shared/diff';

export class FormatError extends Error {}

/* ---------- shared XML helpers ---------- */

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function loadZip(bytes: Buffer) {
  try { return await JSZip.loadAsync(bytes); } catch { throw new FormatError('This file is damaged or is not an Office file.'); }
}
async function zipBytes(zip: JSZip) {
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ---------- Word ---------- */

const PARA = /<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g;
const RUN = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;

/** Text of a Word paragraph as a reader sees it (deleted text excluded). */
function paraText(p: string) {
  const withoutDeleted = p.replace(/<w:del\b[^>]*[^/]>[\s\S]*?<\/w:del>/g, '');
  return decode((withoutDeleted.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) ?? [])
    .map((t) => (t === '<w:tab/>' ? '\t' : t === '<w:br/>' || t === '<w:cr/>' ? '\n' : t.replace(/<[^>]+>/g, ''))).join(''));
}

/**
 * The document as text. With `numbered`, every paragraph starts with its number (¶12), which
 * docx_edit_paragraph and docx_insert_paragraph use: far easier for a model than copying text exactly.
 */
export async function docxText(bytes: Buffer, numbered = false): Promise<string> {
  const zip = await loadZip(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new FormatError('This Word file has no document body.');
  // Footnote references show as [^id], so a reader (and the change view) can see where they sit.
  const withRefs = (p: string) => p.replace(/<w:footnoteReference\b[^>]*w:id="(\d+)"[^>]*\/>/g, '<w:t>[^$1]</w:t>');
  const lines = (xml.match(PARA) ?? []).map((p, i) => {
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
    const text = paraText(withRefs(p));
    const shown = style && /^Heading|^Title/i.test(style) && text ? `[${style}] ${text}` : text;
    return numbered ? (text.trim() ? `¶${i + 1} ${shown}` : '') : shown;
  });
  const body = (numbered ? lines.filter(Boolean).join('\n') : lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
  const notesXml = await zip.file('word/footnotes.xml')?.async('string');
  const notes = notesXml ? [...notesXml.matchAll(/<w:footnote\b([^>]*)>([\s\S]*?)<\/w:footnote>/g)]
    .filter((m) => !/w:type=/.test(m[1]))
    .map((m) => `[^${m[1].match(/w:id="(-?\d+)"/)?.[1]}] ${(m[2].match(PARA) ?? []).map(paraText).join(' ').trim()}`) : [];
  return notes.length ? `${body}\n\nFootnotes:\n${notes.join('\n')}` : body;
}

let revisionId = 9000;
const stamp = () => `w:id="${++revisionId}" w:author="JARVIS" w:date="${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}"`;

/* ----- paragraphs as items: runs (plain text or atomic, like a tab or an image) and zero-width markup ----- */

interface Item { xml: string; text: string; kind: 'plain' | 'atomic' | 'mark'; rPr: string; open: string; start: number }

const RUN_TEXT = /<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
const runText = (body: string) => decode((body.match(RUN_TEXT) ?? [])
  .map((t) => (t === '<w:tab/>' ? '\t' : t === '<w:br/>' || t === '<w:cr/>' ? '\n' : t.replace(/<[^>]+>/g, ''))).join(''));

function splitPara(p: string): { head: string; pPr: string; items: Item[]; tail: string } {
  const open = p.match(/^<w:p\b[^>]*>/)?.[0] ?? '<w:p>';
  if (/\/>$/.test(open) && p === open) return { head: '<w:p>', pPr: '', items: [], tail: '</w:p>' };
  let inner = p.slice(open.length, p.length - '</w:p>'.length);
  const pPr = inner.match(/^\s*<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? '';
  inner = inner.slice(pPr.length);
  const items: Item[] = [];
  let pos = 0;
  const re = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>|<[^>]+>|[^<]+/g;
  for (const m of inner.matchAll(re)) {
    const xml = m[0];
    if (/^<w:r\b/.test(xml) && !/^<w:r\b[^>]*\/>$/.test(xml)) {
      const rOpen = xml.match(/^<w:r\b[^>]*>/)![0];
      const rPr = xml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? '';
      const body = xml.slice(rOpen.length, xml.length - 6).replace(rPr, '');
      const text = runText(body);
      const plain = /^(\s*<w:t\b[^>]*>[\s\S]*?<\/w:t>\s*)+$/.test(body);
      items.push({ xml, text, kind: plain ? 'plain' : text ? 'atomic' : 'mark', rPr, open: rOpen, start: pos });
      pos += text.length;
    } else {
      items.push({ xml, text: '', kind: 'mark', rPr: '', open: '', start: pos });
    }
  }
  return { head: open, pPr, items, tail: '</w:p>' };
}

const W_T = (t: string) => `<w:t xml:space="preserve">${encode(t)}</w:t>`;

/** A paragraph's own tracked changes by JARVIS are undone, giving the text as it is in the file on disk. */
function withoutOwnRevisions(p: string): string {
  return p
    .replace(/<w:ins\b(?=[^>]*w:author="JARVIS")[^>]*[^/]>[\s\S]*?<\/w:ins>/g, '')
    .replace(/<w:del\b(?=[^>]*w:author="JARVIS")[^>]*[^/]>([\s\S]*?)<\/w:del>/g, (_, inner: string) => inner
      .replace(/<w:delText\b/g, '<w:t').replace(/<\/w:delText>/g, '</w:t>')
      .replace(/<w:delInstrText\b/g, '<w:instrText').replace(/<\/w:delInstrText>/g, '</w:instrText>'))
    .replace(/<w:del\b(?=[^>]*w:author="JARVIS")[^>]*\/>/g, '');
}

function assertOnlyOwnRevisions(p: string) {
  for (const m of p.matchAll(/<w:(ins|del|moveFrom|moveTo)\b[^>]*>/g)) {
    if (!/w:author="JARVIS"/.test(m[0])) throw new FormatError('This paragraph has tracked changes by someone else. Accept or reject them in Word first.');
  }
}

/**
 * Rewrite one paragraph to `target` as tracked changes: a word-level diff against the paragraph as it is
 * on disk, keeping the formatting of the words around each change. Earlier JARVIS edits to the same
 * paragraph (still waiting for review) are folded in, so a paragraph can be edited more than once.
 */
function rewriteParagraph(p: string, target: string, deleteMark = false): string {
  assertOnlyOwnRevisions(p);
  if (/txbxContent/.test(p)) throw new FormatError('This paragraph holds a text box. Edit the text box text in Word.');
  const base = withoutOwnRevisions(p);
  const { head, pPr: pPrRaw, items, tail } = splitPara(base);
  const original = items.map((i) => i.text).join('');
  const insertedByUs = /<w:rPr>[\s\S]*?<w:ins\b[^>]*w:author="JARVIS"[^>]*\/>[\s\S]*?<\/w:rPr>/.test(pPrRaw);
  if (deleteMark && insertedByUs) return ''; // a paragraph JARVIS added and now removes simply goes
  let pPr = pPrRaw;
  if (deleteMark) {
    const mark = `<w:del ${stamp()}/>`;
    pPr = !pPr ? `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>` : /<w:rPr>/.test(pPr) ? pPr.replace(/<w:rPr>/, `<w:rPr>${mark}`) : pPr.replace('</w:pPr>', `<w:rPr>${mark}</w:rPr></w:pPr>`);
  }
  if (original === target && !deleteMark) return base;

  const at = (pos: number) => items.filter((i) => i.kind !== 'mark' && i.start <= pos && pos < i.start + i.text.length)[0];
  const styleAt = (pos: number) => (at(pos) ?? [...items].reverse().find((i) => i.kind === 'plain' && i.start < pos) ?? items.find((i) => i.kind === 'plain'))?.rPr ?? '';
  let out = '';
  let cursor = 0; // index into items: everything before it is written
  const emit = (a: number, b: number, mode: 'keep' | 'del') => {
    for (; cursor < items.length; cursor++) {
      const it = items[cursor];
      const s = it.start;
      const e = s + it.text.length;
      if (it.kind === 'mark') { if (s >= b) break; out += it.xml; continue; }
      if (s >= b) break;
      const from = Math.max(a, s) - s;
      const to = Math.min(b, e) - s;
      const whole = from === 0 && to === it.text.length;
      if (it.kind === 'atomic' && !whole) throw new FormatError('That change cuts through a tab, line break, field or image. Change a smaller piece of plain text.');
      if (mode === 'keep') out += whole ? it.xml : `${it.open}${it.rPr}${W_T(it.text.slice(from, to))}</w:r>`;
      else if (it.kind === 'atomic') out += `<w:del ${stamp()}>${it.xml.replace(/<w:t\b/g, '<w:delText').replace(/<\/w:t>/g, '</w:delText>').replace(/<w:instrText\b/g, '<w:delInstrText').replace(/<\/w:instrText>/g, '</w:delInstrText>')}</w:del>`;
      else out += `<w:del ${stamp()}><w:r>${it.rPr}<w:delText xml:space="preserve">${encode(it.text.slice(from, to))}</w:delText></w:r></w:del>`;
      if (e > b) return; // the rest of this run belongs to the next part
    }
  };
  let pos = 0;
  // Whole words change, as a person would mark them: "€4.61M" → "€4.82M", not "61M" → "82M".
  let replaced = -1; // where the deletion that an insertion replaces began: the new words take its look
  for (const part of changeBlocks(original, target)) {
    if (part.added) {
      out += `<w:ins ${stamp()}><w:r>${styleAt(replaced >= 0 ? replaced : pos > 0 ? pos - 1 : 0)}${W_T(part.value)}</w:r></w:ins>`;
      replaced = -1;
      continue;
    }
    replaced = part.removed ? pos : -1;
    emit(pos, pos + part.value.length, part.removed ? 'del' : 'keep');
    pos += part.value.length;
  }
  for (; cursor < items.length; cursor++) out += items[cursor].xml;
  return `${head}${pPr}${out}${tail}`;
}

/* ----- finding text the way people (and small models) type it ----- */

const FOLD: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ', '…': '...' };
/** Folded text plus, for each folded character, where it came from. */
function fold(s: string, lower = false): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let c = FOLD[s[i]] ?? s[i];
    if (/\s/.test(c)) { if (space) continue; c = ' '; space = true; } else space = false;
    if (lower) c = c.toLowerCase();
    for (const ch of c) { text += ch; map.push(i); }
  }
  map.push(s.length);
  return { text, map };
}

/** Where `find` is in `text`: exact first, then ignoring quote styles, dashes and spacing, then case. */
function locate(texts: string[], find: string): { para: number; start: number; end: number }[] {
  const exact = texts.flatMap((t, para) => indexesOf(t, find).map((start) => ({ para, start, end: start + find.length })));
  if (exact.length) return exact;
  for (const lower of [false, true]) {
    const needle = fold(find.trim(), lower).text;
    if (!needle) return [];
    const hits = texts.flatMap((t, para) => {
      const f = fold(t, lower);
      return indexesOf(f.text, needle).map((i) => ({ para, start: f.map[i], end: f.map[i + needle.length - 1] + 1 }));
    });
    if (hits.length) return hits;
  }
  return [];
}
function indexesOf(t: string, f: string) {
  const out: number[] = [];
  for (let i = t.indexOf(f); i >= 0 && f; i = t.indexOf(f, i + 1)) out.push(i);
  return out;
}

async function loadDocument(bytes: Buffer) {
  const zip = await loadZip(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new FormatError('This Word file has no document body.');
  return { zip, xml, paras: [...xml.matchAll(PARA)] };
}

async function saveDocument(zip: JSZip, xml: string, para: RegExpMatchArray, replacement: string) {
  zip.file('word/document.xml', xml.slice(0, para.index!) + replacement + xml.slice(para.index! + para[0].length));
  return zipBytes(zip);
}

/**
 * Replace text inside one paragraph as a tracked change: the old words become a deletion
 * and the new words an insertion, both attributed to JARVIS, using the original run formatting.
 */
export async function docxReplace(bytes: Buffer, find: string, replace: string): Promise<Buffer> {
  if (!find.trim()) throw new FormatError('Give the exact text to replace.');
  const { zip, xml, paras } = await loadDocument(bytes);
  const texts = paras.map((m) => paraText(m[0]));
  const hits = locate(texts, find);
  if (!hits.length) {
    const anywhere = locate([texts.join('\n')], find).length > 0;
    throw new FormatError(anywhere ? 'That text crosses a paragraph break. Replace one paragraph at a time, or use docx_edit_paragraph.' : 'That text was not found in the document. Read the file again, or use docx_edit_paragraph with the paragraph number (¶).');
  }
  if (hits.length > 1) throw new FormatError(`That text appears ${hits.length} times. Include more words so it matches once, or use docx_edit_paragraph with the paragraph number (¶).`);
  const { para, start, end } = hits[0];
  const t = texts[para];
  return saveDocument(zip, xml, paras[para], rewriteParagraph(paras[para][0], t.slice(0, start) + replace + t.slice(end)));
}

/** Rewrite paragraph ¶n (as numbered by read_file) to new text, as tracked changes. Empty text deletes the paragraph. */
export async function docxEditParagraph(bytes: Buffer, n: number, content: string): Promise<Buffer> {
  const { zip, xml, paras } = await loadDocument(bytes);
  const m = paras[n - 1];
  if (!Number.isInteger(n) || !m) throw new FormatError(`There is no paragraph ¶${n}. The document has ${paras.length} paragraphs; read it again to see the numbers.`);
  const text = content.replace(/\r/g, '');
  if (text.includes('\n')) throw new FormatError('Give one paragraph without line breaks. Use docx_insert_paragraph to add more paragraphs after it.');
  return saveDocument(zip, xml, m, rewriteParagraph(m[0], text, !text.trim()));
}

/** Text runs for one line, with **bold** and *italic*, and [n] citations as footnotes when the source is known. */
function lineRuns(line: string, rPr: string, notes: Awaited<ReturnType<typeof footnoteWriter>> | null, footnote?: (n: number) => string | null) {
  const styled = (t: string) => {
    let out = '';
    for (const part of t.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/)) {
      if (!part) continue;
      const bold = /^\*\*[^*]+\*\*$/.test(part);
      const italic = !bold && /^\*[^*]+\*$/.test(part);
      const text = bold ? part.slice(2, -2) : italic ? part.slice(1, -1) : part;
      const extra = bold ? '<w:b/>' : italic ? '<w:i/>' : '';
      const props = extra ? (rPr ? rPr.replace('<w:rPr>', `<w:rPr>${extra}`) : `<w:rPr>${extra}</w:rPr>`) : rPr;
      out += `<w:r>${props}${W_T(text)}</w:r>`;
    }
    return out;
  };
  if (!notes || !footnote) return styled(line);
  let out = '';
  let last = 0;
  for (const m of line.matchAll(/\s*\[(\d{1,3})\]/g)) {
    const cite = footnote(Number(m[1]));
    if (!cite) continue;
    out += styled(line.slice(last, m.index));
    out += `<w:r><w:rPr>${notes.refStyle}<w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${notes.add(cite)}"/></w:r>`;
    last = m.index! + m[0].length;
  }
  return out + styled(line.slice(last));
}

/** "# Title" → Heading1 …; "- item" → a bullet; anything else → body text. */
function lineStyle(line: string): { text: string; style?: string; bullet: boolean } {
  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (h) return { text: h[2], style: `Heading${h[1].length}`, bullet: false };
  const b = line.match(/^\s*[-*•]\s+(.*)$/);
  if (b) return { text: `•\t${b[1]}`, bullet: true };
  return { text: line, bullet: false };
}

/**
 * Add new paragraphs after paragraph ¶n (a number) or the paragraph containing `after` (a few words),
 * as a tracked insertion. Several lines become several paragraphs; "# " lines become headings.
 * Citation markers like [2] become real Word footnotes when `footnote(2)` knows the source.
 */
export async function docxInsertParagraph(bytes: Buffer, after: string | number, text: string, style?: string, footnote?: (n: number) => string | null): Promise<Buffer> {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) throw new FormatError('Give the text of the new paragraph.');
  const { zip, xml, paras } = await loadDocument(bytes);
  let anchor: (typeof paras)[number] | undefined;
  if (typeof after === 'number' || /^¶?\d+$/.test(String(after).trim())) {
    const n = Number(String(after).replace('¶', ''));
    anchor = n === 0 ? undefined : paras[n - 1];
    if (n !== 0 && !anchor) throw new FormatError(`There is no paragraph ¶${n}. The document has ${paras.length} paragraphs.`);
    if (n === 0) anchor = paras[0];
  } else if (String(after).trim()) {
    const hits = locate(paras.map((m) => paraText(m[0])), String(after));
    const where = [...new Set(hits.map((h) => h.para))];
    if (!where.length) throw new FormatError('The paragraph to insert after was not found. Use its number (¶) from read_file instead.');
    if (where.length > 1) throw new FormatError('Several paragraphs contain that text. Use the paragraph number (¶) from read_file instead.');
    anchor = paras[where[0]];
  } else {
    // The end of the document: after the last paragraph that has text.
    anchor = [...paras].reverse().find((m) => paraText(m[0]).trim()) ?? paras[paras.length - 1];
  }
  if (!anchor) throw new FormatError('This document has no paragraphs to insert after.');
  if (style && !/^[\w-]{1,60}$/.test(style)) throw new FormatError('That style name is not valid.');

  // Body text takes its look from a body paragraph near the anchor, not from a heading.
  const isHeading = (p: string) => /<w:pStyle w:val="(Heading|Title|Subtitle)/i.test(p);
  const idx = paras.indexOf(anchor);
  const body = isHeading(anchor[0]) ? (paras.slice(idx + 1).find((m) => !isHeading(m[0]) && paraText(m[0]).trim()) ?? paras.slice(0, idx).reverse().find((m) => !isHeading(m[0]) && paraText(m[0]).trim())) : anchor;
  const cleanPPr = (p: string | undefined) => (p?.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? '<w:pPr></w:pPr>')
    .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, '').replace(/<w:(ins|del)\b[^>]*\/>/g, '').replace(/<w:rPr><\/w:rPr>/, '');
  const bodyPPr = body ? cleanPPr(body[0]) : '<w:pPr></w:pPr>';
  const bodyRPr = (body?.[0].match(RUN) ?? []).map((r) => r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? '').find((r) => !/<w:(b|i|u|vertAlign)\b/.test(r)) ?? '';
  const withStyle = (pPr: string, st: string | undefined) => {
    let out = isHeading(pPr) && !st ? pPr.replace(/<w:pStyle\b[^>]*\/>/, '') : pPr;
    if (st) out = /<w:pStyle\b[^>]*\/>/.test(out) ? out.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${st}"/>`) : out.replace('<w:pPr>', `<w:pPr><w:pStyle w:val="${st}"/>`);
    const mark = `<w:ins ${stamp()}/>`;
    return /<w:rPr>/.test(out) ? out.replace(/<w:rPr>/, `<w:rPr>${mark}`) : out.replace('</w:pPr>', `<w:rPr>${mark}</w:rPr></w:pPr>`);
  };
  const notes = footnote ? await footnoteWriter(zip) : null;
  const newParas = lines.map((raw) => {
    const l = lineStyle(raw.trim());
    const st = style || l.style;
    const pPr = withStyle(bodyPPr, st);
    return `<w:p>${pPr}<w:ins ${stamp()}>${lineRuns(l.text, st ? '' : bodyRPr, notes, footnote)}</w:ins></w:p>`;
  }).join('');
  const at = anchor.index! + anchor[0].length;
  zip.file('word/document.xml', xml.slice(0, at) + newParas + xml.slice(at));
  if (notes) await notes.save();
  return zipBytes(zip);
}

const NEW_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>'
  + [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${[360, 240, 200][n - 1]}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[32, 26, 23][n - 1]}"/></w:rPr></w:style>`).join('')
  + '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
  + '</w:styles>';

/**
 * A new Word document from simple text: "# " / "## " / "### " lines are headings, "- " lines bullets,
 * other lines paragraphs; **bold**, *italic* and [n] citations (as footnotes) inside lines.
 */
export async function docxCreate(text: string, footnote?: (n: number) => string | null): Promise<Buffer> {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) throw new FormatError('Give the text of the document.');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', NEW_STYLES);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>JARVIS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  const notes = footnote ? await footnoteWriter(zip) : null;
  const body = lines.map((raw, i) => {
    const l = lineStyle(raw.trim());
    const st = i === 0 && l.style === 'Heading1' ? 'Title' : l.bullet ? 'ListBullet' : l.style;
    return `<w:p>${st ? `<w:pPr><w:pStyle w:val="${st}"/></w:pPr>` : ''}${lineRuns(l.text, '', notes, footnote)}</w:p>`;
  }).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
  if (notes) await notes.save();
  return zipBytes(zip);
}

const FOOTNOTES_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';
const FOOTNOTES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
const NEW_FOOTNOTES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>'
  + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
  + '</w:footnotes>';

/** Adds footnotes to a Word file, creating the footnotes part (and its links) when the file has none. */
async function footnoteWriter(zip: JSZip) {
  let notes = await zip.file('word/footnotes.xml')?.async('string') ?? null;
  const created = notes === null;
  if (!notes) notes = NEW_FOOTNOTES;
  const styles = await zip.file('word/styles.xml')?.async('string') ?? '';
  const has = (id: string) => styles.includes(`w:styleId="${id}"`);
  const refStyle = has('FootnoteReference') ? '<w:rStyle w:val="FootnoteReference"/>' : '';
  const textStyle = has('FootnoteText') ? '<w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>' : '';
  let next = Math.max(0, ...[...notes.matchAll(/<w:footnote\b[^>]*w:id="(-?\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const added: string[] = [];
  return {
    refStyle,
    add(text: string) {
      const id = next++;
      added.push(`<w:footnote w:id="${id}"><w:p>${textStyle}<w:ins ${stamp()}><w:r><w:rPr>${refStyle}<w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>`
        + `<w:r><w:t xml:space="preserve"> ${encode(text)}</w:t></w:r></w:ins></w:p></w:footnote>`);
      return id;
    },
    async save() {
      if (!added.length) return;
      zip.file('word/footnotes.xml', notes!.replace(/<\/w:footnotes>\s*$/, `${added.join('')}</w:footnotes>`));
      if (!created) return;
      const relsPath = 'word/_rels/document.xml.rels';
      let rels = await zip.file(relsPath)?.async('string') ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      if (!rels.includes(FOOTNOTES_REL)) rels = rels.replace('</Relationships>', `<Relationship Id="rIdJarvisFootnotes" Type="${FOOTNOTES_REL}" Target="footnotes.xml"/></Relationships>`);
      zip.file(relsPath, rels);
      let types = await zip.file('[Content_Types].xml')?.async('string') ?? '';
      if (!types.includes('/word/footnotes.xml')) types = types.replace('</Types>', `<Override PartName="/word/footnotes.xml" ContentType="${FOOTNOTES_TYPE}"/></Types>`);
      zip.file('[Content_Types].xml', types);
    },
  };
}

/* ---------- Excel ---------- */

const MAX_ROWS = 200;

export async function xlsxText(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer); } catch { throw new FormatError('This Excel file could not be opened.'); }
  const out: string[] = [];
  wb.eachSheet((ws) => {
    out.push(`## Sheet "${ws.name}" (${ws.rowCount} rows × ${ws.columnCount} columns)`);
    let shown = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (shown++ >= MAX_ROWS) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (c) => {
        const v = c.value as ExcelJS.CellValue;
        let shownValue: string;
        if (v && typeof v === 'object' && 'formula' in v) shownValue = `${formatValue((v as ExcelJS.CellFormulaValue).result)} [=${(v as ExcelJS.CellFormulaValue).formula}]`;
        else if (v && typeof v === 'object' && 'sharedFormula' in v) shownValue = `${formatValue((v as ExcelJS.CellSharedFormulaValue).result)} [shared formula]`;
        else shownValue = formatValue(v);
        cells.push(`${c.address}=${shownValue}`);
      });
      out.push(cells.join(' | '));
    });
    if (shown > MAX_ROWS) out.push(`[… ${shown - MAX_ROWS} more rows not shown]`);
  });
  return out.join('\n');
}

/** A sheet as rows of objects keyed by its header row, with formula results as values. For analyze_data. */
export async function xlsxRows(bytes: Buffer, sheet = ''): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer); } catch { throw new FormatError('This Excel file could not be opened.'); }
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
  if (!ws) throw new FormatError(`There is no sheet "${sheet}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}.`);
  const plain = (v: unknown): unknown => {
    if (v && typeof v === 'object' && 'result' in (v as object)) return plain((v as { result: unknown }).result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v && typeof v === 'object') return formatValue(v);
    return v ?? null;
  };
  let keys: string[] = [];
  const rows: Record<string, unknown>[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1).map(plain);
    if (!keys.length) { keys = values.map((v, i) => (v == null || v === '' ? `col${i + 1}` : String(v))); return; }
    rows.push(Object.fromEntries(keys.map((k, i) => [k, values[i] ?? null])));
  });
  return rows;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in o) return String(o.text);
    if ('error' in o) return String(o.error);
    return JSON.stringify(v);
  }
  return String(v);
}

/** Features exceljs drops when it saves, so Jarvis refuses to edit workbooks that have them. */
async function xlsxRiskyParts(bytes: Buffer): Promise<string[]> {
  const zip = await loadZip(bytes);
  const names = Object.keys(zip.files);
  const found: string[] = [];
  if (names.some((n) => n.startsWith('xl/charts/'))) found.push('charts');
  if (names.some((n) => n.startsWith('xl/pivotTables/') || n.startsWith('xl/pivotCache/'))) found.push('pivot tables');
  if (names.some((n) => n.startsWith('xl/slicers/'))) found.push('slicers');
  if (names.some((n) => /vbaProject/i.test(n))) found.push('macros');
  return found;
}

export interface CellEdit { ref: string; before: string; after: string }

/** Set cell values in one sheet, keeping styles and other formulas. Values starting with "=" become formulas. */
export async function xlsxWrite(bytes: Buffer, sheetName: string, cells: Record<string, unknown>): Promise<{ bytes: Buffer; edits: CellEdit[] }> {
  const risky = await xlsxRiskyParts(bytes);
  if (risky.length) throw new FormatError(`This workbook has ${risky.join(' and ')}, which would be lost if Jarvis saved it. Jarvis can read it, but can't edit it yet.`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new FormatError(`There is no sheet called "${sheetName}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}.`);
  const edits: CellEdit[] = [];
  const entries = Object.entries(cells ?? {});
  if (!entries.length) throw new FormatError('Give at least one cell, e.g. {"B2": 4.82}.');
  if (entries.length > 500) throw new FormatError('Change at most 500 cells at a time.');
  for (const [ref, raw] of entries) {
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(ref)) throw new FormatError(`"${ref}" is not a cell address like B2.`);
    const cell = ws.getCell(ref.toUpperCase());
    const before = cell.formula ? `=${cell.formula}` : formatValue(cell.value);
    let value: ExcelJS.CellValue;
    if (typeof raw === 'number' || typeof raw === 'boolean') value = raw;
    else {
      const s = String(raw ?? '');
      if (s.startsWith('=')) value = { formula: s.slice(1) } as ExcelJS.CellFormulaValue;
      else if (/^-?\d+(\.\d+)?$/.test(s.trim())) value = Number(s);
      else value = s;
    }
    cell.value = value;
    edits.push({ ref: `${ws.name}!${ref.toUpperCase()}`, before, after: typeof raw === 'string' ? raw : String(raw) });
  }
  const out = Buffer.from(await wb.xlsx.writeBuffer());
  return { bytes: out, edits };
}

/* ---------- PowerPoint ---------- */

const A_PARA = /<a:p\b[^>]*?(?:\/>|>[\s\S]*?<\/a:p>)/g;
const A_RUN = /<a:r\b[^>]*>[\s\S]*?<\/a:r>/g;
const aParaText = (p: string) => decode((p.match(/<a:t>[\s\S]*?<\/a:t>|<a:t\/>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));

async function slideFiles(zip: JSZip) {
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
}

export async function pptxText(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const out: string[] = [];
  for (const [i, name] of (await slideFiles(zip)).entries()) {
    const xml = await zip.file(name)!.async('string');
    const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? [];
    const lines = shapes.map((sp) => {
      const shapeName = sp.match(/<p:cNvPr\b[^>]*name="([^"]*)"/)?.[1] ?? 'Shape';
      const text = (sp.match(A_PARA) ?? []).map(aParaText).filter(Boolean).join(' / ');
      return text ? `  [${decode(shapeName)}] ${text}` : '';
    }).filter(Boolean);
    out.push(`## Slide ${i + 1}`, ...lines);
  }
  return out.join('\n') || '(no slides)';
}

/** Replace text on one slide, keeping the formatting of the first run it touches. */
export async function pptxReplace(bytes: Buffer, slide: number, find: string, replace: string): Promise<Buffer> {
  if (!find) throw new FormatError('Give the exact text to replace.');
  const zip = await loadZip(bytes);
  const slides = await slideFiles(zip);
  const name = slides[slide - 1];
  if (!name) throw new FormatError(`There is no slide ${slide}. The deck has ${slides.length} slides.`);
  const xml = await zip.file(name)!.async('string');
  const paras = [...xml.matchAll(A_PARA)];
  const hits = paras.filter((m) => aParaText(m[0]).includes(find));
  const total = hits.reduce((n, m) => n + aParaText(m[0]).split(find).length - 1, 0);
  if (total === 0) throw new FormatError(`That text was not found on slide ${slide}. Read the deck again and copy it exactly.`);
  if (total > 1) throw new FormatError(`That text appears ${total} times on slide ${slide}. Include more words.`);
  const m = hits[0];
  const p = m[0];
  const runs: { xml: string; start: number; end: number; text: string }[] = [];
  let pos = 0;
  for (const r of p.matchAll(A_RUN)) {
    const text = decode(r[0].match(/<a:t>([\s\S]*?)<\/a:t>/)?.[1] ?? '');
    runs.push({ xml: r[0], start: pos, end: pos + text.length, text });
    pos += text.length;
  }
  const at = aParaText(p).indexOf(find);
  const end = at + find.length;
  const touched = runs.filter((r) => r.end > at && r.start < end);
  let newP = p;
  touched.forEach((r, i) => {
    const a = Math.max(at, r.start) - r.start;
    const b = Math.min(end, r.end) - r.start;
    const text = r.text.slice(0, a) + (i === 0 ? replace : '') + r.text.slice(b);
    const replaced = r.xml.replace(/<a:t>[\s\S]*?<\/a:t>/, `<a:t>${encode(text)}</a:t>`);
    newP = newP.replace(r.xml, replaced);
  });
  zip.file(name, xml.slice(0, m.index!) + newP + xml.slice(m.index! + p.length));
  return zipBytes(zip);
}

/* ---------- PDF ---------- */

interface PdfPage { getTextContent(): Promise<{ items: unknown[] }> }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy?(): Promise<void>; cleanup?(): Promise<void> }
interface PdfJs { getDocument(src: object): { promise: Promise<PdfDoc>; destroy(): Promise<void> } }
let pdfjs: Promise<PdfJs> | null = null;
// pdf.js is an ES module; a dynamic import loads it from this CommonJS file.
const loadPdfJs = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>);

export async function pdfText(bytes: Buffer): Promise<string> {
  const lib = await loadPdfJs();
  let doc: PdfDoc;
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    doc = await task.promise;
  } catch (e) {
    if ((e as Error).name === 'PasswordException') throw new FormatError('This PDF is password-protected.');
    throw new FormatError('This PDF could not be read. It may be damaged.');
  }
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 300); i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let lastY: number | undefined;
    let text = '';
    for (const item of content.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
      if (item.str === undefined) continue;
      const y = item.transform?.[5];
      text += lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2 ? `\n${item.str}` : item.str;
      if (item.hasEOL) text += '\n';
      lastY = y;
    }
    pages.push(text.replace(/\n{2,}/g, '\n').trim());
  }
  await task.destroy();
  if (!pages.join('').trim()) return `(${doc.numPages} page${doc.numPages === 1 ? '' : 's'}, but no text: this PDF is probably scanned images.)`;
  return pages.map((t, i) => `## Page ${i + 1}\n${t}`).join('\n\n') + (doc.numPages > 300 ? `\n\n[… ${doc.numPages - 300} more pages not shown]` : '');
}
