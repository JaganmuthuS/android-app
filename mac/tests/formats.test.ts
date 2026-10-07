import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docxInsertParagraph, docxReplace, docxText, pdfText, pptxReplace, pptxText, xlsxText, xlsxWrite } from '../electron/formats';
import { STYLES_XML, makeDocx, makePdf, makePptx, makeXlsx } from './fixtures';

const part = async (b: Buffer, name: string) => (await JSZip.loadAsync(b)).file(name)!.async('string');

describe('Word', () => {
  it('reads paragraphs and headings', async () => {
    const t = await docxText(await makeDocx());
    expect(t).toContain('[Heading1] 2. Financial summary');
    expect(t).toContain('Net revenue was €4.61M, slightly ahead of the June forecast.');
  });

  it('replaces text across runs as a tracked change, keeping run formatting and everything else', async () => {
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
  });

  it('refuses ambiguous, missing, or tab-crossing text', async () => {
    const b = await makeDocx();
    await expect(docxReplace(b, 'not there', 'x')).rejects.toThrow(/not found/);
    await expect(docxReplace(b, 'e', 'x')).rejects.toThrow(/appears \d+ times/);
    await expect(docxReplace(b, 'Before\tafter', 'x')).rejects.toThrow(/tab/);
    const once = await docxReplace(b, 'June forecast', 'plan');
    await expect(docxReplace(once, 'Net revenue', 'Revenue')).rejects.toThrow(/already has tracked changes/);
  });

  it('inserts a tracked paragraph after an anchor, with a style', async () => {
    const after = await docxInsertParagraph(await makeDocx(), 'June forecast', '4.2 Regulatory outlook', 'Heading1');
    const xml = await part(after, 'word/document.xml');
    expect(xml).toMatch(/June forecast\.<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:pStyle w:val="Heading1"\/><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">4\.2 Regulatory outlook<\/w:t>/);
    expect(await docxText(after)).toContain('[Heading1] 4.2 Regulatory outlook');
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
