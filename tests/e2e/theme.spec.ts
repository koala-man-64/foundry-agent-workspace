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
type Recorded = Window & { firstPaintTheme?: string; modeChanged?: Promise<void> };
// data-theme when parsing ends: the deferred module bundle has not run yet, so only the first-paint script can have set it.
const recordFirstPaint = (page: Page) => page.addInitScript(() => document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') (window as Recorded).firstPaintTheme = document.documentElement.dataset.theme; }));
const firstPaintTheme = (page: Page) => page.evaluate(() => (window as Recorded).firstPaintTheme);
// Switches the emulated Windows app mode and waits until the page has been told, so every listener has run.
async function windowsMode(page: Page, colorScheme: 'light' | 'dark') {
  await page.evaluate(() => { (window as Recorded).modeChanged = new Promise(done => matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(done), { once: true })); });
  await page.emulateMedia({ colorScheme });
  await page.evaluate(() => (window as Recorded).modeChanged);
}

test('the theme is a closed choice in settings that persists, follows Windows for System and colours the window', async () => {
  test.setTimeout(120_000);
  const { root, app, page } = await launch();
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await waitForRuntimeReady(page);
    // A poll: without the first-paint script the bridge can be ready before React's first commit. The script itself
    // is checked by firstPaintTheme after the reload below.
    await expect.poll(() => theme(page)).toBe('light');
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
    await recordFirstPaint(page);
    await page.reload();
    await waitForRuntimeReady(page);
    expect(await firstPaintTheme(page)).toBe('dark');
    expect(await theme(page)).toBe('dark');

    await page.getByRole('button', { name: /Model settings/ }).first().click();
    await choices.getByRole('radio', { name: 'System' }).check();
    await expect.poll(() => theme(page)).toBe('light');
    await windowsMode(page, 'dark');
    expect(await theme(page)).toBe('dark');
    await windowsMode(page, 'light');
    expect(await theme(page)).toBe('light');

    // The arrow keys move the choice, and leaving System stops following Windows.
    await choices.getByRole('radio', { name: 'System' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(choices.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect.poll(() => theme(page)).toBe('dark');
    await windowsMode(page, 'dark');
    await windowsMode(page, 'light');
    expect(await theme(page)).toBe('dark');

    // A stored value outside the list is ignored.
    await page.evaluate(() => localStorage.setItem('foundry.theme', 'paper'));
    await page.reload();
    await waitForRuntimeReady(page);
    expect(await firstPaintTheme(page)).toBe('light');
    expect(await theme(page)).toBe('light');
    await expect.poll(() => windowBackground(app)).toBe('#e8e2d4');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
