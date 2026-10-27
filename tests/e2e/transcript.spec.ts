import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForRuntimeReady } from './fixtures';

type Box = { left: number; right: number; top: number; bottom: number };
// The author line and the first paragraph of each message, in CSS pixels.
const layout = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[aria-label="Conversation transcript"] article.message:not(.compaction-summary)')].map(article => {
  const box = (element: Element | null): Box => { const rect = element!.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
  return { role: article.classList.contains('user') ? 'user' : 'assistant', message: box(article), meta: box(article.querySelector('.message-meta')), text: box(article.querySelector('p')) };
}));

// From a 620px transcript the author and time hang in a column beside the text and both speakers share its left edge;
// a narrower transcript (here the 1000x680 minimum window) keeps them on a line above the text.
test('the transcript hangs the author and time beside the text when wide, and above it when narrow', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'foundry-transcript-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await page.getByLabel('Chat message', { exact: true }).fill('Lay out the transcript');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Fake response: Lay out the transcript', { exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1480, 940));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1480);
    const transcript = page.getByLabel('Conversation transcript');
    expect((await transcript.boundingBox())!.width).toBeGreaterThanOrEqual(620);

    const wide = await layout(page);
    expect(wide.map(message => message.role)).toEqual(['user', 'assistant']);
    for (const message of wide) {
      expect(message.meta.right, `${message.role}: meta beside the text`).toBeLessThanOrEqual(message.text.left);
      expect(Math.abs(message.meta.top - message.text.top), `${message.role}: meta on the text's first line`).toBeLessThan(12);
    }
    expect(Math.abs(wide[0]!.text.left - wide[1]!.text.left), 'both speakers share the text edge').toBeLessThan(1);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 680));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000);
    await expect.poll(async () => (await transcript.boundingBox())!.width).toBeLessThan(620);
    const narrow = await layout(page);
    for (const message of narrow) expect(message.meta.bottom, `${message.role}: meta above the text`).toBeLessThanOrEqual(message.text.top + 1);
    // Your own bubble stays right-aligned in the narrow transcript and the agent's text left-aligned, as before.
    expect(Math.abs(narrow[0]!.text.right - narrow[0]!.message.right), 'your bubble at the right edge').toBeLessThan(1);
    expect(Math.abs(narrow[1]!.text.left - narrow[1]!.message.left), "the agent's text at the left edge").toBeLessThan(1);
    expect(narrow[0]!.text.left, 'your bubble is not stretched to the left edge').toBeGreaterThan(narrow[0]!.message.left + 1);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
