import { _electron as electron, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFakeOllama, type FakeOllama } from './fake-ollama';

let ollama: FakeOllama;

test.beforeEach(async () => { ollama = await startFakeOllama({ installed: ['qwen3:8b'] }); });
test.afterEach(async () => { await ollama.close(); });

test('web research: search, read, cite, and list numbered sources', async () => {
  const packaged = process.env.E2E_APP_PATH;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, '--no-sandbox'],
    env: { ...process.env, JARVIS_OLLAMA_URL: ollama.url, JARVIS_SEARCH_URL: `${ollama.url}/ddg/html/`, JARVIS_ALLOW_LOCAL_WEB: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.wordmark');

  const input = page.getByLabel('Message Jarvis');
  await input.fill('What is the ECB deposit rate right now?');
  await input.press('Enter');

  await expect(page.locator('.log').filter({ hasText: '“ECB deposit facility rate” · 1 result (DuckDuckGo)' })).toBeVisible();
  await expect(page.locator('.log').filter({ hasText: '[1] Key ECB interest rates' })).toBeVisible();
  await expect(page.locator('.msg-jarvis').filter({ hasText: 'unchanged since June' })).toBeVisible();

  // The citation opens the source in the Research tab.
  await page.getByRole('button', { name: 'Source 1' }).click();
  await expect(page.getByRole('tab', { name: /Research/ })).toHaveAttribute('aria-selected', 'true');
  const source = page.locator('.source[data-n="1"]');
  await expect(source).toHaveClass(/focused/);
  await expect(source).toContainText('Key ECB interest rates');
  await expect(source).toContainText('2026-09-11');
  await expect(source).toContainText('Cited');
  await expect(page.locator('.searches')).toContainText('“ECB deposit facility rate”');
  await page.screenshot({ path: path.join(os.tmpdir(), 'jarvis-research.png') });

  // The switch in Settings turns research off.
  await page.getByRole('button', { name: 'Settings' }).click();
  const toggle = page.getByLabel('Web research');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await app.close();
});
