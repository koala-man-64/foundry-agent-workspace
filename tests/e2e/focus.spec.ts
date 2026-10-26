import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixtureTask, waitForRuntimeReady } from './fixtures';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foundry-focus-e2e-'));
  const project = join(root, 'repository'); await mkdir(project);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n\nInitial README content.\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  return { root, project, env };
}

// The renderer is the window's own web contents, so every child view is a browser tab.
const nativeViewsHidden = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.every(view => !view.getVisible()));

test('Focus mode keeps a pending decision and its evidence on screen, one copy, and stays one action from everything', async () => {
  test.setTimeout(180_000);
  const state = await fixture();
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    const task = await createFixtureTask(page, state.project, 'Focus approvals', 'coding');
    const focusToggle = page.getByRole('button', { name: 'Focus mode', exact: true });
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'false');
    await focusToggle.click();
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.sidebar-shell')).toBeHidden();
    await expect(page.getByLabel('Task inspector')).toBeHidden();
    await expect(page.getByRole('button', { name: /^Inspect task/ })).toBeVisible();

    await page.getByLabel('Task message').fill('/demo');
    await page.locator('.composer').getByRole('button', { name: /Send/ }).click();
    const tray = page.getByRole('region', { name: 'Pending actions' });
    await expect(tray.locator('article.approval-card.awaiting-approval').first()).toBeVisible({ timeout: 30_000 });
    // One copy only: the hidden inspector renders no live cards while the tray holds them.
    await expect(page.getByLabel('Task inspector').locator('article.approval-card.awaiting-approval')).toHaveCount(0);
    await expect(page).toHaveTitle('Needs you (1) · Foundry Agent Workspace');
    const chip = page.getByRole('button', { name: '1 needs you', exact: true });
    await expect(chip).toBeVisible();

    // The chip leaves Focus and shows the Inbox; the banner takes over while the Approvals tab is not on screen.
    await chip.click();
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.sidebar-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Inbox(?: \(\d+\+?\))?$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.approval-banner')).toContainText('An action is waiting for your decision.');
    await expect(tray).toHaveCount(0);

    // Ctrl+Shift+F toggles Focus from the composer without typing into it.
    await page.getByLabel('Task message').focus();
    await page.keyboard.press('Control+Shift+F');
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Task message')).toHaveValue('');
    await expect(page.locator('.approval-banner')).toHaveCount(0);

    await tray.locator('article.approval-card.awaiting-approval').first().getByRole('button', { name: 'Approve', exact: true }).click();
    const command = tray.locator('article.approval-card.awaiting-approval').filter({ has: page.locator('.command-evidence') });
    await expect(command).toBeVisible({ timeout: 60_000 });
    await expect(command).toContainText('Runs with your Windows privileges; approval is not sandboxing.');
    await command.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate(async taskId => (await window.workspace.invoke('task.read', { taskId })).task.status, task.id), { timeout: 60_000 }).toBe('idle');
    // Cards decided here stay where they were until the task is switched.
    await expect(tray.locator('article.approval-card.complete')).toHaveCount(2);
    await expect(page).toHaveTitle('Foundry Agent Workspace');

    // The inspector is a slide-over while focused: it takes the cards, and Escape returns focus to its toggle.
    await page.getByRole('button', { name: /^Inspect task/ }).click();
    await expect(page.getByRole('dialog', { name: 'Task inspector' })).toBeVisible();
    await expect(tray).toHaveCount(0);
    await page.getByRole('dialog', { name: 'Task inspector' }).press('Escape');
    await expect(page.getByRole('button', { name: /^Inspect task/ })).toBeFocused();
    await expect(tray.locator('article.approval-card.complete')).toHaveCount(2);

    await focusToggle.click();
    await expect(page.locator('.sidebar-shell')).toBeVisible();
    await expect(page.getByLabel('Task inspector')).toBeVisible();
  } finally { await app.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('Focus mode hides the native browser view until the slide-over shows it', async () => {
  test.setTimeout(120_000);
  const state = await fixture();
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Focus fixture</title><h1>Focus fixture</h1>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture server address.');
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await createFixtureTask(page, state.project, 'Focus browser', 'chat');
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByLabel('Website address').fill(`http://127.0.0.1:${address.port}/`);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(() => nativeViewsHidden(app), { timeout: 30_000 }).toBe(false);
    await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    await expect.poll(() => nativeViewsHidden(app)).toBe(true);
    await page.getByRole('button', { name: /^Inspect task/ }).click();
    await expect(page.getByRole('dialog', { name: 'Task inspector' })).toBeVisible();
    await expect.poll(() => nativeViewsHidden(app)).toBe(false);
    await page.getByRole('dialog', { name: 'Task inspector' }).press('Escape');
    await expect.poll(() => nativeViewsHidden(app)).toBe(true);
    await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    await expect.poll(() => nativeViewsHidden(app)).toBe(false);
  } finally { await app.close(); server.close(); await rm(state.root, { recursive: true, force: true }); }
});
