import { expect, type Page } from '@playwright/test';
import type { CoordinationConfig } from '../../packages/protocol/src/index';

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
