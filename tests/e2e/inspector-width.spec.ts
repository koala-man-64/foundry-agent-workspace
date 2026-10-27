import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForRuntimeReady } from './fixtures';

// The keyboard limit comes from the rail-width tokens (layout.ts); the drag limit measures the rendered rail. Both must
// stop where the conversation keeps its 320px minimum, with the wide rail and with the narrow one (<=1050px).
test('the inspector resizer stops at the same width by keyboard and by drag, leaving the conversation its minimum', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'foundry-inspector-width-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await page.getByLabel('Chat message', { exact: true }).fill('Inspector width');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Inspector width', exact: true })).toBeVisible();
    const separator = page.getByRole('separator', { name: 'Resize inspector' });
    const inspector = page.locator('#task-inspector');
    for (const [width, height] of [[1480, 940], [1040, 760]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      const rail = Math.round((await page.locator('.sidebar-shell').boundingBox())!.width);
      const limit = Math.max(300, width - rail - 320 - 5);

      await separator.focus();
      await page.keyboard.press('End');
      await expect(separator).toHaveAttribute('aria-valuemax', String(limit));
      await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(limit);
      expect(Math.round((await page.locator('.conversation').boundingBox())!.width)).toBeGreaterThanOrEqual(320);

      await page.keyboard.press('Home');
      await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(300);
      const handle = (await separator.boundingBox())!;
      await page.mouse.move(handle.x + 2, handle.y + 40); await page.mouse.down();
      await page.mouse.move(5, handle.y + 40, { steps: 6 }); await page.mouse.up();
      await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(limit);
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

// A window narrowed after the inspector was sized (by a drag, or by a wide window's default) keeps the whole inspector on
// screen and the conversation its minimum; widening the window again restores the chosen width.
test('narrowing the window keeps the whole inspector on screen, and widening it restores the chosen width', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'foundry-inspector-narrow-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await page.getByLabel('Chat message', { exact: true }).fill('Narrow window');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Narrow window', exact: true })).toBeVisible();
    const separator = page.getByRole('separator', { name: 'Resize inspector' });
    const inspector = page.locator('#task-inspector');
    const resize = async (width: number, height: number) => {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    };
    await resize(1480, 940);
    await separator.focus();
    await page.keyboard.press('End');
    const rail = async () => Math.round((await page.locator('.sidebar-shell').boundingBox())!.width);
    const chosen = Math.max(300, 1480 - await rail() - 320 - 5);
    await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(chosen);

    await resize(1100, 760);
    const limit = Math.max(300, 1100 - await rail() - 320 - 5);
    await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(limit);
    const box = (await inspector.boundingBox())!;
    expect(box.x + box.width, 'the inspector ends inside the window').toBeLessThanOrEqual(1100.5);
    expect(Math.round((await page.locator('.conversation').boundingBox())!.width)).toBeGreaterThanOrEqual(320);
    await expect(separator).toHaveAttribute('aria-valuenow', String(limit));
    await expect(separator).toHaveAttribute('aria-valuemax', String(limit));

    await resize(1480, 940);
    await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(chosen);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
