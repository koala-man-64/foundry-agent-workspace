import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('compaction, MCP under approval, diagnostics export, explicit commit and safe retirement through the desktop UI', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-phase04-e2e-'));
  const project = join(fixture, 'repository'); await mkdir(project);
  const notes = join(fixture, 'notes.txt');
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n'); git('add', 'README.md'); git('commit', '-m', 'Fixture');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.snapshot', {}))).toMatchObject({ runtime: 'ready' });
    const createTask = async (title: string, mode: 'chat' | 'coding'): Promise<{ id: string; worktreePath: string; branch: string }> => {
      await page.getByLabel('Project path').fill(project);
      await page.getByLabel('Task title').fill(title);
      await page.getByLabel('Mode').selectOption(mode);
      await page.getByRole('button', { name: 'Create task', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      return page.evaluate(async (taskTitle) => {
        const snapshot = await window.workspace.invoke('workspace.snapshot', {});
        const task = snapshot.tasks.find((candidate) => candidate.title === taskTitle);
        if (!task) throw new Error('Task was not created.');
        return { id: task.id, worktreePath: task.worktreePath, branch: task.branch };
      }, title);
    };
    const send = async (content: string): Promise<void> => {
      await page.getByLabel('Task message').fill(content);
      await page.getByRole('button', { name: /^Send/ }).click();
      await expect(page.getByText(`Fake response: ${content}`, { exact: true })).toBeVisible();
    };

    // 1. Compaction of a chat task keeps the originals visible and shows the runtime summary and usage.
    const chat = await createTask('Compaction task', 'chat');
    const first = 'first direction '.repeat(30).trim();
    for (const content of [first, 'second direction '.repeat(30).trim(), 'third direction '.repeat(30).trim()]) await send(content);
    await page.getByRole('button', { name: 'Compact context', exact: true }).first().click();
    await expect(page.getByRole('status')).toContainText('Compacted 2 earlier messages');
    await expect(page.locator('article.compaction-summary')).toHaveCount(1);
    await expect(page.locator('article.compaction-summary')).toContainText('runtime-generated');
    await expect(page.locator('article.message.compacted')).toHaveCount(2);
    await expect(page.getByText(`Fake response: ${first}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    await expect(page.getByTestId('usage-panel')).toContainText('2 messages');
    await expect(page.getByTestId('usage-panel')).toContainText('Requests');
    const usage = await page.evaluate((taskId) => window.workspace.invoke('task.usage', { taskId }), chat.id);
    expect(usage.compactions).toHaveLength(1); expect(usage.totals.requests).toBe(3);

    // 2. Configure the fixture MCP server from settings and mark echo read-only.
    await page.getByRole('button', { name: /Model settings/ }).click();
    const settings = page.getByRole('dialog');
    await settings.getByLabel('MCP key').fill('fixture');
    await settings.getByLabel('MCP name').fill('Fixture server');
    await settings.getByLabel('MCP command').fill(process.execPath);
    await settings.getByLabel('MCP arguments').fill(resolve('tests/fixtures/mcp-fixture-server.mjs'));
    await settings.getByLabel('MCP environment').fill(`MCP_FIXTURE_NOTES=${notes}`);
    await settings.getByRole('button', { name: 'Connect and save server', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('listed 7 tool(s)');
    const server = settings.getByTestId('mcp-server-fixture');
    await expect(server).toContainText('foundry-fixture 1.0.0');
    // The allowlist is stored by the runtime (a save re-launches and relists the server); the checkbox reflects the saved state.
    await server.getByRole('checkbox', { name: /^echo/ }).click();
    await expect.poll(() => page.evaluate(async () => (await window.workspace.invoke('mcp.list', {}))[0]?.readOnlyTools)).toEqual(['echo']);
    await expect(server.getByRole('checkbox', { name: /^echo/ })).toBeChecked();
    await settings.getByRole('button', { name: 'Close settings' }).click();

    // 3. The offline MCP demo runs echo without approval and stops for the state-changing write_note.
    const coding = await createTask('MCP demo task', 'coding');
    await page.getByLabel('Task message').fill('/mcp-demo');
    await page.getByRole('button', { name: /^Send/ }).click();
    await page.getByRole('button', { name: 'Approvals', exact: false }).click();
    const card = page.locator('article.approval-card.awaiting-approval').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('mcp__fixture__write_note');
    await expect(card).toContainText('Fixture server (fixture)');
    await expect(card).toContainText('echo said: echo: ping from the offline demo');
    await expect(card).toContainText('server\'s own annotations grant nothing');
    await page.screenshot({ path: 'docs/mcp-approval-screenshot.png', fullPage: true });
    await expect(stat(notes)).rejects.toThrow();
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate(async (taskId) => (await window.workspace.invoke('task.get', { taskId })).task.status, coding.id)).toBe('idle');
    await expect(page.locator('article.approval-card.complete')).toHaveCount(1);
    expect(await readFile(notes, 'utf8')).toBe('echo said: echo: ping from the offline demo\n');
    await expect(page.getByText('the note was written through the approved external tool', { exact: false })).toBeVisible();

    // 4. Diagnostics export is scrubbed of the saved credential canary.
    await page.getByRole('button', { name: /Model settings/ }).click();
    await settings.getByRole('button', { name: 'New profile', exact: true }).click();
    await settings.getByLabel('Name', { exact: true }).fill('Canary profile');
    await settings.getByLabel('Endpoint', { exact: true }).fill('https://fixture.openai.azure.com');
    await settings.getByLabel('Deployment', { exact: true }).fill('fixture');
    const canary = 'not-a-real-api-key-diagnostics-canary-2468';
    await settings.getByLabel(/^Credential/).fill(canary);
    await settings.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(settings).not.toBeVisible();
    await page.getByRole('button', { name: /Export diagnostics/ }).click();
    await expect(page.getByRole('status')).toContainText('Sanitized diagnostics written to');
    const noticeText = await page.getByRole('status').textContent();
    const exported = /written to (.+?\.json)/.exec(noticeText ?? '')?.[1];
    expect(exported).toBeTruthy();
    const bundle = await readFile(exported!, 'utf8');
    expect(bundle).not.toContain(canary);
    expect(bundle).toContain('MCP demo task');
    expect(JSON.parse(bundle).mcpServers[0].key).toBe('fixture');

    // 5. Explicit commit then safe retirement of the coding task worktree; the branch and history remain.
    await page.getByRole('button', { name: /MCP demo task/ }).click();
    await writeFile(join(coding.worktreePath, 'demo-note.txt'), 'written by the user in the task worktree\n');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByTestId('publish-panel').getByLabel('Commit message').fill('Offline MCP demo change');
    await page.getByRole('button', { name: 'Commit all changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Committed');
    expect(execFileSync('git', ['-C', coding.worktreePath, 'log', '-1', '--format=%s'], { encoding: 'utf8', windowsHide: true }).trim()).toBe('Offline MCP demo change');
    expect(execFileSync('git', ['-C', coding.worktreePath, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim()).toBe('');
    await page.getByRole('button', { name: 'Retire worktree…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm retire (clean worktrees only)', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Retired 1 clean worktree');
    await expect(stat(coding.worktreePath)).rejects.toThrow();
    expect(git('rev-parse', '--verify', coding.branch)).toHaveLength(40);
    await expect(page.getByRole('button', { name: /MCP demo task/ })).toContainText('Retired');
    await expect(page.getByLabel('Task message')).toBeDisabled();
    expect(git('status', '--porcelain')).toBe('');
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
