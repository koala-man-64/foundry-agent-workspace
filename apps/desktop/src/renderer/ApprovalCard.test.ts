import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Approval } from '../../../../packages/protocol/src/index';
import { ApprovalCard } from './ApprovalCard';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SHA_1 = '1'.repeat(40);
const base: Approval = {
  id: 'approval-1', taskId: 'task-1', toolCallId: 'call-1', nonce: 'nonce', tool: 'run_command', state: 'awaiting-approval',
  createdAt: '2026-10-25T00:00:00.000Z', summary: 'Run this exact PowerShell command with your Windows privileges.', fingerprint: 'fingerprint'
};

function render(approval: Partial<Approval>, options: { variant?: 'task' | 'coordinated'; complete?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...base, ...approval }, variant: options.variant ?? 'task', complete: options.complete ?? true,
    onDecide: () => undefined, onReconcile: () => undefined, onAcknowledgeBrowser: () => undefined
  }));
}

describe('ApprovalCard', () => {
  it('keeps the state class, heading hook and decision buttons for a pending command', () => {
    const html = render({ command: "Write-Output 'x'", cwd: 'C:\\work', shell: 'powershell.exe', environment: { PATH: 'C:\\Windows' }, timeoutMs: 10000 });
    expect(html).toContain('class="approval-card awaiting-approval"');
    expect(html).toContain('data-approval-id="approval-1"');
    expect(html).toContain('<div class="approval-heading"><strong class="approval-tool">run_command</strong>');
    expect(html).toContain('class="command-evidence"');
    expect(html).toContain('Runs with your Windows privileges; approval is not sandboxing.');
    expect(html).toContain('powershell.exe');
    expect(html).toContain('PATH=C:\\Windows');
    expect(html).toContain('10,000 ms');
    expect(html).toMatch(/>Approve<\/button>/);
    expect(html).toMatch(/>Reject<\/button>/);
  });

  it('shows shell, environment and hash evidence on coordinated approvals too', () => {
    const html = render({ command: 'git status', cwd: 'C:\\wt', shell: 'powershell.exe', environment: { TEMP: 'C:\\t' }, targetLabel: 'Child alpha · revision 1', generation: 1 }, { variant: 'coordinated' });
    expect(html).toContain('class="approval-target"');
    expect(html).toContain('powershell.exe');
    expect(html).toContain('TEMP=C:\\t');
  });

  it('distinguishes an absent file from an existing empty file', () => {
    const created = render({ tool: 'write_file', path: 'src/new.txt', expectedHash: null, after: 'hello', resultingHash: HASH_B });
    expect(created).toContain('<strong class="approval-kind">Create file</strong>');
    expect(created).toContain('File is absent. This approval creates a new file.');
    expect(created).toContain(`absent → ${HASH_B}`);
    const emptied = render({ tool: 'replace_text', path: 'src/empty.txt', expectedHash: HASH_A, before: '', after: 'x', resultingHash: HASH_B });
    expect(emptied).toContain('Existing empty file.');
    expect(emptied).toContain(`${HASH_A} → ${HASH_B}`);
  });

  it('labels external MCP and browser actions with their disclosures', () => {
    const mcp = render({ tool: 'mcp__fixture__write_note', mcp: { serverId: 'server-1', serverKey: 'fixture', serverName: 'Fixture server', tool: 'write_note', arguments: '{"text":"x"}' } });
    expect(mcp).toContain('Fixture server (fixture)');
    expect(mcp).toContain('the server&#x27;s own annotations grant nothing');
  });

  it('withholds Approve until the full evidence has loaded, with each shell\'s own wording', () => {
    const task = render({ command: 'x' }, { complete: false });
    expect(task).toContain('Full evidence has not loaded. Refresh approvals before deciding.');
    expect(task).toMatch(/<button type="button" class="primary" disabled="">Approve<\/button>/);
    const coordinated = render({ command: 'x' }, { variant: 'coordinated', complete: false });
    expect(coordinated).toContain('Full approval evidence is unavailable. Approval is disabled until it can be loaded.');
  });

  it('offers only read-only reconciliation for unknown outcomes', () => {
    const task = render({ state: 'unknown', command: 'x' });
    expect(task).toContain('class="approval-card unknown"');
    expect(task).toContain('Check outcome');
    expect(task).toContain('Read-only reconciliation; this never retries or discards the action.');
    expect(task).not.toMatch(/>Approve<\/button>/);
    const coordinatedFile = render({ state: 'unknown', tool: 'replace_text', path: 'a.txt', expectedHash: HASH_A, resultingHash: HASH_B }, { variant: 'coordinated' });
    expect(coordinatedFile).toContain('Read-only file reconciliation; this never retries the edit.');
    const coordinatedCommand = render({ state: 'unknown', command: 'x' }, { variant: 'coordinated' });
    expect(coordinatedCommand).not.toContain('Check outcome');
  });

  it('shows a decision failure inside the card as an alert', () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { approval: { ...base, command: 'x' }, variant: 'task', complete: true, error: 'This approval could not be confirmed: busy', onDecide: () => undefined, onReconcile: () => undefined }));
    expect(html).toContain('<p class="approval-error" role="alert">This approval could not be confirmed: busy</p>');
  });

  it('renders handoff and integration evidence for coordinated approvals', () => {
    const html = render({
      tool: 'integrate_result', state: 'awaiting-approval',
      integration: { kind: 'cherry-pick', sourceSha: SHA_1, expectedHead: SHA_1, expectedTree: SHA_1, manifestSha256: HASH_A, changedPaths: ['alpha.txt'], gitPath: 'C:\\git.exe', gitSha256: HASH_B, patch: '+x', patchTruncated: false }
    } as Partial<Approval>, { variant: 'coordinated' });
    expect(html).toContain('class="orchestration-evidence"');
    expect(html).toContain('alpha.txt');
    expect(html).toContain(HASH_A);
  });
});
