import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task } from '../../packages/protocol/src/index';
import { Store } from '../../packages/runtime/src/store';

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

test('usage overview filters offline requests and opens their conversation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-usage-e2e-'));
  const project = join(fixture, 'repository'); await mkdir(project);
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'ignore' }); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New chat in repository', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New chat in repository', exact: true }).click();
    await page.getByRole('button', { name: /More options/ }).click();
    await page.getByLabel('Title (optional)').fill('Usage fixture task');
    await page.getByLabel('Chat message', { exact: true }).fill('Usage fixture response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Fake response: Usage fixture response', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Usage overview' }).click();
    const overview = page.getByRole('region', { name: 'Usage overview' });
    await expect(overview.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
    await expect(overview.getByText('Calendar days in', { exact: false })).toBeVisible();
    await expect(overview.getByRole('region', { name: 'Request details' }).getByText('No requests match this view.')).toBeVisible();
    await overview.getByLabel('Include offline demo').check();
    await expect(overview.getByRole('region', { name: 'Request details' }).getByText('Usage fixture task')).toBeVisible();
    await expect(overview.getByRole('img', { name: /Daily measured token totals/ }).locator('rect')).toHaveCount(0);
    await overview.getByRole('button', { name: 'Custom' }).click();
    await overview.getByLabel('From').fill('2026-10-02');
    await overview.getByLabel('Through').fill('2026-10-01');
    await expect(overview.getByRole('alert')).toContainText('Choose valid start and end dates');
    await expect(overview.getByRole('region', { name: 'Request details' }).getByText('Usage fixture task')).toHaveCount(0);
    await overview.getByRole('button', { name: 'Today' }).click();
    await overview.getByLabel('Group by').selectOption('model');
    await expect(overview.getByRole('region', { name: 'Usage breakdown' }).getByRole('listitem').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/usage-offline-overview.png', fullPage: true });
    await overview.getByRole('region', { name: 'Usage breakdown' }).getByRole('listitem').first().click();
    await expect(overview.getByRole('heading', { name: /Requests ·/ })).toBeVisible();
    await overview.getByRole('button', { name: 'Open conversation' }).click();
    await expect(page.getByRole('heading', { name: 'Usage fixture task' })).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('profile effort choices follow the selected API without a live probe', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-effort-e2e-'));
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = join(fixture, 'state'); delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /Model settings/ }).click();
    const settings = page.getByRole('dialog').filter({ visible: true });
    await settings.getByRole('button', { name: 'New profile' }).click();
    await settings.getByLabel('Reasoning effort').selectOption('max');
    await settings.getByLabel('API kind').selectOption('chat-completions');
    await expect(settings.getByLabel('Reasoning effort')).toHaveValue('');
    await expect(settings.getByLabel('Reasoning effort').locator('option[value="max"]')).toHaveCount(0);
    await settings.getByLabel('Reasoning effort').selectOption('none');
    await settings.getByLabel('API kind').selectOption('anthropic');
    await expect(settings.getByLabel('Reasoning effort')).toHaveValue('');
    await expect(settings.getByLabel('Reasoning effort').locator('option[value="none"]')).toHaveCount(0);
    await settings.getByLabel('Reasoning effort').selectOption('high');
    await expect(settings.getByText('at high effort with the configured', { exact: false })).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});

test('seeded usage shows sparse days, partial metrics, pagination, and child drilldown', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'foundry-usage-seeded-e2e-'));
  const project = join(fixture, 'repository'); await mkdir(project);
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const stateDirectory = join(fixture, 'state');
  const store = new Store(join(stateDirectory, 'workspace.db'));
  const now = new Date();
  const noon = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
  const base: Task = { id: randomUUID(), title: 'Seeded root task', projectPath: project, worktreePath: project, workspaceKind: 'git', branch: 'main', baseCommit: git('rev-parse', 'HEAD'), profileId: randomUUID(), status: 'idle', createdAt: noon(-3).toISOString(), updatedAt: noon(0).toISOString(), tokenBudget: 100000, usedTokens: 0, mode: 'chat', role: 'coordinator' };
  const child: Task = { ...base, id: randomUUID(), title: 'Seeded child task', rootTaskId: base.id, parentTaskId: base.id, role: 'child' };
  store.saveTask(base); store.saveTask(child);
  store.saveProfile({ id: base.profileId, name: 'Seeded profile', apiKind: 'responses', endpoint: 'https://example.invalid', deployment: 'fixture-deployment', contextLimit: 32000, outputLimit: 1024 });
  const columns = ['request_id', 'task_id', 'root_task_id', 'parent_task_id', 'task_title', 'root_task_title', 'role', 'purpose', 'profile_id', 'profile_name', 'api_kind', 'deployment', 'effort', 'attribution_known', 'reported_model', 'response_id', 'created_at', 'attempted_at', 'finished_at', 'outcome', 'reserved', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'reasoning_tokens', 'usage_known', 'reason'];
  const insert = store.db.prepare(`INSERT INTO provider_requests (${columns.join(',')}) VALUES (${columns.map(column => '@' + column).join(',')})`);
  store.transaction(() => {
    for (let index = 0; index < 55; index++) {
      const task = index === 0 ? child : base;
      const dayOffset = index === 53 ? -3 : index === 54 ? -1 : 0;
      const createdAt = new Date(noon(dayOffset).getTime() - index * 1000).toISOString();
      insert.run({ request_id: randomUUID(), task_id: task.id, root_task_id: base.id, parent_task_id: task.parentTaskId ?? null, task_title: task.title, root_task_title: base.title, role: task.role ?? null, purpose: 'conversation', profile_id: base.profileId, profile_name: 'Seeded profile', api_kind: 'responses', deployment: 'fixture-deployment', effort: 'medium', attribution_known: 1, reported_model: 'reported-model', response_id: null, created_at: createdAt, attempted_at: createdAt, finished_at: createdAt, outcome: 'completed', reserved: 100, input_tokens: index === 54 ? 0 : index === 53 ? 9 : 1, output_tokens: index === 54 ? 0 : index === 53 ? 3 : 1, cache_read_tokens: index === 0 ? 1 : null, cache_creation_tokens: index === 1 ? 1 : null, reasoning_tokens: index === 2 ? 1 : null, usage_known: 1, reason: null });
    }
    insert.run({ request_id: randomUUID(), task_id: base.id, root_task_id: base.id, parent_task_id: null, task_title: base.title, root_task_title: base.title, role: 'coordinator', purpose: 'conversation', profile_id: base.profileId, profile_name: 'Seeded profile', api_kind: 'responses', deployment: 'fixture-deployment', effort: 'medium', attribution_known: 1, reported_model: null, response_id: null, created_at: new Date(noon(0).getTime() + 60000).toISOString(), attempted_at: null, finished_at: new Date(noon(0).getTime() + 60001).toISOString(), outcome: 'cancelled', reserved: 100, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, reasoning_tokens: null, usage_known: 0, reason: 'Stopped before dispatch.' });
  });
  store.close();

  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.FOUNDRY_WORKSPACE_TEST_DATA = stateDirectory; delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Usage overview' }).click();
    const overview = page.getByRole('region', { name: 'Usage overview' });
    await expect(overview.getByText('1/55 reported').first()).toBeVisible();
    await expect(overview.getByRole('region', { name: 'Request details' }).getByText('Not dispatched', { exact: true })).toBeVisible();
    await expect(overview.getByText('100 not dispatched', { exact: false })).toBeVisible();
    await overview.getByRole('button', { name: 'Custom' }).click();
    await overview.getByLabel('From').fill(localDate(noon(-3)));
    await overview.getByLabel('Through').fill(localDate(noon(0)));
    const bars = overview.getByRole('img', { name: /Daily measured token totals/ }).locator('rect');
    await expect(bars).toHaveCount(2);
    const positions = await bars.evaluateAll(rectangles => rectangles.map(rectangle => Number(rectangle.getAttribute('x'))));
    expect(positions[1]! - positions[0]!).toBeGreaterThan(150);
    await page.screenshot({ path: 'test-results/usage-seeded-overview.png', fullPage: true });

    await expect(overview.getByRole('region', { name: 'Request details' }).getByText('Seeded child task').first()).toBeVisible();
    await overview.getByRole('region', { name: 'Usage breakdown' }).getByRole('listitem').first().click();
    await expect(overview.getByRole('heading', { name: 'Requests · Seeded root task' })).toBeVisible();
    await expect(overview.getByText('Child agent', { exact: false }).first()).toBeVisible();
    await overview.getByRole('region', { name: 'Request details' }).getByRole('button', { name: 'More requests' }).click();
    await overview.getByRole('region', { name: 'Request details' }).getByRole('button', { name: 'More requests' }).click();
    await expect(overview.locator('.usage-request')).toHaveCount(56);
    await overview.locator('.usage-request').filter({ hasText: 'Child agent' }).getByRole('button', { name: 'Open conversation' }).click();
    await expect(page.getByRole('heading', { name: 'Seeded root task' })).toBeVisible();
  } finally { await app.close(); await rm(fixture, { recursive: true, force: true }); }
});
