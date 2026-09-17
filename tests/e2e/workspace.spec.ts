import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    await expect(page.getByRole('heading', { name: 'A considered local workspace.' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).toMatchObject({ runtime: 'ready' });
    expect(await page.evaluate(() => 'require' in window)).toBe(false);
    await page.getByLabel('Project path').fill(project);
    await page.getByLabel('Task title').fill('Offline acceptance task');
    await page.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Offline acceptance task' })).toBeVisible();
    await page.getByLabel('Task message').fill('Explain the project briefly.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Fake response: Explain the project briefly.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /hello.txt/ }).click();
    await expect(page.getByText('Hello from an isolated task.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /▸ src$/ }).click();
    await page.getByRole('button', { name: /src\/example.ts$/ }).click();
    await expect(page.getByText('export const answer = 42;', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Root', exact: true }).click();
    await page.getByRole('button', { name: /hello.txt$/ }).click();
    const worktree = await page.evaluate(async () => (await window.workspace.invoke('workspace.snapshot', {})).tasks[0]!.worktreePath);
    await writeFile(join(worktree, 'hello.txt'), 'Changed in the task worktree.\n');
    await page.locator('aside.inspector').getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(page.getByText('+Changed in the task worktree.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByText('Changed in the task worktree.', { exact: true })).toBeVisible();
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
    await expect(page.getByRole('status')).toContainText('cancelled');
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
    await page.getByRole('button', { name: /Offline acceptance task/ }).click();
    await expect(page.getByText('Fake response: Explain the project briefly.', { exact: true })).toBeVisible();
    const task = await page.evaluate(async () => (await window.workspace.invoke('workspace.snapshot', {})).tasks[0]);
    expect(task?.worktreePath).not.toBe(project);
    expect(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toBe('');
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('offline coding demo keeps review evidence, rejects safely, and applies only approved worktree changes', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-coding-e2e-'));
  const project = join(fixture, 'repository'); await mkdir(project);
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'ignore' }); };
  const sourceReadme = '# Fixture\n\nInitial README content.\n';
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), sourceReadme); git('add', 'README.md'); git('commit', '-m', 'Fixture');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    let page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).toMatchObject({ runtime: 'ready' });
    const createCodingTask = async (title: string): Promise<{ id: string; worktreePath: string }> => {
      await page.getByLabel('Project path').fill(project);
      await page.getByLabel('Task title').fill(title);
      await page.getByLabel('Mode').selectOption('coding');
      await page.getByRole('button', { name: 'Create task', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      return page.evaluate(async (taskTitle) => {
        const snapshot = await window.workspace.invoke('workspace.snapshot', {});
        const task = snapshot.tasks.find((candidate) => candidate.title === taskTitle);
        if (!task) throw new Error('Coding task was not created.');
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
    await requestDemo();
    const rejectedEdit = page.locator('article.approval-card').filter({ has: page.locator('dt', { hasText: 'File' }) }).first();
    await expect(rejectedEdit).toBeVisible();
    await rejectedEdit.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.get', { taskId })).approvals?.find((approval) => approval.state === 'rejected')?.state, rejected.id)).toBe('rejected');
    await expect(readFile(join(rejected.worktreePath, 'README.md'), 'utf8')).resolves.toBe(sourceReadme);

    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const accepted = await createCodingTask('Approve offline demo');
    await requestDemo();
    const editApproval = page.locator('article.approval-card').filter({ has: page.locator('dt', { hasText: 'File' }) }).first();
    const reviewedAfter = await editApproval.locator('dl').filter({ has: page.locator('dt', { hasText: 'After' }) }).locator('pre').textContent();
    expect(reviewedAfter).toBeTruthy();
    await editApproval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.get', { taskId })).approvals?.find((approval) => approval.command)?.state, accepted.id)).toBe('awaiting-approval');
    const commandApproval = page.locator('article.approval-card').filter({ has: page.locator('.command-evidence') }).first();
    await expect(commandApproval).toContainText('Runs with your Windows privileges; approval is not sandboxing.');
    await page.screenshot({ path: 'docs/coding-approval-screenshot.png', fullPage: true });
    await commandApproval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.get', { taskId })).task.status, accepted.id)).toBe('idle');
    await expect(readFile(join(accepted.worktreePath, 'README.md'), 'utf8')).resolves.toBe(reviewedAfter);
    await expect(readFile(join(project, 'README.md'), 'utf8')).resolves.toBe(sourceReadme);
    expect(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toBe('');

    await app.close();
    app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
    page = await app.firstWindow();
    await page.getByRole('button', { name: /Approve offline demo/ }).click();
    await page.getByRole('button', { name: 'Approvals', exact: false }).click();
    await expect(page.locator('article.approval-card.complete')).toHaveCount(2);
    await expect(page.getByText('Redacted result', { exact: false }).first()).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
