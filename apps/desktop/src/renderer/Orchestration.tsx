import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentChannelPanel } from './AgentChannel';
import type { Approval, DesktopApi, DiffResult, FileContent, FileEntry, Message, ModelProfile, Task } from '../../../../packages/protocol/src/index';
import type { CompactionSummary, SearchHit } from '../../../../packages/protocol/src/workspace';
import { Transcript } from './Transcript';
import { TaskActivity } from './TaskActivity';
import { AssignmentGraph } from './AssignmentGraph';
import { ContinuityPanel } from './ContinuityPanel';
import { CoordinatedTaskControls } from './CoordinatedTaskControls';
import { CoordinatedHandoffPanel } from './CoordinatedHandoffPanel';
import { readApprovalEvidence } from './ApprovalEvidence';
import { ApprovalCard, focusAfterDecision } from './ApprovalCard';
import { approvalsTabLabel, useCompactLayout } from './layout';
import { sendOnShortcut } from './composer';
import { Hash, PatchText } from './Evidence';
import { formatDateTime, humanize, lifecycleLabel, waitReasonLabel } from './labels';
import { mergeTranscriptPage, refreshedOlderCursor } from './transcriptHistory';
import type { ActionItem } from '../../../../packages/protocol/src/workspace';
import type {
  AgentRun, Assignment, AssignmentState, ChildDetail, IntegrationOperation, IntegrationState, OrchestrationView, RunOutcome
} from '../../../../packages/protocol/src/orchestration';
import { decisionFailure, errorMessage, type SetNotice } from './feedback';

interface Props {
  api: DesktopApi;
  task: Task;
  profiles: ModelProfile[];
  /** The app notice element, rendered here so it stays next to the coordinated conversation. */
  notice: ReactNode;
  setNotice: SetNotice;
  /** The coordinator composer text, held by the app per task so it cannot follow the user into another task. */
  composer: string;
  setComposer: (text: string) => void;
  onWorkspaceRefresh: () => void;
  onTaskCreated: (task: Task) => void;
  focusAction?: ActionItem;
  searchHit?: SearchHit;
}

const outcomeLabel: Record<RunOutcome, string> = { succeeded: 'Succeeded', incomplete: 'Incomplete', failed: 'Failed', cancelled: 'Cancelled' };
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

function full(sha: string | undefined | null): string { return sha || 'none'; }

export function CoordinatedTaskView({ api, task, profiles, notice, setNotice, composer, setComposer, onWorkspaceRefresh, onTaskCreated, focusAction, searchHit }: Props) {
  const rootTaskId = task.id;
  const [runsById, setRunsById] = useState<Record<string, AgentRun>>({});
  const [runsCursor, setRunsCursor] = useState<number | null>(null);
  const [eventsById, setEventsById] = useState<Record<number, OrchestrationView['events'][number]>>({});
  const [eventsCursor, setEventsCursor] = useState<number | null>(null);
  const [view, setView] = useState<Omit<OrchestrationView, 'runs' | 'runsCursor' | 'events' | 'eventsCursor'>>();
  const [viewError, setViewError] = useState('');
  const [selectedChildId, setSelectedChildId] = useState<string | undefined>(undefined);
  const [childDetail, setChildDetail] = useState<ChildDetail>();
  const [childNextBefore, setChildNextBefore] = useState<number | null>(null);
  const [childThrough, setChildThrough] = useState<number>();
  const [rootApprovals, setRootApprovals] = useState<Approval[]>([]);
  const [incompleteApprovalIds, setIncompleteApprovalIds] = useState<Set<string>>(new Set());
  const [rootMessages, setRootMessages] = useState<Message[]>([]);
  const [rootCompactions, setRootCompactions] = useState<CompactionSummary[]>([]);
  const [rootNextBefore, setRootNextBefore] = useState<number | null>(null);
  const [rootThrough, setRootThrough] = useState<number>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const inspectorWasOpen = useRef(false);
  const [childApprovals, setChildApprovals] = useState<Record<string, Approval[]>>({});
  const [tab, setTab] = useState<'files' | 'changes' | 'approvals' | 'orchestration' | 'activity' | 'continuity' | 'channel' | 'usage' | 'handoff'>('orchestration');
  const [approvalInFlight, setApprovalInFlight] = useState<Record<string, 'approve' | 'reject' | 'reconcile'>>({});
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
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
  const approvalsFlight = useRef<Promise<void> | null>(null);
  const approvalsDirty = useRef(false);
  const approvalsWorker = useRef<() => Promise<void>>(async () => undefined);
  const transcriptVersion = useRef(0);
  const viewFlight = useRef<Promise<void> | null>(null);
  const viewDirty = useRef(false);
  const viewWorker = useRef<() => Promise<void>>(async () => undefined);
  const childFlight = useRef<Promise<void> | null>(null);
  const childDirty = useRef(false);
  const childRequested = useRef('');
  const childWorker = useRef<(id: string) => Promise<void>>(async () => undefined);
  const childLoadedId = useRef('');
  const transcriptFlight = useRef<Promise<void> | null>(null);
  const transcriptDirty = useRef(false);
  const transcriptWorker = useRef<() => Promise<void>>(async () => undefined);
  const transcriptLoadedId = useRef('');
  const rootMessageOrdinals = useRef(new Map<string, number>());
  const childMessageOrdinals = useRef(new Map<string, number>());
  const rootLatestThrough = useRef<number | undefined>(undefined);
  const childLatestThrough = useRef<number | undefined>(undefined);
  const rootMessageCursor = useRef<number | null>(null);
  const childMessageCursor = useRef<number | null>(null);
  const searchedMessage = useRef('');
  const inspectorVersion = useRef(0);
  const selectedChildRef = useRef<string | undefined>(undefined); selectedChildRef.current = selectedChildId;
  useEffect(() => { if (searchHit?.rootTaskId === rootTaskId) setSelectedChildId(searchHit.taskId === rootTaskId ? undefined : searchHit.taskId); }, [searchHit, rootTaskId]);
  useEffect(() => {
    if (!searchHit?.messageId || searchHit.ordinal === undefined || searchHit.rootTaskId !== rootTaskId) return;
    if (searchHit.taskId !== rootTaskId && childDetail?.run.taskId !== searchHit.taskId) return;
    const key = `${searchHit.taskId}:${searchHit.messageId}`;
    if (searchedMessage.current === key) return;
    searchedMessage.current = key;
    void api.invoke('task.messages', { taskId: searchHit.taskId, before: searchHit.ordinal + 1, limit: 50 }).then(page => {
      if (searchHit.taskId === rootTaskId) { setRootMessages(current => mergeTranscriptPage(current, page.items, rootMessageOrdinals.current)); if (rootMessageCursor.current === null) { rootMessageCursor.current = page.nextBefore; setRootNextBefore(page.nextBefore); } }
      else { setChildDetail(current => current?.run.taskId === searchHit.taskId ? { ...current, messages: mergeTranscriptPage(current.messages, page.items.map(item => ({ ...item, message: { ...item.message, truncated: Boolean(item.message.truncated) } })), childMessageOrdinals.current) } : current); if (childMessageCursor.current === null) { childMessageCursor.current = page.nextBefore; setChildNextBefore(page.nextBefore); } }
      requestAnimationFrame(() => document.querySelector(`[data-message-id="${searchHit.messageId}"]`)?.scrollIntoView({ block: 'center' }));
    }, error => { searchedMessage.current = ''; setNotice(`Could not open search result: ${errorMessage(error)}`); });
  }, [api, searchHit, rootTaskId, childDetail?.run.taskId, setNotice]);
  const compactLayout = useCompactLayout();
  useEffect(() => {
    if (!compactLayout) return;
    if (inspectorOpen) inspectorCloseRef.current?.focus();
    else if (inspectorWasOpen.current) inspectorToggleRef.current?.focus();
    inspectorWasOpen.current = inspectorOpen;
  }, [inspectorOpen, compactLayout]);

  const performFetchLatest = useCallback(async () => {
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
    } catch (error) { if (version === viewVersion.current) setViewError(errorMessage(error)); }
  }, [api, rootTaskId]);
  viewWorker.current = performFetchLatest;
  const fetchLatest = useCallback((): Promise<void> => {
    if (viewFlight.current) { viewDirty.current = true; return viewFlight.current; }
    const run = (async () => { do { viewDirty.current = false; await viewWorker.current(); } while (viewDirty.current); })();
    viewFlight.current = run;
    void run.finally(() => { if (viewFlight.current === run) viewFlight.current = null; });
    return run;
  }, []);

  const loadMoreAgents = useCallback(async () => {
    if (runsCursor === null) return;
    const version = ++viewVersion.current;
    try {
      const next = await api.invoke('orchestration.get', { rootTaskId, runsCursor });
      if (version !== viewVersion.current || rootRef.current !== rootTaskId) return;
      setRunsById((current) => { const merged = { ...current }; for (const run of next.runs) merged[run.taskId] = run; return merged; });
      setRunsCursor(next.runsCursor);
    } catch (error) { setNotice(`Could not load more agents: ${errorMessage(error)}`); }
  }, [api, rootTaskId, runsCursor, setNotice]);

  const loadOlderEvents = useCallback(async () => {
    if (eventsCursor === null) return;
    const version = ++viewVersion.current;
    try {
      const next = await api.invoke('orchestration.get', { rootTaskId, runsCursor: 0, eventsBefore: eventsCursor });
      if (version !== viewVersion.current || rootRef.current !== rootTaskId) return;
      setEventsById((current) => { const merged = { ...current }; for (const item of next.events) merged[item.sequence] = item; return merged; });
      setEventsCursor(next.eventsCursor);
    } catch (error) { setNotice(`Could not load older events: ${errorMessage(error)}`); }
  }, [api, rootTaskId, eventsCursor, setNotice]);

  const performLoadChild = useCallback(async (childTaskId: string) => {
    const version = ++childVersion.current;
    try {
      const [detail, page] = await Promise.all([api.invoke('orchestration.child', { rootTaskId, childTaskId }), api.invoke('task.messages', { taskId: childTaskId, limit: 50 })]);
      if (version === childVersion.current && selectedChildRef.current === childTaskId) {
        const sameChild = childLoadedId.current === childTaskId;
        if (!sameChild) childMessageOrdinals.current.clear();
        const previousThrough = childLatestThrough.current;
        const incoming = page.items.map(item => ({ ...item, message: { ...item.message, truncated: Boolean(item.message.truncated) } }));
        setChildDetail(current => {
          if (!sameChild || current?.run.taskId !== childTaskId) return { ...detail, messages: mergeTranscriptPage([], incoming, childMessageOrdinals.current) };
          return { ...detail, messages: mergeTranscriptPage(current.messages, incoming, childMessageOrdinals.current) };
        });
        childLoadedId.current = childTaskId;
        childMessageCursor.current = sameChild ? refreshedOlderCursor(previousThrough, childMessageCursor.current, page) : page.nextBefore;
        setChildNextBefore(childMessageCursor.current);
        childLatestThrough.current = page.through; setChildThrough(page.through);
      }
    } catch (error) { if (version === childVersion.current && selectedChildRef.current === childTaskId) setNotice(`Could not load agent detail: ${errorMessage(error)}`); }
  }, [api, rootTaskId, setNotice]);
  childWorker.current = performLoadChild;
  const loadChild = useCallback((childTaskId: string): Promise<void> => {
    childRequested.current = childTaskId;
    if (childFlight.current) { ++childVersion.current; childDirty.current = true; return childFlight.current; }
    const run = (async () => { do { childDirty.current = false; await childWorker.current(childRequested.current); } while (childDirty.current); })();
    childFlight.current = run;
    void run.finally(() => { if (childFlight.current === run) childFlight.current = null; });
    return run;
  }, []);

  const loadOlderChildMessages = async () => {
    if (!selectedChildId || childNextBefore === null) return;
    const transcript = document.querySelector<HTMLElement>('.child-panel .messages');
    const previousHeight = transcript?.scrollHeight ?? 0;
    try {
      const page = await api.invoke('task.messages', { taskId: selectedChildId, before: childNextBefore, through: childThrough, limit: 50 });
      setChildDetail(current => current?.run.taskId === selectedChildId ? { ...current, messages: mergeTranscriptPage(current.messages, page.items.map(item => ({ ...item, message: { ...item.message, truncated: Boolean(item.message.truncated) } })), childMessageOrdinals.current) } : current);
      if (childMessageCursor.current === childNextBefore) { childMessageCursor.current = page.nextBefore; setChildNextBefore(page.nextBefore); }
      requestAnimationFrame(() => { if (transcript) transcript.scrollTop += transcript.scrollHeight - previousHeight; });
    } catch (error) { setNotice(`Could not load older agent messages: ${errorMessage(error)}`); }
  };

  const performLoadApprovals = useCallback(async () => {
    const version = ++approvalsVersion.current;
    try {
      const rootPage = await api.invoke('task.approvals', { taskId: rootTaskId, limit: 50 });
      const rootReads = await Promise.all(rootPage.approvals.map(item => readApprovalEvidence(api, item.taskId, item.id)));
      const childIds = Object.values(runsById).filter((run) => run.role === 'child').map((run) => run.taskId);
      const childLists = await Promise.all(childIds.map(async (childTaskId) => {
        const summaries = await api.invoke('task.approvals', { taskId: childTaskId, limit: 50 });
        return [childTaskId, await Promise.all(summaries.approvals.map(item => readApprovalEvidence(api, item.taskId, item.id)))] as const;
      }));
      if (version !== approvalsVersion.current || rootRef.current !== rootTaskId) return;
      setRootApprovals(rootReads.map(read => read.approval));
      setChildApprovals(Object.fromEntries(childLists.map(([id, reads]) => [id, reads.map(read => read.approval)])));
      setIncompleteApprovalIds(new Set([...rootReads, ...childLists.flatMap(([, reads]) => reads)].filter(read => !read.complete).map(read => read.approval.id)));
    } catch (error) { if (version === approvalsVersion.current) setNotice(`Could not load approvals: ${errorMessage(error)}`); }
  }, [api, rootTaskId, runsById, setNotice]);
  approvalsWorker.current = performLoadApprovals;
  const loadApprovals = useCallback((): Promise<void> => {
    if (approvalsFlight.current) { ++approvalsVersion.current; approvalsDirty.current = true; return approvalsFlight.current; }
    const run = (async () => { do { approvalsDirty.current = false; await approvalsWorker.current(); } while (approvalsDirty.current); })();
    approvalsFlight.current = run;
    void run.finally(() => { if (approvalsFlight.current === run) approvalsFlight.current = null; });
    return run;
  }, []);

  const performLoadRootTranscript = useCallback(async () => {
    const version = ++transcriptVersion.current;
    try {
      const [page, usage] = await Promise.all([api.invoke('task.messages', { taskId: rootTaskId, limit: 50 }), api.invoke('task.usage', { taskId: rootTaskId })]);
      if (version !== transcriptVersion.current || rootRef.current !== rootTaskId) return;
      const sameTask = transcriptLoadedId.current === rootTaskId;
      if (!sameTask) rootMessageOrdinals.current.clear();
      const previousThrough = rootLatestThrough.current;
      setRootMessages(current => mergeTranscriptPage(sameTask ? current : [], page.items, rootMessageOrdinals.current));
      rootMessageCursor.current = sameTask ? refreshedOlderCursor(previousThrough, rootMessageCursor.current, page) : page.nextBefore;
      setRootNextBefore(rootMessageCursor.current);
      rootLatestThrough.current = page.through; setRootThrough(page.through);
      transcriptLoadedId.current = rootTaskId;
      setRootCompactions(usage.compactions);
    } catch (error) { if (version === transcriptVersion.current) setNotice(`Could not load coordinator conversation: ${errorMessage(error)}`); }
  }, [api, rootTaskId, setNotice]);
  transcriptWorker.current = performLoadRootTranscript;
  const loadRootTranscript = useCallback((): Promise<void> => {
    if (transcriptFlight.current) { ++transcriptVersion.current; transcriptDirty.current = true; return transcriptFlight.current; }
    const run = (async () => { do { transcriptDirty.current = false; await transcriptWorker.current(); } while (transcriptDirty.current); })();
    transcriptFlight.current = run;
    void run.finally(() => { if (transcriptFlight.current === run) transcriptFlight.current = null; });
    return run;
  }, []);

  const loadOlderRootMessages = async () => {
    if (rootNextBefore === null) return;
    const transcript = document.querySelector<HTMLElement>('.coordinator-detail .messages');
    const previousHeight = transcript?.scrollHeight ?? 0;
    try {
      const page = await api.invoke('task.messages', { taskId: rootTaskId, before: rootNextBefore, through: rootThrough, limit: 50 });
      setRootMessages(current => mergeTranscriptPage(current, page.items, rootMessageOrdinals.current));
      if (rootMessageCursor.current === rootNextBefore) { rootMessageCursor.current = page.nextBefore; setRootNextBefore(page.nextBefore); }
      requestAnimationFrame(() => { if (transcript) transcript.scrollTop += transcript.scrollHeight - previousHeight; });
    } catch (error) { setNotice(`Could not load older coordinator messages: ${errorMessage(error)}`); }
  };

  const refreshInspector = useCallback(async (path: string) => {
    const version = ++inspectorVersion.current;
    try {
      const [nextFiles, nextDiff] = await Promise.all([api.invoke('files.list', { taskId: rootTaskId, path }), api.invoke('task.diff', { taskId: rootTaskId })]);
      if (version === inspectorVersion.current && rootRef.current === rootTaskId) { setFiles(nextFiles); setDiff(nextDiff); }
    } catch (error) { if (version === inspectorVersion.current) setNotice(`Could not refresh inspector: ${errorMessage(error)}`); }
  }, [api, rootTaskId, setNotice]);

  useEffect(() => {
    setRunsById({}); setRunsCursor(null); setEventsById({}); setEventsCursor(null); setView(undefined);
    childLoadedId.current = ''; transcriptLoadedId.current = ''; childMessageOrdinals.current.clear(); rootMessageOrdinals.current.clear(); childLatestThrough.current = undefined; rootLatestThrough.current = undefined; childMessageCursor.current = null; rootMessageCursor.current = null;
    setSelectedChildId(undefined); setChildDetail(undefined); setRootApprovals([]); setChildApprovals({}); setRootMessages([]); setRootCompactions([]); setRootNextBefore(null); setRootThrough(undefined);
    setCurrentPath(''); setFiles([]); setFile(undefined); setDiff(undefined);
    void fetchLatest(); void refreshInspector(''); void loadRootTranscript();
  }, [rootTaskId, fetchLatest, refreshInspector, loadRootTranscript]);

  useEffect(() => { void fetchLatest(); }, [fetchLatest]);
  useEffect(() => { if (selectedChildId) void loadChild(selectedChildId); }, [selectedChildId, loadChild]);
  useEffect(() => { if (tab === 'approvals') void loadApprovals(); }, [tab, runsById, loadApprovals]);
  useEffect(() => {
    if (!focusAction || focusAction.taskId !== rootTaskId) return;
    setInspectorOpen(true);
    setTab(focusAction.kind === 'approval' ? 'approvals' : focusAction.kind === 'intent' ? 'orchestration' : 'activity');
  }, [focusAction, rootTaskId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'runtime.stopped' || event.type === 'task.progress') return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void fetchLatest();
        void loadRootTranscript();
        if (selectedChildRef.current) void loadChild(selectedChildRef.current);
        if (tab === 'approvals') void loadApprovals();
      }, 250);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [api, fetchLatest, loadRootTranscript, loadChild, loadApprovals, tab]);

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
  useEffect(() => {
    if (tab === 'approvals' && focusAction?.kind === 'approval') document.querySelector(`[data-approval-id="${focusAction.sourceId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [tab, focusAction, pendingApprovals]);

  const decideApproval = async (approval: Approval, decision: 'approve' | 'reject') => {
    if (approvalInFlight[approval.id]) return;
    setApprovalInFlight((current) => ({ ...current, [approval.id]: decision }));
    try {
      await api.invoke('orchestration.decide', { rootTaskId, taskId: approval.taskId, approvalId: approval.id, nonce: approval.nonce, assignmentId: approval.assignmentId ?? null, generation: approval.generation ?? 1, fingerprint: approval.fingerprint, decision });
      await fetchLatest(); await loadApprovals(); if (selectedChildId) await loadChild(selectedChildId);
      setApprovalErrors(({ [approval.id]: _previous, ...rest }) => rest);
      focusAfterDecision(approval.id);
    } catch (error) { setApprovalErrors(current => ({ ...current, [approval.id]: decisionFailure(decision, error) })); await loadApprovals().catch(() => undefined); }
    finally { setApprovalInFlight((current) => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };

  const sendToCoordinator = async (event: FormEvent) => {
    event.preventDefault(); if (!composer.trim() || task.status === 'retired' || coordinatorRun?.lifecycle === 'terminal') return;
    const content = composer.trim(); setComposer('');
    try { await api.invoke('task.send', { taskId: rootTaskId, content }); await fetchLatest(); await loadRootTranscript(); }
    catch (error) { setComposer(content); setNotice(`Message was not sent: ${errorMessage(error)}`); }
  };

  const reconcileApproval = async (approval: Approval) => {
    if (approvalInFlight[approval.id]) return;
    setApprovalInFlight(current => ({ ...current, [approval.id]: 'reconcile' }));
    try {
      const result = await api.invoke('approval.reconcile', { taskId: approval.taskId, approvalId: approval.id });
      setNotice(result.result?.content ?? `File outcome: ${result.state}`, 'info');
      await loadApprovals();
      await fetchLatest();
      setApprovalErrors(({ [approval.id]: _previous, ...rest }) => rest);
    } catch (error) { setApprovalErrors(current => ({ ...current, [approval.id]: decisionFailure('reconcile', error) })); await loadApprovals().catch(() => undefined); }
    finally { setApprovalInFlight(current => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };

  const refreshManagedTask = async () => {
    await fetchLatest(); await loadRootTranscript();
    if (selectedChildRef.current) await loadChild(selectedChildRef.current);
    onWorkspaceRefresh();
  };

  const cancelChild = async (run: AgentRun, key: string) => {
    setBusy(`cancel-${run.taskId}`);
    try { await api.invoke('orchestration.cancelChild', { rootTaskId, childTaskId: run.taskId, generation: run.generation }); await fetchLatest(); if (selectedChildId === run.taskId) await loadChild(run.taskId); }
    catch (error) { setNotice(`Could not cancel ${key}: ${errorMessage(error)}`); }
    finally { setBusy(undefined); }
  };

  const cancelRoot = async () => {
    setBusy('cancel-root');
    try { await api.invoke('orchestration.cancelRoot', { rootTaskId }); await fetchLatest(); onWorkspaceRefresh(); }
    catch (error) { setNotice(`Could not cancel the coordinated task: ${errorMessage(error)}`); }
    finally { setBusy(undefined); }
  };

  const startRevise = (assignment: Assignment) => { setReviseTarget(assignment.id); setReviseObjective(assignment.objective); setReviseAcceptance(assignment.acceptance.join('\n')); };
  const submitRevise = async (event: FormEvent) => {
    event.preventDefault(); if (!reviseTarget) return;
    const acceptance = reviseAcceptance.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!reviseObjective.trim() || !acceptance.length) { setNotice('An assignment revision needs an objective and at least one acceptance item.', 'warning'); return; }
    setBusy(`revise-${reviseTarget}`);
    try { await api.invoke('orchestration.reviseAssignment', { rootTaskId, assignmentId: reviseTarget, objective: reviseObjective.trim(), acceptance }); setReviseTarget(undefined); await fetchLatest(); }
    catch (error) { setNotice(`Could not revise this assignment: ${errorMessage(error)}`); }
    finally { setBusy(undefined); }
  };

  const checkOutcome = async (operation: IntegrationOperation) => {
    setOperationInFlight((current) => ({ ...current, [operation.id]: 'check' }));
    try { const result = await api.invoke('orchestration.reconcile', { rootTaskId, operationId: operation.id }); setNotice(`Reconciliation: ${result.kind} — ${result.detail}`, 'info'); await fetchLatest(); }
    catch (error) { setNotice(`Could not check this outcome: ${errorMessage(error)}`); }
    finally { setOperationInFlight((current) => { const next = { ...current }; delete next[operation.id]; return next; }); }
  };
  const prepareContinuation = async (operation: IntegrationOperation) => {
    setOperationInFlight((current) => ({ ...current, [operation.id]: 'continue' }));
    try { await api.invoke('orchestration.prepareContinue', { rootTaskId, operationId: operation.id }); setNotice('A continuation approval was prepared. Review it in Approvals.', 'info'); await fetchLatest(); }
    catch (error) { setNotice(`Could not prepare a continuation: ${errorMessage(error)}`); }
    finally { setOperationInFlight((current) => { const next = { ...current }; delete next[operation.id]; return next; }); }
  };

  const browseDirectory = (path: string) => { setCurrentPath(path); setFile(undefined); void refreshInspector(path); };
  const readFile = async (path: string) => {
    try { setFile(await api.invoke('files.read', { taskId: rootTaskId, path })); }
    catch (error) { setNotice(`Could not read file: ${errorMessage(error)}`); }
  };
  const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';

  const awaitingCount = pendingApprovals.filter(item => item.state === 'awaiting-approval').length;
  const waitingFor = (taskId: string) => pendingApprovals.filter(item => item.state === 'awaiting-approval' && item.taskId === taskId).length;
  const canSendToCoordinator = Boolean(composer.trim()) && task.status !== 'retired' && coordinatorRun?.lifecycle !== 'terminal';
  const approvalsLabel = approvalsTabLabel(awaitingCount, pendingApprovals.filter(item => item.state === 'unknown').length, awaitingCount > 0 && runsCursor !== null);
  const rootLifecycle = coordinatorRun?.lifecycle;
  const rootTerminal = rootLifecycle === 'terminal';
  const budget = view?.budget;
  const completion = view?.completion;

  return <>
    <section className="conversation orchestration-conversation" role="main" aria-label="Coordinated conversation">
      <header className="task-header orchestration-header">
        <div>
          <p className="eyebrow">{task.projectPath}</p>
          <h1>{task.title}</h1>
          {budget && <p className={`task-status orchestration-budget ${budget.warning ? 'warning' : ''} ${budget.overrun ? 'overrun' : ''}`}>
            charged {budget.charged.toLocaleString()} · in flight {budget.inFlight.toLocaleString()} · held {budget.unusedHolds.toLocaleString()} · unallocated {budget.unallocated.toLocaleString()} of {budget.cap.toLocaleString()}
            {budget.overrun && <span className="overrun-notice"> · budget overrun recorded</span>}
          </p>}
          {completion && <p className="task-status">{completion.complete ? `Completed on ${full(latestCombined?.head)}` : completion.completedAt ? `Completion recorded ${new Date(completion.completedAt).toLocaleString()}; current state unverified: ${completion.blockers[0] ?? 'no current verification available'}` : `Incomplete: ${completion.blockers[0] ?? 'no blockers reported yet'}`}</p>}
        </div>
        <div className="header-actions">{!rootTerminal && <button className="danger" disabled={busy === 'cancel-root'} onClick={() => void cancelRoot()}>{busy === 'cancel-root' ? 'Cancelling…' : 'Cancel coordinated task'}</button>}<button ref={inspectorToggleRef} type="button" className="secondary inspector-open" aria-controls="coordinated-inspector" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(true)}>Inspect task</button></div>
      </header>
      {notice}
      {viewError && <p className="muted inspector-empty">{viewError}</p>}
      <nav aria-label="Agent tree" className="agent-tree">
        <button type="button" className={`agent-row ${!selectedChildId ? 'selected' : ''}`} onClick={() => setSelectedChildId(undefined)}>
          <span className="agent-key" title="coordinator">Coordinator</span>
          <span className="agent-lifecycle">{coordinatorRun ? lifecycleLabel[coordinatorRun.lifecycle] : 'Loading…'}{coordinatorRun?.lifecycle === 'waiting' && coordinatorRun.waitReason ? ` · ${waitReasonLabel[coordinatorRun.waitReason]}` : ''}{coordinatorRun?.outcome ? ` · ${outcomeLabel[coordinatorRun.outcome]}` : ''}</span>{waitingFor(rootTaskId) > 0 && <span className="agent-pending">{waitingFor(rootTaskId)} awaiting approval</span>}
        </button>
        {childRuns.map((run) => {
          const assignment = run.assignmentId ? assignmentById[run.assignmentId] : undefined;
          const key = assignment?.key ?? run.title;
          return <button type="button" key={run.taskId} className={`agent-row ${selectedChildId === run.taskId ? 'selected' : ''}`} onClick={() => setSelectedChildId(run.taskId)}>
            <span className="agent-key" title={`${key} · ${run.title}`}>{key} · {run.title}</span>
            <span className="agent-lifecycle">{lifecycleLabel[run.lifecycle]}{run.lifecycle === 'waiting' && run.waitReason ? ` · ${waitReasonLabel[run.waitReason]}` : ''}{run.outcome ? ` · ${outcomeLabel[run.outcome]}` : ''}</span>{waitingFor(run.taskId) > 0 && <span className="agent-pending">{waitingFor(run.taskId)} awaiting approval</span>}
          </button>;
        })}
        {runsCursor !== null && <button type="button" className="quiet" onClick={() => void loadMoreAgents()}>Load more agents</button>}
      </nav>
      <div className={`agent-detail ${selectedChildId ? '' : 'coordinator-detail'}`}>
        {!selectedChildId ? <>
          <Transcript messages={rootMessages} compactions={rootCompactions} ordinals={rootMessageOrdinals.current} api={api} taskId={rootTaskId} empty={<div className="empty-state"><h2>Coordinator conversation</h2><p>Messages to the coordinator and its replies will appear here.</p></div>} />
          {rootNextBefore !== null && <button type="button" className="quiet older-messages" onClick={() => void loadOlderRootMessages()}>Load older coordinator messages</button>}
          {awaitingCount > 0 && !(tab === 'approvals' && (!compactLayout || inspectorOpen)) && <div className="approval-banner"><p>{awaitingCount > 1 ? `${awaitingCount}${runsCursor !== null ? '+' : ''} actions are waiting for your decision.` : 'An action is waiting for your decision.'}</p><button type="button" className="secondary" onClick={() => { setTab('approvals'); setInspectorOpen(true); }}>Review pending actions</button></div>}
          <form className="composer" onSubmit={sendToCoordinator}>
            <textarea value={composer} onChange={(e) => setComposer(e.target.value)} onKeyDown={sendOnShortcut(canSendToCoordinator)} disabled={task.status === 'retired' || rootTerminal} aria-label="Message coordinator" aria-describedby={rootTerminal ? 'coordinator-finished' : undefined}
              placeholder={task.status === 'retired' ? 'This task worktree is retired.' : rootTerminal ? 'This coordinated task has finished.' : 'Message the coordinator…'} />
            <button className="primary" disabled={!canSendToCoordinator} aria-keyshortcuts="Control+Enter" title="Send (Ctrl+Enter)">Send<span className="shortcut-hint" aria-hidden="true">Ctrl+Enter</span></button>
            {rootTerminal && task.status !== 'retired' && <p id="coordinator-finished" className="composer-note">The coordinator has finished, so it accepts no more messages. Start a continuation from the Continue tab to keep working.</p>}
          </form>
        </> : <div className="child-panel">
          <p className="child-note">Assignments define child scope. The project channel shares coordination messages without changing that scope.</p>
          <Transcript messages={childDetail?.messages ?? []} ordinals={childMessageOrdinals.current} api={api} taskId={selectedChildId} userLabel="Coordinator assignment" empty={<p className="muted">No child messages yet.</p>} />
          {childNextBefore !== null && <button type="button" className="quiet" onClick={() => void loadOlderChildMessages()}>Load older agent messages</button>}
          {childDetail?.assignment && <div className="assignment-summary">
            <dl><dt>Objective</dt><dd>{childDetail.assignment.objective}</dd></dl>
            <dl><dt>Acceptance</dt><dd><ul>{childDetail.assignment.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></dl>
            <dl><dt>Read scope</dt><dd>{childDetail.assignment.readPaths.join(', ') || 'none'}</dd></dl>
            <dl><dt>Write scope</dt><dd>{childDetail.assignment.writePaths.join(', ') || 'none'}</dd></dl>
            <dl><dt>Validation command</dt><dd>{childDetail.assignment.validation?.command ?? 'none'}</dd></dl>
            <dl><dt>Base commit</dt><dd><Hash value={childDetail.assignment.baseCommit} /></dd></dl>
            <dl><dt>Revision</dt><dd>{childDetail.assignment.revision}</dd></dl>
            <dl><dt>Allocation / charged</dt><dd>{childDetail.assignment.allocation.toLocaleString()} / {(budget?.runs.find((item) => item.taskId === selectedChildId)?.charged ?? 0).toLocaleString()}</dd></dl>
          </div>}
          {childDetail && childDetail.results.length > 0 && <div className="assignment-summary">
            <strong>Results</strong>
            {childDetail.results.map((result) => <dl key={result.id}><dt>Commit / tree</dt><dd><Hash value={result.commit} /> / <Hash value={result.tree} /></dd></dl>)}
          </div>}
          {childDetail && childDetail.run.lifecycle !== 'terminal' && <button type="button" className="danger" disabled={busy === `cancel-${childDetail.run.taskId}`} onClick={() => void cancelChild(childDetail.run, childDetail.assignment?.key ?? childDetail.run.title)}>
            {busy === `cancel-${childDetail.run.taskId}` ? 'Cancelling…' : `Cancel child ${childDetail.assignment?.key ?? childDetail.run.title}`}
          </button>}
        </div>}
      </div>
    </section>
    <aside className={`inspector ${inspectorOpen ? 'open' : ''}`} id="coordinated-inspector" aria-label="Coordinated task inspector" role={compactLayout && inspectorOpen ? 'dialog' : undefined} aria-modal={compactLayout && inspectorOpen ? true : undefined} onKeyDown={event => { if (event.key === 'Escape') setInspectorOpen(false); }}>
      <button ref={inspectorCloseRef} type="button" className="secondary inspector-close" onClick={() => setInspectorOpen(false)}>Close inspector</button>
      <div className="inspector-tabs" role="group" aria-label="Inspector sections">
        <button type="button" className={tab === 'files' ? 'active' : ''} aria-pressed={tab === 'files'} onClick={() => setTab('files')}>Files</button>
        <button type="button" className={tab === 'changes' ? 'active' : ''} aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>Changes</button>
        <button type="button" className={tab === 'approvals' ? 'active' : ''} aria-pressed={tab === 'approvals'} onClick={() => setTab('approvals')}>{approvalsLabel}</button>
        <button type="button" className={tab === 'orchestration' ? 'active' : ''} aria-pressed={tab === 'orchestration'} onClick={() => setTab('orchestration')}>Orchestration</button>
        <button type="button" className={tab === 'activity' ? 'active' : ''} aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Activity</button>
        <button type="button" className={tab === 'continuity' ? 'active' : ''} aria-pressed={tab === 'continuity'} onClick={() => setTab('continuity')}>Continue</button>
        <button type="button" className={tab === 'usage' ? 'active' : ''} aria-pressed={tab === 'usage'} onClick={() => setTab('usage')}>Usage</button>
        <button type="button" className={tab === 'handoff' ? 'active' : ''} aria-pressed={tab === 'handoff'} onClick={() => setTab('handoff')}>Handoff</button>
      </div>
      <button type="button" className={`channel-tab ${tab === 'channel' ? 'active' : ''}`} aria-pressed={tab === 'channel'} onClick={() => setTab('channel')}>Project channel</button>
      {tab === 'handoff' ? <CoordinatedHandoffPanel key={rootTaskId} api={api} rootTaskId={rootTaskId} /> : tab === 'usage' ? <CoordinatedTaskControls key={selectedChildId ?? rootTaskId} api={api} rootTaskId={rootTaskId} taskId={selectedChildId ?? rootTaskId} label={selectedChildId ? 'Child' : 'Coordinator'} active={(selectedChildId ? runsById[selectedChildId]?.lifecycle : coordinatorRun?.lifecycle) === 'running' || (selectedChildId ? runsById[selectedChildId]?.lifecycle : coordinatorRun?.lifecycle) === 'preparing'} retired={task.status === 'retired'} retirementReady={rootTerminal && childRuns.every(run => run.lifecycle === 'terminal')} refreshToken={eventsSorted[0]?.sequence ?? 0} onRefresh={refreshManagedTask} setNotice={setNotice} /> : tab === 'channel' ? <AgentChannelPanel key={selectedChildId ?? rootTaskId} api={api} taskId={selectedChildId ?? rootTaskId} /> : tab === 'activity' ? <TaskActivity api={api} taskId={rootTaskId} refreshToken={eventsSorted[0]?.sequence ?? 0} unknownOutcomes={(view?.integrations ?? []).filter(item => item.state === 'unknown').length} /> : tab === 'continuity' ? <ContinuityPanel api={api} taskId={rootTaskId} messages={rootMessages} profiles={profiles} setNotice={setNotice} onCreated={onTaskCreated} /> : tab === 'files' ? <>
        <div className="inspector-tools"><button type="button" onClick={() => browseDirectory('')} disabled={!currentPath}>Root</button><span title={currentPath || 'Repository root'}>{currentPath || 'Repository root'}</span><button type="button" onClick={() => void refreshInspector(currentPath)}>Refresh</button></div>
        <div className="file-tree">
          {currentPath && <button type="button" className="up-directory" onClick={() => browseDirectory(parentPath)}><span>←</span>Up</button>}
          {files.map((entry) => <button key={entry.path} type="button" className={file?.path === entry.path ? 'active-file' : ''} onClick={() => entry.kind === 'directory' ? browseDirectory(entry.path) : void readFile(entry.path)}><span>{entry.kind === 'directory' ? '▸' : '·'}</span>{entry.path}</button>)}
          {!files.length && <p className="muted">No files here.</p>}
        </div>
        <div className="file-content"><p>{file?.path ?? 'Choose a file to read'}</p><pre>{file?.content}</pre></div>
      </> : tab === 'changes' ? <div className="patch"><p>{diff?.summary ?? 'Loading changes…'}{diff?.truncated ? ' (truncated)' : ''}</p>{diff && <PatchText patch={diff.patch} />}</div>
        : tab === 'approvals' ? <div className="approvals-panel">
          {pendingApprovals.map((approval) => <ApprovalCard key={approval.id} variant="coordinated" approval={approval} complete={!incompleteApprovalIds.has(approval.id)} busy={approvalInFlight[approval.id]} error={approvalErrors[approval.id]} onDecide={decideApproval} onReconcile={reconcileApproval} />)}
          {!pendingApprovals.length && <p className="muted inspector-empty">No reviewed actions are queued.</p>}
        </div> : <div className="orchestration-panel">
          <section><h3>Dependency map</h3><AssignmentGraph assignments={view?.assignments ?? []} /></section>
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
                <dl><dt>Commit / tree</dt><dd><Hash value={result.commit} /> / <Hash value={result.tree} /></dd></dl>
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
              <dl><dt>Source SHA</dt><dd><Hash value={operation.sourceSha} /></dd></dl>
              <dl><dt>Observed</dt><dd>{operation.observed?.commit ? `commit ${full(operation.observed.commit)}` : operation.observed?.unmergedPaths?.length ? `conflict: ${operation.observed.unmergedPaths.join(', ')}` : operation.observed?.detail ?? 'none'}</dd></dl>
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
              <div className="approval-heading"><strong>{item.passed ? 'Passed' : 'Did not pass'}</strong><span><Hash value={item.head} /></span></div>
              <dl><dt>Tree</dt><dd><Hash value={item.tree} /></dd></dl>
              <dl><dt>Command</dt><dd><pre>{item.command}</pre></dd></dl>
            </article>)}
            {!combinedEvidence.length && <p className="muted">No combined validation evidence yet.</p>}
          </section>
          <section><h3>Events</h3>
            <ul className="event-list">{eventsSorted.map((item) => <li key={item.sequence}><time dateTime={item.createdAt} title={item.createdAt}>{formatDateTime(item.createdAt)}</time> · {humanize(item.type)}</li>)}</ul>
            {eventsCursor !== null && <button type="button" className="quiet" onClick={() => void loadOlderEvents()}>Older events</button>}
          </section>
          {view?.truncated && <p className="muted">(truncated)</p>}
        </div>}
    </aside>
  </>;
}
