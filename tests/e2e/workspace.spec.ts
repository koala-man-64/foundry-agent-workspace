import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixtureTask, notice, waitForRuntimeReady } from './fixtures';

test('offline create demo clearly reviews an absent file and creates only the approved worktree content', async () => {
  test.setTimeout(120_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-create-e2e-'));
  const project = join(fixture, 'repository');
  await mkdir(join(project, 'src'), { recursive: true });
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Creation fixture\n');
  await writeFile(join(project, 'src', 'existing-empty.txt'), '');
  git('add', '.'); git('commit', '-m', 'Fixture');
  const originalHead = git('rev-parse', 'HEAD');
  const relativeFile = 'src/created-demo.txt';
  const content = 'Created by the reviewed offline demo.\nUTF-8: café.\n';
  const resultingHash = createHash('sha256').update(content, 'utf8').digest('hex');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await waitForRuntimeReady(page);
    for (const decision of ['reject', 'approve'] as const) {
      const task = await createFixtureTask(page, project, `${decision} new file`, 'coding');
      if (!task.worktreePath) throw new Error('The creation fixture has no task worktree.');
      const destination = join(task.worktreePath, relativeFile);
      await page.getByLabel('Task message').fill('/create-demo');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.getByRole('button', { name: /^Approvals/ }).click();
      const card = page.locator('article.approval-card.awaiting-approval');
      await expect(card).toBeVisible();
      await expect(card.locator('.approval-heading strong')).toHaveText('Create file');
      await expect(card).toContainText(relativeFile);
      await expect(card).toContainText('File is absent. This approval creates a new file.');
      await expect(card).not.toContainText('Existing empty file.');
      const after = card.locator('dl').filter({ has: page.locator('dt', { hasText: 'After' }) }).locator('pre');
      expect(await after.textContent()).toBe(content);
      await expect(card).toContainText(`absent → ${resultingHash}`);
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      // An unchanged worktree is said in words, not left blank.
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      await expect(page.locator('.patch')).toHaveText('No uncommitted changes to show.');
      await page.getByRole('button', { name: /^Approvals/ }).click();
      await card.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Reject', exact: true }).click();
      await expect.poll(() => page.evaluate(async taskId => (await window.workspace.invoke('task.read', { taskId })).task.status, task.id), { timeout: 60_000 }).toBe('idle');
      if (decision === 'reject') {
        await expect(page.locator('article.approval-card.rejected')).toContainText('Create file');
        await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
        await page.getByRole('button', { name: 'Changes', exact: true }).click();
        await expect(page.locator('.patch')).toHaveText('No uncommitted changes to show.');
      } else {
        await expect(page.locator('article.approval-card.complete')).toContainText('Create file');
        expect(await readFile(destination)).toEqual(Buffer.from(content, 'utf8'));
        // The finished approval re-reads the worktree, so the new file is listed without pressing Refresh.
        await page.getByRole('button', { name: 'Changes', exact: true }).click();
        await expect(page.locator('.patch')).toContainText('src/created-demo.txt');
        await expect(page.locator('.patch')).toContainText('+Created by the reviewed offline demo.');
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        await page.getByRole('button', { name: /▸ src$/ }).click();
        await page.getByRole('button', { name: /src\/created-demo\.txt$/ }).click();
        await expect.poll(() => page.locator('.file-content pre').textContent()).toBe(content);
      }
      await expect(readFile(join(project, relativeFile))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(project, 'src', 'existing-empty.txt'), 'utf8')).toBe('');
      expect(git('rev-parse', 'HEAD')).toBe(originalHead);
      expect(git('status', '--porcelain')).toBe('');
    }
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('isolated task, offline conversation, file inspection and restart history', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-e2e-'));
  const project = join(fixture, 'repository'); await mkdir(project);
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'ignore' }); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'hello.txt'), 'Hello from an isolated task.\n');
  await mkdir(join(project, 'src')); await writeFile(join(project, 'src', 'example.ts'), 'export const answer = 42;\n');
  git('add', '.'); git('commit', '-m', 'Fixture');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state');
  delete environment.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
    await waitForRuntimeReady(page);
    expect(await page.evaluate(() => 'require' in window)).toBe(false);
    const createdTask = await createFixtureTask(page, project, 'Offline acceptance task', 'chat');
    await page.getByLabel('Task message').fill('Explain the project briefly.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Fake response: Explain the project briefly.', { exact: true })).toBeVisible();
    // Ctrl+Enter sends through the same guarded path as the button; bare Enter stays a newline.
    await page.getByLabel('Task message').fill('Second message by shortcut.');
    await page.getByLabel('Task message').press('Enter');
    await expect(page.getByLabel('Task message')).toHaveValue('Second message by shortcut.\n');
    await page.getByLabel('Task message').press('Control+Enter');
    await expect(page.getByText('Fake response: Second message by shortcut.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Task message')).toHaveValue('');
    await page.getByRole('button', { name: /hello.txt/ }).click();
    await expect(page.getByText('Hello from an isolated task.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /▸ src$/ }).click();
    await page.getByRole('button', { name: /src\/example.ts$/ }).click();
    await expect(page.getByText('export const answer = 42;', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Root', exact: true }).click();
    await page.getByRole('button', { name: /hello.txt$/ }).click();
    const worktree = createdTask.worktreePath;
    await writeFile(join(worktree, 'hello.txt'), 'Changed in the task worktree.\n');
    await page.locator('aside.inspector').getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Changed in the task worktree.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('+Changed in the task worktree.', { exact: false })).toBeVisible();
    // Browsing a folder while Refresh is still reading supersedes the listing, not the worktree diff.
    await writeFile(join(worktree, 'hello.txt'), 'Changed again in the task worktree.\n');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('aside.inspector').getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: /▸ src$/ }).click();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(page.getByText('+Changed again in the task worktree.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    expect((await page.getByRole('button', { name: 'Send' }).boundingBox())!.height).toBeLessThan(80);
    await page.screenshot({ path: 'test-results/workspace.png', fullPage: true });
    expect(errors).toEqual([]);
    await expect(page.evaluate(() => Reflect.apply(window.workspace.invoke, window.workspace, ['command.execute', { command: 'echo unsafe' }]))).rejects.toThrow('Unsupported operation');
    await page.getByLabel('Task message').fill('cancel fixture '.repeat(500));
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Cancel task' }).click();
    await expect(notice(page)).toContainText('cancelled');
    await page.getByRole('button', { name: /Model settings/ }).click();
    await page.getByRole('button', { name: 'New profile', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByLabel('Name', { exact: true }).fill('Credential fixture');
    await settings.getByLabel('Endpoint', { exact: true }).fill('https://fixture.openai.azure.com');
    await settings.getByLabel('Deployment', { exact: true }).fill('fixture');
    const canary = 'not-a-real-api-key-credential-canary-45678';
    await settings.getByLabel(/^Credential/).fill(canary);
    await settings.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(settings).not.toBeVisible();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(settings.getByLabel(/^Credential/)).toHaveValue('');
    await page.getByRole('button', { name: 'Close settings' }).click();
    const savedFiles = await readdir(join(fixture, 'state'), { recursive: true, withFileTypes: true });
    let encryptedCount = 0;
    for (const entry of savedFiles) {
      if (!entry.isFile() || (!entry.name.startsWith('workspace.db') && !entry.name.endsWith('.bin'))) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      expect(bytes.includes(Buffer.from(canary))).toBe(false);
      if (entry.name.endsWith('.bin')) encryptedCount += 1;
    }
    expect(encryptedCount).toBe(1);
    await app.close();
    app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.locator('.task-row', { hasText: 'Offline acceptance task' }).click();
    await expect(page.getByText('Fake response: Explain the project briefly.', { exact: true })).toBeVisible();
    const task = await page.evaluate(async () => (await window.workspace.invoke('workspace.tasks', { visibility: 'all', sort: 'created', limit: 50 })).tasks[0]);
    expect(task?.worktreePath).not.toBe(project);
    expect(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toBe('');
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('offline coding demo keeps review evidence, rejects safely, and applies only approved worktree changes', async () => {
  test.setTimeout(180_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-coding-e2e-'));
  const project = join(fixture, 'repository'); await mkdir(project);
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'ignore' }); };
  const sourceReadme = '# Fixture\n\nInitial README content.\n';
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), sourceReadme);
  await writeFile(join(project, '.gitignore'), 'node_modules/\n');
  git('add', 'README.md', '.gitignore'); git('commit', '-m', 'Fixture');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    let page = await app.firstWindow();
    await waitForRuntimeReady(page);
    const createCodingTask = async (title: string): Promise<{ id: string; worktreePath: string }> => {
      await createFixtureTask(page, project, title, 'coding');
      return page.evaluate(async (taskTitle) => {
        const snapshot = await window.workspace.invoke('workspace.tasks', { visibility: 'all', limit: 50 });
        const task = snapshot.tasks.find((candidate) => candidate.title === taskTitle);
        if (!task?.worktreePath) throw new Error('Coding task was not created.');
        return { id: task.id, worktreePath: task.worktreePath };
      }, title);
    };
    const requestDemo = async (): Promise<void> => {
      await page.getByLabel('Task message').fill('/demo');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.getByRole('button', { name: 'Approvals', exact: false }).click();
      await expect(page.locator('article.approval-card.awaiting-approval').first()).toBeVisible();
    };

    const rejected = await createCodingTask('Reject offline demo');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const fixtureProject = await page.evaluate(async () => (await window.workspace.invoke('workspace.projects', { limit: 50 })).projects.find(item => item.name === 'repository'));
    expect(fixtureProject).toBeTruthy();
    await page.getByRole('button', { name: `New chat in ${fixtureProject!.name}`, exact: true }).click();
    await page.getByLabel('Mode', { exact: true }).selectOption('coding');
    await expect(page.getByTestId('command-review-limits')).toContainText('50,000 files / 1 GiB');
    await expect(page.getByTestId('command-review-limits')).toContainText('10,000 directories + links');
    await expect(page.getByTestId('command-review-limits')).toContainText('including ignored dependencies');
    await page.getByRole('button', { name: 'Inbox & history', exact: true }).click();
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.locator('.task-row', { hasText: 'Reject offline demo' }).click();
    await requestDemo();
    const rejectedEdit = page.locator('article.approval-card').filter({ has: page.locator('dt', { hasText: 'File' }) }).first();
    await expect(rejectedEdit).toBeVisible();
    await rejectedEdit.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.approvals', { taskId, limit: 50 })).approvals.find((approval) => approval.state === 'rejected')?.state, rejected.id)).toBe('rejected');
    await expect(readFile(join(rejected.worktreePath, 'README.md'), 'utf8')).resolves.toBe(sourceReadme);

    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const accepted = await createCodingTask('Approve offline demo');
    // Synthetic installed-dependency contents belong only to this app-owned fixture worktree.
    // They exceed both former limits and remain Git-ignored, so source-checkout dirt is unchanged.
    const installed = join(accepted.worktreePath, 'node_modules', 'installed-fixture');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'fixture-data.bin'), Buffer.alloc(65 * 1024 * 1024, 0x61));
    await writeFile(join(installed, 'index.js'), 'module.exports = 1;\n');
    for (let start = 0; start < 10_001; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 10_001 - start) }, (_, offset) => writeFile(join(installed, `dependency-${start + offset}.js`), 'module.exports = 1;\n')));
    }
    expect((await readdir(installed)).length).toBe(10_003);
    expect(execFileSync('git', ['-C', accepted.worktreePath, 'check-ignore', 'node_modules/installed-fixture/index.js'], { encoding: 'utf8', windowsHide: true }).trim()).toBe('node_modules/installed-fixture/index.js');
    await expect(readdir(join(project, 'node_modules'))).rejects.toThrow();
    await requestDemo();
    const editApproval = page.locator('article.approval-card').filter({ has: page.locator('dt', { hasText: 'File' }) }).first();
    const reviewedAfter = await editApproval.locator('dl').filter({ has: page.locator('dt', { hasText: 'After' }) }).locator('pre').textContent();
    expect(reviewedAfter).toBeTruthy();
    await editApproval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.approvals', { taskId, limit: 50 })).approvals.find((approval) => approval.state === 'awaiting-approval')?.state, accepted.id), { timeout: 60_000 }).toBe('awaiting-approval');
    const commandApproval = page.locator('article.approval-card').filter({ has: page.locator('.command-evidence') }).first();
    await expect(commandApproval).toContainText('Runs with your Windows privileges; approval is not sandboxing.');
    await expect(page.getByTestId('command-review-limits')).toContainText('including ignored dependencies');
    await page.screenshot({ path: 'test-results/coding-approval-screenshot.png', fullPage: true });
    await commandApproval.getByRole('button', { name: 'Approve', exact: true }).click();
    // Windows process startup and verified Job cleanup can exceed the generic 5s UI assertion budget.
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.read', { taskId })).task.status, accepted.id), { timeout: 60_000 }).toBe('idle');
    const completedCommand = await page.evaluate(async (taskId) => {
      const command = (await window.workspace.invoke('task.approvals', { taskId, limit: 50 })).approvals.find(approval => approval.tool === 'run_command');
      if (!command) throw new Error('Reviewed command approval was not retained.');
      return (await window.workspace.invoke('approval.get', { taskId, approvalId: command.id })).approval;
    }, accepted.id);
    expect(completedCommand).toMatchObject({ state: 'complete', result: { cleanupVerified: true, exitCode: 0 } });
    await expect(readFile(join(accepted.worktreePath, 'README.md'), 'utf8')).resolves.toBe(reviewedAfter);
    await expect(readFile(join(project, 'README.md'), 'utf8')).resolves.toBe(sourceReadme);
    expect(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toBe('');

    const stale = await createCodingTask('Reject changed ignored dependency');
    const changedDependency = join(stale.worktreePath, 'node_modules', 'installed-fixture', 'index.js');
    await mkdir(join(stale.worktreePath, 'node_modules', 'installed-fixture'), { recursive: true });
    await writeFile(changedDependency, 'module.exports = 1;\n');
    await requestDemo();
    await page.locator('article.approval-card.awaiting-approval').first().getByRole('button', { name: 'Approve', exact: true }).click();
    const staleCommand = page.locator('article.approval-card.awaiting-approval').filter({ has: page.locator('.command-evidence') });
    await expect(staleCommand).toBeVisible();
    // Same file size, same ignored path: a content hash must invalidate the old approval.
    await writeFile(changedDependency, 'module.exports = 2;\n');
    await staleCommand.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate(async taskId => (await window.workspace.invoke('task.read', { taskId })).task.status, stale.id), { timeout: 30_000 }).toBe('idle');
    const refusedCommand = await page.evaluate(async taskId => {
      const command = (await window.workspace.invoke('task.approvals', { taskId, limit: 50 })).approvals.find(item => item.tool === 'run_command');
      if (!command) throw new Error('The stale command approval was not retained.');
      return (await window.workspace.invoke('approval.get', { taskId, approvalId: command.id })).approval;
    }, stale.id);
    expect(refusedCommand.state).toBe('failed');
    expect(refusedCommand.result).toEqual({ content: 'Prepared command fingerprint is stale; request approval again.', isError: true, cleanupVerified: false });
    expect(refusedCommand.result?.content).not.toContain('Foundry command demo completed');
    expect(refusedCommand.result?.exitCode).toBeUndefined();
    await expect(page.locator('article.approval-card.failed .approval-result')).toContainText('stale');
    await expect(readFile(join(project, 'README.md'), 'utf8')).resolves.toBe(sourceReadme);
    expect(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toBe('');

    await app.close();
    app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.locator('.task-row', { hasText: 'Approve offline demo' }).click();
    await page.getByRole('button', { name: 'Approvals', exact: false }).click();
    await expect(page.locator('article.approval-card.complete')).toHaveCount(2);
    // Decided approvals from an earlier session start folded under a counted summary; their evidence is one action away.
    await expect(page.locator('details.decided-approvals > summary')).toHaveText('Decided approvals (2: 2 complete)');
    await page.locator('details.decided-approvals > summary').click();
    await expect(page.getByText('Redacted result', { exact: false }).first()).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
