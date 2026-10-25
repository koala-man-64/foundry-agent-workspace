import { useEffect, useState } from 'react';
import type { DesktopApi, UsageReport } from '../../../../packages/protocol/src/index';
import { UsageChart } from './UsageChart';
import { errorMessage, type SetNotice } from './feedback';

interface Props {
  api: DesktopApi;
  rootTaskId: string;
  taskId: string;
  label: string;
  active: boolean;
  retired: boolean;
  retirementReady: boolean;
  refreshToken: number;
  onRefresh: () => Promise<void>;
  setNotice: SetNotice;
}

const measuredMetric = (value: number | null, reported: number, known: number): string =>
  value === null ? 'Unavailable' : `${value.toLocaleString()} (${reported}/${known} reported)`;

/** User controls for existing runtime operations; publication remains unavailable for coordinated tasks. */
export function CoordinatedTaskControls({ api, rootTaskId, taskId, label, active, retired, retirementReady, refreshToken, onRefresh, setNotice }: Props) {
  const [usage, setUsage] = useState<UsageReport>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'compact' | 'retire'>();
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    void api.invoke('task.usage', { taskId }).then(result => {
      if (current) { setUsage(result); setError(''); }
    }, reason => { if (current) setError(`Could not load usage: ${errorMessage(reason)}`); });
    return () => { current = false; };
  }, [api, taskId, refreshToken, revision]);

  const compact = async () => {
    if (busy) return;
    setBusy('compact');
    try {
      await api.invoke('task.compact', { taskId });
      setNotice(`Compacted ${label} context. Original messages remain in history.`, 'success');
      setRevision(value => value + 1);
      await onRefresh();
    } catch (reason) { setNotice(`Could not compact ${label}: ${errorMessage(reason)}`); }
    finally { setBusy(undefined); }
  };

  const retire = async () => {
    if (busy) return;
    setBusy('retire'); setConfirmRetire(false);
    try {
      const result = await api.invoke('task.retire', { taskId: rootTaskId, confirm: 'retire' });
      setNotice(`Retired ${result.removedWorktrees.length} clean worktree(s). Branches and task history are retained.`, 'success');
      await onRefresh();
    } catch (reason) { setNotice(`Could not retire: ${errorMessage(reason)}`); }
    finally { setBusy(undefined); }
  };

  return <div className="usage-panel" data-testid="coordinated-task-controls">
    <h3>{label} usage</h3>
    {taskId === rootTaskId && <p className="muted">Request totals and measured token counts include child agents. Context, the request chart and compaction apply to the coordinator only.</p>}
    {error && <p role="alert">{error}</p>}
    {usage ? <>
      <dl className="usage-grid">
        <div><dt>Task budget</dt><dd>{usage.usedTokens.toLocaleString()} / {usage.tokenBudget.toLocaleString()}</dd></div>
        <div><dt>Next request estimate</dt><dd className={usage.contextPercent >= usage.warningPercent ? 'warning' : ''}>{usage.estimatedContextTokens.toLocaleString()} / {usage.contextLimit.toLocaleString()} ({usage.contextPercent}%)</dd></div>
        <div><dt>Requests</dt><dd>{usage.metrics ? `${usage.metrics.attemptedRequests} attempts (${usage.metrics.knownRequests} measured, ${usage.metrics.unknownRequests} unknown, ${usage.metrics.pendingRequests} pending, ${usage.metrics.notSentRequests} not dispatched)` : `${usage.totals.requests} (${usage.totals.knownRequests} measured, ${usage.totals.unknownRequests} unknown)`}</dd></div>
        <div><dt>Measured input tokens</dt><dd>{(usage.metrics?.input ?? usage.totals.prompt).toLocaleString()}</dd></div>
        <div><dt>Measured output tokens</dt><dd>{(usage.metrics?.output ?? usage.totals.completion).toLocaleString()}</dd></div>
        <div><dt>Cache read / creation</dt><dd>{usage.metrics ? `${measuredMetric(usage.metrics.cacheRead, usage.metrics.cacheReadKnownRequests, usage.metrics.knownRequests)} / ${measuredMetric(usage.metrics.cacheCreation, usage.metrics.cacheCreationKnownRequests, usage.metrics.knownRequests)}` : 'Unavailable / Unavailable'}</dd></div>
        <div><dt>Reasoning output</dt><dd>{usage.metrics ? measuredMetric(usage.metrics.reasoning, usage.metrics.reasoningKnownRequests, usage.metrics.knownRequests) : 'Unavailable'}</dd></div>
        <div><dt>Conservative reservations</dt><dd>{usage.metrics ? `${usage.metrics.reservedUnknown.toLocaleString()} unknown · ${usage.metrics.reservedPending.toLocaleString()} pending · ${usage.metrics.reservedNotSent.toLocaleString()} not dispatched` : `${usage.totals.reservedUnknown.toLocaleString()} unknown`}</dd></div>
      </dl>
      <p className="muted">Context estimates are conservative. Compaction summarizes older turns and retains the original messages.</p>
      <UsageChart records={usage.records} />
      <button type="button" className="secondary" disabled={Boolean(busy) || active || retired} onClick={() => void compact()}>{busy === 'compact' ? 'Compacting…' : 'Compact context'}</button>
      <h3>Compactions</h3>
      {usage.compactions.map(record => <p key={record.id}>Messages {record.fromOrdinal}–{record.toOrdinal} · {record.estimatedTokensBefore.toLocaleString()} → {record.estimatedTokensAfter.toLocaleString()} estimated tokens</p>)}
      {!usage.compactions.length && <p className="muted">No compaction has been performed.</p>}
      {usage.compactionsNextBefore !== null && usage.compactionsNextBefore !== undefined && <p className="muted">Showing the latest compactions. Older summaries remain in conversation history.</p>}
      {usage.recordsNextBefore !== null && usage.recordsNextBefore !== undefined && <p className="muted">Showing the latest usage records. Full usage history is available in workspace Usage.</p>}
    </> : !error && <p className="muted">Loading usage…</p>}
    <h3>Retire coordinated worktrees</h3>
    <p className="muted">Retires the root and all child worktrees only after every run is terminal and every worktree is clean. Branches, commits and history remain. Coordinated commit and push are unavailable.</p>
    {confirmRetire ? <div className="approval-actions">
      <button type="button" className="danger" disabled={Boolean(busy) || retired || !retirementReady} onClick={() => void retire()}>Confirm retire (clean worktrees only)</button>
      <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setConfirmRetire(false)}>Keep worktrees</button>
    </div> : <button type="button" className="secondary" disabled={Boolean(busy) || retired || !retirementReady} onClick={() => setConfirmRetire(true)}>{busy === 'retire' ? 'Retiring…' : retired ? 'Retired' : 'Retire worktrees…'}</button>}
  </div>;
}
