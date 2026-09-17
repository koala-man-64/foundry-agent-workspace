import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, DesktopApi, DiffResult, FileContent, FileEntry, Task } from '../../../../packages/protocol/src/index';
import type {
  AgentRun, Assignment, AssignmentState, ChildDetail, IntegrationOperation, IntegrationState, OrchestrationView, RunLifecycle, RunOutcome, WaitReason
} from '../../../../packages/protocol/src/orchestration';

interface Props {
  api: DesktopApi;
  task: Task;
  notice: string;
  setNotice: (value: string) => void;
  onWorkspaceRefresh: () => void;
}

const lifecycleLabel: Record<RunLifecycle, string> = { queued: 'Queued', preparing: 'Preparing', running: 'Running', waiting: 'Waiting', terminal: 'Terminal' };
const outcomeLabel: Record<RunOutcome, string> = { succeeded: 'Succeeded', incomplete: 'Incomplete', failed: 'Failed', cancelled: 'Cancelled' };
const waitReasonLabel: Record<WaitReason, string> = {
  admission: 'Waiting for an admission slot', dependencies: 'Waiting on dependencies', children: 'Waiting on children',
  approval: 'Waiting on approval', 'profile-quota': 'Waiting on profile availability', 'task-budget': 'Waiting on task budget',
  conflict: 'Blocked on a conflict', reconciliation: 'Awaiting reconciliation', 'user-continuation': 'Waiting for you to continue'
};
const assignmentStateLabel: Record<AssignmentState, string> = {
  proposed: 'Proposed', admitted: 'Admitted', 'result-submitted': 'Result submitted', integrated: 'Integrated',
  incomplete: 'Incomplete', failed: 'Failed', cancelled: 'Cancelled', revoked: 'Revoked', superseded: 'Superseded'
};
const integrationStateLabel: Record<IntegrationState, string> = {
  'awaiting-approval': 'Awaiting approval', executing: 'Executing', succeeded: 'Succeeded', conflict: 'Conflict',
  continued: 'Continued', empty: 'Empty (blocked)', mismatch: 'Mismatch (blocked)', unknown: 'Unknown (blocked)', rejected: 'Rejected', revoked: 'Revoked', failed: 'Failed'
};
const REVISABLE: AssignmentState[] = ['proposed', 'incomplete', 'failed', 'cancelled', 'revoked'];
const RECONCILABLE: IntegrationState[] = ['unknown', 'conflict', 'empty', 'mismatch'];

function short(sha: string | undefined | null): string { return sha ? sha.slice(0, 10) : 'none'; }

function ApprovalCard({ approval, busy, onDecide }: { approval: Approval; busy?: 'approve' | 'reject'; onDecide: (approval: Approval, decision: 'approve' | 'reject') => void }) {
  return <article className={`approval-card ${approval.state}`} key={approval.id}>
    <div className="approval-heading"><strong>{approval.tool}</strong><span>{approval.state}</span></div>
    {approval.targetLabel && <p className="approval-target">{approval.targetLabel}{approval.generation !== undefined ? ` · generation ${approval.generation}` : ''}</p>}
    <p>{approval.summary}</p>
    {approval.path && <dl><dt>File</dt><dd>{approval.path}</dd></dl>}
    {approval.before !== undefined && <dl><dt>Before</dt><dd><pre>{approval.before}</pre></dd></dl>}
    {approval.after !== undefined && <dl><dt>After</dt><dd><pre>{approval.after}</pre></dd></dl>}
    {approval.command && <div className="command-evidence"><strong>Command</strong><pre>{approval.command}</pre><small>Runs with your Windows privileges; approval is not sandboxing.</small></div>}
    {approval.cwd && <dl><dt>Working directory</dt><dd>{approval.cwd}</dd></dl>}
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
    {approval.result && <div className="approval-result"><strong>{approval.result.isError ? 'Redacted error result' : 'Redacted result'}</strong><pre>{approval.result.content}</pre>{approval.result.exitCode !== undefined && <small>Exit code {approval.result.exitCode}</small>}</div>}
    {approval.state === 'awaiting-approval' && <div className="approval-actions">
      <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => onDecide(approval, 'approve')}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
      <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => onDecide(approval, 'reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
    </div>}
  </article>;
}

export function CoordinatedTaskView({ api, task, notice, setNotice, onWorkspaceRefresh }: Props) {
  const rootTaskId = task.id;
  const [runsById, setRunsById] = useState<Record<string, AgentRun>>({});
  const [runsCursor, setRunsCursor] = useState<number | null>(null);
  const [eventsById, setEventsById] = useState<Record<number, OrchestrationView['events'][number]>>({});
  const [eventsCursor, setEventsCursor] = useState<number | null>(null);
  const [view, setView] = useState<Omit<OrchestrationView, 'runs' | 'runsCursor' | 'events' | 'eventsCursor'>>();
  const [viewError, setViewError] = useState('');
  const [selectedChildId, setSelectedChildId] = useState<string | undefined>(undefined);
  const [childDetail, setChildDetail] = useState<ChildDetail>();
  const [rootApprovals, setRootApprovals] = useState<Approval[]>([]);
  const [childApprovals, setChildApprovals] = useState<Record<string, Approval[]>>({});
  const [tab, setTab] = useState<'files' | 'changes' | 'approvals' | 'orchestration'>('orchestration');
  const [composer, setComposer] = useState('');
  const [approvalInFlight, setApprovalInFlight] = useState<Record<string, 'approve' | 'reject'>>({});
  const [operationInFlight, setOperationInFlight] = useState<Record<string, 'check' | 'continue'>>({});
  const [reviseTarget, setReviseTarget] = useState<string>();
  const [reviseObjective, setReviseObjective] = useState('');
  const [reviseAcceptance, setReviseAcceptance] = useState('');
  const [busy, setBusy] = useState<string>();
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent>();
  const [diff, setDiff] = useState<DiffResult>();

  const rootRef = useRef(rootTaskId); rootRef.current = rootTaskId;
  const viewVersion = useRef(0);
  const childVersion = useRef(0);
  const approvalsVersion = useRef(0);
  const inspectorVersion = useRef(0);
  const selectedChildRef = useRef<string | undefined>(undefined); selectedChildRef.current = selectedChildId;

  const fetchLatest = useCallback(async () => {
    const version = ++viewVersion.current;
    try {
      const next = await api.invoke('orchestration.get', { rootTaskId, runsCursor: 0 });
      if (version !== viewVersion.current || rootRef.current !== rootTaskId) return;
      setRunsById((current) => { const merged = { ...current }; for (const run of next.runs) merged[run.taskId] = run; return merged; });
      setEventsById((current) => { const merged = { ...current }; for (const item of next.events) merged[item.sequence] = item; return merged; });
      setRunsCursor(next.runsCursor);
      setEventsCursor(next.eventsCursor);
      const { runs: _runs, runsCursor: _rc, events: _events, eventsCursor: _ec, ...rest } = next;
      setView(rest);
      setViewError('');
    } catch (error) { if (version === viewVersion.current) setViewError(error instanceof Error ? error.message : String(error)); }
  }, [api, rootTaskId]);

  const loadMoreAgents = useCallback(async () => {
    if (runsCursor === null) return;
    const version = ++viewVersion.current;
    try {
      const next = await api.invoke('orchestration.get', { rootTaskId, runsCursor });
      if (version !== viewVersion.current || rootRef.current !== rootTaskId) return;
      setRunsById((current) => { const merged = { ...current }; for (const run of next.runs) merged[run.taskId] = run; return merged; });
      setRunsCursor(next.runsCursor);
    } catch (error) { setNotice(`Could not load more agents: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, rootTaskId, runsCursor, setNotice]);

  const loadOlderEvents = useCallback(async () => {
    if (eventsCursor === null) return;
    const version = ++viewVersion.current;
    try {
      const next = await api.invoke('orchestration.get', { rootTaskId, runsCursor: 0, eventsBefore: eventsCursor });
      if (version !== viewVersion.current || rootRef.current !== rootTaskId) return;
      setEventsById((current) => { const merged = { ...current }; for (const item of next.events) merged[item.sequence] = item; return merged; });
      setEventsCursor(next.eventsCursor);
    } catch (error) { setNotice(`Could not load older events: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, rootTaskId, eventsCursor, setNotice]);

  const loadChild = useCallback(async (childTaskId: string) => {
    const version = ++childVersion.current;
    try {
      const detail = await api.invoke('orchestration.child', { rootTaskId, childTaskId });
      if (version === childVersion.current && selectedChildRef.current === childTaskId) setChildDetail(detail);
    } catch (error) { if (version === childVersion.current && selectedChildRef.current === childTaskId) setNotice(`Could not load agent detail: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, rootTaskId, setNotice]);

  const loadApprovals = useCallback(async () => {
    const version = ++approvalsVersion.current;
    try {
      const rootDetail = await api.invoke('task.get', { taskId: rootTaskId });
      const childIds = Object.values(runsById).filter((run) => run.role === 'child').map((run) => run.taskId);
      const childLists = await Promise.all(childIds.map(async (childTaskId) => [childTaskId, (await api.invoke('orchestration.child', { rootTaskId, childTaskId })).approvals] as const));
      if (version !== approvalsVersion.current || rootRef.current !== rootTaskId) return;
      setRootApprovals(rootDetail.approvals ?? []);
      setChildApprovals(Object.fromEntries(childLists));
    } catch (error) { if (version === approvalsVersion.current) setNotice(`Could not load approvals: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, rootTaskId, runsById, setNotice]);

  const refreshInspector = useCallback(async (path: string) => {
    const version = ++inspectorVersion.current;
    try {
      const [nextFiles, nextDiff] = await Promise.all([api.invoke('files.list', { taskId: rootTaskId, path }), api.invoke('task.diff', { taskId: rootTaskId })]);
      if (version === inspectorVersion.current && rootRef.current === rootTaskId) { setFiles(nextFiles); setDiff(nextDiff); }
    } catch (error) { if (version === inspectorVersion.current) setNotice(`Could not refresh inspector: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, rootTaskId, setNotice]);

  useEffect(() => {
    setRunsById({}); setRunsCursor(null); setEventsById({}); setEventsCursor(null); setView(undefined);
    setSelectedChildId(undefined); setChildDetail(undefined); setRootApprovals([]); setChildApprovals({});
    setCurrentPath(''); setFiles([]); setFile(undefined); setDiff(undefined);
    void fetchLatest(); void refreshInspector('');
  }, [rootTaskId, fetchLatest, refreshInspector]);

  useEffect(() => { void fetchLatest(); }, [fetchLatest]);
  useEffect(() => { if (selectedChildId) void loadChild(selectedChildId); }, [selectedChildId, loadChild]);
  useEffect(() => { if (tab === 'approvals') void loadApprovals(); }, [tab, loadApprovals]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'runtime.stopped') return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void fetchLatest();
        if (selectedChildRef.current) void loadChild(selectedChildRef.current);
        if (tab === 'approvals') void loadApprovals();
      }, 250);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [api, fetchLatest, loadChild, loadApprovals, tab]);

  const coordinatorRun = useMemo(() => Object.values(runsById).find((run) => run.role === 'coordinator'), [runsById]);
  const childRuns = useMemo(() => Object.values(runsById).filter((run) => run.role === 'child').sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [runsById]);
  const assignmentById = useMemo(() => Object.fromEntries((view?.assignments ?? []).map((item) => [item.id, item])), [view]);
  const eventsSorted = useMemo(() => Object.values(eventsById).sort((a, b) => b.sequence - a.sequence), [eventsById]);
  const combinedEvidence = useMemo(() => (view?.evidence ?? []).filter((item) => item.kind === 'combined').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [view]);
  const latestCombined = combinedEvidence[0];

  const pendingApprovals = useMemo(() => {
    const list: Approval[] = [...rootApprovals];
    for (const items of Object.values(childApprovals)) list.push(...items);
    return list;
  }, [rootApprovals, childApprovals]);

  const decideApproval = async (approval: Approval, decision: 'approve' | 'reject') => {
    if (approvalInFlight[approval.id]) return;
    setApprovalInFlight((current) => ({ ...current, [approval.id]: decision }));
    try {
      await api.invoke('orchestration.decide', { rootTaskId, taskId: approval.taskId, approvalId: approval.id, nonce: approval.nonce, assignmentId: approval.assignmentId ?? null, generation: approval.generation ?? 1, fingerprint: approval.fingerprint, decision });
      await fetchLatest(); await loadApprovals(); if (selectedChildId) await loadChild(selectedChildId);
    } catch (error) { setNotice(`Could not ${decision} this approval: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setApprovalInFlight((current) => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };

  const sendToCoordinator = async (event: FormEvent) => {
    event.preventDefault(); if (!composer.trim()) return;
    const content = composer.trim(); setComposer('');
    try { await api.invoke('task.send', { taskId: rootTaskId, content }); await fetchLatest(); }
    catch (error) { setComposer(content); setNotice(`Message was not sent: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const cancelChild = async (run: AgentRun, key: string) => {
    setBusy(`cancel-${run.taskId}`);
    try { await api.invoke('orchestration.cancelChild', { rootTaskId, childTaskId: run.taskId, generation: run.generation }); await fetchLatest(); if (selectedChildId === run.taskId) await loadChild(run.taskId); }
    catch (error) { setNotice(`Could not cancel ${key}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(undefined); }
  };

  const cancelRoot = async () => {
    setBusy('cancel-root');
    try { await api.invoke('orchestration.cancelRoot', { rootTaskId }); await fetchLatest(); onWorkspaceRefresh(); }
    catch (error) { setNotice(`Could not cancel the coordinated task: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(undefined); }
  };

  const startRevise = (assignment: Assignment) => { setReviseTarget(assignment.id); setReviseObjective(assignment.objective); setReviseAcceptance(assignment.acceptance.join('\n')); };
  const submitRevise = async (event: FormEvent) => {
    event.preventDefault(); if (!reviseTarget) return;
    const acceptance = reviseAcceptance.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!reviseObjective.trim() || !acceptance.length) { setNotice('An assignment revision needs an objective and at least one acceptance item.'); return; }
    setBusy(`revise-${reviseTarget}`);
    try { await api.invoke('orchestration.reviseAssignment', { rootTaskId, assignmentId: reviseTarget, objective: reviseObjective.trim(), acceptance }); setReviseTarget(undefined); await fetchLatest(); }
    catch (error) { setNotice(`Could not revise this assignment: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(undefined); }
  };

  const checkOutcome = async (operation: IntegrationOperation) => {
    setOperationInFlight((current) => ({ ...current, [operation.id]: 'check' }));
    try { const result = await api.invoke('orchestration.reconcile', { rootTaskId, operationId: operation.id }); setNotice(`Reconciliation: ${result.kind} — ${result.detail}`); await fetchLatest(); }
    catch (error) { setNotice(`Could not check this outcome: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setOperationInFlight((current) => { const next = { ...current }; delete next[operation.id]; return next; }); }
  };
  const prepareContinuation = async (operation: IntegrationOperation) => {
    setOperationInFlight((current) => ({ ...current, [operation.id]: 'continue' }));
    try { await api.invoke('orchestration.prepareContinue', { rootTaskId, operationId: operation.id }); setNotice('A continuation approval was prepared. Review it in Approvals.'); await fetchLatest(); }
    catch (error) { setNotice(`Could not prepare a continuation: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setOperationInFlight((current) => { const next = { ...current }; delete next[operation.id]; return next; }); }
  };

  const browseDirectory = (path: string) => { setCurrentPath(path); setFile(undefined); void refreshInspector(path); };
  const readFile = async (path: string) => {
    try { setFile(await api.invoke('files.read', { taskId: rootTaskId, path })); }
    catch (error) { setNotice(`Could not read file: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';

  const rootLifecycle = coordinatorRun?.lifecycle;
  const rootTerminal = rootLifecycle === 'terminal';
  const budget = view?.budget;
  const completion = view?.completion;

  return <>
    <section className="conversation orchestration-conversation">
      <header className="task-header orchestration-header">
        <div>
          <p className="eyebrow">{task.projectPath}</p>
          <h1>{task.title}</h1>
          {budget && <p className={`task-status orchestration-budget ${budget.warning ? 'warning' : ''} ${budget.overrun ? 'overrun' : ''}`}>
            charged {budget.charged.toLocaleString()} · in flight {budget.inFlight.toLocaleString()} · held {budget.unusedHolds.toLocaleString()} · unallocated {budget.unallocated.toLocaleString()} of {budget.cap.toLocaleString()}
            {budget.overrun && <span className="overrun-notice"> · budget overrun recorded</span>}
          </p>}
          {completion && <p className="task-status">{completion.complete ? `Completed on ${short(latestCombined?.head)}` : `Incomplete: ${completion.blockers[0] ?? 'no blockers reported yet'}`}</p>}
        </div>
        {!rootTerminal && <button className="danger" disabled={busy === 'cancel-root'} onClick={() => void cancelRoot()}>{busy === 'cancel-root' ? 'Cancelling…' : 'Cancel coordinated task'}</button>}
      </header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
      {viewError && <p className="muted inspector-empty">{viewError}</p>}
      <nav aria-label="Agent tree" className="agent-tree">
        <button type="button" className={`agent-row ${!selectedChildId ? 'selected' : ''}`} onClick={() => setSelectedChildId(undefined)}>
          <span className="agent-key" title="coordinator">Coordinator</span>
          <span className="agent-lifecycle">{coordinatorRun ? lifecycleLabel[coordinatorRun.lifecycle] : 'Loading…'}{coordinatorRun?.lifecycle === 'waiting' && coordinatorRun.waitReason ? ` · ${waitReasonLabel[coordinatorRun.waitReason]}` : ''}{coordinatorRun?.outcome ? ` · ${outcomeLabel[coordinatorRun.outcome]}` : ''}</span>
        </button>
        {childRuns.map((run) => {
          const assignment = run.assignmentId ? assignmentById[run.assignmentId] : undefined;
          const key = assignment?.key ?? run.title;
          return <button type="button" key={run.taskId} className={`agent-row ${selectedChildId === run.taskId ? 'selected' : ''}`} onClick={() => setSelectedChildId(run.taskId)}>
            <span className="agent-key" title={`${key} · ${run.title}`}>{key} · {run.title}</span>
            <span className="agent-lifecycle">{lifecycleLabel[run.lifecycle]}{run.lifecycle === 'waiting' && run.waitReason ? ` · ${waitReasonLabel[run.waitReason]}` : ''}{run.outcome ? ` · ${outcomeLabel[run.outcome]}` : ''}</span>
          </button>;
        })}
        {runsCursor !== null && <button type="button" className="quiet" onClick={() => void loadMoreAgents()}>Load more agents</button>}
      </nav>
      <div className="agent-detail">
        {!selectedChildId ? <>
          <form className="composer" onSubmit={sendToCoordinator}>
            <textarea value={composer} onChange={(e) => setComposer(e.target.value)} aria-label="Message coordinator" placeholder="Message the coordinator…" />
            <button className="primary" disabled={!composer.trim()}>Send <span>↵</span></button>
          </form>
        </> : <div className="child-panel">
          <p className="child-note">Child agents receive input only through assignments.</p>
          <div className="messages" aria-live="polite">
            {childDetail?.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-meta">{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}</div><p>{message.content}{message.truncated ? ' (truncated)' : ''}</p></article>)}
          </div>
          {childDetail?.assignment && <div className="assignment-summary">
            <dl><dt>Objective</dt><dd>{childDetail.assignment.objective}</dd></dl>
            <dl><dt>Acceptance</dt><dd><ul>{childDetail.assignment.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></dl>
            <dl><dt>Read scope</dt><dd>{childDetail.assignment.readPaths.join(', ') || 'none'}</dd></dl>
            <dl><dt>Write scope</dt><dd>{childDetail.assignment.writePaths.join(', ') || 'none'}</dd></dl>
            <dl><dt>Validation command</dt><dd>{childDetail.assignment.validation?.command ?? 'none'}</dd></dl>
            <dl><dt>Base commit</dt><dd>{short(childDetail.assignment.baseCommit)}</dd></dl>
            <dl><dt>Revision</dt><dd>{childDetail.assignment.revision}</dd></dl>
            <dl><dt>Allocation / charged</dt><dd>{childDetail.assignment.allocation.toLocaleString()} / {(budget?.runs.find((item) => item.taskId === selectedChildId)?.charged ?? 0).toLocaleString()}</dd></dl>
          </div>}
          {childDetail && childDetail.results.length > 0 && <div className="assignment-summary">
            <strong>Results</strong>
            {childDetail.results.map((result) => <dl key={result.id}><dt>Commit / tree</dt><dd>{short(result.commit)} / {short(result.tree)}</dd></dl>)}
          </div>}
          {childDetail && childDetail.run.lifecycle !== 'terminal' && <button type="button" className="danger" disabled={busy === `cancel-${childDetail.run.taskId}`} onClick={() => void cancelChild(childDetail.run, childDetail.assignment?.key ?? childDetail.run.title)}>
            {busy === `cancel-${childDetail.run.taskId}` ? 'Cancelling…' : `Cancel child ${childDetail.assignment?.key ?? childDetail.run.title}`}
          </button>}
        </div>}
      </div>
    </section>
    <aside className="inspector">
      <div className="inspector-tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Files</button>
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Changes</button>
        <button className={tab === 'approvals' ? 'active' : ''} onClick={() => setTab('approvals')}>Approvals{pendingApprovals.some((item) => item.state === 'awaiting-approval') ? ' · 1+' : ''}</button>
        <button className={tab === 'orchestration' ? 'active' : ''} onClick={() => setTab('orchestration')}>Orchestration</button>
      </div>
      {tab === 'files' ? <>
        <div className="inspector-tools"><button type="button" onClick={() => browseDirectory('')} disabled={!currentPath}>Root</button><span title={currentPath || 'Repository root'}>{currentPath || 'Repository root'}</span><button type="button" onClick={() => void refreshInspector(currentPath)}>Refresh</button></div>
        <div className="file-tree">
          {currentPath && <button type="button" className="up-directory" onClick={() => browseDirectory(parentPath)}><span>←</span>Up</button>}
          {files.map((entry) => <button key={entry.path} type="button" className={file?.path === entry.path ? 'active-file' : ''} onClick={() => entry.kind === 'directory' ? browseDirectory(entry.path) : void readFile(entry.path)}><span>{entry.kind === 'directory' ? '▸' : '·'}</span>{entry.path}</button>)}
          {!files.length && <p className="muted">No files here.</p>}
        </div>
        <div className="file-content"><p>{file?.path ?? 'Choose a file to read'}</p><pre>{file?.content}</pre></div>
      </> : tab === 'changes' ? <div className="patch"><p>{diff?.summary ?? 'Loading changes…'}{diff?.truncated ? ' (truncated)' : ''}</p><pre>{diff?.patch}</pre></div>
        : tab === 'approvals' ? <div className="approvals-panel">
          {pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={approvalInFlight[approval.id]} onDecide={decideApproval} />)}
          {!pendingApprovals.length && <p className="muted inspector-empty">No reviewed actions are queued.</p>}
        </div> : <div className="orchestration-panel">
          <section><h3>Assignments</h3>
            {(view?.assignments ?? []).map((assignment) => <article className="assignment-card" key={assignment.id}>
              <div className="approval-heading"><strong>{assignment.key} · revision {assignment.revision}</strong><span>{assignmentStateLabel[assignment.state]}</span></div>
              <p>{assignment.objective}</p>
              {assignment.waitReason && <p className="muted">{waitReasonLabel[assignment.waitReason]}</p>}
              {assignment.dependsOn.length > 0 && <dl><dt>Depends on</dt><dd>{assignment.dependsOn.map((id) => assignmentById[id]?.key ?? id).join(', ')}</dd></dl>}
              {REVISABLE.includes(assignment.state) && (reviseTarget === assignment.id ? <form className="revise-form" onSubmit={submitRevise}>
                <label>Objective <textarea value={reviseObjective} onChange={(e) => setReviseObjective(e.target.value)} maxLength={4000} /></label>
                <label>Acceptance (one per line) <textarea value={reviseAcceptance} onChange={(e) => setReviseAcceptance(e.target.value)} maxLength={4000} /></label>
                <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setReviseTarget(undefined)}>Cancel</button><button className="primary" disabled={busy === `revise-${assignment.id}`}>{busy === `revise-${assignment.id}` ? 'Revising…' : 'Submit revision'}</button></div>
              </form> : <button type="button" className="secondary" onClick={() => startRevise(assignment)}>Revise</button>)}
            </article>)}
            {!(view?.assignments ?? []).length && <p className="muted">No assignments yet.</p>}
          </section>
          <section><h3>Results</h3>
            {(view?.results ?? []).map((result) => {
              const passed = result.evidenceIds.map((id) => view?.evidence.find((item) => item.id === id)).filter(Boolean);
              return <article className="assignment-card" key={result.id}>
                <div className="approval-heading"><strong>{assignmentById[result.assignmentId]?.key ?? result.assignmentId}</strong><span>{passed.length && passed.every((item) => item?.passed) ? 'evidence passed' : passed.length ? 'evidence failed' : 'no evidence'}</span></div>
                <dl><dt>Commit / tree</dt><dd>{short(result.commit)} / {short(result.tree)}</dd></dl>
                <dl><dt>Changed paths</dt><dd>{result.changedPaths.join(', ') || 'none'}</dd></dl>
                <dl><dt>Child claim (untrusted)</dt><dd>{result.summary}</dd></dl>
                {result.unresolved && <dl><dt>Unresolved</dt><dd>{result.unresolved}</dd></dl>}
              </article>;
            })}
            {!(view?.results ?? []).length && <p className="muted">No submitted results yet.</p>}
          </section>
          <section><h3>Integrations</h3>
            {(view?.integrations ?? []).map((operation) => <article className="assignment-card" key={operation.id}>
              <div className="approval-heading"><strong>{assignmentById[operation.assignmentId]?.key ?? operation.assignmentId} · {operation.kind}</strong><span>{integrationStateLabel[operation.state]}</span></div>
              <dl><dt>Source SHA</dt><dd>{short(operation.sourceSha)}</dd></dl>
              <dl><dt>Observed</dt><dd>{operation.observed?.commit ? `commit ${short(operation.observed.commit)}` : operation.observed?.unmergedPaths?.length ? `conflict: ${operation.observed.unmergedPaths.join(', ')}` : operation.observed?.detail ?? 'none'}</dd></dl>
              {(operation.state === 'empty' || operation.state === 'mismatch') && <p className="muted">Blocked outcome; the runtime never auto-skips or manufactures a commit here.</p>}
              {RECONCILABLE.includes(operation.state) && <div className="approval-actions">
                <button type="button" className="secondary" disabled={Boolean(operationInFlight[operation.id])} onClick={() => void checkOutcome(operation)}>{operationInFlight[operation.id] === 'check' ? 'Checking…' : 'Check outcome'}</button>
                {operation.state === 'conflict' && <button type="button" className="secondary" disabled={Boolean(operationInFlight[operation.id])} onClick={() => void prepareContinuation(operation)}>{operationInFlight[operation.id] === 'continue' ? 'Preparing…' : 'Prepare continuation'}</button>}
              </div>}
            </article>)}
            {!(view?.integrations ?? []).length && <p className="muted">No integration operations yet.</p>}
          </section>
          <section><h3>Combined validation</h3>
            {combinedEvidence.map((item) => <article className="assignment-card" key={item.id}>
              <div className="approval-heading"><strong>{item.passed ? 'Passed' : 'Did not pass'}</strong><span>{short(item.head)}</span></div>
              <dl><dt>Tree</dt><dd>{short(item.tree)}</dd></dl>
              <dl><dt>Command</dt><dd><pre>{item.command}</pre></dd></dl>
            </article>)}
            {!combinedEvidence.length && <p className="muted">No combined validation evidence yet.</p>}
          </section>
          <section><h3>Events</h3>
            <ul className="event-list">{eventsSorted.map((item) => <li key={item.sequence}>{item.createdAt} · {item.type}</li>)}</ul>
            {eventsCursor !== null && <button type="button" className="quiet" onClick={() => void loadOlderEvents()}>Older events</button>}
          </section>
          {view?.truncated && <p className="muted">(truncated)</p>}
        </div>}
    </aside>
  </>;
}
