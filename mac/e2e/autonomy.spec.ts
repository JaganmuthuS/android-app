import { _electron as electron, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFakeOllama, type FakeOllama } from './fake-ollama';

let ollama: FakeOllama;
test.beforeEach(async () => { ollama = await startFakeOllama({ installed: ['qwen3:8b'] }); });
test.afterEach(async () => { await ollama.close(); });

test('0.6 defaults: autonomous edits that apply and verify at once, and a fast model for routine requests', async () => {
  const packaged = process.env.E2E_APP_PATH;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-')));
  fs.mkdirSync(path.join(root, 'Notes'));
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, '--no-sandbox'],
    env: { ...process.env, JARVIS_OLLAMA_URL: ollama.url, JARVIS_WORKSPACE: root, JARVIS_TEST_MEMORY_GB: '16' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.wordmark');

  // Autonomous by default; the fast model downloads by itself.
  await expect(page.getByRole('radio', { name: 'Autonomous' }).first()).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => ollama.installed.includes('qwen3:4b'), { timeout: 15_000 }).toBe(true);

  // A routine request goes to the fast model and is done at once: no Accept needed.
  await page.getByLabel('Access for Notes').selectOption('edit_auto');
  const input = page.getByLabel('Message Jarvis');
  await input.fill('Create a folder called Notes/2026');
  await input.press('Enter');
  await expect(page.locator('.log').filter({ hasText: 'Notes/2026 · done' })).toBeVisible();
  await expect.poll(() => fs.existsSync(path.join(root, 'Notes/2026'))).toBe(true);
  await expect(page.locator('.msg-jarvis .model-tag').last()).toContainText('qwen3:4b');
  expect(ollama.chats.filter((c) => c.messages > 0).every((c) => c.model === 'qwen3:4b' && !c.think)).toBe(true);
  await expect(page.locator('.lane-status').first()).not.toHaveText(/to review/);

  // Settings show both models.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Reasoning model')).toHaveValue('qwen3:8b');
  await expect(page.getByLabel('Fast model')).toHaveValue('qwen3:4b');
  await expect(page.getByText('qwen3:4b is downloaded and answers routine requests.')).toBeVisible();
  await app.close();
});
