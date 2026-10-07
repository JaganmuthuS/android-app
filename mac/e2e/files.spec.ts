import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFakeOllama, type FakeOllama } from './fake-ollama';

let ollama: FakeOllama;
let userData: string;
let root: string;
const ORIGINAL = '# Q3 Board Report\n\nNet revenue was €4.61M, slightly ahead of the June forecast.\n';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--no-sandbox'],
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
