import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForRuntimeReady } from './fixtures';

async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'foundry-theme-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  return { root, app, page: await app.firstWindow() };
}
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const underlay = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas-deep').trim());
const windowBackground = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase());

test('the theme is a closed choice in settings that persists, follows Windows for System and colours the window', async () => {
  test.setTimeout(120_000);
  const { root, app, page } = await launch();
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await waitForRuntimeReady(page);
    expect(await theme(page)).toBe('light');
    await page.getByRole('button', { name: /Model settings/ }).first().click();
    const choices = page.getByRole('dialog').getByRole('group', { name: 'Theme' });
    await expect(choices.getByRole('radio')).toHaveCount(3);
    await expect(choices.getByRole('radio', { name: 'Light' })).toBeChecked();

    await choices.getByRole('radio', { name: 'Dark' }).check();
    await expect.poll(() => theme(page)).toBe('dark');
    const dark = await underlay(page);
    expect(dark).not.toBe('#e8e2d4');
    // main applies the page's theme-color as the window underlay, so resizing never shows the light colour.
    await expect.poll(() => windowBackground(app)).toBe(dark);

    // The first-paint script restores the choice before the app starts.
    await page.reload();
    await waitForRuntimeReady(page);
    expect(await theme(page)).toBe('dark');

    await page.getByRole('button', { name: /Model settings/ }).first().click();
    await page.getByRole('dialog').getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'System' }).check();
    await expect.poll(() => theme(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');

    // A stored value outside the list is ignored.
    await page.evaluate(() => localStorage.setItem('foundry.theme', 'paper'));
    await page.reload();
    await waitForRuntimeReady(page);
    expect(await theme(page)).toBe('light');
    await expect.poll(() => windowBackground(app)).toBe('#e8e2d4');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
