import { _electron as electron, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { startFakeOllama, type FakeOllama } from './fake-ollama';
import { makeDocx } from '../tests/fixtures';

let ollama: FakeOllama;
test.beforeEach(async () => { ollama = await startFakeOllama({ installed: ['qwen3:8b'] }); });
test.afterEach(async () => { await ollama.close(); });

test('Word: reasons first, rewrites a paragraph by number, creates a document; one model call for a question', async () => {
  const packaged = process.env.E2E_APP_PATH;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-')));
  fs.mkdirSync(path.join(root, 'Board'));
  fs.writeFileSync(path.join(root, 'Board/Q3.docx'), await makeDocx());
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, '--no-sandbox'],
    env: { ...process.env, JARVIS_OLLAMA_URL: ollama.url, JARVIS_WORKSPACE: root },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.wordmark');
  await page.getByLabel('Access for Board').selectOption('edit_ask');

  // The model is loaded ahead of time and kept in memory.
  await expect.poll(() => ollama.chats.some((c) => c.messages === 0 && c.keepAlive === '30m')).toBe(true);

  // A quick question: one model call, no reasoning.
  const before = ollama.chats.length;
  const input = page.getByLabel('Message Jarvis');
  await input.fill('What is the capital of France?');
  await input.press('Enter');
  await expect(page.locator('.msg-jarvis').filter({ hasText: 'Paris' })).toBeVisible();
  await expect(page.locator('.lane-status').first()).toHaveText('Answered');
  expect(ollama.chats.slice(before).filter((c) => c.messages > 0).map((c) => c.think)).toEqual([false]);

  // Document work: reasoning, then a tracked rewrite of ¶2.
  await input.fill('Rewrite paragraph 2 of Board/Q3.docx with the September figures');
  await input.press('Enter');
  await expect(page.locator('.log').filter({ hasText: 'Board/Q3.docx' }).first()).toBeVisible();
  await expect(page.locator('.msg-jarvis').filter({ hasText: 'Paragraph 2 now has the September figures' })).toBeVisible();
  const reasoning = page.locator('.thinking').first();
  await expect(reasoning).toContainText('Reasoning');
  await reasoning.locator('summary').click();
  await expect(reasoning).toContainText('Paragraph 2 holds the revenue sentence.');
  await expect(page.locator('.change-title').filter({ hasText: '¶2 rewritten' })).toBeVisible();
  await expect(page.locator('.doc-text .ins').first()).toContainText('€4.82M, 3.1% above');
  await page.screenshot({ path: path.join(os.tmpdir(), 'jarvis-word.png') });
  await page.locator('.change-actions').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.locator('.change-done').first()).toContainText('Accepted');
  const xml = await (await JSZip.loadAsync(fs.readFileSync(path.join(root, 'Board/Q3.docx')))).file('word/document.xml')!.async('string');
  expect(xml).toMatch(/<w:delText xml:space="preserve">€4\.61M, <\/w:delText>/);
  expect(xml).toContain('w:author="JARVIS"');

  // A new Word document.
  await page.getByRole('button', { name: /New lane/ }).click();
  await input.fill('Write a short board memo as Board/Memo.docx');
  await input.press('Enter');
  await expect(page.locator('.change-title').filter({ hasText: 'New Word document Memo.docx' })).toBeVisible();
  await page.locator('.change-actions').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(() => fs.existsSync(path.join(root, 'Board/Memo.docx'))).toBe(true);
  const memo = await (await JSZip.loadAsync(fs.readFileSync(path.join(root, 'Board/Memo.docx')))).file('word/document.xml')!.async('string');
  expect(memo).toContain('<w:pStyle w:val="Title"/>');
  await app.close();
});
