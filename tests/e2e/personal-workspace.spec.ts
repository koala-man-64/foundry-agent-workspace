import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createFixtureTask } from './fixtures';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foundry-personal-e2e-'));
  const project = join(root, 'repository'); await mkdir(project);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  return { root, project, env };
}

test('archived pending coding task stays in global action center and inspector is reachable at narrow width', async () => {
  const state = await fixture();
  let app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  try {
    const page = await app.firstWindow();
    await createFixtureTask(page, state.project, 'Pending archived task', 'coding');
    await page.getByLabel('Task message').fill('/demo');
    await page.locator('.composer').getByRole('button', { name: /Send/ }).click();
    await page.getByRole('button', { name: /Approvals/ }).click();
    await expect(page.locator('.approval-card.awaiting-approval').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Archive Pending archived task' }).click();
    await page.getByRole('button', { name: /^Inbox(?: \(\d+\+?\))?$/ }).click();
    await expect(page.getByLabel('Global action center').getByText('Pending archived task').first()).toBeVisible();
    await expect(page.getByLabel('Global action center')).toContainText('Archived');
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(1000, 680); window.webContents.setZoomFactor(2); });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(2);
    await page.getByRole('button', { name: 'Inspect task' }).click();
    await expect(page.getByLabel('Task inspector')).toBeVisible();
    await page.getByLabel('Task inspector').getByRole('button', { name: /Approvals/ }).click();
    await expect(page.locator('.approval-card.awaiting-approval').first()).toBeVisible();
    await page.getByLabel('Task inspector').press('Escape');
    await expect(page.getByRole('button', { name: 'Inspect task' })).toBeFocused();
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(page.locator('.task-row', { hasText: 'Pending archived task' })).toBeVisible();
    await app.close();
    app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
    const restoredPage = await app.firstWindow();
    await restoredPage.getByRole('button', { name: /^Inbox(?: \(\d+\+?\))?$/ }).click();
    await expect(restoredPage.getByLabel('Global action center').getByText('Pending archived task').first()).toBeVisible();
  } finally { await app.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('action query failure exposes all task history and permits restoring archived work', async () => {
  const state = await fixture();
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  let renamed = false;
  try {
    const page = await app.firstWindow();
    await createFixtureTask(page, state.project, 'Archived fallback task', 'chat');
    await expect(page.getByRole('button', { name: 'Archive Archived fallback task' })).toBeVisible();
    await page.getByRole('button', { name: 'Archive Archived fallback task' }).click();
    await createFixtureTask(page, state.project, 'Active fallback task', 'chat');
    await expect(page.getByRole('button', { name: 'Archive Active fallback task' })).toBeVisible();

    const db = new Database(join(state.root, 'state', 'workspace.db'));
    try { db.exec('ALTER TABLE intents RENAME TO intents_fixture_hidden'); renamed = true; }
    finally { db.close(); }
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.getByRole('button', { name: /^Inbox(?: \(\d+\+?\))?$/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Action center unavailable' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Task history' }).getByText('Archived fallback task')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Task history' }).getByText('Active fallback task')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive Active fallback task' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Restore Archived fallback task' })).toBeEnabled();
  } finally {
    if (renamed) {
      const db = new Database(join(state.root, 'state', 'workspace.db'));
      try { db.exec('ALTER TABLE intents_fixture_hidden RENAME TO intents'); } finally { db.close(); }
    }
    await app.close(); await rm(state.root, { recursive: true, force: true });
  }
});

test('pinned script remains untrusted until explicit reviewed grant', async () => {
  const state = await fixture();
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /Hooks and follow-ups/ }).click();
    const settings = page.locator('dialog.automation-dialog');
    await expect(settings).toBeVisible();
    await settings.getByLabel('Script name').fill('Read-only fixture');
    await settings.getByLabel('Project path scope (optional; blank means all projects)').last().fill(state.project);
    await settings.getByLabel('Working directory (absolute)').fill(state.project);
    await settings.getByLabel('Arguments (JSON array of strings)').fill('["--fixture"]');
    await settings.getByLabel('Timeout (seconds)').fill('10');
    await settings.getByLabel('status', { exact: true }).uncheck();
    await settings.getByLabel('Script source').fill('Write-Output "fixture"');
    await settings.getByRole('button', { name: 'Register untrusted revision' }).click();
    await expect(settings).toContainText('Untrusted');
    const review = settings.getByRole('dialog', { name: 'Review pinned script' });
    await expect(review).toContainText('Windows privileges');
    await expect(review).toContainText('Write-Output "fixture"');
    await expect(review).toContainText(state.project);
    await expect(review).toContainText('["--fixture"]');
    await expect(review).toContainText('10000 ms');
    await expect(review.getByLabel('Days until expiry')).toHaveValue('30');
    await expect(review.getByLabel('Max runs per 24 hours')).toHaveValue('100');
    await expect(review.getByLabel('Days until expiry')).toBeFocused();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(1000, 680); window.webContents.setZoomFactor(2); });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(2);
    await page.keyboard.press('Tab');
    await expect(review.getByLabel('Max runs per 24 hours')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(review.getByRole('button', { name: 'Keep untrusted' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(review.getByRole('button', { name: 'Grant trust to pinned revision' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(review.getByLabel('Days until expiry')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(review.getByRole('button', { name: 'Grant trust to pinned revision' })).toBeFocused();
    await expect(review.getByRole('button', { name: 'Grant trust to pinned revision' })).toBeInViewport();
    // Native zoom changes physical pixels; Electron's capture records the complete visible window.
    const grantCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
    await writeFile('test-results/script-grant-200-percent.png', Buffer.from(grantCapture, 'base64'));
    await page.keyboard.press('Enter');
    await expect(settings).toContainText('Trusted');
    await settings.getByRole('button', { name: 'Revoke' }).click();
    await expect(settings).toContainText('Untrusted');
    await settings.getByRole('button', { name: 'Create new revision' }).click();
    await expect(settings.getByLabel('Script source')).toHaveValue('Write-Output "fixture"');
    await expect(settings.getByLabel('Arguments (JSON array of strings)')).toHaveValue('["--fixture"]');
    await settings.getByLabel('Script source').fill('Write-Output "fixture revision 2"');
    await settings.getByRole('button', { name: 'Register replacement revision' }).click();
    await expect(settings.getByRole('dialog', { name: 'Review pinned script' })).toContainText('fixture revision 2');
    await page.keyboard.press('Escape');
    await expect(settings.getByRole('dialog', { name: 'Review pinned script' })).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(settings).toContainText('Untrusted');
  } finally { await app.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('task-linked follow-up saves project scope and editable local-time intent', async () => {
  const state = await fixture();
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: state.env });
  try {
    const page = await app.firstWindow();
    await createFixtureTask(page, state.project, 'Follow-up target', 'chat');
    await expect(page.getByRole('heading', { name: 'Follow-up target' })).toBeVisible();
    const taskId = await page.evaluate(async () => (await window.workspace.invoke('workspace.tasks', { visibility: 'all', sort: 'created', limit: 50 })).tasks.find(task => task.title === 'Follow-up target')?.id);
    expect(taskId).toBeTruthy();
    await page.getByRole('button', { name: /Hooks and follow-ups/ }).click();
    const settings = page.locator('dialog.automation-dialog');
    const form = settings.locator('form.automation-form').last();
    const startDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await form.getByLabel('Name').fill('Review next week');
    await form.getByLabel('Title').fill('Review work');
    await form.getByLabel('Follow-up text').fill('Check the current task state.');
    await form.getByLabel('Task ID (optional)').fill(taskId!);
    await form.getByLabel('Start date').fill(startDate);
    await form.getByLabel('Local time').fill('14:30');
    await form.getByLabel('Time zone (IANA)').fill('America/New_York');
    await form.getByRole('button', { name: 'Save follow-up' }).click();
    const saved = settings.locator('.automation-card', { hasText: 'Review next week' }).first();
    await expect(saved).toContainText('America/New_York');
    const schedule = await page.evaluate(async () => (await window.workspace.invoke('automation.list', {})).schedules.find(item => item.name === 'Review next week'));
    expect(schedule?.projectPath).toBe(state.project);
    expect(schedule?.taskId).toBe(taskId);
    expect(schedule?.startDate).toBe(startDate);
    expect(schedule?.cadence).toBe('once');
    await saved.getByRole('button', { name: 'Edit' }).click();
    await form.getByLabel('Cadence').selectOption('weekly');
    await form.getByLabel('Weekday').selectOption('1');
    await form.getByLabel('Time zone (IANA)').fill('America/Chicago');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(saved).toContainText('America/Chicago');
    await expect(saved).toContainText('weekly');
  } finally { await app.close(); await rm(state.root, { recursive: true, force: true }); }
});
