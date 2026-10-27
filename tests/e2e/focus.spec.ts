import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
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
    // The edit decided a moment ago is older, but the card still waiting leads the tray, so Approve stays in reach.
    await expect(tray.locator('article.approval-card').first()).toHaveClass(/awaiting-approval/);
    await expect(command).toContainText('Runs with your Windows privileges; approval is not sandboxing.');
    // The command-review limits qualify the decision, so they stay on screen beside it, outside the scrolling cards.
    await expect(tray.getByTestId('command-review-limits')).toBeVisible();
    await expect(tray.getByTestId('command-review-limits')).toContainText('including ignored dependencies');
    await expect(tray.locator('.tray-summary')).toHaveText('Pending actions: 1 waiting for your decision');
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

const box = async (locator: Locator) => (await locator.boundingBox())!;

// Where the pending card's Approve sits against the tray's own scroll area and the window. The cards are scrolled to the top
// first: a decision moves focus to the next card, which may scroll the cards.
async function approveFit(page: Page) {
  return page.evaluate(() => {
    const cards = document.querySelector<HTMLElement>('.approval-tray-cards')!;
    cards.scrollTop = 0;
    const card = document.querySelector('.approval-tray article.approval-card.awaiting-approval')!;
    const approve = [...card.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Approve')!.getBoundingClientRect();
    const port = cards.getBoundingClientRect();
    const messages = document.querySelector<HTMLElement>('.conversation > .messages')!;
    return { above: approve.top - port.top, below: Math.min(port.bottom, window.innerHeight) - approve.bottom, transcript: messages.getBoundingClientRect().height, floor: Number.parseFloat(getComputedStyle(messages).minHeight) };
  });
}

// From 1180px the Focus tray is a pane beside the transcript, under the header and above the composer, which both span the two
// panes; below it the tray is stacked above the composer. Either way the pending Approve is in view, in both styles, at the
// default size and at the minimum window, beside a long transcript.
test('Focus mode puts the tray beside the transcript from 1180px and keeps the pending Approve in view down to 1000x680', async () => {
  test.setTimeout(240_000);
  const state = await fixture();
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await createFixtureTask(page, state.project, 'Focus panes', 'coding');
    const focusToggle = page.getByRole('button', { name: 'Focus mode', exact: true });
    const setSize = async (width: number, height: number) => {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });
      await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height]);
    };
    const measureFocus = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--measure-focus').trim());
    const section = page.locator('section.conversation');
    const transcript = page.getByLabel('Conversation transcript'), composer = page.locator('.composer'), header = page.locator('.task-header');
    const tray = page.getByRole('region', { name: 'Pending actions' });
    const approve = tray.locator('article.approval-card.awaiting-approval').first().getByRole('button', { name: 'Approve', exact: true });
    const beside = async (label: string) => {
      const [m, t, c, h] = await Promise.all([box(transcript), box(tray), box(composer), box(header)]);
      expect(t.x, `${label}: the tray is right of the transcript`).toBeGreaterThanOrEqual(m.x + m.width - 1);
      expect(Math.abs(t.y - m.y), `${label}: both start under the header`).toBeLessThan(4);
      expect(t.y + t.height, `${label}: the tray ends at the composer`).toBeLessThanOrEqual(c.y + 1);
      expect(c.x <= m.x + 1 && c.x + c.width >= t.x + t.width - 1 && h.x + h.width >= t.x + t.width - 1, `${label}: the header and composer span both panes`).toBe(true);
      await expect(approve).toBeInViewport({ ratio: 1 });
      expect((await box(approve)).y + (await box(approve)).height, `${label}: Approve is above the composer`).toBeLessThanOrEqual(c.y);
    };
    const stacked = async (label: string) => {
      const [m, t] = await Promise.all([box(transcript), box(tray)]);
      expect(t.y, `${label}: the tray is under the transcript`).toBeGreaterThanOrEqual(m.y + m.height - 1);
      expect(Math.abs(t.x - m.x) <= 1 && Math.abs(t.width - m.width) <= 2, `${label}: the tray spans the column`).toBe(true);
    };

    // With nothing pending the Focus column is 1100px: in a 1480px window the composer's inline padding is the rest, split in two.
    await setSize(1480, 940);
    await focusToggle.click();
    await expect(page.locator('.sidebar-shell')).toBeHidden();
    expect(await measureFocus()).toBe('1100px');
    expect(Math.abs(Number.parseFloat(await composer.evaluate(element => getComputedStyle(element).paddingLeft)) - 190)).toBeLessThanOrEqual(1);

    await page.getByLabel('Task message').fill('/demo');
    await composer.getByRole('button', { name: /Send/ }).click();
    await expect(tray.locator('article.approval-card.awaiting-approval').first()).toBeVisible({ timeout: 30_000 });
    await expect(section).toHaveAttribute('data-tray', 'conversation');
    await beside('1480x940');
    // Placement only: the reading and Tab order is still header, transcript, tray, composer.
    expect(await section.evaluate(element => [...element.children].map(child => child.className.split(' ')[0]))).toEqual(['task-header', 'messages', 'approval-tray', 'composer']);
    // The breakpoint: stacked below 1180px, beside again at 1180px. 1176, not 1179: at 125% display scaling a content width
    // lands on a multiple of 4 CSS px, so 1179 arrives as 1180.
    await setSize(1176, 940);
    await stacked('1176x940');
    await setSize(1180, 940);
    await beside('1180x940');

    // The command card is the tallest: Command block, environment and timeout. Approve stays in view at the minimum window.
    await approve.click();
    const command = tray.locator('article.approval-card.awaiting-approval').filter({ has: page.locator('.command-evidence') });
    await expect(command).toBeVisible({ timeout: 60_000 });
    await setSize(1000, 680);
    await stacked('1000x680');
    for (const choice of ['Comfortable', 'Compact'] as const) {
      if (choice === 'Compact') {
        // Settings live in the rail, which Focus hides; the command stays pending across the round trip.
        await focusToggle.click();
        await page.getByRole('button', { name: /Model settings/ }).first().click();
        await page.getByRole('dialog').getByRole('group', { name: 'Style' }).getByRole('radio', { name: 'Compact' }).check();
        await page.getByRole('button', { name: 'Close settings' }).click();
        await focusToggle.click();
        await expect(tray.locator('article.approval-card.awaiting-approval')).toHaveCount(1);
        expect(await measureFocus()).toBe('1180px');
      }
      const fit = await approveFit(page);
      expect(fit.above, `${choice}: Approve starts inside the tray`).toBeGreaterThanOrEqual(0);
      expect(fit.below, `${choice}: Approve ends inside the tray and the window`).toBeGreaterThanOrEqual(0);
      // A long transcript keeps its floor and cannot squeeze the decision: the tray is not sized against the transcript's length.
      await page.evaluate(() => { const filler = document.createElement('div'); filler.dataset.filler = ''; filler.style.height = '3000px'; document.querySelector('.conversation > .messages')!.append(filler); });
      const long = await approveFit(page);
      expect(long.below, `${choice}: Approve beside a long transcript`).toBeGreaterThanOrEqual(0);
      expect(long.transcript, `${choice}: the transcript keeps its floor`).toBeGreaterThanOrEqual(long.floor - 0.5);
      await page.evaluate(() => document.querySelector('[data-filler]')?.remove());
    }
    await setSize(1480, 940);
    await beside('Compact 1480x940');
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
