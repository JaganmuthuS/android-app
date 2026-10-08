import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docxCreate, docxEditParagraph, docxInsertParagraph, docxReplace, docxText, pdfText, pptxReplace, pptxText, xlsxText, xlsxWrite } from '../electron/formats';
import { STYLES_XML, makeDocx, makePdf, makePptx, makeXlsx } from './fixtures';

const part = async (b: Buffer, name: string) => (await JSZip.loadAsync(b)).file(name)!.async('string');
/** The document text as Word shows it after "Reject all changes". */
const rejectAll = (xml: string) => xml
  .replace(/<w:ins\b[^>]*[^/]>[\s\S]*?<\/w:ins>/g, '')
  .replace(/<w:delText\b[^>]*>([\s\S]*?)<\/w:delText>/g, '<w:t>$1</w:t>')
  .split(/<w:p\b/)
  .map((p) => (p.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
  .join('\n');

describe('Word', () => {
  it('turns [n] citations into real, tracked footnotes', async () => {
    const cite = (n: number) => (n === 1 ? 'Key ECB interest rates. https://www.ecb.europa.eu/ (published 2026-09-11).' : null);
    const once = await docxInsertParagraph(await makeDocx(), 'June forecast', 'The deposit rate is 2.00% [1]; see also [7].', undefined, cite);
    const doc = await part(once, 'word/document.xml');
    expect(doc).toMatch(/2\.00%<\/w:t><\/w:r><w:r><w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:footnoteReference w:id="1"\/><\/w:r><w:r><w:rPr><w:sz w:val="22"\/><\/w:rPr><w:t xml:space="preserve">; see also \[7\]\.<\/w:t>/);
    const notes = await part(once, 'word/footnotes.xml');
    expect(notes).toContain('w:type="separator" w:id="-1"');
    expect(notes).toMatch(/<w:footnote w:id="1"><w:p><w:ins [^>]*w:author="JARVIS"[^>]*><w:r>[\s\S]*<w:footnoteRef\/><\/w:r><w:r><w:t xml:space="preserve"> Key ECB interest rates\. https:\/\/www\.ecb\.europa\.eu\/ \(published 2026-09-11\)\.<\/w:t>/);
    expect(await part(once, 'word/_rels/document.xml.rels')).toContain('relationships/footnotes" Target="footnotes.xml"');
    expect(await part(once, '[Content_Types].xml')).toContain('PartName="/word/footnotes.xml"');
    // A second citation adds footnote 2 to the same part without duplicating the links.
    const twice = await docxInsertParagraph(once, 'see also', 'Unchanged since June [1].', undefined, cite);
    expect(await part(twice, 'word/footnotes.xml')).toContain('<w:footnote w:id="2">');
    expect((await part(twice, 'word/_rels/document.xml.rels')).match(/footnotes\.xml/g)).toHaveLength(1);
    const text = await docxText(twice);
    expect(text).toContain('The deposit rate is 2.00%[^1]; see also [7].');
    expect(text).toMatch(/Footnotes:\n\[\^1\]  ?Key ECB interest rates/);
  });


  it('reads paragraphs and headings', async () => {
    const t = await docxText(await makeDocx());
    expect(t).toContain('[Heading1] 2. Financial summary');
    expect(t).toContain('Net revenue was €4.61M, slightly ahead of the June forecast.');
  });

  it('replaces text across runs as tracked whole-word changes, keeping run formatting and everything else', async () => {
    const before = await makeDocx();
    const after = await docxReplace(before, '€4.61M, slightly ahead of', '€4.82M, 3.1% above');
    const xml = await part(after, 'word/document.xml');
    expect(xml).toMatch(/<w:del w:id="\d+" w:author="JARVIS"[^>]*><w:r><w:rPr><w:sz w:val="22"\/><\/w:rPr><w:delText xml:space="preserve">€4\.61M, <\/w:delText>/);
    expect(xml).toMatch(/<w:del [^>]*><w:r><w:rPr><w:i\/><\/w:rPr><w:delText xml:space="preserve">slightly ahead of<\/w:delText>/);
    expect(xml).toMatch(/<w:ins w:id="\d+" w:author="JARVIS"[^>]*><w:r><w:rPr><w:sz w:val="22"\/><\/w:rPr><w:t xml:space="preserve">€4\.82M, 3\.1% above<\/w:t><\/w:r><\/w:ins>/);
    expect(await part(after, 'word/styles.xml')).toBe(STYLES_XML);
    // Other paragraphs are byte-identical.
    const untouched = (s: string) => s.match(/<w:p><w:pPr><w:pStyle w:val="Heading1"\/>[\s\S]*?<\/w:p>/)![0];
    expect(untouched(xml)).toBe(untouched(await part(before, 'word/document.xml')));
    expect(await docxText(after)).toContain('Net revenue was €4.82M, 3.1% above the June forecast.');
    // Rejecting every change in Word gives back the original text exactly.
    expect(rejectAll(xml)).toContain('Net revenue was €4.61M, slightly ahead of the June forecast.');
  });

  it('finds text typed with other quotes, dashes, spacing or case', async () => {
    const b = await makeDocx();
    const after = await docxReplace(b, 'net revenue  was', 'Revenue was');
    expect(await docxText(after)).toContain('Revenue was €4.61M');
    await expect(docxReplace(b, 'not there', 'x')).rejects.toThrow(/not found[\s\S]*¶/);
    await expect(docxReplace(b, 'e', 'x')).rejects.toThrow(/appears \d+ times/);
  });

  it('edits the same paragraph again while the first edit waits for review', async () => {
    const once = await docxReplace(await makeDocx(), 'June forecast', 'plan');
    const twice = await docxReplace(once, 'Net revenue', 'Group revenue');
    expect(await docxText(twice)).toContain('Group revenue was €4.61M, slightly ahead of the plan.');
    expect(rejectAll(await part(twice, 'word/document.xml'))).toContain('Net revenue was €4.61M, slightly ahead of the June forecast.');
    // A whole tab can be removed; it is tracked like text.
    const tab = await docxReplace(once, 'Before\tafter', 'Before after');
    expect(await docxText(tab)).toContain('Before after tab');
  });

  it("refuses paragraphs with someone else's tracked changes", async () => {
    const zip = await JSZip.loadAsync(await makeDocx());
    const xml = (await zip.file('word/document.xml')!.async('string')).replace('<w:r><w:t xml:space="preserve"> the June', '<w:ins w:id="1" w:author="Anna"><w:r><w:t>new </w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> the June');
    zip.file('word/document.xml', xml);
    const b = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(docxReplace(b, 'Net revenue', 'Revenue')).rejects.toThrow(/someone else/);
  });

  it('numbers paragraphs for the model, and edits or deletes a paragraph by number', async () => {
    const b = await makeDocx();
    const numbered = await docxText(b, true);
    expect(numbered).toContain('¶1 [Heading1] 2. Financial summary');
    expect(numbered).toContain('¶2 Net revenue was');
    const edited = await docxEditParagraph(b, 2, 'Net revenue was €4.82M, 3.1% above the June forecast.');
    expect(await docxText(edited)).toContain('Net revenue was €4.82M, 3.1% above the June forecast.');
    const removed = await docxEditParagraph(b, 3, '');
    const xml = await part(removed, 'word/document.xml');
    expect(xml).toMatch(/<w:p><w:pPr><w:rPr><w:del [^>]*w:author="JARVIS"[^>]*\/><\/w:rPr><\/w:pPr><w:del /);
    expect(await docxText(removed)).not.toContain('after tab');
    await expect(docxEditParagraph(b, 99, 'x')).rejects.toThrow(/no paragraph ¶99/);
    // A paragraph JARVIS added and then removes leaves no trace.
    const added = await docxInsertParagraph(b, 2, 'Temporary line');
    const gone = await docxEditParagraph(added, 3, '');
    expect(await part(gone, 'word/document.xml')).toBe(await part(b, 'word/document.xml'));
  });

  it('creates a new Word document from simple text', async () => {
    const cite = (n: number) => (n === 1 ? 'ECB. https://www.ecb.europa.eu/' : null);
    const b = await docxCreate('# Board memo\n\nRevenue rose **3.1%** [1].\n## Risks\n- Rates\n- *Energy* prices', cite);
    const text = await docxText(b);
    expect(text).toContain('[Title] Board memo');
    expect(text).toContain('[Heading2] Risks');
    expect(text).toContain('Revenue rose 3.1%[^1].');
    expect(text).toContain('•\tRates');
    expect(text).toMatch(/Footnotes:\n\[\^1\] +ECB\./);
    const xml = await part(b, 'word/document.xml');
    expect(xml).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">3.1%</w:t></w:r>');
    expect(xml).not.toMatch(/<w:ins|<w:del/); // a new file is reviewed as a whole, not as tracked changes
    expect(await part(b, '[Content_Types].xml')).toContain('/word/footnotes.xml');
  });

  it('inserts a tracked paragraph after an anchor, with a style', async () => {
    const after = await docxInsertParagraph(await makeDocx(), 'June forecast', '4.2 Regulatory outlook', 'Heading1');
    const xml = await part(after, 'word/document.xml');
    expect(xml).toMatch(/June forecast\.<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:pStyle w:val="Heading1"\/><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">4\.2 Regulatory outlook<\/w:t>/);
    expect(await docxText(after)).toContain('[Heading1] 4.2 Regulatory outlook');
  });

  it('inserts body text after a heading in the body style, and several lines as several paragraphs', async () => {
    const after = await docxInsertParagraph(await makeDocx(), 1, 'First new line.\n## A sub-heading\nSecond new line.');
    const xml = await part(after, 'word/document.xml');
    expect(xml).toMatch(/2\. Financial summary<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:pStyle w:val="BoardBody"\/><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:rPr><w:sz w:val="22"\/><\/w:rPr><w:t xml:space="preserve">First new line\./);
    const text = await docxText(after, true);
    expect(text).toContain('¶2 First new line.');
    expect(text).toContain('¶3 [Heading2] A sub-heading');
    expect(text).toContain('¶4 Second new line.');
  });
});

describe('Excel', () => {
  it('reads sheets with addresses and formulas', async () => {
    const t = await xlsxText(await makeXlsx());
    expect(t).toContain('## Sheet "Summary"');
    expect(t).toContain('A2=Net revenue | B2=4.61');
    expect(t).toContain('B3=9.22 [=B2*2]');
    expect(t).toContain('## Sheet "Notes"');
  });

  it('writes cells and keeps number formats, fonts, formulas and other sheets', async () => {
    const { bytes, edits } = await xlsxWrite(await makeXlsx(), 'Summary', { B2: 4.82, C2: '=B2/4.61-1', A4: 'Checked' });
    expect(edits.map((e) => [e.ref, e.before, e.after])).toEqual([['Summary!B2', '4.61', '4.82'], ['Summary!C2', '', '=B2/4.61-1'], ['Summary!A4', '', 'Checked']]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Summary')!;
    expect(ws.getCell('B2').value).toBe(4.82);
    expect(ws.getCell('B2').numFmt).toBe('€0.00"M"');
    expect(ws.getCell('B2').font?.bold).toBe(true);
    expect(ws.getCell('B3').formula).toBe('B2*2');
    expect(ws.getCell('C2').formula).toBe('B2/4.61-1');
    expect(wb.getWorksheet('Notes')!.getCell('A1').value).toBe('Keep me');
  });

  it('refuses to save workbooks whose charts would be lost, and bad input', async () => {
    await expect(xlsxWrite(await makeXlsx(true), 'Summary', { B2: 1 })).rejects.toThrow(/charts/);
    await expect(xlsxWrite(await makeXlsx(), 'Nope', { B2: 1 })).rejects.toThrow(/no sheet called "Nope"/);
    await expect(xlsxWrite(await makeXlsx(), 'Summary', { 'B-2': 1 })).rejects.toThrow(/not a cell address/);
  });
});

describe('PowerPoint and PDF', () => {
  it('reads slides by shape and replaces text keeping run formatting', async () => {
    const b = await makePptx();
    expect(await pptxText(b)).toContain('## Slide 1\n  [Title 1] Q3 results\n  [Content 2] Revenue €4.61M');
    const after = await pptxReplace(b, 1, '€4.61M', '€4.82M');
    const xml = await part(after, 'ppt/slides/slide1.xml');
    expect(xml).toContain('<a:rPr lang="en-GB" sz="2000"/><a:t>Revenue €4.82M</a:t>');
    expect(await part(after, 'ppt/slides/slide2.xml')).toBe(await part(b, 'ppt/slides/slide2.xml'));
    await expect(pptxReplace(b, 3, 'x', 'y')).rejects.toThrow(/no slide 3/);
  });

  it('reads PDF text by page', async () => {
    const t = await pdfText(await makePdf());
    expect(t).toContain('## Page 1');
    expect(t).toContain('limited risk, transparency duties only');
    expect(t).toContain('## Page 2');
  });
});
