import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { startFakeOllama, type FakeOllama } from './fake-ollama';
import { makeDocx, makePdf, makeXlsx } from '../tests/fixtures';

let ollama: FakeOllama;
let userData: string;
let root: string;
const ORIGINAL = '# Q3 Board Report\n\nNet revenue was €4.61M, slightly ahead of the June forecast.\n';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const packaged = process.env.E2E_APP_PATH;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, '--no-sandbox'],
    env: { ...process.env, JARVIS_OLLAMA_URL: ollama.url, JARVIS_WORKSPACE: root },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.wordmark');
  return { app, page };
}

test.beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-')));
  for (const [rel, text] of [['Finance/Sept-close.csv', 'metric,value\nNet revenue,4.82\n'], ['Board/Q3-Board.md', ORIGINAL], ['Personal/diary.md', 'private']]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  ollama = await startFakeOllama({ installed: ['qwen3:8b'] });
});
test.afterEach(async () => { await ollama.close(); });

const board = () => fs.readFileSync(path.join(root, 'Board/Q3-Board.md'), 'utf8');

test('file work: scoped read, reviewed edit, gate, checkpoints, restore', async () => {
  const { app, page } = await launch();
  await expect(page.locator('.workspace-pick')).toContainText(path.basename(root));
  await expect(page.getByLabel('Access for Personal')).toHaveValue('none');
  await expect(page.getByLabel('Access for main folder')).toHaveValue('none');
  await page.getByLabel('Access for Finance').selectOption('read');
  await page.getByLabel('Access for Board').selectOption('edit_ask');

  const input = page.getByLabel('Message Jarvis');
  await input.fill('Update the revenue in the board report from the September close, then email it');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Approve plan' }).click();

  // Step 1 reads, step 2 stages an edit; the original file is untouched.
  await expect(page.locator('.log').filter({ hasText: 'Finance/Sept-close.csv · 3 lines' })).toBeVisible();
  await expect(page.locator('.log').filter({ hasText: 'Board/Q3-Board.md · held for review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve step' })).toBeDisabled();
  await expect(page.getByText('Review 1 open change first')).toBeVisible();
  expect(board()).toBe(ORIGINAL);

  // Review the inline diff, then accept.
  await expect(page.getByText('Changes · 1 open')).toBeVisible();
  const marked = (cls: string) => page.locator(`.doc-text .${cls}`).evaluateAll((els) => els.map((e) => e.textContent).join('|'));
  expect(await marked('del')).toMatch(/61M.*slightly.*ahead/);
  expect(await marked('ins')).toMatch(/82M.*3\.1%.*above/);
  await expect(page.locator('.doc-text')).toContainText('Net revenue was');
  await expect(page.locator('.change-why')).toHaveText('Source: Finance/Sept-close.csv, row 2');
  await page.locator('.rail').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('Changes · 0 open')).toBeVisible();
  expect(board()).toContain('€4.82M, 3.1% above');

  await page.getByRole('button', { name: 'Approve step' }).click();
  await expect(page.locator('.lane-row').first()).toContainText('Done');

  // Files tab and audit.
  await page.getByRole('tab', { name: /Files/ }).click();
  await expect(page.locator('.files')).toContainText('Finance/Sept-close.csv');
  await expect(page.locator('.files')).toContainText('Board/Q3-Board.md');
  await page.screenshot({ path: 'test-results/phase3-files.png' });

  // Restore to before the edits.
  await expect(page.locator('.cp')).toHaveCount(3);
  await page.locator('.cp').filter({ hasText: 'Before edits' }).click();
  await page.getByRole('button', { name: /^Restore to/ }).click();
  await expect(page.locator('.log').filter({ hasText: 'Files are back to' })).toBeVisible();
  expect(board()).toBe(ORIGINAL);
  await expect(page.locator('.cp').last()).toContainText('Before restore to');
  await expect(page.getByRole('button', { name: 'Resume from step 1' })).toBeVisible();
  await page.getByRole('tab', { name: /Document/ }).click();
  await page.screenshot({ path: 'test-results/phase3-restored.png' });
  await app.close();
});

test('blocked folder: Jarvis asks for access instead of reading it', async () => {
  const { app, page } = await launch();
  const input = page.getByLabel('Message Jarvis');
  await input.fill('What did I write in my diary?');
  await input.press('Enter');
  const card = page.getByRole('alert').filter({ hasText: 'no access to Personal/' });
  await expect(card).toBeVisible();
  await expect(page.getByText('I could not open that file', { exact: false })).toBeVisible();
  await card.getByRole('button', { name: 'Allow reading Personal/' }).click();
  await expect(card).toContainText('Access granted');
  await expect(page.getByLabel('Access for Personal')).toHaveValue('read');
  await page.screenshot({ path: 'test-results/phase3-denied.png' });
  await app.close();
});

test('creating folders: inside an edit folder, and at the top of the workspace', async () => {
  const { app, page } = await launch();
  await page.getByLabel('Set access for every folder').selectOption('edit_ask');
  await expect(page.getByLabel('Access for main folder')).toHaveValue('edit_ask');
  await expect(page.getByLabel('Access for Board')).toHaveValue('edit_ask');

  const input = page.getByLabel('Message Jarvis');
  await input.fill('Create a folder called Board/2026');
  await input.press('Enter');
  await expect(page.locator('.log').filter({ hasText: 'Board/2026 · held for review' })).toBeVisible();
  await expect(page.locator('.doc-note')).toContainText('Accepting creates the folder Board/2026/');
  await page.locator('.rail').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('Changes · 0 open')).toBeVisible();
  expect(fs.statSync(path.join(root, 'Board/2026')).isDirectory()).toBe(true);

  // A brand-new top-level folder follows the main folder's access and appears in the list.
  await page.getByRole('button', { name: '+ New lane' }).click();
  await input.fill('Make a new folder called Reports');
  await input.press('Enter');
  await page.locator('.rail').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByLabel('Access for Reports')).toHaveValue('edit_ask');
  expect(fs.statSync(path.join(root, 'Reports')).isDirectory()).toBe(true);

  // A folder made in Finder shows up when you come back to the app.
  fs.mkdirSync(path.join(root, 'FromFinder'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Access for FromFinder')).toHaveValue('edit_ask');
  await page.screenshot({ path: 'test-results/phase3-folders.png' });
  await app.close();
});

test('check file access and the waiting-changes banner', async () => {
  const { app, page } = await launch();
  await page.getByLabel('Access for Board').selectOption('edit_ask');
  await page.getByLabel('Access for Finance').selectOption('read');
  await page.getByRole('button', { name: 'Check file access' }).click();
  const list = page.locator('.check-list');
  await expect(list).toContainText('macOS lets JARVIS open the workspace');
  await expect(list).toContainText('Board/: read and write (changes wait for your Accept)');
  await expect(list).toContainText('Finance/: read');
  await expect(list).toContainText('Personal/: no access (by your choice)');
  await expect(list).toContainText('The model actually calls file tools');
  await expect(list.locator('li.bad')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/phase3-check.png' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await page.getByLabel('Message Jarvis').fill('Create a folder called Board/2026');
  await page.getByLabel('Message Jarvis').press('Enter');
  const banner = page.locator('.pending-banner');
  await expect(banner).toContainText('1 change waiting for you');
  await banner.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(banner).toBeHidden();
  expect(fs.statSync(path.join(root, 'Board/2026')).isDirectory()).toBe(true);
  await app.close();
});

test('Office: Excel cells and a Word tracked change, reviewed then accepted', async () => {
  fs.writeFileSync(path.join(root, 'Board/close.xlsx'), await makeXlsx());
  fs.writeFileSync(path.join(root, 'Board/Q3.docx'), await makeDocx());
  fs.writeFileSync(path.join(root, 'Board/memo.pdf'), await makePdf());
  const { app, page } = await launch();
  await page.getByLabel('Access for Board').selectOption('edit_ask');
  await page.getByLabel('Message Jarvis').fill('Put the September revenue into the workbook and the board report');
  await page.getByLabel('Message Jarvis').press('Enter');
  await expect(page.locator('.pending-banner')).toContainText('2 changes waiting for you');
  await expect(page.locator('.log').filter({ hasText: 'Board/memo.pdf · 5 lines' })).toBeVisible();
  await expect(page.locator('.cells')).toContainText('Summary!B2');
  await expect(page.locator('.cells .ins-cell')).toHaveText('4.82');
  await page.locator('.change-title').filter({ hasText: 'slightly ahead of' }).click();
  await expect(page.locator('.doc-hint')).toContainText('Saved as tracked changes');
  await page.screenshot({ path: 'test-results/phase4-office.png' });
  await page.locator('.rail').getByRole('button', { name: 'Accept all' }).click();
  await expect(page.locator('.pending-banner')).toBeHidden();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(path.join(root, 'Board/close.xlsx')) as unknown as ArrayBuffer);
  expect(wb.getWorksheet('Summary')!.getCell('B2').value).toBe(4.82);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(path.join(root, 'Board/Q3.docx')))).file('word/document.xml')!.async('string');
  expect(xml).toContain('w:author="JARVIS"');
  await app.close();
});

test('updates: finds a newer release on GitHub and downloads it', async () => {
  const zip = Buffer.from('PK test');
  const gh = http.createServer((req, res) => {
    if (req.url?.startsWith('/repos/JaganmuthuS/android-app/releases?')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify([{ tag_name: 'mac-v9.9.9', draft: false, prerelease: false, body: 'Everything is better.', html_url: 'x',
        assets: [{ id: 7, name: 'JARVIS-mac.zip', size: zip.length }, { id: 8, name: 'JARVIS-mac-apple-silicon.zip', size: zip.length }] }]));
    }
    if (/\/releases\/assets\/[78]$/.test(req.url ?? '')) { res.setHeader('content-length', String(zip.length)); return res.end(zip); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
  process.env.JARVIS_UPDATE_API = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  process.env.JARVIS_UPDATE_DRYRUN = '1';
  try {
    const { app, page } = await launch();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByText('Version 9.9.9 is available.', { exact: false })).toBeVisible();
    await expect(page.locator('.update-notes')).toHaveText('Everything is better.');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.update-pill')).toHaveText('Update to 9.9.9');
    await page.locator('.update-pill').click();
    await page.getByRole('button', { name: 'Update now' }).click();
    await expect(page.getByText('Installing. JARVIS will close and reopen', { exact: false })).toBeVisible();
    await page.screenshot({ path: 'test-results/phase4-update.png' });
    await app.close();
  } finally {
    delete process.env.JARVIS_UPDATE_API;
    delete process.env.JARVIS_UPDATE_DRYRUN;
    gh.close();
  }
});
