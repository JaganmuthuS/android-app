// Small but real Office files for tests, built in memory.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const CT = (parts: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts}</Types>`;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr></w:style><w:style w:type="paragraph" w:customStyle="1" w:styleId="BoardBody"><w:name w:val="Board v4 Body"/></w:style></w:styles>`;

export async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'));
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', STYLES_XML);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>2. Financial summary</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:pStyle w:val="BoardBody"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">Net revenue was €4.61M, </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>slightly ahead of</w:t></w:r><w:r><w:t xml:space="preserve"> the June forecast.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Before</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>after tab</w:t></w:r></w:p>`
    + `<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makeXlsx(withChart = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary');
  ws.getCell('A1').value = 'Metric';
  ws.getCell('B1').value = 'Value';
  ws.getCell('A2').value = 'Net revenue';
  ws.getCell('B2').value = 4.61;
  ws.getCell('B2').numFmt = '€0.00"M"';
  ws.getCell('B2').font = { bold: true, color: { argb: 'FFC00000' } };
  ws.getCell('A3').value = 'Doubled';
  ws.getCell('B3').value = { formula: 'B2*2', result: 9.22 } as ExcelJS.CellFormulaValue;
  wb.addWorksheet('Notes').getCell('A1').value = 'Keep me';
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  if (!withChart) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  zip.file('xl/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

const slide = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr lang="en-GB" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr lang="en-GB" sz="2000"/><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>`
  + `</p:spTree></p:cSld></p:sld>`;

export async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT(''));
  zip.file('ppt/slides/slide1.xml', slide('Q3 results', 'Revenue €4.61M'));
  zip.file('ppt/slides/slide2.xml', slide('Outlook', 'Hiring continues'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('AI Act memo: limited risk, transparency duties only.', { x: 50, y: 700, size: 12, font });
  doc.addPage().drawText('Page two text.', { x: 50, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}
