import { test, expect, _electron as electron, type Page, type ElectronApplication, type Locator } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Approval } from '../../packages/protocol/src/index';
import type { CoordinatedHandoffReport } from '../../apps/desktop/src/renderer/coordinatedHandoff';
import { V1_SCHEMA } from '../../packages/runtime/src/schema';
import { createFixtureTask, waitForRuntimeReady } from './fixtures';

const FAKE_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const VALIDATION_COMMAND = "$files = @(Get-ChildItem -File -Filter *.txt); if ($files.Count -lt 3) { exit 1 }; foreach ($f in $files) { if ((Get-Content -Raw $f.FullName) -notmatch 'fixture') { exit 2 } }; Write-Output ('validated ' + $files.Count)";

type HandoffDownload = { filename: string; path: string; state: string };

async function captureHandoffDownloads(app: ElectronApplication, directory: string, prefix: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await app.evaluate(({ session }, input) => {
    const records: { filename: string; path: string; state: string }[] = [];
    (globalThis as unknown as { handoffDownloads: typeof records }).handoffDownloads = records;
    session.defaultSession.on('will-download', (_event, item) => {
      const record = { filename: item.getFilename(), path: `${input.directory}/${input.prefix}-${records.length + 1}.json`, state: 'progressing' };
      records.push(record);
      // Intercept before Chromium chooses a destination; the user's Downloads directory is never used.
      item.setSavePath(record.path);
      item.once('done', (_event, state) => { record.state = state; });
    });
  }, { directory, prefix });
}

async function handoffDownloads(app: ElectronApplication): Promise<HandoffDownload[]> {
  return app.evaluate(() => (globalThis as unknown as { handoffDownloads: HandoffDownload[] }).handoffDownloads);
}

async function readHandoffDownload(app: ElectronApplication, count: number): Promise<{ report: CoordinatedHandoffReport; path: string }> {
  await expect.poll(async () => (await handoffDownloads(app)).filter(item => item.state === 'completed').length, { timeout: 15_000 }).toBe(count);
  const item = (await handoffDownloads(app))[count - 1]!;
  expect(item.filename).toMatch(/^coordinated-handoff-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/);
  return { report: JSON.parse(await readFile(item.path, 'utf8')) as CoordinatedHandoffReport, path: item.path };
}

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
  await waitForRuntimeReady(page);
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
  await createFixtureTask(page, project, title, 'coordinated', {
    childProfileIds: [], requiredValidation: { command: VALIDATION_COMMAND, cwd: '', timeoutMs: 600000 }
  });
}

async function snapshotTaskByTitle(page: Page, title: string): Promise<{ id: string; worktreePath: string }> {
  return page.evaluate(async (taskTitle) => {
    const page = await window.workspace.invoke('workspace.tasks', { visibility: 'all', sort: 'created', limit: 50 });
    const task = page.tasks.find((candidate) => candidate.title === taskTitle);
    if (!task?.worktreePath) throw new Error('Coordinated task was not created.');
    return { id: task.id, worktreePath: task.worktreePath };
  }, title);
}

/**
 * Writes the orchestration state, every agent's approvals and transcript, the UI text and a screenshot into this test's
 * output folder, which CI uploads on failure. Each part is saved as soon as it is read, with a time bound, so a hung
 * renderer cannot take the rest with it.
 */
async function saveCoordinatorEvidence(page: Page, rootTaskId: string, name: string): Promise<void> {
  const info = test.info();
  const bounded = async (operation: Promise<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'No answer within 10 s.' }), 10_000); });
    try { return await Promise.race([operation.catch((error: unknown) => ({ unavailable: error instanceof Error ? error.message : String(error) })), late]); }
    finally { clearTimeout(timer); }
  };
  const save = async (file: string, body: string): Promise<void> => { await writeFile(info.outputPath(file), body); await info.attach(file, { path: info.outputPath(file) }); };
  await save(`${name}-state.json`, JSON.stringify(await bounded(page.evaluate(id => window.workspace.invoke('orchestration.get', { rootTaskId: id }), rootTaskId)), null, 2));
  await save(`${name}-agents.json`, JSON.stringify(await bounded(page.evaluate(async id => {
    const view = await window.workspace.invoke('orchestration.get', { rootTaskId: id });
    const coordinator = {
      approvals: (await window.workspace.invoke('task.approvals', { taskId: id, limit: 50 })).approvals,
      transcript: (await window.workspace.invoke('task.messages', { taskId: id, limit: 8 })).items.map(item => ({ role: item.message.role, status: item.message.status, content: item.message.content }))
    };
    const children = await Promise.all(view.runs.filter(run => run.role === 'child').map(run => window.workspace.invoke('orchestration.child', { rootTaskId: id, childTaskId: run.taskId })
      .catch((error: unknown) => ({ childTaskId: run.taskId, unavailable: error instanceof Error ? error.message : String(error) }))));
    return { coordinator, children };
  }, rootTaskId)), null, 2));
  await save(`${name}-ui.txt`, await page.locator('body').innerText({ timeout: 5000 }).catch(() => '(The page text was unavailable.)'));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, timeout: 5000 }).catch(() => undefined);
}

async function coordinatorProgress(page: Page, rootTaskId: string, card: Locator): Promise<'approval' | 'terminal' | 'stopped' | 'working'> {
  if (await card.isVisible()) return 'approval';
  const coordinator = await page.evaluate(async id => (await window.workspace.invoke('orchestration.get', { rootTaskId: id })).runs.find(run => run.role === 'coordinator'), rootTaskId);
  if (coordinator?.lifecycle === 'terminal') return 'terminal';
  // The fixture coordinator ends its turn without completing only when a step failed, and nothing resumes it.
  if (coordinator?.lifecycle === 'waiting' && coordinator.waitReason === 'user-continuation') return 'stopped';
  return 'working';
}

async function approveUntilSettled(page: Page, rootTaskId: string, maxApprovals: number): Promise<void> {
  await page.getByRole('button', { name: /^Approvals/ }).click();
  for (let i = 0; i < maxApprovals; i++) {
    const card = page.locator('article.approval-card.awaiting-approval').first();
    let progress = 'working';
    // A quiet interval during child provisioning/integration is not evidence of completion.
    try {
      await expect.poll(async () => (progress = await coordinatorProgress(page, rootTaskId, card)), { timeout: 45000 }).not.toBe('working');
      if (progress === 'stopped') throw new Error('The coordinator stopped before completing; see coordinator-wait-state.json and coordinator-wait-agents.json for its last message and the integrations.');
    } catch (error) {
      await saveCoordinatorEvidence(page, rootTaskId, 'coordinator-wait');
      throw error;
    }
    if (progress !== 'approval') return;
    await expect(card.locator('.approval-target')).toBeVisible();
    const approvalId = await card.getAttribute('data-approval-id');
    expect(approvalId).toBeTruthy();
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator(`article.approval-card.awaiting-approval[data-approval-id="${approvalId}"]`)).toHaveCount(0, { timeout: 30000 });
  }
  throw new Error(`Coordinated fixture exceeded ${maxApprovals} approvals without completing.`);
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
    const savedProject = await page.evaluate((path) => window.workspace.invoke('project.add', { path }), project);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: `New chat in ${savedProject.name}`, exact: true }).click();
    await page.getByLabel('Mode', { exact: true }).selectOption('coordinated');
    await page.getByRole('button', { name: /More options/ }).click();
    await page.getByLabel('Title (optional)', { exact: true }).fill('Coordinated demo task');
    await page.getByLabel('Required validation command').fill(VALIDATION_COMMAND);
    await page.getByLabel('Chat message', { exact: true }).fill('/orchestrate-demo');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByRole('heading', { name: 'Coordinated demo task', exact: true })).toBeVisible();
    const created = await snapshotTaskByTitle(page, 'Coordinated demo task');

    await approveUntilSettled(page, created.id, 40);
    try { await expect(page.getByText(/^Completed on /)).toBeVisible({ timeout: 60000 }); }
    catch (error) {
      await saveCoordinatorEvidence(page, created.id, 'coordinated-failure');
      throw error;
    }
    await expect(page.locator('article.approval-card.awaiting-approval')).toHaveCount(0);
    // The runtime rejects messages to a finished coordinator, so the composer says so instead of accepting them.
    await expect(page.getByLabel('Message coordinator')).toBeDisabled();
    // Integration committed every change, and the root's Changes tab says so in words.
    const inspector = page.getByLabel('Coordinated task inspector');
    await inspector.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(inspector.locator('.patch')).toHaveText('No uncommitted changes to show.');
    const rootHistory = await page.evaluate(taskId => window.workspace.invoke('task.messages', { taskId, limit: 50 }), created.id);
    const finalReply = rootHistory.items.map(item => item.message).filter(message => message.role === 'assistant' && message.status === 'complete').at(-1)?.content;
    expect(finalReply).toBeTruthy();
    await expect(page.getByLabel('Conversation transcript')).toContainText('/orchestrate-demo');
    await expect(page.getByLabel('Conversation transcript')).toContainText(finalReply!);
    await page.locator('nav[aria-label="Agent tree"] .agent-row').filter({ hasNotText: 'Coordinator' }).first().click();
    await expect(page.getByLabel('Conversation transcript').locator('article.message.assistant').first()).toBeVisible();
    await page.getByRole('button', { name: /^Coordinator/ }).click();
    await expect(page.getByLabel('Conversation transcript')).toContainText(finalReply!);

    await page.screenshot({ path: 'test-results/orchestration-complete.png', fullPage: true });
    await page.getByRole('button', { name: 'Orchestration', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Assignments', level: 3 })).toBeVisible();

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

    await captureHandoffDownloads(app, join(fixture, 'reports'), 'initial');
    await page.getByRole('button', { name: 'Handoff', exact: true }).click();
    let handoff = page.getByRole('region', { name: 'Coordinated handoff report' });
    const repository = { head: git(worktree, 'rev-parse', 'HEAD').trim(), tree: git(worktree, 'rev-parse', 'HEAD^{tree}').trim(), branch: git(worktree, 'branch', '--show-current').trim() };
    await expect(handoff).toContainText(repository.head);
    await expect(handoff).toContainText(repository.tree);
    await expect(handoff).toContainText(repository.branch);
    await handoff.getByRole('button', { name: 'Download handoff report', exact: true }).click();
    const firstDownload = await readHandoffDownload(app, 1);
    expect(firstDownload.report.repository).toEqual(repository);
    expect(firstDownload.report.rootTaskId).toBe(created.id);
    expect(firstDownload.report.containsCode).toBe(false);
    const exactValidation = await page.evaluate(async rootTaskId => (await window.workspace.invoke('orchestration.get', { rootTaskId })).evidence.find(item => item.kind === 'combined')!.id, created.id);
    expect(firstDownload.report.validation.id).toBe(exactValidation);
    const reportText = JSON.stringify(firstDownload.report);
    for (const excluded of [VALIDATION_COMMAND, finalReply!, '/orchestrate-demo', 'alpha child change', worktree]) expect(reportText).not.toContain(excluded);
    const reportKeys = (value: unknown): string[] => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => [key, ...reportKeys(child)]) : [];
    expect(reportKeys(firstDownload.report).filter(key => /command|nonce|transcript|content|environment|credential|arguments|patch|approval/i.test(key))).toEqual([]);

    // Cached successful preview must not permit a report after an external repository change.
    const staleFile = join(worktree, 'handoff-dirty.txt');
    await writeFile(staleFile, 'untracked change after handoff preview\n');
    await handoff.getByRole('button', { name: 'Download handoff report', exact: true }).click();
    await expect(handoff.getByRole('alert')).toContainText('Report not exported');
    await expect(handoff.getByRole('heading', { name: 'Checked report preview' })).toHaveCount(0);
    expect(await handoffDownloads(app)).toHaveLength(1);
    await rm(staleFile);
    await createFixtureTask(page, project, 'Handoff navigation task', 'chat');
    await page.locator('.task-row', { hasText: 'Coordinated demo task' }).click();
    await page.getByRole('button', { name: 'Handoff', exact: true }).click();
    await expect(handoff).toContainText(repository.head);
    expect(JSON.parse(await readFile(firstDownload.path, 'utf8')).repository).toEqual(repository);

    expect(errors).toEqual([]);
    const childTasks = await page.evaluate(async rootTaskId => {
      const runs = (await window.workspace.invoke('orchestration.get', { rootTaskId })).runs.filter(run => run.role === 'child');
      return Promise.all(runs.map(async run => {
        const { task } = await window.workspace.invoke('task.read', { taskId: run.taskId });
        if (!task.worktreePath || !task.branch) throw new Error('The child fixture has no Git worktree.');
        return { id: task.id, worktreePath: task.worktreePath, branch: task.branch };
      }));
    }, created.id);

    // Reject the next fresh renderer read using supported Electron test hooks. A valid cached
    // preview exists, but losing IPC must never turn that preview into a downloaded report.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('workspace:invoke');
      ipcMain.handle('workspace:invoke', () => { throw new Error('Synthetic handoff refresh unavailable'); });
    });
    await handoff.getByRole('button', { name: 'Download handoff report', exact: true }).click();
    await expect(handoff.getByRole('alert')).toContainText('Synthetic handoff refresh unavailable');
    await expect(handoff.getByRole('heading', { name: 'Checked report preview' })).toHaveCount(0);
    expect(await handoffDownloads(app)).toHaveLength(1);
    await app.close();

    // Reproduce the durable crash boundary in isolated app data: the approved file was applied,
    // but its intent still says executing. Restart must retain it as unknown rather than replaying it.
    const db = new Database(join(fixture, 'state', 'workspace.db'));
    let interruptedEdit: Approval;
    try {
      const approvals = (db.prepare("SELECT data FROM intents WHERE kind = 'tool.approval'").all() as { data: string }[]).map(row => JSON.parse(row.data) as Approval);
      const edit = approvals.find(item => childTasks.some(child => child.id === item.taskId) && item.path && item.resultingHash && !item.handoff && !item.integration);
      if (!edit) throw new Error('The coordinated fixture did not retain an ordinary file edit.');
      interruptedEdit = edit;
      db.prepare("UPDATE intents SET state = 'executing', data = ? WHERE id = ?").run(JSON.stringify({ ...edit, state: 'executing' }), edit.id);
    } finally { db.close(); }

    ({ app, page, errors } = await launch(join(fixture, 'state')));
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.locator('.task-row', { hasText: 'Coordinated demo task' }).click();
    await expect(page.getByLabel('Conversation transcript')).toContainText('/orchestrate-demo');
    await expect(page.getByLabel('Conversation transcript')).toContainText(finalReply!);
    await expect(page.getByRole('navigation', { name: 'Agent tree' })).toBeVisible();
    const childRows = page.locator('nav[aria-label="Agent tree"] .agent-row').filter({ hasNotText: 'Coordinator' });
    await expect(childRows).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(childRows.nth(i)).toContainText('Succeeded');
    await captureHandoffDownloads(app, join(fixture, 'reports'), 'restart');
    handoff = page.getByRole('region', { name: 'Coordinated handoff report' });
    await page.getByRole('button', { name: 'Handoff', exact: true }).click();
    await handoff.getByRole('button', { name: 'Download handoff report', exact: true }).click();
    await expect(handoff.getByRole('alert')).toContainText('An effect is unknown');
    expect(await handoffDownloads(app)).toHaveLength(0);

    await page.getByRole('button', { name: 'Orchestration', exact: true }).click();
    const assignmentCards = page.locator('.orchestration-panel article.assignment-card').filter({ hasText: 'Integrated' });
    await expect(assignmentCards).toHaveCount(3);
    await expect(page.getByRole('heading', { name: 'Combined validation', level: 3 })).toBeVisible();
    await expect(page.getByText(/^Completion recorded .*current state unverified:/)).toContainText('An effect is unknown');
    await expect(page.getByText(/^Completed on /)).toHaveCount(0);

    await page.getByRole('button', { name: /^Approvals/ }).click();
    const unknownEdit = page.locator(`[data-approval-id="${interruptedEdit.id}"]`);
    await expect(unknownEdit).toContainText('unknown');
    const editTask = childTasks.find(child => child.id === interruptedEdit.taskId)!;
    const appliedFile = join(editTask.worktreePath, interruptedEdit.path!);
    const appliedContent = await readFile(appliedFile, 'utf8');
    await unknownEdit.getByRole('button', { name: 'Check outcome', exact: true }).click();
    await expect(unknownEdit).toContainText('complete');
    await expect(unknownEdit).toContainText('Read-only reconciliation found the exact approved file content.');
    await expect(page.getByText(/^Completed on /)).toBeVisible();
    expect(await readFile(appliedFile, 'utf8')).toBe(appliedContent);
    expect((await page.evaluate(async input => (await window.workspace.invoke('approval.get', input)).approval.state, { taskId: interruptedEdit.taskId, approvalId: interruptedEdit.id }))).toBe('complete');
    await page.getByRole('button', { name: 'Handoff', exact: true }).click();
    await handoff.getByRole('button', { name: 'Download handoff report', exact: true }).click();
    const resumedDownload = await readHandoffDownload(app, 1);
    expect(resumedDownload.report.repository).toEqual(firstDownload.report.repository);
    expect(resumedDownload.report.validation).toEqual(firstDownload.report.validation);
    expect(JSON.parse(await readFile(firstDownload.path, 'utf8')).repository).toEqual(repository);

    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    const controls = page.getByTestId('coordinated-task-controls');
    await expect(controls.getByRole('heading', { name: 'Coordinator usage' })).toBeVisible();
    await expect(controls).toContainText('Next request estimate');
    await expect(controls).toContainText('Cache read / creation');
    await childRows.first().click();
    await expect(controls.getByRole('heading', { name: 'Child usage' })).toBeVisible();
    await page.getByRole('button', { name: /^Coordinator/ }).click();
    await expect(controls.getByRole('heading', { name: 'Coordinator usage' })).toBeVisible();

    // A dirty child blocks the entire root retirement before any worktree is removed.
    const dirtyFile = join(childTasks[0]!.worktreePath, 'retirement-guard.txt');
    await writeFile(dirtyFile, 'retain this untracked child file\n');
    await controls.getByRole('button', { name: 'Retire worktrees…', exact: true }).click();
    await controls.getByRole('button', { name: 'Confirm retire (clean worktrees only)', exact: true }).click();
    await expect(page.locator('.notice')).toContainText('uncommitted or untracked files');
    for (const member of [{ worktreePath: worktree }, ...childTasks]) expect(await stat(member.worktreePath)).toBeTruthy();
    await rm(dirtyFile);
    await controls.getByRole('button', { name: 'Retire worktrees…', exact: true }).click();
    await controls.getByRole('button', { name: 'Confirm retire (clean worktrees only)', exact: true }).click();
    // Retirement validates and removes four worktrees with sequential Git operations. Wait for the
    // durable terminal state, rather than applying the 5 s UI assertion budget to the whole operation.
    await expect.poll(() => page.evaluate(async taskId => (await window.workspace.invoke('task.read', { taskId })).task.status, created.id), {
      timeout: 60_000, message: 'The coordinated root must finish retiring all four clean worktrees'
    }).toBe('retired');
    await expect(page.locator('.notice')).toContainText('Retired 4 clean worktree(s)');
    for (const child of childTasks) {
      await expect(stat(child.worktreePath)).rejects.toThrow();
      expect(git(project, 'rev-parse', '--verify', child.branch).trim()).toHaveLength(40);
    }
    await expect(stat(worktree)).rejects.toThrow();
    await expect(page.getByLabel('Message coordinator')).toBeDisabled();
    await expect(page.getByLabel('Conversation transcript')).toContainText(finalReply!);
    await expect(page.getByText(/^Completion recorded .*current state unverified:/)).toBeVisible();
    await expect(page.getByText(/^Completed on /)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('coordinator usage compacts idle history and retains the original conversation after restart', async () => {
  test.setTimeout(120_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-coordinator-compaction-e2e-'));
  const project = join(fixture, 'repository');
  await initFixtureRepo(project);
  let { app, page, errors } = await launch(join(fixture, 'state'));
  try {
    await createCoordinatedTask(page, project, 'Coordinator compaction');
    const created = await snapshotTaskByTitle(page, 'Coordinator compaction');
    for (const content of ['first coordinator direction '.repeat(40).trim(), 'second coordinator direction '.repeat(40).trim(), 'third coordinator direction '.repeat(40).trim()]) {
      await page.getByLabel('Message coordinator').fill(content);
      await page.getByRole('button', { name: /^Send/ }).click();
      await expect(page.getByLabel('Conversation transcript')).toContainText(`Fake coordinator response: ${content}`);
      await expect.poll(() => page.evaluate(async id => (await window.workspace.invoke('task.read', { taskId: id })).task.status, created.id)).toBe('idle');
    }
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    const controls = page.getByTestId('coordinated-task-controls');
    await expect(controls).toContainText('3 attempts');
    await expect(controls.getByRole('button', { name: 'Retire worktrees…', exact: true })).toBeDisabled();
    await expect(controls.getByRole('button', { name: 'Commit all changes', exact: true })).toHaveCount(0);
    await expect(controls.getByRole('button', { name: 'Push branch…', exact: true })).toHaveCount(0);
    await controls.getByRole('button', { name: 'Compact context', exact: true }).click();
    await expect(page.locator('.notice')).toContainText('Compacted Coordinator context');
    await expect(page.locator('article.compaction-summary')).toHaveCount(1);
    await expect(page.locator('article.message.compacted')).toHaveCount(2);
    const usage = await page.evaluate(id => window.workspace.invoke('task.usage', { taskId: id }), created.id);
    expect(usage.compactions).toHaveLength(1);
    expect(usage.compactions[0]!.estimatedTokensAfter).toBeLessThan(usage.compactions[0]!.estimatedTokensBefore);
    expect(errors).toEqual([]);
    await app.close();
    ({ app, page, errors } = await launch(join(fixture, 'state')));
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.locator('.task-row', { hasText: 'Coordinator compaction' }).click();
    await expect(page.locator('article.compaction-summary')).toHaveCount(1);
    await expect(page.getByLabel('Conversation transcript')).toContainText('first coordinator direction');
    await expect(page.getByLabel('Conversation transcript')).toContainText('third coordinator direction');
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('archived coordinator with child approval retains recovery in Inbox after restart', async () => {
  test.setTimeout(180_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-orchestration-archive-e2e-'));
  const project = join(fixture, 'repository');
  await initFixtureRepo(project);
  let { app, page, errors } = await launch(join(fixture, 'state'));
  try {
    await createCoordinatedTask(page, project, 'Archived coordinated task');
    await page.getByLabel('Message coordinator').fill('/orchestrate-demo');
    await page.getByRole('button', { name: /^Send/ }).click();
    await page.getByRole('button', { name: /^Approvals/ }).click();
    await expect(page.locator('article.approval-card.awaiting-approval')).toHaveCount(2, { timeout: 30_000 });
    const oldApprovalIds = await page.locator('article.approval-card.awaiting-approval').evaluateAll(items => items.map(item => item.getAttribute('data-approval-id')));
    await page.getByRole('button', { name: 'Archive Archived coordinated task' }).click();
    await page.getByRole('button', { name: /^Inbox(?: \(\d+\+?\))?$/ }).click();
    await expect(page.getByLabel('Global action center').getByText('Archived coordinated task').first()).toBeVisible();
    expect(errors).toEqual([]);
    await app.close();

    ({ app, page, errors } = await launch(join(fixture, 'state')));
    await page.getByRole('button', { name: /^Inbox(?: \(\d+\+?\))?$/ }).click();
    const action = page.getByLabel('Global action center').getByRole('button', { name: /Archived coordinated task/ }).first();
    await expect(action).toBeVisible();
    await action.click();
    await expect(page.getByRole('heading', { name: 'Archived coordinated task' })).toBeVisible();
    await expect(page.getByLabel('Conversation transcript')).toContainText('/orchestrate-demo');
    await page.getByRole('button', { name: /^Approvals/ }).click();
    for (const id of oldApprovalIds) {
      const card = page.locator(`article.approval-card[data-approval-id="${id}"]`);
      await expect(card).toContainText('revoked');
      await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    }
    await page.getByLabel('Message coordinator').fill('Resume the interrupted work after reviewing current state.');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByLabel('Conversation transcript')).toContainText('Resume the interrupted work');
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(1000, 680); window.webContents.setZoomFactor(2); });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(2);
    if (!(await page.getByLabel('Coordinated task inspector').isVisible())) await page.getByRole('button', { name: 'Inspect task' }).click();
    await page.getByLabel('Coordinated task inspector').getByRole('button', { name: 'Orchestration', exact: true }).click();
    const incomplete = page.locator('article.assignment-card', { hasText: 'alpha · revision 1' });
    await expect(incomplete).toContainText('Incomplete');
    await incomplete.getByRole('button', { name: 'Revise' }).click();
    await incomplete.getByRole('button', { name: 'Submit revision' }).click();
    await page.getByLabel('Coordinated task inspector').getByRole('button', { name: /^Approvals/ }).click();
    const fresh = page.locator('article.approval-card.awaiting-approval').first();
    await expect(fresh).toBeVisible({ timeout: 30_000 });
    const freshId = await fresh.getAttribute('data-approval-id');
    expect(oldApprovalIds).not.toContain(freshId);
    await fresh.getByRole('button', { name: 'Approve', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`article.approval-card[data-approval-id="${freshId}"]`)).not.toHaveClass(/awaiting-approval/, { timeout: 15_000 });
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
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await expect(page.locator('.task-row', { hasText: 'Legacy chat task' })).toBeVisible();
    await page.locator('.task-row', { hasText: 'Legacy chat task' }).click();
    await expect(page.getByText('Fake response: Legacy fixture message.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
    await expect(page.locator('.upgrade-banner')).toBeVisible();
    // The banner takes its own row: the bottom of the app stays inside the window.
    const footer = await page.getByRole('button', { name: 'Hooks and follow-ups' }).boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));

    await page.locator('.upgrade-banner').getByRole('button', { name: 'Review upgrade' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Back up and upgrade' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep current database', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.schema', {}))).toMatchObject({ version: 1 });

    await page.locator('.upgrade-banner').getByRole('button', { name: 'Review upgrade' }).click();
    await page.getByRole('button', { name: 'Create backup and upgrade', exact: true }).click();
    await expect(page.locator('.notice')).toContainText('Database upgraded to v5', { timeout: 20000 });
    await expect.poll(async () => ({
      schema: await page.evaluate(() => window.workspace.invoke('workspace.schema', {})),
      error: await page.locator('.notice').filter({ hasText: 'Could not upgrade' }).allTextContents()
    }), { timeout: 20000 }).toMatchObject({ schema: { version: 5, coordinatedAvailable: true }, error: [] });
    const backups = await readdir(join(stateDirectory, 'backups'), { recursive: true });
    expect(backups.some((name) => name.endsWith('.db'))).toBe(true);

    await expect(page.getByText('Fake response: Legacy fixture message.', { exact: true })).toBeVisible();
    await expect(page.locator('nav[aria-label="Agent tree"]')).toHaveCount(0);
    await page.getByLabel('Task message').fill('One more legacy message.');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Fake response: One more legacy message.', { exact: true })).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('Focus mode keeps coordinated child approvals on screen, one copy each', async () => {
  test.setTimeout(180_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-orchestration-focus-e2e-'));
  const project = join(fixture, 'repository');
  await initFixtureRepo(project);
  const { app, page, errors } = await launch(join(fixture, 'state'));
  try {
    await createCoordinatedTask(page, project, 'Focused coordinated task');
    await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    await expect(page.locator('.sidebar-shell')).toBeHidden();
    await page.getByLabel('Message coordinator').fill('/orchestrate-demo');
    await page.getByRole('button', { name: /^Send/ }).click();
    const tray = page.getByRole('region', { name: 'Pending actions' });
    await expect(tray.locator('article.approval-card.awaiting-approval')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByLabel('Coordinated task inspector').locator('article.approval-card')).toHaveCount(0);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    const first = tray.locator('article.approval-card.awaiting-approval').first();
    const id = await first.getAttribute('data-approval-id');
    await first.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator(`article.approval-card[data-approval-id="${id}"]`)).not.toHaveClass(/awaiting-approval/, { timeout: 30_000 });
    await expect(tray.locator(`article.approval-card[data-approval-id="${id}"]`)).toHaveCount(1);
    // The other child's approval is still waiting, so it leads the tray ahead of the card just decided.
    await expect(tray.locator('article.approval-card').first()).toHaveClass(/awaiting-approval/);
    await expect(tray.locator('article.approval-card').first()).not.toHaveAttribute('data-approval-id', id!);
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
