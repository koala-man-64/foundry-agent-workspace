import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const profileId = '00000000-0000-4000-8000-000000000001';

async function launch(state: string) {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = state;
  env.FOUNDRY_WORKSPACE_ENABLE_COORDINATED = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).toMatchObject({ runtime: 'ready' });
  return { app, page, errors };
}

async function addProject(app: ElectronApplication, page: Page, folder: string) {
  // Drive the real renderer -> main native picker -> validated runtime registration flow.
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, folder);
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect.poll(() => page.evaluate(async (path) => (await window.workspace.invoke('workspace.snapshot', {})).projects.some((project) => project.path.toLowerCase() === path.toLowerCase()), folder)).toBe(true);
}

test('saved ordinary folders keep grouped chats, drafts, visibility and collapsed state across navigation and restart', async () => {
  const testInfo = test.info();
  test.setTimeout(180_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-projects-e2e-'));
  const alpha = join(fixture, 'Alpha'); const beta = join(fixture, 'Beta');
  await mkdir(alpha); await mkdir(beta);
  await writeFile(join(alpha, 'hello.txt'), 'Read-only project file.\n');
  await writeFile(join(alpha, '.env'), 'SECRET_FIXTURE=never_display\n');
  let current = await launch(join(fixture, 'state'));
  try {
    let { app, page } = current;
    await expect(page.locator('.sidebar form')).toHaveCount(0);
    await addProject(app, page, beta); await addProject(app, page, alpha);
    await addProject(app, page, alpha);
    expect((await page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).projects).toHaveLength(2);
    await page.getByRole('button', { name: 'New chat in Alpha', exact: true }).click();
    await page.getByLabel('Chat message', { exact: true }).fill('Remember the Alpha draft.');
    await page.getByRole('button', { name: 'New chat in Beta', exact: true }).click();
    await page.getByLabel('Chat message', { exact: true }).fill('Remember the Beta draft.');
    const alternateProfile = await page.evaluate(() => window.workspace.invoke('profile.save', { id: crypto.randomUUID(), name: 'Alternate offline', apiKind: 'fake', endpoint: '', deployment: 'fixture', contextLimit: 32000, outputLimit: 2048 }));
    await page.getByLabel('Model', { exact: true }).selectOption(alternateProfile.id);
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).toMatchObject({ preferences: { profileId: alternateProfile.id } });
    await page.getByRole('button', { name: 'New chat in Alpha', exact: true }).click();
    await expect(page.getByLabel('Chat message', { exact: true })).toHaveValue('Remember the Alpha draft.');
    // An unrelated runtime event must not steal draft selection or its text.
    await page.evaluate((id) => window.workspace.invoke('workspace.preferences.save', { profileId: id }), alternateProfile.id);
    await expect(page.getByLabel('Chat message', { exact: true })).toHaveValue('Remember the Alpha draft.');
    await page.getByLabel('Chat message', { exact: true }).fill('Discuss the Alpha project.');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Fake response: Discuss the Alpha project.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Discuss the Alpha project.', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Changes', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Project channel', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: /hello\.txt/ }).click();
    await expect(page.getByText('Read-only project file.', { exact: true })).toBeVisible();
    await expect(page.locator('.file-tree')).not.toContainText('.env');
    const snapshot = await page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}));
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ workspaceKind: 'folder', projectPath: alpha });
    expect(snapshot.tasks[0]).not.toHaveProperty('worktreePath');
    await page.getByRole('button', { name: 'New chat in Beta', exact: true }).click();
    await expect(page.getByLabel('Chat message', { exact: true })).toHaveValue('Remember the Beta draft.');
    await page.evaluate((taskId) => window.workspace.invoke('task.send', { taskId, content: 'Continue in the background.' }), snapshot.tasks[0]!.id);
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.get', { taskId })).task.status, snapshot.tasks[0]!.id)).toBe('idle');
    await expect(page.getByLabel('Chat message', { exact: true })).toHaveValue('Remember the Beta draft.');

    await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Manage projects' });
    const betaRow = manager.locator('form').filter({ has: page.getByLabel('Name for Beta', { exact: true }) });
    await betaRow.getByLabel('Name for Beta', { exact: true }).fill('Beta renamed');
    await betaRow.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New chat in Beta renamed', exact: true })).toBeVisible();
    await manager.getByRole('button', { name: 'Hide Alpha', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New chat in Alpha', exact: true })).toHaveCount(0);
    await manager.getByRole('button', { name: 'Restore Alpha', exact: true }).click();
    await manager.getByRole('button', { name: /Close/ }).click();
    await expect(page.getByRole('button', { name: 'New chat in Alpha', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Alpha', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await app.close();
    current = await launch(join(fixture, 'state')); ({ app, page } = current);
    await expect(page.getByRole('button', { name: 'Alpha', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await page.getByRole('button', { name: 'Discuss the Alpha project.', exact: false }).click();
    await expect(page.getByText('Fake response: Discuss the Alpha project.', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.screenshot({ path: testInfo.outputPath('projects-sidebar.png') });
    await page.setViewportSize({ width: 880, height: 720 });
    const send = await page.getByRole('button', { name: /^Send/ }).boundingBox();
    expect(send).not.toBeNull(); expect(send!.x + send!.width).toBeLessThanOrEqual(880);
    await page.getByRole('button', { name: 'New chat', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Chat message', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue(alternateProfile.id);
    await page.screenshot({ path: testInfo.outputPath('draft-composer.png') });
    expect(current.errors).toEqual([]);
  } finally { await current.app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('projectless drafts retain Git mode preference and start without filesystem authority', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-no-folder-e2e-'));
  const { app, page, errors } = await launch(join(fixture, 'state'));
  try {
    await page.evaluate((id) => window.workspace.invoke('workspace.preferences.save', { profileId: id, mode: 'coding' }), profileId);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.getByLabel('Mode', { exact: true })).toHaveValue('chat');
    await page.getByLabel('Chat message', { exact: true }).fill('A conversation without a folder.');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Fake response: A conversation without a folder.', { exact: true })).toBeVisible();
    const snapshot = await page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}));
    expect(snapshot.preferences.mode).toBe('coding');
    expect(snapshot.tasks).toHaveLength(1);
    const task = snapshot.tasks[0]!;
    expect(task.workspaceKind).toBe('none');
    expect(task).not.toHaveProperty('projectPath'); expect(task).not.toHaveProperty('worktreePath');
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Project channel', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(page.evaluate((taskId) => window.workspace.invoke('files.list', { taskId }), task.id)).rejects.toThrow();
    await expect(page.evaluate((taskId) => window.workspace.invoke('task.retire', { taskId, confirm: 'retire' }), task.id)).rejects.toThrow();
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('Git draft first send creates one isolated worktree and missing folder errors preserve draft text', async () => {
  test.setTimeout(120_000);
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-git-draft-e2e-'));
  const gitFolder = join(fixture, 'Code'); const plainFolder = join(fixture, 'Notes');
  await mkdir(gitFolder); await mkdir(plainFolder);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', gitFolder, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(gitFolder, 'README.md'), '# Draft fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const { app, page } = await launch(join(fixture, 'state'));
  try {
    await addProject(app, page, gitFolder); await addProject(app, page, plainFolder);
    await page.getByRole('button', { name: 'New chat in Code', exact: true }).click();
    await page.getByLabel('Chat message', { exact: true }).fill('Start in the saved Git project.');
    await page.getByLabel('Mode', { exact: true }).selectOption('coordinated');
    await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled();
    if (!(await page.getByLabel('Required validation command').isVisible())) await page.getByRole('button', { name: /More options/ }).click();
    await page.getByLabel('Required validation command').fill('Write-Output fixture-validation');
    await expect(page.getByRole('button', { name: /^Send/ })).toBeEnabled();
    await page.getByLabel('Mode', { exact: true }).selectOption('chat');
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Fake response: Start in the saved Git project.', { exact: true })).toBeVisible();
    const snapshot = await page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}));
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ workspaceKind: 'git' });
    expect(snapshot.tasks[0]!.worktreePath).not.toBe(gitFolder);
    expect(git('status', '--porcelain')).toBe('');
    await page.getByRole('button', { name: 'New chat in Notes', exact: true }).click();
    await page.getByLabel('Chat message', { exact: true }).fill('Keep this text if the folder disappears.');
    await rename(plainFolder, join(fixture, 'MovedNotes'));
    await page.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByRole('status')).toContainText(/could not|unavailable|folder|directory/i);
    await expect(page.getByLabel('Chat message', { exact: true })).toHaveValue('Keep this text if the folder disappears.');
    expect((await page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).tasks).toHaveLength(1);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
