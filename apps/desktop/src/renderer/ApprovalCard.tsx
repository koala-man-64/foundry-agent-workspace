import type { Approval } from '../../../../packages/protocol/src/index';

export type ApprovalBusy = 'approve' | 'reject' | 'reconcile' | 'acknowledge';

interface Props {
  approval: Approval;
  /** `task` is an ordinary coding task; `coordinated` is a coordinator or child approval with handoff/integration evidence. */
  variant: 'task' | 'coordinated';
  complete: boolean;
  busy?: ApprovalBusy;
  /** Why the last decision or reconciliation on this card could not be confirmed; shown in the card, where the action is. */
  error?: string;
  onDecide: (approval: Approval, decision: 'approve' | 'reject') => void;
  onReconcile: (approval: Approval) => void;
  onAcknowledgeBrowser?: (approval: Approval) => void;
}

function short(sha: string | undefined | null): string { return sha ? sha.slice(0, 10) : 'none'; }

/** One reviewed tool action. Render-only: the caller owns the decision, reconciliation and evidence loading. */
export function ApprovalCard({ approval, variant, complete, busy, error, onDecide, onReconcile, onAcknowledgeBrowser }: Props) {
  const coordinated = variant === 'coordinated';
  const fileReconcilable = approval.path && approval.resultingHash && !approval.handoff && !approval.integration;
  return <article className={`approval-card ${approval.state}`} data-approval-id={approval.id}>
    <div className="approval-heading"><strong>{approval.expectedHash === null ? 'Create file' : approval.tool}</strong><span>{approval.state}</span></div>
    {approval.targetLabel && <p className="approval-target">{approval.targetLabel}{approval.generation !== undefined ? ` · generation ${approval.generation}` : ''}</p>}
    <p>{approval.summary}</p>
    {error && <p className="approval-error" role="alert">{error}</p>}
    {coordinated && !complete && <p role="alert">Full approval evidence is unavailable. Approval is disabled until it can be loaded.</p>}
    {approval.browser && <div className="command-evidence">
      <strong>Browser action</strong>
      <dl><dt>Origin</dt><dd>{approval.browser.prepared.origin}</dd></dl>
      <dl><dt>Target tab</dt><dd>{approval.browser.prepared.tabId}</dd></dl>
      <dl><dt>Action</dt><dd>{approval.browser.prepared.action.kind}</dd></dl>
      <dl><dt>Exact request</dt><dd><pre>{JSON.stringify(approval.browser.prepared.action, null, 2)}</pre></dd></dl>
      <small>One approval permits this exact action only. The page may have changed; stale actions are rejected.</small>
    </div>}
    {approval.mcp && <div className="command-evidence">
      <strong>External MCP tool</strong>
      <dl><dt>Server</dt><dd>{approval.mcp.serverName} ({approval.mcp.serverKey})</dd></dl>
      <dl><dt>Tool</dt><dd>{approval.mcp.tool}</dd></dl>
      <dl><dt>Arguments</dt><dd><pre>{approval.mcp.arguments}</pre></dd></dl>
      <small>External tools act outside the worktree with your Windows privileges; the server's own annotations grant nothing.</small>
    </div>}
    {approval.path && <dl><dt>File</dt><dd>{approval.path}</dd></dl>}
    {approval.expectedHash === null
      ? <dl><dt>Before</dt><dd>File is absent. This approval creates a new file.</dd></dl>
      : approval.before !== undefined && <dl><dt>Before</dt><dd>{approval.before === '' ? 'Existing empty file.' : <pre>{approval.before}</pre>}</dd></dl>}
    {approval.after !== undefined && <dl><dt>After</dt><dd><pre>{approval.after}</pre></dd></dl>}
    {(approval.expectedHash !== undefined || approval.resultingHash !== undefined) && <dl><dt>Hash</dt><dd>{approval.expectedHash === null ? 'absent' : approval.expectedHash ?? 'unavailable'} → {approval.resultingHash ?? 'pending'}</dd></dl>}
    {approval.command && <div className="command-evidence"><strong>Command</strong><pre>{approval.command}</pre><small>Runs with your Windows privileges; approval is not sandboxing.</small></div>}
    {approval.cwd && <dl><dt>Working directory</dt><dd>{approval.cwd}</dd></dl>}
    {approval.shell && <dl><dt>Shell</dt><dd>{approval.shell}</dd></dl>}
    {approval.environment && <dl><dt>Environment</dt><dd>{Object.entries(approval.environment).map(([key, value]) => <span className="environment" key={key}>{key}={value}</span>)}</dd></dl>}
    {approval.timeoutMs !== undefined && <dl><dt>Timeout</dt><dd>{approval.timeoutMs.toLocaleString()} ms</dd></dl>}
    {approval.handoff && <div className="orchestration-evidence">
      <strong>Handoff</strong>
      <dl><dt>Paths</dt><dd>{approval.handoff.paths.join(', ')}</dd></dl>
      <dl><dt>Message</dt><dd>{approval.handoff.message}</dd></dl>
      <dl><dt>Manifest SHA-256</dt><dd>{approval.handoff.manifestSha256}</dd></dl>
      <dl><dt>Git</dt><dd>{approval.handoff.gitPath} ({short(approval.handoff.gitSha256)})</dd></dl>
      <dl><dt>Expected HEAD</dt><dd>{short(approval.handoff.expectedHead)}</dd></dl>
      <dl><dt>Patch</dt><dd><pre>{approval.handoff.patch}{approval.handoff.patchTruncated ? '\n(truncated)' : ''}</pre></dd></dl>
    </div>}
    {approval.integration && <div className="orchestration-evidence">
      <strong>Integration</strong>
      <dl><dt>Kind</dt><dd>{approval.integration.kind}</dd></dl>
      <dl><dt>Source SHA</dt><dd>{short(approval.integration.sourceSha)}</dd></dl>
      <dl><dt>Expected HEAD / tree</dt><dd>{short(approval.integration.expectedHead)} / {short(approval.integration.expectedTree)}</dd></dl>
      <dl><dt>Manifest SHA-256</dt><dd>{approval.integration.manifestSha256}</dd></dl>
      {approval.integration.resolvedTree && <dl><dt>Resolved tree (continuation)</dt><dd>{short(approval.integration.resolvedTree)}</dd></dl>}
      <dl><dt>Changed paths</dt><dd>{approval.integration.changedPaths.join(', ') || 'none'}</dd></dl>
      <dl><dt>Git</dt><dd>{approval.integration.gitPath} ({short(approval.integration.gitSha256)})</dd></dl>
      <dl><dt>Patch</dt><dd><pre>{approval.integration.patch}{approval.integration.patchTruncated ? '\n(truncated)' : ''}</pre></dd></dl>
    </div>}
    {approval.result && <div className="approval-result">
      <strong>{approval.result.isError ? 'Redacted error result' : 'Redacted result'}</strong>
      <pre>{approval.result.content}</pre>
      {approval.result.exitCode !== undefined && <small>Exit code {approval.result.exitCode}</small>}
      {approval.result.cleanupVerified !== undefined && <small>Cleanup {approval.result.cleanupVerified ? 'verified' : 'not verified'}</small>}
    </div>}
    {approval.state === 'awaiting-approval' && <div className="approval-actions">
      {!coordinated && !complete && <p role="alert">Full evidence has not loaded. Refresh approvals before deciding.</p>}
      <button type="button" className="primary" disabled={Boolean(busy) || !complete} onClick={() => onDecide(approval, 'approve')}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
      <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => onDecide(approval, 'reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
    </div>}
    {approval.state === 'unknown' && approval.browser && !coordinated && <div className="approval-actions">
      <p>The browser action was dispatched, but its result is unknown. Inspect the tab manually before allowing newly reviewed actions. This action remains unknown and will not be retried.</p>
      {approval.browser.acknowledgment
        ? <small>Inspected {approval.browser.acknowledgment.inspectedAt}. New actions may be reviewed.</small>
        : <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onAcknowledgeBrowser?.(approval)}>{busy === 'acknowledge' ? 'Recording inspection…' : 'I inspected the tab · allow new actions'}</button>}
    </div>}
    {approval.state === 'unknown' && !approval.browser && !coordinated && <div className="approval-actions">
      <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onReconcile(approval)}>{busy === 'reconcile' ? 'Checking…' : 'Check outcome'}</button>
      <small>Read-only reconciliation; this never retries or discards the action.</small>
    </div>}
    {approval.state === 'unknown' && coordinated && fileReconcilable && <div className="approval-actions">
      <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onReconcile(approval)}>{busy === 'reconcile' ? 'Checking…' : 'Check outcome'}</button>
      <small>Read-only file reconciliation; this never retries the edit.</small>
    </div>}
  </article>;
}
