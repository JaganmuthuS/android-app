import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFakeOllama, type FakeOllama } from './fake-ollama';

let ollama: FakeOllama;
let userData: string;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const packaged = process.env.E2E_APP_PATH;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, '--no-sandbox'],
    env: { ...process.env, JARVIS_KEEP_DEFAULTS: '1', JARVIS_OLLAMA_URL: ollama.url },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.wordmark');
  return { app, page };
}

test.beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  ollama = await startFakeOllama();
});
test.afterEach(async () => { await ollama.close(); });

test('first run: set up the model, answer a question, run a gated plan', async () => {
  const { app, page } = await launch();

  // Security settings on the real window.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences();
    return { contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox };
  });
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });

  // Setup guide: Ollama is running but no model yet.
  await expect(page.getByText('Ollama 0.12.0-test is running.')).toBeVisible();
  await page.getByRole('button', { name: 'Download qwen3:8b' }).click();
  await expect(page.getByRole('region', { name: 'Set up the AI engine' })).toBeHidden();
  await expect(page.getByText('What should I work on?', { exact: false })).toBeVisible();

  // A plain question gets a streamed answer, no plan.
  const input = page.getByLabel('Message Jarvis');
  await input.fill('What is the capital of France?');
  await input.press('Enter');
  await expect(page.getByText('Paris is the capital of France.')).toBeVisible();
  await expect(page.locator('.lane-row').first()).toContainText('Answered');

  // A task gets a plan and waits.
  await page.getByRole('button', { name: '+ New lane' }).click();
  await expect(page.locator('.lane-row')).toHaveCount(2);
  await input.fill('Write the September board summary and email it to the board');
  await input.press('Enter');
  await expect(page.getByText('Here is my plan.', { exact: false })).toBeVisible();
  await expect(page.locator('.lane-name')).toHaveText('Board summary');
  await expect(page.locator('.plan-step')).toHaveCount(3);
  await expect(page.locator('.plan-step').nth(2)).toContainText('needs your approval');

  // Edit steps: rename the first one.
  await page.getByRole('button', { name: 'Edit steps' }).click();
  await page.getByRole('textbox', { name: 'Step 1' }).fill('Collect the September figures from Finance');
  await page.getByRole('button', { name: 'Save steps' }).click();
  await expect(page.locator('.plan-step').first()).toContainText('from Finance');

  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByRole('button', { name: 'Approve step' })).toBeVisible();
  await expect(page.getByText('Finished: Draft a three-line summary.')).toBeVisible();
  await expect(page.locator('.lane-row').nth(1)).toContainText('Waiting for your approval');

  await page.getByRole('button', { name: 'Approve step' }).click();
  await expect(page.getByText('Should I file the draft in Board?', { exact: false })).toBeVisible();
  await expect(page.locator('.lane-row').nth(1)).toContainText('Done');
  await expect(page.locator('.plan-head .label')).toHaveText('Plan · 3 of 3');
  await page.screenshot({ path: 'test-results/phase2-flow.png' });
  await app.close();

  // Everything is still there after a restart.
  const again = await launch();
  await expect(again.page.locator('.lane-row')).toHaveCount(2);
  await expect(again.page.locator('.lane-name')).toHaveText('Board summary');
  await expect(again.page.getByText('Should I file the draft in Board?', { exact: false })).toBeVisible();
  await again.app.close();
});

test('settings: memories, autonomy and engine errors', async () => {
  ollama.installed.push('qwen3:8b');
  const { app, page } = await launch();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('New memory').fill('Exact figures, no hedging words');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('dialog').getByRole('radio', { name: 'Autonomous' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.memory-list')).toContainText('Exact figures, no hedging words');

  // Autonomous lane runs without plan approval but still stops at the gate.
  await page.getByRole('button', { name: '+ New lane' }).click();
  await page.getByLabel('Message Jarvis').fill('Board summary, then email it');
  await page.getByLabel('Message Jarvis').press('Enter');
  await expect(page.getByText('Running the plan below.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve step' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip it' }).click();
  await expect(page.locator('.plan-step').nth(2)).toContainText('skipped');
  await expect(page.locator('.lane-row').nth(1)).toContainText('Done');

  // Switching to a model that isn't downloaded gives a clear error in the chat.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Reasoning model').fill('llama3.2:1b');
  await page.getByRole('button', { name: 'Use model' }).click();
  await expect(page.getByRole('dialog').getByText('Not downloaded yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: '+ New lane' }).click();
  await page.getByLabel('Message Jarvis').fill('Hello?');
  await page.getByLabel('Message Jarvis').press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'is not downloaded yet' })).toBeVisible();
  await expect(page.locator('.lane-row').nth(1)).toContainText('Done');
  await page.screenshot({ path: 'test-results/phase2-settings.png' });
  await app.close();
});
