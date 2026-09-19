import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { V1_SCHEMA } from '../../packages/runtime/src/schema';

const FAKE_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const VALIDATION_COMMAND = "$files = @(Get-ChildItem -File -Filter *.txt); if ($files.Count -lt 3) { exit 1 }; foreach ($f in $files) { if ((Get-Content -Raw $f.FullName) -notmatch 'fixture') { exit 2 } }; Write-Output ('validated ' + $files.Count)";

function baseEnvironment(stateDirectory: string): Record<string, string> {
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = stateDirectory;
  environment.FOUNDRY_WORKSPACE_ENABLE_COORDINATED = '1';
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

async function launch(stateDirectory: string): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: baseEnvironment(stateDirectory) });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).toMatchObject({ runtime: 'ready' });
  return { app, page, errors };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
}

async function initFixtureRepo(project: string): Promise<void> {
  await mkdir(project, { recursive: true });
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'alpha.txt'), 'alpha fixture\n');
  await writeFile(join(project, 'beta.txt'), 'beta fixture\n');
  await writeFile(join(project, 'gamma.txt'), 'gamma fixture\n');
  await writeFile(join(project, 'README.md'), '# Fixture\n\nCoordinated demo fixture.\n');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture');
}

async function createCoordinatedTask(page: Page, project: string, title: string): Promise<void> {
  await page.getByLabel('Project path').fill(project);
  await page.getByLabel('Task title').fill(title);
  await page.getByLabel('Mode').selectOption('coordinated');
  await page.getByLabel('Required validation command').fill(VALIDATION_COMMAND);
  await page.getByLabel('Token budget').fill('600000');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function snapshotTaskByTitle(page: Page, title: string): Promise<{ id: string; worktreePath: string }> {
  return page.evaluate(async (taskTitle) => {
    const snapshot = await window.workspace.invoke('workspace.snapshot', {});
    const task = snapshot.tasks.find((candidate) => candidate.title === taskTitle);
    if (!task) throw new Error('Coordinated task was not created.');
    return { id: task.id, worktreePath: task.worktreePath };
  }, title);
}

async function approveUntilSettled(page: Page, maxApprovals: number): Promise<void> {
  await page.getByRole('button', { name: /^Approvals/ }).click();
  for (let i = 0; i < maxApprovals; i++) {
    const card = page.locator('article.approval-card.awaiting-approval').first();
    try { await expect(card).toBeVisible({ timeout: 8000 }); } catch { return; }
    await expect(card.locator('.approval-target')).toBeVisible();
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card).not.toHaveClass(/awaiting-approval/, { timeout: 8000 }).catch(() => undefined);
  }
}

test('coordinated workflow: delegation, review, serial integration and restart evidence', async () => {
  test.setTimeout(300_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-orchestration-e2e-'));
  const project = join(fixture, 'repository');
  await initFixtureRepo(project);
  const baseCommit = git(project, 'rev-parse', 'HEAD').trim();
  // Dirty the source checkout after the task worktree would be created from it.
  await writeFile(join(project, 'README.md'), '# Fixture\n\nCoordinated demo fixture.\n\nUncommitted local edit.\n');
  await writeFile(join(project, 'untracked-note.txt'), 'Not part of any commit.\n');
  const sourceStatusBefore = git(project, 'status', '--porcelain');

  let { app, page, errors } = await launch(join(fixture, 'state'));
  try {
    await createCoordinatedTask(page, project, 'Coordinated demo task');
    const created = await snapshotTaskByTitle(page, 'Coordinated demo task');

    await page.getByLabel('Message coordinator').fill('/orchestrate-demo');
    await page.getByRole('button', { name: /^Send/ }).click();

    await approveUntilSettled(page, 40);
    await expect(page.getByText(/^Completed on /)).toBeVisible({ timeout: 60000 });
    await expect(page.locator('article.approval-card.awaiting-approval')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/orchestration-complete.png', fullPage: true });
    await page.getByRole('button', { name: 'Orchestration', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Assignments', level: 3 })).toBeVisible();
    await page.screenshot({ path: 'docs/coordinated-workflow-screenshot.png', fullPage: true });

    // Git evidence on the coordinated root worktree: three new single-parent commits.
    const worktree = created.worktreePath;
    const newCount = Number(git(worktree, 'rev-list', '--count', `${baseCommit}..HEAD`).trim());
    expect(newCount).toBe(3);
    const parentCounts = git(worktree, 'log', '--format=%P', `${baseCommit}..HEAD`).trim().split('\n').filter(Boolean);
    for (const parents of parentCounts) expect(parents.trim().split(/\s+/).length).toBe(1);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    for (const name of ['alpha', 'beta', 'gamma']) {
      const content = await readFile(join(worktree, `${name}.txt`), 'utf8');
      expect(content.trimEnd().endsWith(`${name} child change`)).toBe(true);
    }
    // Source checkout is untouched: same HEAD, same dirty status.
    expect(git(project, 'rev-parse', 'HEAD').trim()).toBe(baseCommit);
    expect(git(project, 'status', '--porcelain')).toBe(sourceStatusBefore);
    expect(await readFile(join(project, 'README.md'), 'utf8')).toContain('Uncommitted local edit.');
    expect(await stat(join(project, 'untracked-note.txt'))).toBeTruthy();

    expect(errors).toEqual([]);
    await app.close();

    ({ app, page, errors } = await launch(join(fixture, 'state')));
    await page.getByRole('button', { name: /Coordinated demo task/ }).click();
    await expect(page.getByRole('navigation', { name: 'Agent tree' })).toBeVisible();
    const childRows = page.locator('nav[aria-label="Agent tree"] .agent-row').filter({ hasNotText: 'Coordinator' });
    await expect(childRows).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(childRows.nth(i)).toContainText('Succeeded');

    await page.getByRole('button', { name: 'Orchestration', exact: true }).click();
    const assignmentCards = page.locator('.orchestration-panel article.assignment-card').filter({ hasText: 'Integrated' });
    await expect(assignmentCards).toHaveCount(3);
    await expect(page.getByRole('heading', { name: 'Combined validation', level: 3 })).toBeVisible();
    await expect(page.getByText(/^Completed on /)).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('scoped cancellation: child cancel is isolated, root cancel stops the rest', async () => {
  test.setTimeout(180_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-orchestration-cancel-e2e-'));
  const project = join(fixture, 'repository');
  await initFixtureRepo(project);
  const { app, page, errors } = await launch(join(fixture, 'state'));
  try {
    await createCoordinatedTask(page, project, 'Cancellation demo task');
    await page.getByLabel('Message coordinator').fill('/orchestrate-demo');
    await page.getByRole('button', { name: /^Send/ }).click();
    await page.getByRole('button', { name: /^Approvals/ }).click();
    await expect(page.locator('article.approval-card.awaiting-approval')).toHaveCount(2, { timeout: 30000 });

    await page.getByRole('button', { name: /^alpha ·/ }).click();
    await page.getByRole('button', { name: 'Cancel child alpha', exact: true }).click();
    await expect(page.getByRole('button', { name: /^alpha ·/ })).toContainText('Cancelled', { timeout: 15000 });
    await page.getByRole('button', { name: /^beta ·/ }).click();
    await expect(page.getByRole('button', { name: 'Cancel child beta', exact: true })).toBeVisible();
    await expect(page.locator('article.approval-card.awaiting-approval')).not.toHaveCount(0);

    await page.getByRole('button', { name: 'Cancel coordinated task', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Coordinator/ })).toContainText('Cancelled', { timeout: 15000 });
    await expect(page.getByRole('button', { name: /^beta ·/ })).toContainText('Cancelled', { timeout: 15000 });
    await expect(page.locator('article.approval-card.awaiting-approval')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('IPC forgery: malformed and foreign orchestration decisions are rejected before any effect', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-orchestration-forgery-e2e-'));
  const { app, page } = await launch(join(fixture, 'state'));
  try {
    await expect(page.evaluate(() => Reflect.apply(window.workspace.invoke, window.workspace, ['orchestration.decide', { rootTaskId: 'not-a-uuid' }]))).rejects.toThrow();
    await expect(page.evaluate(() => window.workspace.invoke('orchestration.decide', {
      rootTaskId: crypto.randomUUID(), taskId: crypto.randomUUID(), approvalId: crypto.randomUUID(),
      nonce: 'x'.repeat(32), assignmentId: null, generation: 1, fingerprint: 'forged', decision: 'approve'
    }))).rejects.toThrow();
    await expect(page.evaluate(() => Reflect.apply(window.workspace.invoke, window.workspace, ['command.execute', { command: 'echo unsafe' }]))).rejects.toThrow('Unsupported operation');
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('legacy v1 database: history renders, coordinated mode stays disabled, and a confirmed upgrade unlocks it', async () => {
  test.setTimeout(120_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-orchestration-upgrade-e2e-'));
  const source = join(fixture, 'legacy-source');
  await mkdir(source, { recursive: true });
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'README.md'), '# Legacy fixture\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Legacy fixture');
  const baseCommit = git(source, 'rev-parse', 'HEAD').trim();
  const worktreePath = join(fixture, 'legacy-worktree');
  git(source, 'worktree', 'add', worktreePath, '-b', 'legacy-task');

  const stateDirectory = join(fixture, 'state');
  await mkdir(stateDirectory, { recursive: true });
  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const legacyTask = {
    id: taskId, title: 'Legacy chat task', projectPath: source, worktreePath, branch: 'legacy-task', baseCommit,
    profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: 100000, usedTokens: 128
  };
  const userMessage = { id: crypto.randomUUID(), taskId, role: 'user', content: 'Legacy fixture message.', createdAt: now, status: 'complete' };
  const assistantMessage = { id: crypto.randomUUID(), taskId, role: 'assistant', content: 'Fake response: Legacy fixture message.', createdAt: now, status: 'complete' };
  const db = new Database(join(stateDirectory, 'workspace.db'));
  db.pragma('journal_mode = WAL');
  db.exec(V1_SCHEMA);
  db.prepare('INSERT INTO tasks(id, data) VALUES (?, ?)').run(taskId, JSON.stringify(legacyTask));
  db.prepare('INSERT INTO messages(id, task_id, data, ordinal) VALUES (?, ?, ?, 1)').run(userMessage.id, taskId, JSON.stringify(userMessage));
  db.prepare('INSERT INTO messages(id, task_id, data, ordinal) VALUES (?, ?, ?, 2)').run(assistantMessage.id, taskId, JSON.stringify(assistantMessage));
  db.pragma('user_version = 1');
  db.close();

  const { app, page } = await launch(stateDirectory);
  try {
    await expect(page.getByRole('button', { name: /Legacy chat task/ })).toBeVisible();
    await page.getByRole('button', { name: /Legacy chat task/ }).click();
    await expect(page.getByText('Fake response: Legacy fixture message.', { exact: true })).toBeVisible();
    expect(await page.getByLabel('Mode').locator('option[value="coordinated"]').evaluate((element) => (element as HTMLOptionElement).disabled)).toBe(true);
    await expect(page.locator('.upgrade-banner')).toBeVisible();

    await page.locator('.upgrade-banner').getByRole('button', { name: 'Review upgrade' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Back up and upgrade' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep current database', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.schema', {}))).toMatchObject({ version: 1 });

    await page.locator('.upgrade-banner').getByRole('button', { name: 'Review upgrade' }).click();
    await page.getByRole('button', { name: 'Create backup and upgrade', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.schema', {})), { timeout: 20000 }).toMatchObject({ version: 2, coordinatedAvailable: true });
    const backups = await readdir(join(stateDirectory, 'backups'));
    expect(backups.some((name) => name.endsWith('.db'))).toBe(true);

    await expect(page.getByText('Fake response: Legacy fixture message.', { exact: true })).toBeVisible();
    await expect(page.locator('nav[aria-label="Agent tree"]')).toHaveCount(0);
    await page.getByLabel('Task message').fill('One more legacy message.');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Fake response: One more legacy message.', { exact: true })).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
