import { expect, type Locator, type Page } from '@playwright/test';
import type { CoordinationConfig } from '../../packages/protocol/src/index';

/**
 * The first workspace.summary answers only after Electron, the renderer and the runtime child process with its
 * SQLite store have all started. On a contended CI runner that cold start can outlast the default 5 s assertion
 * timeout, so readiness gets its own budget; a fast start still returns as soon as the runtime answers.
 */
export const RUNTIME_READY_TIMEOUT = 30_000;

export async function waitForRuntimeReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.summary', {})), { timeout: RUNTIME_READY_TIMEOUT }).toMatchObject({ runtime: 'ready' });
}

/**
 * The application notice. Other status regions can be on screen at the same time (the sidebar announces
 * "Loading workspace…" during every refresh), so an unscoped getByRole('status') is a strict-mode violation
 * whenever the two overlap.
 */
export function notice(page: Page): Locator {
  return page.getByRole('status').and(page.locator('.notice'));
}

export const box = async (locator: Locator) => (await locator.boundingBox())!;

/**
 * Where the first pending card's Approve sits against the Focus tray's own scroll area and the window, and the given transcript's
 * height against its floor. The cards are scrolled to the top first: a decision moves focus to the next card, which may scroll them.
 */
export function approveFit(page: Page, transcript: string) {
  return page.evaluate(selector => {
    const cards = document.querySelector<HTMLElement>('.approval-tray-cards')!;
    cards.scrollTop = 0;
    const card = document.querySelector('.approval-tray article.approval-card.awaiting-approval')!;
    const approve = [...card.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Approve')!.getBoundingClientRect();
    const port = cards.getBoundingClientRect(), messages = document.querySelector<HTMLElement>(selector)!;
    return { above: approve.top - port.top, below: Math.min(port.bottom, window.innerHeight) - approve.bottom, transcript: messages.getBoundingClientRect().height, floor: Number.parseFloat(getComputedStyle(messages).minHeight) };
  }, transcript);
}

/** Every child of a two-pane Focus grid is placed by its own area, so none is auto-placed into a free cell or an implicit row. */
export function placedByArea(grid: Locator) {
  return grid.evaluate(element => [...element.children].filter(child => getComputedStyle(child).gridRowStart === 'auto').map(child => child.className));
}

/** Existing approval/publishing scenarios use explicit fixtures; projects.spec covers draft creation through the UI. */
export async function createFixtureTask(page: Page, projectPath: string, title: string, mode: 'chat' | 'coding' | 'coordinated', coordination?: CoordinationConfig) {
  const task = await page.evaluate(async (input) => window.workspace.invoke('task.create', {
    ...input, profileId: '00000000-0000-4000-8000-000000000001',
    tokenBudget: input.mode === 'coordinated' ? 600000 : 100000
  }), { projectPath, title, mode, ...(coordination ? { coordination } : {}) });
  await page.getByRole('button', { name: 'Inbox & history', exact: true }).click();
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await page.getByRole('navigation', { name: 'Task history' }).locator('.task-row', { hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return task;
}
