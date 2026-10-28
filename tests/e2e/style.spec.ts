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
    // Compact's composer: Send is shorter than Comfortable's 44px minimum.
    expect((await page.getByRole('button', { name: 'Send' }).boundingBox())!.height).toBeLessThan(40);

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

// The settings form is label-left rows in both styles: every field, the two limits and the Theme and Style radios start
// at one edge beside their labels, nothing overflows the 780px dialog sideways, and the MCP form keeps its long labels
// above their fields. The dialog still scrolls at 940px tall (it holds the profile and the MCP servers), so no height is
// claimed.
test('the settings dialog lays its fields out in label-left rows in both styles', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'foundry-settings-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1480, 940));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1480);
    await page.getByRole('button', { name: /Model settings/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('group', { name: 'Theme' })).toBeVisible();
    const measure = () => page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]')!;
      const textBox = (label: Element) => { const range = document.createRange(); range.selectNodeContents(label.firstChild!); return range.getBoundingClientRect(); };
      const field = (label: string) => [...dialog.querySelectorAll('.profile-form > label, .profile-form > .limits label')].find(element => element.firstChild?.textContent?.trim() === label)!;
      const rows = ['Name', 'Context limit', 'Credential'].map(label => {
        const element = field(label); const input = element.querySelector('input')!.getBoundingClientRect(); const text = textBox(element);
        return { label, inputLeft: Math.round(input.left), beside: text.right <= input.left && text.top < input.bottom && text.bottom > input.top };
      });
      const options = [...dialog.querySelectorAll('.appearance-settings')].map(fieldset => Math.round(fieldset.querySelector('.appearance-options')!.getBoundingClientRect().left));
      const key = document.querySelector('[aria-label="MCP key"]')!; const keyLabel = key.closest('label')!;
      const heights = [...dialog.querySelectorAll('.profile-form > label > input, .profile-form > label > select, .profile-form > .limits input')].map(control => Math.round(control.getBoundingClientRect().height));
      return { width: Math.round(dialog.getBoundingClientRect().width), sideways: dialog.scrollWidth > dialog.clientWidth, rows, options, heights: [...new Set(heights)], mcpStacked: key.getBoundingClientRect().top >= textBox(keyLabel).bottom };
    });
    for (const choice of ['Comfortable', 'Compact'] as const) {
      await dialog.getByRole('group', { name: 'Style' }).getByRole('radio', { name: choice }).check();
      await expect.poll(() => style(page)).toBe(choice.toLowerCase());
      const layout = await measure();
      expect(layout.width, choice).toBe(Math.min(780, 1480 - 48));
      expect(layout.sideways, `${choice}: no sideways scroll`).toBe(false);
      expect(layout.rows.map(row => row.beside), `${choice}: each label beside its field`).toEqual([true, true, true]);
      const edges = [...layout.rows.map(row => row.inputLeft), ...layout.options];
      expect(Math.max(...edges) - Math.min(...edges), `${choice}: fields and radios share one edge ${JSON.stringify(edges)}`).toBeLessThanOrEqual(1);
      expect(layout.mcpStacked, `${choice}: the MCP form keeps its labels above`).toBe(true);
      // Inputs and selects share one height, so the rows keep one rhythm.
      expect(layout.heights, `${choice}: field heights`).toEqual([choice === 'Comfortable' ? 29 : 27]);
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
