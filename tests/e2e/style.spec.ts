import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForRuntimeReady } from './fixtures';

type Recorded = Window & { firstPaintStyle?: string };
// data-style when parsing ends: the deferred module bundle has not run yet, so only the first-paint script can have set it.
const recordFirstPaint = (page: Page) => page.addInitScript(() => document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') (window as Recorded).firstPaintStyle = document.documentElement.dataset.style; }));
const style = (page: Page) => page.evaluate(() => document.documentElement.dataset.style);

// Compact is a closed choice beside the theme. It changes sizes only, so the geometry the other specs assert for the
// default style is asserted here for Compact: the inspector limit follows the narrower rail at runtime, Send stays
// short and inside a narrow window, and the rail footer stays in the window at 1000x680 and 200% zoom.
test('Compact is a closed style choice that persists, composes with Dark and keeps the layout limits', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'foundry-style-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await expect.poll(() => style(page)).toBe('comfortable');
    await page.getByLabel('Chat message', { exact: true }).fill('Compact style');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Compact style', exact: true })).toBeVisible();

    await page.getByRole('button', { name: /Model settings/ }).first().click();
    const styles = page.getByRole('dialog').getByRole('group', { name: 'Style' });
    await expect(styles.getByRole('radio')).toHaveCount(2);
    await expect(styles.getByRole('radio', { name: 'Comfortable' })).toBeChecked();
    await styles.getByRole('radio', { name: 'Compact' }).check();
    await expect.poll(() => style(page)).toBe('compact');
    await page.getByRole('dialog').getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).check();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.getByRole('button', { name: 'Close settings' }).click();

    // The rail is narrower in Compact; the keyboard limit was read again when the style changed.
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width: 1480, height: 940 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1480);
    const rail = Math.round((await page.locator('.sidebar-shell').boundingBox())!.width);
    expect(rail).toBe(240);
    const separator = page.getByRole('separator', { name: 'Resize inspector' });
    await separator.focus();
    await page.keyboard.press('End');
    await expect(separator).toHaveAttribute('aria-valuemax', String(1480 - rail - 320 - 5));
    await expect.poll(async () => Math.round((await page.locator('#task-inspector').boundingBox())!.width)).toBe(1480 - rail - 320 - 5);
    // Compact's composer: Send is shorter than Comfortable's 52px minimum.
    expect((await page.getByRole('button', { name: 'Send' }).boundingBox())!.height).toBeLessThan(48);

    // Approval fields put the label beside the value in a wide list and stack in a narrow one (the stylesheet's container rule).
    const layout = await page.evaluate(() => {
      const list = (className: string, width: number) => {
        const element = document.createElement('div');
        element.className = className;
        element.style.width = `${width}px`;
        element.innerHTML = '<article class="approval-card"><dl><dt>Shell</dt><dd>powershell.exe</dd></dl></article>';
        document.body.append(element);
        return element;
      };
      const measure = (element: HTMLElement) => {
        const label = element.querySelector('dt')!.getBoundingClientRect(), value = element.querySelector('dd')!.getBoundingClientRect();
        return { beside: label.right <= value.left, below: value.top >= label.bottom };
      };
      const narrow = list('approvals-panel', 400), wide = list('approval-tray-cards', 900);
      const result = { narrow: measure(narrow), wide: measure(wide) };
      narrow.remove(); wide.remove();
      return result;
    });
    expect(layout).toEqual({ narrow: { beside: false, below: true }, wide: { beside: true, below: false } });

    // Back to Comfortable: the wider rail lowers the limit, and the inspector is clamped to it.
    const chooseStyle = async (name: string) => {
      await page.getByRole('button', { name: /Model settings/ }).first().click();
      await page.getByRole('dialog').getByRole('group', { name: 'Style' }).getByRole('radio', { name }).check();
      await page.getByRole('button', { name: 'Close settings' }).click();
    };
    await chooseStyle('Comfortable');
    await expect.poll(async () => Math.round((await page.locator('#task-inspector').boundingBox())!.width)).toBe(1480 - 270 - 320 - 5);
    await expect(separator).toHaveAttribute('aria-valuemax', String(1480 - 270 - 320 - 5));
    await chooseStyle('Compact');
    await expect.poll(() => style(page)).toBe('compact');

    // The first-paint script restores both choices.
    await recordFirstPaint(page);
    await page.reload();
    await waitForRuntimeReady(page);
    expect(await page.evaluate(() => (window as Recorded).firstPaintStyle)).toBe('compact');
    expect(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.style])).toEqual(['dark', 'compact']);

    // The minimum window at 200% zoom, before any viewport emulation: wait for its 340 CSS px so the earlier layout cannot pass.
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(1000, 680); window.webContents.setZoomFactor(2); });
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(340);
    const footer = page.getByRole('button', { name: 'Hooks and follow-ups' });
    await expect.poll(async () => { const box = (await footer.boundingBox())!; return box.y + box.height <= 340; }).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1));

    // Narrower than the window minimum, so emulated, as projects.spec.ts does.
    await page.setViewportSize({ width: 880, height: 720 });
    await page.getByRole('button', { name: 'Inbox & history', exact: true }).click();
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.getByRole('navigation', { name: 'Task history' }).locator('.task-row', { hasText: 'Compact style' }).click();
    const send = await page.getByRole('button', { name: /^Send/ }).boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(880);

    // A stored value outside the list is ignored.
    await page.evaluate(() => localStorage.setItem('foundry.style', 'dense'));
    await page.reload();
    await waitForRuntimeReady(page);
    expect(await page.evaluate(() => (window as Recorded).firstPaintStyle)).toBe('comfortable');
    expect(await style(page)).toBe('comfortable');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
