// Reading and editing Office files and PDFs. Edits change only what they must:
// Word and PowerPoint edits rewrite just the affected paragraph's XML, so the rest of
// the file (styles, numbering, images) stays byte-for-byte the same.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

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
  const withoutDeleted = p.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
  return decode((withoutDeleted.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>/g) ?? [])
    .map((t) => (t === '<w:tab/>' ? '\t' : t === '<w:br/>' ? '\n' : t.replace(/<[^>]+>/g, ''))).join(''));
}

export async function docxText(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new FormatError('This Word file has no document body.');
  // Footnote references show as [^id], so a reader (and the change view) can see where they sit.
  const withRefs = (p: string) => p.replace(/<w:footnoteReference\b[^>]*w:id="(\d+)"[^>]*\/>/g, '<w:t>[^$1]</w:t>');
  const body = (xml.match(PARA) ?? []).map((p) => {
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
    const text = paraText(withRefs(p));
    return style && /^Heading|^Title/i.test(style) && text ? `[${style}] ${text}` : text;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const notesXml = await zip.file('word/footnotes.xml')?.async('string');
  const notes = notesXml ? [...notesXml.matchAll(/<w:footnote\b([^>]*)>([\s\S]*?)<\/w:footnote>/g)]
    .filter((m) => !/w:type=/.test(m[1]))
    .map((m) => `[^${m[1].match(/w:id="(-?\d+)"/)?.[1]}] ${(m[2].match(PARA) ?? []).map(paraText).join(' ').trim()}`) : [];
  return notes.length ? `${body}\n\nFootnotes:\n${notes.join('\n')}` : body;
}

let revisionId = 9000;
const stamp = () => `w:id="${++revisionId}" w:author="JARVIS" w:date="${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}"`;

interface RunInfo { xml: string; start: number; end: number; text: string; rPr: string; plain: boolean }

/**
 * Replace text inside one paragraph as a tracked change: the old words become a deletion
 * and the new words an insertion, both attributed to JARVIS, using the original run formatting.
 */
export async function docxReplace(bytes: Buffer, find: string, replace: string): Promise<Buffer> {
  if (!find) throw new FormatError('Give the exact text to replace.');
  const zip = await loadZip(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new FormatError('This Word file has no document body.');
  const paras = [...xml.matchAll(PARA)];
  const hits = paras.filter((m) => paraText(m[0]).includes(find));
  const total = hits.reduce((n, m) => n + paraText(m[0]).split(find).length - 1, 0);
  if (total === 0) {
    const anywhere = paras.map((m) => paraText(m[0])).join('\n').includes(find);
    throw new FormatError(anywhere ? 'That text crosses a paragraph break. Replace one paragraph at a time.' : 'That text was not found in the document. Read the file again and copy it exactly.');
  }
  if (total > 1) throw new FormatError(`That text appears ${total} times. Include more words so it matches once.`);
  const m = hits[0];
  const p = m[0];
  if (/<w:(ins|del)\b/.test(p)) throw new FormatError('This paragraph already has tracked changes. Accept or reject them in Word first.');

  // Map the paragraph's text onto its runs.
  const runs: RunInfo[] = [];
  let pos = 0;
  for (const r of p.matchAll(RUN)) {
    const body = r[0];
    const text = decode((body.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>/g) ?? [])
      .map((t) => (t === '<w:tab/>' ? '\t' : t === '<w:br/>' ? '\n' : t.replace(/<[^>]+>/g, ''))).join(''));
    const rPr = body.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? '';
    const inner = body.replace(/^<w:r\b[^>]*>/, '').replace(/<\/w:r>$/, '').replace(rPr, '');
    const plain = /^(\s*<w:t\b[^>]*>[\s\S]*?<\/w:t>\s*)*$/.test(inner);
    runs.push({ xml: body, start: pos, end: pos + text.length, text, rPr, plain });
    pos += text.length;
  }
  const at = paraText(p).indexOf(find);
  const end = at + find.length;
  const touched = runs.filter((r) => r.end > at && r.start < end);
  if (touched.some((r) => !r.plain)) throw new FormatError('That text runs across a tab, line break, field or image. Replace a smaller piece of plain text.');

  const tRun = (rPr: string, text: string) => (text ? `<w:r>${rPr}<w:t xml:space="preserve">${encode(text)}</w:t></w:r>` : '');
  let out = '';
  touched.forEach((r, i) => {
    const a = Math.max(at, r.start) - r.start;
    const b = Math.min(end, r.end) - r.start;
    out += tRun(r.rPr, r.text.slice(0, a));
    out += `<w:del ${stamp()}><w:r>${r.rPr}<w:delText xml:space="preserve">${encode(r.text.slice(a, b))}</w:delText></w:r></w:del>`;
    if (i === touched.length - 1) {
      if (replace) out += `<w:ins ${stamp()}>${tRun(touched[0].rPr, replace)}</w:ins>`;
      out += tRun(r.rPr, r.text.slice(b));
    }
  });
  const first = p.indexOf(touched[0].xml);
  const lastRun = touched[touched.length - 1].xml;
  const last = p.indexOf(lastRun, first) + lastRun.length;
  const newP = p.slice(0, first) + out + p.slice(last);
  zip.file('word/document.xml', xml.slice(0, m.index!) + newP + xml.slice(m.index! + p.length));
  return zipBytes(zip);
}

/**
 * Add a new paragraph after the paragraph containing `after`, as a tracked insertion.
 * Citation markers like [2] become real Word footnotes when `footnote(2)` knows the source.
 */
export async function docxInsertParagraph(bytes: Buffer, after: string, text: string, style?: string, footnote?: (n: number) => string | null): Promise<Buffer> {
  if (!text.trim()) throw new FormatError('Give the text of the new paragraph.');
  const zip = await loadZip(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new FormatError('This Word file has no document body.');
  const paras = [...xml.matchAll(PARA)];
  const hits = after ? paras.filter((m) => paraText(m[0]).includes(after)) : [paras[paras.length - 1]];
  if (!hits.length || !hits[0]) throw new FormatError('The paragraph to insert after was not found. Copy a few words of it exactly.');
  if (hits.length > 1) throw new FormatError('Several paragraphs contain that text. Use more words.');
  const anchor = hits[0];
  const pPrSrc = anchor[0].match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? '<w:pPr></w:pPr>';
  let pPr = pPrSrc.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, '');
  if (style) {
    if (!/^[\w-]{1,60}$/.test(style)) throw new FormatError('That style name is not valid.');
    pPr = /<w:pStyle\b[^>]*\/>/.test(pPr) ? pPr.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${style}"/>`) : pPr.replace('<w:pPr>', `<w:pPr><w:pStyle w:val="${style}"/>`);
  }
  const mark = `<w:ins ${stamp()}/>`;
  pPr = /<w:rPr>/.test(pPr) ? pPr.replace(/<w:rPr>/, `<w:rPr>${mark}`) : pPr.replace('</w:pPr>', `<w:rPr>${mark}</w:rPr></w:pPr>`);
  const firstRPr = anchor[0].match(RUN)?.[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? '';
  const runRPr = style ? '' : firstRPr; // a new heading takes its look from the style
  const notes = footnote ? await footnoteWriter(zip) : null;
  const tRun = (t: string) => (t ? `<w:r>${runRPr}<w:t xml:space="preserve">${encode(t)}</w:t></w:r>` : '');
  const runs = (line: string) => {
    if (!notes) return tRun(line);
    let out = '';
    let last = 0;
    for (const m of line.matchAll(/\s*\[(\d{1,3})\]/g)) {
      const cite = footnote!(Number(m[1]));
      if (!cite) continue;
      out += tRun(line.slice(last, m.index));
      out += `<w:r><w:rPr>${notes.refStyle}<w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${notes.add(cite)}"/></w:r>`;
      last = m.index! + m[0].length;
    }
    return out + tRun(line.slice(last));
  };
  const lines = text.split('\n');
  const newParas = lines.map((line) => `<w:p>${pPr}<w:ins ${stamp()}>${runs(line)}</w:ins></w:p>`).join('');
  const at = anchor.index! + anchor[0].length;
  zip.file('word/document.xml', xml.slice(0, at) + newParas + xml.slice(at));
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
