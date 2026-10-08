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
