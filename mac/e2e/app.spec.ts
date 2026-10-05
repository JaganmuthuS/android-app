import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--no-sandbox'] });
  const page = await app.firstWindow();
  await page.waitForSelector('.wordmark');
  return { app, page };
}

test('board report flow: plan, review, gate, export, restore, resume', async () => {
  const { app, page } = await launch();

  // Security settings on the real window.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences();
    return { contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox, min: w.getMinimumSize() };
  });
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, min: [1180, 720] });
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');

  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Reading the request and checking folder access…')).toBeVisible();
  await expect(page.getByText('Here is my plan.', { exact: false })).toBeVisible();
  await expect(page.locator('.lane-row').first()).toContainText('Waiting for plan approval');

  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByText('Drafted', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Changes · 4 open')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve export' })).toBeDisabled();
  await expect(page.getByText('Review 4 open changes first')).toBeVisible();

  // Review: reject one, accept the rest.
  await page.locator('.change').nth(1).getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('button', { name: 'Accept all' }).click();
  await expect(page.getByText('Changes · 0 open')).toBeVisible();
  await expect(page.locator('.page p').first()).toContainText('€4.82M, slightly ahead of the forecast');

  await page.getByRole('button', { name: 'Approve export' }).click();
  await expect(page.getByText('Board/Out/Q3-Board.pdf · 12 pages · fonts embedded')).toBeVisible();

  // Files and Research tabs.
  await page.getByRole('tab', { name: /Files/ }).click();
  await expect(page.getByRole('cell', { name: 'Board/Out/Q3-Board.pdf' })).toBeVisible();
  await page.getByRole('tab', { name: /Research/ }).click();
  await expect(page.getByText('14 of 14 read')).toBeVisible();

  // Restore to "Before edits", then resume.
  await page.getByRole('button', { name: /09:12 Before edits/ }).click();
  await page.getByRole('button', { name: 'Restore to 09:12' }).click();
  await expect(page.getByText('Changes · 0 open')).toBeVisible();
  await expect(page.getByText('[To be written]')).toBeVisible();
  await page.getByRole('button', { name: 'Resume from step 1' }).click();
  await expect(page.locator('.lane-row').first()).toContainText('Working · step');

  await page.screenshot({ path: 'test-results/flow.png' });
  await page.getByRole('tab', { name: /Document/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/doc.png' });
  await app.close();
});

test('remembers lane, tab and autonomy across launches', async () => {
  let { app, page } = await launch();
  await page.getByRole('radio', { name: 'Ask if risky' }).click();
  await page.getByRole('button', { name: /Vendor contract redlines/ }).click();
  await page.getByRole('tab', { name: /Files/ }).click();
  await expect(page.getByText('Clauses 7.2 (unlimited liability)', { exact: false })).toBeVisible();
  await page.waitForTimeout(300);
  await app.close();

  ({ app, page } = await launch());
  await expect(page.getByRole('radio', { name: 'Ask if risky' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.lane-name')).toHaveText('Vendor contract redlines');
  await expect(page.getByRole('tab', { name: /Files/ })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: 'test-results/restored.png' });
  await app.close();
});
