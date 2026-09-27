import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('independent agents share a project channel with direct messages and a retained visible transcript', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-channel-e2e-'));
  const project = join(fixture, 'project'); await mkdir(project);
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true }); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Channel fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    const page = await app.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const create = async (title: string): Promise<void> => {
      await page.getByLabel('Project path').fill(project); await page.getByLabel('Task title').fill(title);
      await page.getByLabel('Mode').selectOption('chat'); await page.getByRole('button', { name: 'Create task', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    };
    await create('Recipient'); await create('Sender');
    await page.getByLabel('Task message').fill('/channel-demo Agent finding for the project');
    await page.locator('.composer').getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText('Channel message recorded. Idle agents receive it on their next turn.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Project channel', exact: true }).click();
    const channel = page.getByTestId('project-channel');
    await expect(channel.getByText('Agent finding for the project', { exact: true })).toBeVisible();
    const recipientId = await page.evaluate(async () => (await window.workspace.invoke('workspace.snapshot', {})).tasks.find(task => task.title === 'Recipient')!.id);
    await channel.getByLabel('Channel recipient').selectOption(recipientId);
    await channel.getByLabel('Channel message').fill('Private handoff to recipient');
    await channel.getByRole('button', { name: 'Send to channel' }).click();
    await expect(channel.getByText('Private handoff to recipient', { exact: true })).toBeVisible();
    await expect(channel.getByText('You via Sender', { exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Task history' }).getByRole('button', { name: /Recipient/ }).click();
    await expect(channel.getByText('Private handoff to recipient', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async (id) => (await window.workspace.invoke('task.get', { taskId: id })).task.status, recipientId)).toBe('idle');
    await create('Third agent');
    await expect(channel.getByText('Agent finding for the project', { exact: true })).toBeVisible();
    await expect(channel.getByText('Private handoff to recipient', { exact: true })).toHaveCount(0);
    await channel.getByText(/Project agents/).click();
    await expect(channel.getByText('Sender', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/agent-channel.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
