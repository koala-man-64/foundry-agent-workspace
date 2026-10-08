import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Approval, DesktopApi, DiffResult, FileContent, FileEntry, McpServerStatus, McpStatusPage, ModelProfile, ProbeResult, Project, SchemaStatus, Snapshot, TaskDetail, TaskStatus, UsageReport } from '../../../../packages/protocol/src/index';
import { ORCHESTRATION_LIMITS, supportedEfforts } from '../../../../packages/protocol/src/limits';
import { CoordinatedTaskView } from './Orchestration';
import { AgentChannelPanel } from './AgentChannel';
import { McpSettings } from './McpSettings';
import { UsageView } from './Usage';
import { ProjectSidebar } from './ProjectSidebar';

import { BrowserPanel } from './BrowserPanel';
import { Transcript } from './Transcript';
import { WorkspaceNavigation } from './WorkspaceNavigation';
import { TaskActivity } from './TaskActivity';
import { UsageChart } from './UsageChart';
import { AutomationSettings } from './AutomationSettings';
import type { AutomationDraft } from '../../../../packages/protocol/src/automation';
import { TemplatePicker } from './TemplatePicker';
import { ContinuityPanel } from './ContinuityPanel';
import { readApprovalEvidence } from './ApprovalEvidence';
import { mergeTranscriptPage, refreshedOlderCursor } from './transcriptHistory';
import type { ActionItem, CompactionSummary, SearchHit, WorkspaceSummary } from '../../../../packages/protocol/src/workspace';

declare global { interface Window { workspace: DesktopApi; } }

const OFFLINE_PROFILE: ModelProfile = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'local demo',
  contextLimit: 128000, outputLimit: 8192
};

const statusLabel: Record<TaskStatus, string> = { idle: 'Ready', running: 'Working', cancelled: 'Cancelled', interrupted: 'Interrupted', failed: 'Needs attention', retired: 'Retired' };
const emptySnapshot: Snapshot = { tasks: [], profiles: [], projects: [], preferences: { profileId: OFFLINE_PROFILE.id, mode: 'chat', collapsedProjectIds: [] }, lastSequence: 0, runtime: 'ready' };
type Mode = 'chat' | 'coding' | 'coordinated';
interface StartPayload { requestId: string; projectId: string | null; content: string; title?: string; profileId: string; mode: Mode; tokenBudget: number; coordination?: { childProfileIds: string[]; requiredValidation: { command: string; cwd: string; timeoutMs: number } }; }
interface Draft { content: string; title: string; requiredValidationCommand: string; tokenBudget: number; coordinatedBudget: number; childProfileIds: string[]; scopeGuidance: string[]; startPayload?: StartPayload; pending?: boolean; unknown?: boolean; }
const blankDraft = (): Draft => ({ content: '', title: '', requiredValidationCommand: '', tokenBudget: 100000, coordinatedBudget: 600000, childProfileIds: [], scopeGuidance: [] });
const draftKey = (projectId: string | null) => projectId ?? 'none';

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, key);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function payloadNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, key);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function App() {
  const api = window.workspace;
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [page, setPage] = useState<'conversation' | 'usage'>('conversation');
  const [sidebarView, setSidebarView] = useState<'workspace' | 'projects'>('workspace');
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [detail, setDetail] = useState<TaskDetail>();
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [unknownOutcomes, setUnknownOutcomes] = useState(0);
  const [messageNextBefore, setMessageNextBefore] = useState<number | null>(null);
  const [messageThrough, setMessageThrough] = useState<number>();
  const [approvalNextBefore, setApprovalNextBefore] = useState<number | null>(null);
  const [incompleteApprovalIds, setIncompleteApprovalIds] = useState<Set<string>>(new Set());
  const [usage, setUsage] = useState<UsageReport>();
  const [compactions, setCompactions] = useState<CompactionSummary[]>([]);
  const [profileId, setProfileId] = useState(OFFLINE_PROFILE.id);
  const [taskMode, setTaskMode] = useState<Mode>('chat');
  const [draftProjectId, setDraftProjectId] = useState<string | null | undefined>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({ none: blankDraft() });
  const [moreOptions, setMoreOptions] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const manageDialogRef = useRef<HTMLDialogElement>(null);
  const [schema, setSchema] = useState<SchemaStatus>();
  const [composer, setComposer] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent>();
  const [diff, setDiff] = useState<DiffResult>();
  const [currentPath, setCurrentPath] = useState('');
  const [rightTab, setRightTab] = useState<'files' | 'changes' | 'approvals' | 'usage' | 'activity' | 'continuity' | 'publish' | 'channel' | 'browser'>('files');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [inspectorDragging, setInspectorDragging] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [appDialogOpen, setAppDialogOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ModelProfile>(OFFLINE_PROFILE);
  const [credential, setCredential] = useState('');
  const [probe, setProbe] = useState<ProbeResult>();
  const [approvalInFlight, setApprovalInFlight] = useState<Record<string, 'approve' | 'reject' | 'reconcile' | 'acknowledge'>>({});
  const [upgrading, setUpgrading] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [pushRemote, setPushRemote] = useState('origin');
  const [publishBusy, setPublishBusy] = useState<'commit' | 'push' | 'retire' | 'reconcile' | undefined>();
  const [confirmAction, setConfirmAction] = useState<'push' | 'retire' | undefined>();
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [focusAction, setFocusAction] = useState<ActionItem>();
  const [searchHit, setSearchHit] = useState<SearchHit>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const automationDialogRef = useRef<HTMLDialogElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const inspectorWasOpen = useRef(false);
  const upgradeDialogRef = useRef<HTMLDialogElement>(null);
  const fileVersion = useRef(0);
  const inspectorVersion = useRef(0);
  const inspectorLoadedTask = useRef<string | undefined>(undefined);
  const detailVersion = useRef(0);
  const detailLoadedTask = useRef<string | undefined>(undefined);
  const detailFlight = useRef<Promise<void> | null>(null);
  const detailDirty = useRef(false);
  const detailRequestedTask = useRef<string | undefined>(undefined);
  const detailWorker = useRef<(taskId: string) => Promise<void>>(async () => undefined);
  const olderMessagesActive = useRef(false);
  const messageOrdinals = useRef(new Map<string, number>());
  const latestMessageThrough = useRef<number | undefined>(undefined);
  const messageCursor = useRef<number | null>(null);
  const snapshotVersion = useRef(0);
  const snapshotFlight = useRef<Promise<void> | null>(null);
  const snapshotDirty = useRef(false);
  const snapshotSelection = useRef<string | undefined>(undefined);
  const snapshotWorker = useRef<(selection?: string) => Promise<void>>(async () => undefined);
  const approvalFlight = useRef<Promise<void> | null>(null);
  const approvalDirty = useRef(false);
  const approvalRequestedTask = useRef<string | undefined>(undefined);
  const approvalWorker = useRef<(taskId: string) => Promise<void>>(async () => undefined);
  const approvalLoadedTask = useRef<string | undefined>(undefined);
  const olderApprovalsActive = useRef(false);
  const mcpVersion = useRef(0);
  const profilesVersion = useRef(0);
  const profilesStarted = useRef(false);
  const projectsStarted = useRef(false);
  const projectsVersion = useRef(0);
  const preferencesLoaded = useRef(false);
  const preferencesTouched = useRef(false);
  const selectionVersion = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  const draftProjectRef = useRef<string | null | undefined>(null);
  const currentPathRef = useRef('');
  const sequenceRef = useRef(0);
  const eventSequenceRef = useRef(0);
  const retriedSequenceRef = useRef(0);

  useEffect(() => {
    if (!window.matchMedia('(max-width: 880px)').matches) return;
    if (inspectorOpen) inspectorCloseRef.current?.focus();
    else if (inspectorWasOpen.current) inspectorToggleRef.current?.focus();
    inspectorWasOpen.current = inspectorOpen;
  }, [inspectorOpen]);
  selectedRef.current = selectedId;
  draftProjectRef.current = draftProjectId;
  currentPathRef.current = currentPath;

  const profiles = snapshot.profiles.length ? snapshot.profiles : [OFFLINE_PROFILE];
  const projects = snapshot.projects ?? [];
  const activeProject = projects.find((project) => project.id === draftProjectId);
  const draft = drafts[draftKey(draftProjectId ?? null)] ?? blankDraft();
  const isDraft = draftProjectId !== undefined;
  const draftDisplayProfileId = draft.unknown && draft.startPayload ? draft.startPayload.profileId : profileId;
  const draftDisplayMode = draft.unknown && draft.startPayload ? draft.startPayload.mode : activeProject?.kind === 'git' ? taskMode : 'chat';
  const selectedTask = detail && detail.task.id === selectedId ? detail.task : snapshot.tasks.find((task) => task.id === selectedId);
  const workspaceKind = selectedTask?.workspaceKind ?? 'git';
  const effectiveRightTab = (workspaceKind === 'git' || ['usage', 'browser', 'approvals', 'activity', 'continuity'].includes(rightTab) || (workspaceKind === 'folder' && rightTab === 'files')) ? rightTab : 'usage';
  const configuredProfile = profiles.find((profile) => profile.id === profileId);
  const taskProfile = selectedTask ? profiles.find((profile) => profile.id === selectedTask.profileId) : undefined;
  const isProfileReady = (profile: ModelProfile): boolean => profile.apiKind === 'fake' || Boolean(profile.verifiedAt && profile.capabilities?.tools && profile.capabilities?.continuation);
  const codingReady = Boolean(configuredProfile && isProfileReady(configuredProfile));
  const coordinatedAvailable = Boolean(schema?.coordinatedAvailable);
  const coordinatedReady = coordinatedAvailable && codingReady;
  const availableChildProfiles = profiles.filter((profile) => profile.id !== profileId && isProfileReady(profile));
  const taskModeLabel = (selectedTask?.mode ?? 'chat') === 'coding' ? 'Coding with reviewed tools' : (selectedTask?.mode ?? 'chat') === 'coordinated' ? 'Coordinated' : 'Chat';
  const awaitingApproval = pendingApprovalCount > 0 || (detail?.approvals?.some((approval) => approval.state === 'awaiting-approval') ?? false);
  const isBuiltinProfile = profileDraft.id === OFFLINE_PROFILE.id;
  const taskRetired = selectedTask?.status === 'retired';
  const taskBusy = selectedTask?.status === 'running';

  const performTaskDetail = useCallback(async (taskId: string) => {
    const version = ++detailVersion.current;
    try {
      const [read, page, nextUsage] = await Promise.all([
        api.invoke('task.read', { taskId }), api.invoke('task.messages', { taskId, limit: 50 }),
        api.invoke('task.usage', { taskId }).catch(() => undefined)
      ]);
      if (version === detailVersion.current && selectedRef.current === taskId) {
        const sameTask = detailLoadedTask.current === taskId;
        if (!sameTask) messageOrdinals.current.clear();
        const previousThrough = latestMessageThrough.current;
        setDetail(current => {
          if (!sameTask || current?.task.id !== taskId) return { task: read.task, messages: mergeTranscriptPage([], page.items, messageOrdinals.current), approvals: [], hasUnknownPublication: read.unknownOutcomes > 0 };
          return { ...current, task: read.task, messages: mergeTranscriptPage(current.messages, page.items, messageOrdinals.current), hasUnknownPublication: read.unknownOutcomes > 0 };
        });
        detailLoadedTask.current = taskId;
        setCompactions(nextUsage?.compactions ?? []);
        messageCursor.current = sameTask ? refreshedOlderCursor(previousThrough, messageCursor.current, page) : page.nextBefore;
        setMessageNextBefore(messageCursor.current);
        latestMessageThrough.current = page.through;
        setMessageThrough(page.through);
        setUsage(nextUsage); setPendingApprovalCount(read.pendingApprovals); setUnknownOutcomes(read.unknownOutcomes);
      }
    } catch (error) {
      if (version === detailVersion.current && selectedRef.current === taskId) setNotice(`Could not load task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);
  detailWorker.current = performTaskDetail;
  const loadTaskDetail = useCallback((taskId: string): Promise<void> => {
    detailRequestedTask.current = taskId;
    if (detailFlight.current) { ++detailVersion.current; detailDirty.current = true; return detailFlight.current; }
    const run = (async () => {
      do {
        detailDirty.current = false;
        await detailWorker.current(detailRequestedTask.current!);
      } while (detailDirty.current);
    })();
    detailFlight.current = run;
    void run.finally(() => { if (detailFlight.current === run) detailFlight.current = null; });
    return run;
  }, []);

  const loadOlderMessages = async () => {
    if (!selectedId || messageNextBefore === null || olderMessagesActive.current) return;
    olderMessagesActive.current = true;
    const transcript = document.querySelector<HTMLElement>('.messages');
    const previousHeight = transcript?.scrollHeight ?? 0;
    try {
      const page = await api.invoke('task.messages', { taskId: selectedId, before: messageNextBefore, through: messageThrough, limit: 50 });
      setDetail(current => {
        if (current?.task.id !== selectedId) return current;
        return { ...current, messages: mergeTranscriptPage(current.messages, page.items, messageOrdinals.current) };
      });
      if (messageCursor.current === messageNextBefore) { messageCursor.current = page.nextBefore; setMessageNextBefore(page.nextBefore); }
      requestAnimationFrame(() => { if (transcript) transcript.scrollTop += transcript.scrollHeight - previousHeight; });
    } catch (error) { setNotice(`Could not load older messages: ${error instanceof Error ? error.message : String(error)}`); }
    finally { olderMessagesActive.current = false; }
  };

  const fetchApprovals = useCallback(async (taskId: string, before?: number) => {
    try {
      const page = await api.invoke('task.approvals', { taskId, limit: 20, ...(before !== undefined ? { before } : {}) });
      const reads = await Promise.all(page.approvals.map(item => readApprovalEvidence(api, item.taskId, item.id)));
      if (selectedRef.current !== taskId) return;
      const sameTask = approvalLoadedTask.current === taskId;
      setIncompleteApprovalIds(current => { const next = sameTask ? new Set(current) : new Set<string>(); for (const read of reads) { if (read.complete) next.delete(read.approval.id); else next.add(read.approval.id); } return next; });
      setDetail(current => {
        if (current?.task.id !== taskId) return current;
        const incoming = reads.map(read => read.approval);
        const ids = new Set(incoming.map(item => item.id));
        return { ...current, approvals: sameTask ? (before === undefined ? [...incoming, ...(current.approvals ?? []).filter(item => !ids.has(item.id))] : [...(current.approvals ?? []).filter(item => !ids.has(item.id)), ...incoming]) : incoming };
      });
      approvalLoadedTask.current = taskId;
      if (reads.some(read => !read.complete)) setNotice('Some approval evidence could not be loaded. Approval is disabled until the full evidence is available. Retry by reopening Approvals.');
      if (before !== undefined || !sameTask) setApprovalNextBefore(page.nextBefore);
    } catch (error) { setNotice(`Could not load approvals: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api]);
  approvalWorker.current = taskId => fetchApprovals(taskId);
  const loadApprovals = useCallback((taskId: string, before?: number): Promise<void> => {
    if (before !== undefined) {
      if (olderApprovalsActive.current) return Promise.resolve();
      olderApprovalsActive.current = true;
      return fetchApprovals(taskId, before).finally(() => { olderApprovalsActive.current = false; });
    }
    approvalRequestedTask.current = taskId;
    if (approvalFlight.current) { approvalDirty.current = true; return approvalFlight.current; }
    const run = (async () => {
      do {
        approvalDirty.current = false;
        await approvalWorker.current(approvalRequestedTask.current!);
      } while (approvalDirty.current);
    })();
    approvalFlight.current = run;
    void run.finally(() => { if (approvalFlight.current === run) approvalFlight.current = null; });
    return run;
  }, [fetchApprovals]);

  useEffect(() => { if (selectedId && rightTab === 'approvals') void loadApprovals(selectedId); }, [selectedId, rightTab, loadApprovals]);
  useEffect(() => {
    if (focusAction?.kind !== 'approval' || !selectedId || focusAction.taskId !== selectedId || detail?.task.id !== selectedId || detail.task.mode === 'coordinated') return;
    void readApprovalEvidence(api, focusAction.sourceTaskId ?? selectedId, focusAction.sourceId).then(read => {
      const approval = read.approval;
      setIncompleteApprovalIds(current => { const next = new Set(current); if (read.complete) next.delete(approval.id); else next.add(approval.id); return next; });
      setDetail(current => current?.task.id === selectedId ? { ...current, approvals: [approval, ...(current.approvals ?? []).filter(item => item.id !== approval.id)] } : current);
    }, error => setNotice(`Could not open approval: ${error instanceof Error ? error.message : String(error)}`));
  }, [api, focusAction, selectedId, detail?.task.id]);
  useEffect(() => {
    if (rightTab === 'approvals' && focusAction?.kind === 'approval' && detail?.approvals?.some(item => item.id === focusAction.sourceId)) document.querySelector(`[data-approval-id="${focusAction.sourceId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [rightTab, focusAction, detail?.approvals]);

  const loadFiles = useCallback(async (taskId: string, path: string) => {
    const version = ++inspectorVersion.current;
    try {
      const nextFiles = await api.invoke('files.list', { taskId, path });
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) setFiles(nextFiles);
    } catch (error) {
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) setNotice(`Could not load files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);

  const refreshInspector = useCallback(async (taskId: string, path: string, kind: 'git' | 'folder' | 'none') => {
    const version = ++inspectorVersion.current;
    if (kind === 'none') { setFiles([]); setDiff(undefined); return; }
    try {
      const nextFiles = await api.invoke('files.list', { taskId, path });
      const nextDiff = kind === 'git' ? await api.invoke('task.diff', { taskId }) : undefined;
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) {
        setFiles(nextFiles);
        setDiff(nextDiff);
      }
    } catch (error) {
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) setNotice(`Could not refresh inspector: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);

  const loadMcp = useCallback(async () => {
    const version = ++mcpVersion.current;
    try {
      const collected: McpServerStatus[] = [];
      let after: string | null = null;
      do {
        const page: McpStatusPage = await api.invoke('mcp.list', { limit: 10, ...(after ? { after } : {}) });
        collected.push(...page.items);
        if (page.nextCursor !== null && page.nextCursor === after) throw new Error('MCP status paging did not advance.');
        after = page.nextCursor;
      } while (after);
      if (version !== mcpVersion.current) return;
      setMcpServers(collected);
    } catch (error) { if (version === mcpVersion.current) setNotice(`Could not load MCP servers: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api]);

  const loadProfiles = useCallback(async (first?: WorkspaceSummary) => {
    const version = ++profilesVersion.current;
    profilesStarted.current = true;
    setProfilesLoading(true);
    try {
      const initial = first ?? await api.invoke('workspace.summary', {});
      const collected = [...initial.profiles];
      let after = initial.nextProfileAfter;
      while (after) {
        const page = await api.invoke('workspace.profiles', { after, limit: 50 });
        collected.push(...page.profiles);
        if (page.nextAfter === after) throw new Error('Profile paging did not advance.');
        after = page.nextAfter;
      }
      if (version !== profilesVersion.current) return;
      setSnapshot(current => ({ ...current, profiles: collected }));
      setProfilesError('');
    } catch (error) {
      if (version === profilesVersion.current) setProfilesError(error instanceof Error ? error.message : String(error));
    } finally { if (version === profilesVersion.current) setProfilesLoading(false); }
  }, [api]);

  const performRefresh = useCallback(async (selection = selectedRef.current) => {
    const version = ++snapshotVersion.current;
    try {
      const [fresh, nextSchema, taskPage] = await Promise.all([
        api.invoke('workspace.summary', {}), api.invoke('workspace.schema', {}),
        api.invoke('workspace.tasks', { visibility: 'active', sort: 'recent', limit: 50 })
      ]);
      if (version !== snapshotVersion.current) return;
      sequenceRef.current = fresh.lastSequence;
      setSnapshot(current => ({ ...fresh, tasks: taskPage.tasks, profiles: current.profiles.length ? current.profiles : fresh.profiles, projects: projectsStarted.current && current.projects.length ? current.projects : fresh.projects }));
      if (!profilesStarted.current) void loadProfiles(fresh);
      if (!projectsStarted.current) {
        projectsStarted.current = true;
        const projectVersion = ++projectsVersion.current;
        void (async () => {
          try {
            const collected = [...fresh.projects];
            let after = fresh.nextProjectAfter;
            while (after) {
              const page = await api.invoke('workspace.projects', { after, limit: 50 });
              collected.push(...page.projects);
              after = page.nextAfter;
            }
            if (projectVersion === projectsVersion.current) setSnapshot(current => ({ ...current, projects: collected }));
          } catch (error) {
            projectsStarted.current = false;
            setNotice(`Could not load saved projects: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      }
      setNavigationVersion(current => current + 1);
      setSchema(nextSchema);
      if (!preferencesLoaded.current && fresh.preferences) {
        preferencesLoaded.current = true;
        if (!preferencesTouched.current) { setProfileId(fresh.preferences.profileId); setTaskMode(fresh.preferences.mode); }
        setCollapsedProjectIds(fresh.preferences.collapsedProjectIds);
      }
      if (selection && selection === selectedRef.current) {
        void loadTaskDetail(selection);
        if (rightTab === 'approvals') void loadApprovals(selection);
      }
      if (fresh.lastSequence < eventSequenceRef.current && retriedSequenceRef.current < eventSequenceRef.current) {
        retriedSequenceRef.current = eventSequenceRef.current;
        snapshotDirty.current = true;
      }
    } catch (error) { setNotice(`Could not refresh workspace: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, loadTaskDetail, loadApprovals, loadProfiles, rightTab]);
  const loadProjects = useCallback(async () => {
    const version = ++projectsVersion.current;
    try {
      const collected: Project[] = [];
      let after: string | undefined;
      do {
        const page = await api.invoke('workspace.projects', { after, limit: 50 });
        collected.push(...page.projects);
        after = page.nextAfter ?? undefined;
      } while (after);
      if (version === projectsVersion.current) { projectsStarted.current = true; setSnapshot(current => ({ ...current, projects: collected })); }
    } catch (error) { if (version === projectsVersion.current) setNotice(`Could not load saved projects: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api]);
  snapshotWorker.current = performRefresh;
  const refresh = useCallback((selection = selectedRef.current): Promise<void> => {
    snapshotSelection.current = selection;
    if (snapshotFlight.current) { ++snapshotVersion.current; snapshotDirty.current = true; return snapshotFlight.current; }
    const run = (async () => {
      do {
        snapshotDirty.current = false;
        await snapshotWorker.current(snapshotSelection.current);
      } while (snapshotDirty.current);
    })();
    snapshotFlight.current = run;
    void run.finally(() => { if (snapshotFlight.current === run) snapshotFlight.current = null; });
    return run;
  }, []);

  useEffect(() => { void refresh(); void loadMcp(); }, [refresh, loadMcp]);
  useEffect(() => api.onEvent((event) => {
    eventSequenceRef.current = Math.max(eventSequenceRef.current, event.sequence);
    if (event.type === 'usage.changed' || event.type === 'task.completed' || event.type === 'task.stopped' || event.type === 'profiles.changed') setUsageRefreshKey(value => value + 1);
    if (event.type === 'notification.open') {
      if (event.taskId) {
        draftProjectRef.current = undefined; setDraftProjectId(undefined); setPage('conversation'); setSelectedId(event.taskId); setInspectorOpen(true);
        void api.invoke('task.read', { taskId: event.taskId }).then(read => setRightTab(read.pendingApprovals > 0 ? 'approvals' : 'activity'), () => setRightTab('activity'));
      }
      return;
    }
    if (event.type === 'runtime.stopped') {
      setNotice('The local runtime stopped. Restart the desktop app to continue.');
    } else if (event.taskId === selectedRef.current && event.type === 'task.stopped') {
      setNotice(payloadString(event.data, 'reason') ?? 'The task stopped before a response was completed.');
    } else if (event.taskId === selectedRef.current && event.type === 'task.budget-warning') {
      const charged = payloadNumber(event.data, 'usedTokens');
      const budget = payloadNumber(event.data, 'budget');
      setNotice(charged !== undefined && budget !== undefined
        ? `This task has charged or reserved ${charged.toLocaleString()} of ${budget.toLocaleString()} tokens (80% warning).`
        : 'This task has reached 80% of its charged or reserved token budget.');
    } else if (event.taskId === selectedRef.current && event.type === 'task.context-warning') {
      const percent = payloadNumber(event.data, 'percent');
      setNotice(`Context warning: the conservative request estimate is ${percent ?? 80}% of this profile's context limit. Compact the conversation from the Usage panel before it stops.`);
    } else if (event.taskId === selectedRef.current && event.type === 'task.compacted') {
      const before = payloadNumber(event.data, 'estimatedTokensBefore'); const after = payloadNumber(event.data, 'estimatedTokensAfter'); const count = payloadNumber(event.data, 'compactedMessages');
      setNotice(`Compacted ${count ?? 0} earlier messages into a retained summary (estimate ${before?.toLocaleString() ?? '?'} → ${after?.toLocaleString() ?? '?'}). Originals stay in local history.`);
    } else if (event.type === 'mcp.changed') {
      void loadMcp();
    } else if (event.type === 'profiles.changed') {
      void loadProfiles();
    } else if (event.type === 'projects.changed') {
      void loadProjects();
    }
    if (event.sequence > sequenceRef.current) void refresh(selectedRef.current);
  }), [api, refresh, loadMcp, loadProfiles, loadProjects]);

  useEffect(() => {
    if (!selectedId) { ++detailVersion.current; ++inspectorVersion.current; detailLoadedTask.current = undefined; setDetail(undefined); setUsage(undefined); setFiles([]); setFile(undefined); setDiff(undefined); setCurrentPath(''); setPendingApprovalCount(0); setUnknownOutcomes(0); return; }
    ++fileVersion.current;
    currentPathRef.current = '';
    detailLoadedTask.current = undefined;
    messageOrdinals.current.clear(); latestMessageThrough.current = undefined; messageCursor.current = null;
    approvalLoadedTask.current = undefined;
    setCurrentPath(''); setDetail(undefined); setUsage(undefined); setFile(undefined); setDiff(undefined); setConfirmAction(undefined);
    void loadTaskDetail(selectedId);
    const kind = snapshot.tasks.find((task) => task.id === selectedId)?.workspaceKind;
    inspectorLoadedTask.current = kind ? selectedId : undefined;
    if (kind) void refreshInspector(selectedId, '', kind);
  }, [loadTaskDetail, refreshInspector, loadFiles, selectedId]);
  useEffect(() => {
    if (!selectedId || detail?.task.id !== selectedId || inspectorLoadedTask.current === selectedId) return;
    inspectorLoadedTask.current = selectedId;
    void refreshInspector(selectedId, '', detail.task.workspaceKind ?? 'git');
  }, [detail?.task.id, detail?.task.workspaceKind, refreshInspector, selectedId, snapshot.tasks]);

  useEffect(() => {
    if (!searchHit?.messageId || searchHit.ordinal === undefined || searchHit.taskId !== searchHit.rootTaskId || selectedId !== searchHit.rootTaskId || detail?.task.id !== selectedId || detail.task.mode === 'coordinated') return;
    let active = true;
    void api.invoke('task.messages', { taskId: searchHit.taskId, before: searchHit.ordinal + 1, limit: 50 }).then(result => {
      if (!active || selectedRef.current !== searchHit.rootTaskId) return;
      setDetail(current => current?.task.id === searchHit.rootTaskId ? { ...current, messages: mergeTranscriptPage(current.messages, result.items, messageOrdinals.current) } : current);
      if (messageCursor.current === null) { messageCursor.current = result.nextBefore; setMessageNextBefore(result.nextBefore); }
      requestAnimationFrame(() => document.querySelector(`[data-message-id="${searchHit.messageId}"]`)?.scrollIntoView({ block: 'center' }));
    }, error => setNotice(`Could not open search result: ${error instanceof Error ? error.message : String(error)}`));
    return () => { active = false; };
  }, [api, searchHit, selectedId, detail?.task.id, detail?.task.mode]);

  const updateDraftFor = (key: string, patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? blankDraft()), ...patch } }));
  const updateDraft = (patch: Partial<Draft>) => updateDraftFor(draftKey(draftProjectId ?? null), patch);
  const selectDraft = (projectId: string | null) => { ++selectionVersion.current; ++detailVersion.current; ++inspectorVersion.current; selectedRef.current = undefined; draftProjectRef.current = projectId; setSelectedId(undefined); setDraftProjectId(projectId); setPage('conversation'); setNotice(''); };
  const selectTask = (taskId: string) => { ++selectionVersion.current; draftProjectRef.current = undefined; selectedRef.current = taskId; setDraftProjectId(undefined); setSelectedId(taskId); setPage('conversation'); setNotice(''); };
  const addProject = async () => {
    if (addingProject || !schema || schema.version < 3) return;
    const chosen = await api.pickProject();
    if (!chosen) return;
    setAddingProject(true);
    try { const project = await api.invoke('project.add', { path: chosen }); await refresh(); selectDraft(project.id); }
    catch (error) { setNotice(`Could not add project: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setAddingProject(false); }
  };
  const updateProject = async (project: Project, patch: { name?: string; hidden?: boolean }) => {
    try { await api.invoke('project.update', { projectId: project.id, ...patch }); await refresh(); }
    catch (error) { setNotice(`Could not update project: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const savePreferences = async (patch: { profileId?: string; mode?: Mode; collapsedProjectIds?: string[] }) => {
    try { await api.invoke('workspace.preferences.save', patch); }
    catch (error) { setNotice(`Could not save preferences: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const toggleProject = (projectId: string) => {
    const next = collapsedProjectIds.includes(projectId) ? collapsedProjectIds.filter((id) => id !== projectId) : [...collapsedProjectIds, projectId];
    setCollapsedProjectIds(next); void savePreferences({ collapsedProjectIds: next });
  };
  const startDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.content.trim() || creating || !schema || schema.version < 3) return;
    if (!draft.unknown && (!configuredProfile || (configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt))) { setNotice('Choose a verified model profile in Model settings before sending.'); return; }
    if (!draft.unknown && activeProject?.kind === 'unavailable') { setNotice('This folder is unavailable. Restore it before starting a chat.'); return; }
    const mode: Mode = activeProject?.kind === 'git' ? taskMode : 'chat';
    if (!draft.unknown && mode !== 'chat' && configuredProfile && !isProfileReady(configuredProfile)) { setNotice('Coding and coordinated modes require a verified profile with tools and continuation support.'); return; }
    if (mode === 'coordinated' && !draft.requiredValidationCommand.trim() && !draft.unknown) { setNotice('Enter the required combined validation command.'); return; }
    const originKey = draftKey(draftProjectId ?? null);
    const originSelection = selectionVersion.current;
    const guidedContent = draft.scopeGuidance.length ? `${draft.content.trim()}\n\nScope guidance (does not grant access):\n${draft.scopeGuidance.map(item => `- ${item}`).join('\n')}` : draft.content.trim();
    if (guidedContent.length > 64000) { setNotice('This draft exceeds the 64,000-character limit after scope guidance. Shorten it before sending.'); return; }
    const budget = mode === 'coordinated' ? draft.coordinatedBudget : draft.tokenBudget;
    if (!Number.isInteger(budget) || budget < 1024 || budget > 10000000) { setNotice('Choose a token budget from 1,024 to 10,000,000.'); return; }
    const payload: StartPayload = draft.unknown && draft.startPayload ? draft.startPayload : { requestId: crypto.randomUUID(), projectId: draftProjectId ?? null, content: guidedContent, title: draft.title.trim() || undefined, profileId, mode,
      tokenBudget: budget,
      ...(mode === 'coordinated' ? { coordination: { childProfileIds: draft.childProfileIds, requiredValidation: { command: draft.requiredValidationCommand.trim(), cwd: '', timeoutMs: 600000 } } } : {}) };
    updateDraftFor(originKey, { startPayload: payload, pending: true, unknown: false });
    setCreating(true); setNotice('');
    try {
      const task = await api.invoke('task.start', payload);
      setDrafts((current) => ({ ...current, [originKey]: blankDraft() }));
      if (originSelection === selectionVersion.current) { setSnapshot((current) => ({ ...current, tasks: [...current.tasks.filter((existing) => existing.id !== task.id), task] })); draftProjectRef.current = undefined; selectedRef.current = task.id; setDraftProjectId(undefined); setSelectedId(task.id); setPage('conversation'); await refresh(task.id); }
      else await refresh();
    } catch (error) {
      updateDraftFor(originKey, { pending: false, unknown: true });
      if (originSelection === selectionVersion.current) setNotice(`Start outcome is unknown: ${error instanceof Error ? error.message : String(error)}. Your draft is preserved. Retry uses the same request ID.`);
    } finally { setCreating(false); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!selectedId || !composer.trim()) return;
    const content = composer.trim(); setComposer('');
    try { await api.invoke('task.send', { taskId: selectedId, content }); await refresh(selectedId); }
    catch (error) { setComposer(content); setNotice(`Message was not sent: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const cancel = async () => { if (!selectedId) return; try { await api.invoke('task.cancel', { taskId: selectedId }); await refresh(selectedId); } catch (error) { setNotice(`Could not cancel: ${error instanceof Error ? error.message : String(error)}`); } };
  const compact = async () => {
    if (!selectedId || compacting) return;
    setCompacting(true);
    try { await api.invoke('task.compact', { taskId: selectedId }); await loadTaskDetail(selectedId); }
    catch (error) { setNotice(`Could not compact: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setCompacting(false); }
  };
  const exportDiagnostics = async () => {
    if (exporting) return; setExporting(true);
    try { const result = await api.invoke('diagnostics.export', {}); setNotice(`Sanitized diagnostics written to ${result.path} (${result.bytes.toLocaleString()} bytes, SHA-256 ${result.sha256.slice(0, 12)}…). Credentials, file contents and patches are excluded.`); }
    catch (error) { setNotice(`Could not export diagnostics: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setExporting(false); }
  };
  const openAutomation = () => { setAutomationOpen(true); setAppDialogOpen(true); automationDialogRef.current?.showModal(); };
  const openAction = (action: ActionItem) => {
    if (action.kind === 'draft') { openAutomation(); return; }
    if (!action.taskId) return;
    selectTask(action.taskId); setFocusAction(action); setInspectorOpen(true);
    setRightTab(action.kind === 'approval' ? 'approvals' : action.kind === 'intent' ? 'publish' : 'activity');
  };
  const useAutomationDraft = (draft: AutomationDraft) => {
    if (draft.kind !== 'promptDraft') { setNotice('Only prompt drafts can be placed in the composer. Review proposed actions through Approvals.'); return; }
    if (draft.taskId) void api.invoke('task.read', { taskId: draft.taskId }).then(read => selectTask(read.task.parentTaskId ?? read.task.id), error => setNotice(`Could not open draft task: ${error instanceof Error ? error.message : String(error)}`));
    if (!draft.taskId && !selectedRef.current) { setNotice('Choose a task before using this workspace-wide draft.'); return; }
    setComposer(draft.body); automationDialogRef.current?.close();
    setNotice('Draft placed in the composer. Review it and press Send when ready.');
  };
  const openPreparedApproval = async (draft: AutomationDraft, approvalId: string) => {
    if (!draft.taskId) return;
    try {
      const read = await api.invoke('task.read', { taskId: draft.taskId });
      const rootId = read.task.parentTaskId ?? read.task.id;
      selectTask(rootId);
      setFocusAction({ id: approvalId, taskId: rootId, sourceTaskId: draft.taskId, taskTitle: read.task.title, archived: Boolean(read.task.archivedAt), tier: 0, kind: 'approval', state: 'awaiting-approval', sourceId: approvalId, createdAt: new Date().toISOString(), detail: 'Review proposed action' });
      setRightTab('approvals'); setInspectorOpen(true); automationDialogRef.current?.close();
      setNotice('Action prepared for ordinary approval. Review the complete evidence before deciding.');
    } catch (cause) { setNotice(`Could not open prepared approval: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const commit = async () => {
    if (!selectedId || publishBusy || !commitMessage.trim()) return;
    setPublishBusy('commit');
    try { const result = await api.invoke('task.commit', { taskId: selectedId, message: commitMessage.trim() }); setCommitMessage(''); setNotice(`Committed ${result.commit.slice(0, 10)} on ${result.branch} (${result.changedPaths.length} paths).`); await loadTaskDetail(selectedId); void refreshInspector(selectedId, currentPathRef.current, 'git'); }
    catch (error) { setNotice(`Could not commit: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setPublishBusy(undefined); }
  };
  const push = async () => {
    if (!selectedId || publishBusy) return;
    setPublishBusy('push'); setConfirmAction(undefined);
    try { const result = await api.invoke('task.push', { taskId: selectedId, remote: pushRemote.trim() || 'origin', confirm: 'push' }); setNotice(`Pushed ${result.branch} to ${result.remote}. ${result.detail}`.trim()); }
    catch (error) { setNotice(`Could not push: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setPublishBusy(undefined); }
  };
  const retire = async () => {
    if (!selectedId || publishBusy) return;
    setPublishBusy('retire'); setConfirmAction(undefined);
    try { const result = await api.invoke('task.retire', { taskId: selectedId, confirm: 'retire' }); setNotice(`Retired ${result.removedWorktrees.length} clean worktree(s). Branch ${result.branch} and the task history are retained.`); await refresh(selectedId); }
    catch (error) { setNotice(`Could not retire: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setPublishBusy(undefined); }
  };
  const reconcilePublication = async () => {
    if (!selectedId || publishBusy) return;
    setPublishBusy('reconcile');
    try {
      const result = await api.invoke('task.reconcilePublication', { taskId: selectedId });
      setNotice(result.detail);
      await loadTaskDetail(selectedId);
      void refreshInspector(selectedId, currentPathRef.current, 'git');
    } catch (error) {
      setNotice(`Could not reconcile publication: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPublishBusy(undefined);
    }
  };
  const confirmUpgrade = async () => {
    setUpgrading(true);
    try {
      const result = await api.invoke('workspace.upgrade', { confirm: 'backup-and-upgrade' });
      upgradeDialogRef.current?.close();
      setNotice(`Database upgraded to v${result.version}. A verified backup was saved at ${result.backupPath}.`);
      await refresh();
    } catch (error) { setNotice(`Could not upgrade the database: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setUpgrading(false); }
  };
  const readFile = async (path: string) => {
    if (!selectedId) return; const taskId = selectedId; const version = ++fileVersion.current;
    try { const next = await api.invoke('files.read', { taskId, path }); if (version === fileVersion.current && selectedRef.current === taskId) setFile(next); }
    catch (error) { if (version === fileVersion.current && selectedRef.current === taskId) setNotice(`Could not read file: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const browseDirectory = (path: string) => {
    if (!selectedId) return;
    ++fileVersion.current;
    currentPathRef.current = path;
    setCurrentPath(path); setFile(undefined);
    void loadFiles(selectedId, path);
  };
  const refreshCurrentInspector = () => {
    if (!selectedId) return;
    void refreshInspector(selectedId, currentPathRef.current, workspaceKind);
    if (file) void readFile(file.path);
  };
  const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  const decideApproval = async (approval: Approval, decision: 'approve' | 'reject') => {
    if (!selectedId || approvalInFlight[approval.id]) return;
    setApprovalInFlight((current) => ({ ...current, [approval.id]: decision }));
    try {
      await api.invoke('approval.decide', { taskId: selectedId, approvalId: approval.id, nonce: approval.nonce, decision });
      await refresh(selectedId); await loadTaskDetail(selectedId);
    } catch (error) { setNotice(`Could not ${decision} this approval: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setApprovalInFlight((current) => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };
  const reconcileApproval = async (approval: Approval) => {
    if (!selectedId || approvalInFlight[approval.id]) return;
    setApprovalInFlight((current) => ({ ...current, [approval.id]: 'reconcile' }));
    try {
      await api.invoke('approval.reconcile', { taskId: selectedId, approvalId: approval.id });
      await refresh(selectedId); await loadTaskDetail(selectedId);
    } catch (error) { setNotice(`Could not check this approval outcome: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setApprovalInFlight((current) => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };
  const acknowledgeBrowserUnknown = async (approval: Approval) => {
    if (!selectedId || !approval.browser || approvalInFlight[approval.id]) return;
    setApprovalInFlight((current) => ({ ...current, [approval.id]: 'acknowledge' }));
    try {
      await api.invoke('browser.acknowledgeUnknown', { taskId: selectedId, approvalId: approval.id, confirm: 'inspected-unknown-result' });
      await refresh(selectedId); await loadTaskDetail(selectedId);
    } catch (error) { setNotice(`Could not acknowledge this browser outcome: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setApprovalInFlight((current) => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };
  const beginInspectorResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || browserExpanded) return;
    event.preventDefault();
    const startX = event.clientX;
    const separator = event.currentTarget;
    const workspace = separator.parentElement;
    const startWidth = separator.nextElementSibling?.getBoundingClientRect().width ?? inspectorWidth;
    const sidebarWidth = workspace?.querySelector('.sidebar-shell')?.getBoundingClientRect().width ?? 0;
    const minConversation = window.innerWidth <= 950 ? 260 : 320;
    const maxWidth = Math.max(300, (workspace?.getBoundingClientRect().width ?? window.innerWidth) - sidebarWidth - minConversation - separator.getBoundingClientRect().width);
    setInspectorDragging(true);
    separator.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setInspectorWidth(Math.max(300, Math.min(maxWidth, startWidth + startX - next.clientX)));
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop); separator.removeEventListener('lostpointercapture', stop); if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId); setInspectorDragging(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    window.addEventListener('blur', stop, { once: true });
    separator.addEventListener('lostpointercapture', stop, { once: true });
  };
  const openSettings = async () => {
    setCredential(''); setProbe(undefined);
    try { setProfileDraft((await api.invoke('profile.read', { profileId })) ?? OFFLINE_PROFILE); }
    catch (error) { setNotice(`Could not load profile for editing: ${error instanceof Error ? error.message : String(error)}`); return; }
    void loadMcp(); setAppDialogOpen(true); dialogRef.current?.showModal();
  };
  const newProfile = () => { setProfileDraft({ id: crypto.randomUUID(), name: 'New Azure profile', apiKind: 'responses', endpoint: '', deployment: '', contextLimit: 128000, outputLimit: 8192 }); setCredential(''); setProbe(undefined); };
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setNotice('');
    try {
      const saved = await api.invoke('profile.save', { ...profileDraft, name: profileDraft.name.trim(), endpoint: profileDraft.endpoint.trim(), deployment: profileDraft.deployment.trim() });
      if (credential) await api.saveCredential(saved.id, credential);
      setCredential(''); preferencesTouched.current = true; setProfileId(saved.id); await savePreferences({ profileId: saved.id }); await refresh(); dialogRef.current?.close();
    } catch (error) { setCredential(''); setNotice(`Could not save profile: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const probeProfile = async () => { try { const saved = await api.invoke('profile.save', profileDraft); if (credential) await api.saveCredential(saved.id, credential); setCredential(''); setProbe(await api.invoke('profile.probe', { profileId: saved.id })); } catch (error) { setCredential(''); setProbe({ ok: false, capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false }, detail: error instanceof Error ? error.message : String(error), fingerprint: '' }); } };
  const coordinatedTask = selectedTask?.mode === 'coordinated' ? selectedTask : undefined;
  const browserVisible = page === 'conversation' && !isDraft && !coordinatedTask && effectiveRightTab === 'browser';
  const updateDialogVisibility = () => setAppDialogOpen(Boolean(dialogRef.current?.open || upgradeDialogRef.current?.open || manageDialogRef.current?.open || automationDialogRef.current?.open));
  const contextLine = usage ? ` · context ≈ ${usage.contextPercent}% of ${usage.contextLimit.toLocaleString()}` : '';
  const upgradeFeatures = schema && schema.version < 3 ? 'saved projects, new chats, detailed usage, and personal workspace history' : schema && schema.version < 4 ? 'detailed usage and personal workspace history' : 'search, archive, automation, and continuity';

  return <>
    {schema?.upgradeRequired && <div className="upgrade-banner" role="status">
      This database needs a verified, backed-up upgrade to v{schema.current} for {upgradeFeatures}{!schema.coordinatedAvailable ? ' and coordinated tasks' : ''}. Earlier chats remain accessible.
      <button type="button" className="secondary" onClick={() => { setAppDialogOpen(true); upgradeDialogRef.current?.showModal(); }}>Review upgrade</button>
    </div>}
    <main className={`workspace${page === 'usage' || isDraft ? ' wide-content-workspace' : coordinatedTask ? ' coordinated-workspace' : ''}${browserExpanded && browserVisible ? ' browser-expanded' : ''}`} style={{ '--inspector-width': browserExpanded && browserVisible ? 'min(74vw, calc(100vw - 325px))' : `${inspectorWidth}px` } as React.CSSProperties}>
    <div className="sidebar-shell">
      <nav className="sidebar-mode-tabs" aria-label="Sidebar sections"><button type="button" className={sidebarView === 'workspace' ? 'selected' : ''} onClick={() => setSidebarView('workspace')}>Inbox & history</button><button type="button" className={sidebarView === 'projects' ? 'selected' : ''} onClick={() => setSidebarView('projects')}>Projects</button>{sidebarView === 'workspace' && <button type="button" onClick={() => selectDraft(null)}>New chat</button>}</nav>
      {sidebarView === 'projects' ? <ProjectSidebar projects={projects} tasks={snapshot.tasks} selectedId={page === 'usage' ? undefined : selectedId} draftProjectId={page === 'usage' ? undefined : draftProjectId} collapsedProjectIds={collapsedProjectIds} canAdd={Boolean(schema && schema.version >= 3)} adding={addingProject} exporting={exporting} onNew={selectDraft} onSelect={selectTask} onAdd={() => void addProject()} onManage={() => { setAppDialogOpen(true); manageDialogRef.current?.showModal(); }} onToggle={toggleProject} onHide={(project) => void updateProject(project, { hidden: true })} onSettings={() => void openSettings()} onExport={() => void exportDiagnostics()} /> : <WorkspaceNavigation api={api} projects={projects} selectedId={selectedId} onSelect={selectTask} onAction={openAction} onSearchHit={hit => { setSearchHit(hit); selectTask(hit.rootTaskId); }} onOpenAutomation={openAutomation} canArchive={Boolean(schema && schema.version >= 5)} refreshToken={navigationVersion} onChanged={() => void refresh(selectedRef.current)} />}
      <nav className="sidebar-usage" aria-label="Workspace views"><button type="button" className={page === 'usage' ? 'selected' : ''} aria-current={page === 'usage' ? 'page' : undefined} onClick={() => setPage('usage')}>Usage overview <span aria-hidden="true">↗</span></button><button type="button" disabled={!schema || schema.version < 5} onClick={openAutomation}>Hooks and follow-ups</button>{sidebarView === 'workspace' && <><button type="button" onClick={() => void openSettings()}>Model settings</button><button type="button" disabled={exporting} onClick={() => void exportDiagnostics()}>Export diagnostics</button></>}</nav>
    </div>
    {page === 'usage' ? schema && schema.version >= 4 ? <UsageView api={api} refreshKey={usageRefreshKey} onOpenTask={selectTask} /> : <section className="usage-gate"><h1>Usage</h1><p>Upgrade the database to v{schema?.current ?? 4} to view detailed request history.</p><button type="button" className="secondary" onClick={() => { setAppDialogOpen(true); upgradeDialogRef.current?.showModal(); }}>Review upgrade</button></section> : isDraft ? <section className="conversation draft-conversation">
      <header className="task-header"><div><p className="eyebrow">{activeProject?.path ?? 'NO FOLDER'}</p><h1>New chat</h1><p className="task-status">{activeProject ? activeProject.name : 'No folder'}{activeProject?.kind === 'unavailable' ? ' · Folder unavailable' : ''}</p></div></header>
      {notice && <div className="notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
      <div className="draft-welcome"><span className="large-mark">F</span><h2>What would you like to work on?</h2><p>{activeProject ? 'This conversation will start in ' + activeProject.name + '.' : 'Start a conversation without folder access.'}</p></div>
      {schema && schema.version >= 5 && <TemplatePicker api={api} current={{ prompt: draft.content, mode: activeProject?.kind === 'git' ? taskMode : 'chat', profileId, tokenBudget: taskMode === 'coordinated' ? draft.coordinatedBudget : draft.tokenBudget, scope: draft.scopeGuidance, ...(taskMode === 'coordinated' && activeProject?.kind === 'git' ? { coordination: { childProfileIds: draft.childProfileIds, requiredValidation: { command: draft.requiredValidationCommand, cwd: '', timeoutMs: 600000 } } } : {}) }} onApply={template => {
        updateDraft({ content: template.prompt, tokenBudget: template.tokenBudget, coordinatedBudget: template.tokenBudget, scopeGuidance: template.scope, childProfileIds: template.coordination?.childProfileIds ?? [], requiredValidationCommand: template.coordination?.requiredValidation.command ?? '', startPayload: undefined });
        if (profiles.some(profile => profile.id === template.profileId)) { setProfileId(template.profileId); void savePreferences({ profileId: template.profileId }); }
        else setNotice('Template profile is unavailable. Choose a model before sending.');
        if (activeProject?.kind === 'git' || template.mode === 'chat') { setTaskMode(template.mode); void savePreferences({ mode: template.mode }); }
        else setNotice('This folder supports chat mode only. Review the template prompt before sending.');
        setMoreOptions(true);
      }} setNotice={setNotice} />}
      <form className="draft-compose" onSubmit={startDraft}>
        <textarea aria-label="Chat message" placeholder="Ask a question or describe the work…" value={draft.content} onChange={(event) => updateDraft({ content: event.target.value, startPayload: undefined })} disabled={creating || draft.unknown || activeProject?.kind === 'unavailable' || !schema || schema.version < 3} />
        <div className="draft-toolbar"><label>Model<select aria-label="Model" value={draftDisplayProfileId} disabled={draft.unknown} onChange={(event) => { const next = event.target.value; preferencesTouched.current = true; setProfileId(next); void savePreferences({ profileId: next }); }}>{!profiles.some((profile) => profile.id === draftDisplayProfileId) && <option value={draftDisplayProfileId}>Unavailable profile</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label>Mode<select aria-label="Mode" value={draftDisplayMode} disabled={activeProject?.kind !== 'git' || draft.unknown} onChange={(event) => { const next = event.target.value as Mode; preferencesTouched.current = true; setTaskMode(next); void savePreferences({ mode: next }); }}><option value="chat">Chat</option><option value="coding" disabled={!codingReady}>Coding</option><option value="coordinated" disabled={!coordinatedReady}>Coordinated</option></select></label><button type="button" className="draft-more" aria-expanded={moreOptions} onClick={() => setMoreOptions(!moreOptions)}>More options {moreOptions ? '⌃' : '⌄'}</button></div>
        {moreOptions && <div className="draft-options"><label>Title (optional)<input value={draft.title} maxLength={160} disabled={draft.unknown} placeholder="From first message if empty" onChange={(event) => updateDraft({ title: event.target.value, startPayload: undefined })} /></label>{activeProject?.kind === 'git' && draftDisplayMode === 'coordinated' && <><label>Required validation command<textarea value={draft.requiredValidationCommand} maxLength={16384} disabled={draft.unknown} onChange={(event) => updateDraft({ requiredValidationCommand: event.target.value, startPayload: undefined })} /></label><label>Token budget<input type="number" min={1024} max={10000000} value={draft.coordinatedBudget} disabled={draft.unknown} onChange={(event) => updateDraft({ coordinatedBudget: Number(event.target.value), startPayload: undefined })} /></label><fieldset className="child-profiles" disabled={draft.unknown}><legend>Child profiles</legend>{availableChildProfiles.map((profile) => <label key={profile.id} className="checkbox-row"><input type="checkbox" checked={draft.childProfileIds.includes(profile.id)} disabled={!draft.childProfileIds.includes(profile.id) && draft.childProfileIds.length >= ORCHESTRATION_LIMITS.maxChildProfiles} onChange={(event) => updateDraft({ childProfileIds: event.target.checked ? [...draft.childProfileIds, profile.id] : draft.childProfileIds.filter((id) => id !== profile.id), startPayload: undefined })} />{profile.name}</label>)}{!availableChildProfiles.length && <p className="muted">Children reuse the coordinator profile.</p>}</fieldset></>}</div>}
        {moreOptions && draftDisplayMode !== 'coordinated' && <label>Token budget<input type="number" min={1024} max={10000000} value={draft.tokenBudget} disabled={draft.unknown} onChange={event => updateDraft({ tokenBudget: Number(event.target.value), startPayload: undefined })} /></label>}
        {draft.scopeGuidance.length > 0 && <p className="draft-warning">Scope guidance appended to the prompt: {draft.scopeGuidance.join(', ')}. This grants no filesystem access.</p>}
        {profilesLoading && <p className="muted" role="status">Loading saved model profiles…</p>}
        {profilesError && <p className="draft-warning" role="alert">Could not load all model profiles: {profilesError}</p>}
        {!configuredProfile && <p className="draft-warning">The saved model profile is unavailable. Choose a profile before sending.</p>}
        {configuredProfile && configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt && <p className="draft-warning">Verify this profile in Model settings before sending.</p>}
        {draft.unknown && <p className="draft-warning">The start outcome is unknown. Check the project chat list first. Retry uses the original message and settings. <button type="button" className="secondary" onClick={() => updateDraft({ startPayload: undefined, unknown: false })}>Start fresh draft</button></p>}
        <button type="submit" className="primary draft-send" disabled={!draft.content.trim() || creating || !schema || schema.version < 3 || (!draft.unknown && (activeProject?.kind === 'unavailable' || !configuredProfile || (configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt) || (activeProject?.kind === 'git' && taskMode === 'coordinated' && !draft.requiredValidationCommand.trim())))}>{creating ? 'Starting…' : draft.unknown ? 'Retry same request' : 'Send'}</button>
      </form>
    </section> : coordinatedTask ? <CoordinatedTaskView api={api} task={coordinatedTask} profiles={profiles} notice={notice} setNotice={setNotice} onWorkspaceRefresh={() => void refresh(coordinatedTask.id)} onTaskCreated={task => { setSnapshot(current => ({ ...current, tasks: [task, ...current.tasks.filter(item => item.id !== task.id)] })); void refresh(task.id); }} focusAction={focusAction} searchHit={searchHit} /> : <>
    <section className="conversation">
      <header className="task-header">{selectedTask ? <><div><p className="eyebrow">{selectedTask.projectPath || 'NO FOLDER'}</p><h1>{selectedTask.title}</h1><p className={`task-status ${selectedTask.status}`}>{taskModeLabel} · {statusLabel[selectedTask.status]} · {selectedTask.usedTokens.toLocaleString()} / {selectedTask.tokenBudget.toLocaleString()} charged/reserved tokens{contextLine}</p></div><div className="header-actions"><button ref={inspectorToggleRef} type="button" className="secondary inspector-open" onClick={() => setInspectorOpen(true)}>Inspect task{awaitingApproval ? ' · approval waiting' : ''}</button>{selectedTask.status === 'running' && <button className="danger" onClick={() => void cancel()}>Cancel task</button>}{!taskBusy && !taskRetired && <button type="button" className="secondary" disabled={compacting} onClick={() => void compact()}>{compacting ? 'Compacting…' : 'Compact context'}</button>}</div></> : <><div><p className="eyebrow">FOUNDATION</p><h1>A considered local workspace.</h1></div></>}</header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
      <Transcript messages={detail?.messages ?? []} compactions={compactions} ordinals={messageOrdinals.current} awaitingApproval={awaitingApproval} api={api} taskId={selectedId} empty={!selectedTask ? <div className="empty-state"><span className="large-mark">F</span><h2>Start with a local project.</h2><p>Create a task to send a focused brief to a configured model. The default offline profile helps you explore the workspace; it does not execute tools or delegate work.</p></div> : <div className="empty-state"><h2>{awaitingApproval ? 'Awaiting approval.' : selectedTask.status === 'running' ? 'Receiving response…' : 'Set the direction.'}</h2><p>{awaitingApproval ? 'Review the proposed tool action in the Approvals panel before it can continue.' : selectedTask.status === 'running' ? 'The response is being checked locally before it is shown here.' : 'Describe the outcome, constraints, and the files or behavior that matter.'}</p></div>} />
      {messageNextBefore !== null && <button type="button" className="quiet older-messages" onClick={() => void loadOlderMessages()}>Load older messages</button>}
      <form className="composer" onSubmit={send}><textarea value={composer} onChange={(e) => setComposer(e.target.value)} disabled={!selectedId || taskBusy || taskRetired || Boolean(publishBusy)} placeholder={selectedId ? taskRetired ? 'This task worktree is retired. Create a new task to continue.' : taskBusy ? 'The agent is working. Cancel to send a new direction.' : publishBusy ? 'Wait for the Git operation to finish…' : 'Message this task…' : 'Create or select a task to begin.'} aria-label="Task message" /><button className="primary" disabled={!selectedId || !composer.trim() || taskBusy || taskRetired || Boolean(publishBusy)}>Send <span>↵</span></button></form>
    </section>
    <div className="inspector-resize" role="separator" aria-label="Resize inspector" aria-orientation="vertical" onPointerDown={beginInspectorResize} />
    <aside className={`inspector${inspectorOpen ? ' open' : ''}`} role={inspectorOpen ? 'dialog' : undefined} aria-label={inspectorOpen ? 'Task inspector' : undefined} onKeyDown={event => { if (event.key === 'Escape' && inspectorOpen) setInspectorOpen(false); }}>
      <button ref={inspectorCloseRef} type="button" className="inspector-close" onClick={() => setInspectorOpen(false)}>Close inspector</button>
      <div className="inspector-tabs">{workspaceKind !== 'none' && <button className={effectiveRightTab === 'files' ? 'active' : ''} onClick={() => setRightTab('files')}>Files</button>}{workspaceKind === 'git' && <button className={effectiveRightTab === 'changes' ? 'active' : ''} onClick={() => setRightTab('changes')}>Changes</button>}<button className={effectiveRightTab === 'approvals' ? 'active' : ''} onClick={() => setRightTab('approvals')}>Approvals{awaitingApproval ? ' · 1+' : ''}</button><button className={effectiveRightTab === 'activity' ? 'active' : ''} onClick={() => setRightTab('activity')}>Activity</button><button className={effectiveRightTab === 'continuity' ? 'active' : ''} onClick={() => setRightTab('continuity')}>Continue</button><button className={effectiveRightTab === 'usage' ? 'active' : ''} onClick={() => setRightTab('usage')}>Usage</button>{workspaceKind === 'git' && <button className={effectiveRightTab === 'publish' ? 'active' : ''} onClick={() => setRightTab('publish')}>Publish</button>}<button className={effectiveRightTab === 'browser' ? 'active' : ''} onClick={() => setRightTab('browser')}>Browser</button></div>
      {workspaceKind === 'git' && <button type="button" className={`channel-tab ${effectiveRightTab === 'channel' ? 'active' : ''}`} onClick={() => setRightTab('channel')}>Project channel</button>}
      {effectiveRightTab === 'browser' ? <><div className="browser-expand"><button type="button" onClick={() => setBrowserExpanded((current) => !current)}>{browserExpanded ? 'Reduce browser' : 'Expand browser'}</button></div><BrowserPanel api={api} taskId={selectedId} profileName={taskProfile?.name} eligible={Boolean(taskProfile && isProfileReady(taskProfile) && selectedTask?.mode !== 'coordinated' && selectedTask?.status !== 'retired')} hidden={appDialogOpen || inspectorDragging} onNotice={setNotice} /></> : !selectedId ? <p className="muted inspector-empty">Select a chat to inspect it.</p> : effectiveRightTab === 'channel' ? <AgentChannelPanel key={selectedId} api={api} taskId={selectedId} /> : effectiveRightTab === 'activity' ? <TaskActivity api={api} taskId={selectedId} refreshToken={navigationVersion} unknownOutcomes={unknownOutcomes} /> : effectiveRightTab === 'continuity' ? <ContinuityPanel api={api} taskId={selectedId} messages={detail?.messages ?? []} profiles={profiles} onCreated={task => { setSnapshot(current => ({ ...current, tasks: [task, ...current.tasks] })); selectTask(task.id); void refresh(task.id); }} setNotice={setNotice} /> : effectiveRightTab === 'files' ? <>
        <div className="inspector-tools"><button type="button" onClick={() => browseDirectory('')} disabled={!currentPath}>Root</button><span title={currentPath || (workspaceKind === 'folder' ? 'Folder root' : 'Repository root')}>{currentPath || (workspaceKind === 'folder' ? 'Folder root' : 'Repository root')}</span><button type="button" onClick={refreshCurrentInspector}>Refresh</button></div>
        <div className="file-tree">
          {currentPath && <button type="button" className="up-directory" onClick={() => browseDirectory(parentPath)}><span>←</span>Up</button>}
          {files.map((entry) => <button key={entry.path} type="button" className={file?.path === entry.path ? 'active-file' : ''} onClick={() => entry.kind === 'directory' ? browseDirectory(entry.path) : void readFile(entry.path)}><span>{entry.kind === 'directory' ? '▸' : '·'}</span>{entry.path}</button>)}
          {!files.length && <p className="muted">No files here.</p>}
        </div>
        <div className="file-content"><p>{file?.path ?? 'Choose a file to read'}</p><pre>{file?.content}</pre></div>
      </> : effectiveRightTab === 'changes' ? <div className="patch"><p>{diff?.summary ?? 'Loading changes…'}{diff?.truncated ? ' (truncated)' : ''}</p><pre>{diff?.patch}</pre></div> : effectiveRightTab === 'usage' ? <div className="usage-panel" data-testid="usage-panel">
        {usage ? <>
          <div className="usage-grid">
            <div><dt>Task budget</dt><dd>{usage.usedTokens.toLocaleString()} / {usage.tokenBudget.toLocaleString()}</dd></div>
            <div><dt>Next request estimate</dt><dd className={usage.contextPercent >= usage.warningPercent ? 'warning' : ''}>{usage.estimatedContextTokens.toLocaleString()} / {usage.contextLimit.toLocaleString()} ({usage.contextPercent}%)</dd></div>
            <div><dt>Requests</dt><dd>{usage.metrics ? `${usage.metrics.attemptedRequests} attempts (${usage.metrics.knownRequests} measured, ${usage.metrics.unknownRequests} unknown, ${usage.metrics.pendingRequests} pending, ${usage.metrics.notSentRequests} not dispatched)` : `${usage.totals.requests} (${usage.totals.knownRequests} measured, ${usage.totals.unknownRequests} unknown)`}</dd></div>
            <div><dt>Measured input tokens</dt><dd>{(usage.metrics?.input ?? usage.totals.prompt).toLocaleString()}</dd></div>
            <div><dt>Measured output tokens</dt><dd>{(usage.metrics?.output ?? usage.totals.completion).toLocaleString()}</dd></div>
            <div><dt>Cache read / creation</dt><dd>{usage.metrics ? `${usage.metrics.cacheRead === null ? 'Unavailable' : `${usage.metrics.cacheRead.toLocaleString()} (${usage.metrics.cacheReadKnownRequests}/${usage.metrics.knownRequests} reported)`} / ${usage.metrics.cacheCreation === null ? 'Unavailable' : `${usage.metrics.cacheCreation.toLocaleString()} (${usage.metrics.cacheCreationKnownRequests}/${usage.metrics.knownRequests} reported)`}` : 'Unavailable / Unavailable'}</dd></div>
            <div><dt>Reasoning output</dt><dd>{usage.metrics?.reasoning === null || !usage.metrics ? 'Unavailable' : `${usage.metrics.reasoning.toLocaleString()} (${usage.metrics.reasoningKnownRequests}/${usage.metrics.knownRequests} reported)`}</dd></div>
            <div><dt>Conservative reservations</dt><dd>{usage.metrics ? `${usage.metrics.reservedUnknown.toLocaleString()} unknown · ${usage.metrics.reservedPending.toLocaleString()} pending · ${usage.metrics.reservedNotSent.toLocaleString()} not dispatched` : `${usage.totals.reservedUnknown.toLocaleString()} unknown`}</dd></div>
          </div>
          <p className="muted">Estimates are conservative byte counts of the next request (history or native continuation plus tool schemas and the output reservation). A warning appears at {usage.warningPercent}% of the context limit; compaction summarizes older turns and keeps the originals in local history.</p>
          <UsageChart records={usage.records} />
          <div className="usage-actions"><button type="button" className="secondary" disabled={compacting || taskBusy || taskRetired} onClick={() => void compact()}>{compacting ? 'Compacting…' : 'Compact context'}</button></div>
          <h3>Compactions</h3>
          {usage.compactions.length ? usage.compactions.map((record) => <div className="usage-row" key={record.id}><strong>{record.messageCount} messages</strong><span>{record.estimatedTokensBefore.toLocaleString()} → {record.estimatedTokensAfter.toLocaleString()} · {relativeTime(record.createdAt)}</span></div>) : <p className="muted">No compactions yet.</p>}
          <h3>Recent requests</h3>
          {usage.records.slice(-20).reverse().map((record) => <div className="usage-row" key={record.id}><strong>{record.usageKnown ? `${(record.promptTokens ?? 0).toLocaleString()} in · ${(record.completionTokens ?? 0).toLocaleString()} out` : `reserved ${record.reservedTokens.toLocaleString()}`}</strong><span>{record.usageKnown ? `cache ${record.cacheReadTokens === null ? 'unavailable' : record.cacheReadTokens.toLocaleString()} · reservation ${record.reservedTokens.toLocaleString()}` : record.reason ?? 'usage unknown'} · {relativeTime(record.createdAt)}</span></div>)}
          {!usage.records.length && <p className="muted">No provider requests recorded yet.</p>}
        </> : <p className="muted inspector-empty">Loading usage…</p>}
      </div> : effectiveRightTab === 'publish' ? <div className="publish-panel" data-testid="publish-panel">
        <p className="tool-readiness">Commit, push and retirement are explicit actions you take here. The agent never proposes or runs them. Push uses your Git credential helper for this action only and never forces.</p>
        {selectedTask?.mode === 'coordinated' ? <p className="muted">Coordinated worktrees are integrated through reviewed operations; retire the root once every run is terminal.</p> : <>
          <label>Commit message <textarea value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Describe the change" maxLength={2000} disabled={Boolean(publishBusy) || taskBusy || taskRetired} /></label>
          <div className="approval-actions"><button type="button" className="primary" disabled={Boolean(publishBusy) || taskBusy || taskRetired || !commitMessage.trim()} onClick={() => void commit()}>{publishBusy === 'commit' ? 'Committing…' : 'Commit all changes'}</button><small>Stages every change in the task worktree except secret-named paths; hooks stay disabled.</small></div>
          <label>Remote <input value={pushRemote} onChange={(e) => setPushRemote(e.target.value)} maxLength={64} disabled={Boolean(publishBusy) || taskBusy || taskRetired} /></label>
          <div className="approval-actions">{confirmAction === 'push' ? <><button type="button" className="danger" disabled={Boolean(publishBusy)} onClick={() => void push()}>Confirm push to {pushRemote || 'origin'}</button><button type="button" className="secondary" onClick={() => setConfirmAction(undefined)}>Keep local</button></> : <button type="button" className="secondary" disabled={Boolean(publishBusy) || taskBusy || taskRetired} onClick={() => setConfirmAction('push')}>{publishBusy === 'push' ? 'Pushing…' : 'Push branch…'}</button>}<small>Publishes {selectedTask?.branch} to the remote configured in the project repository.</small></div>
        </>}
        {detail?.hasUnknownPublication && <div className="command-evidence">
          <strong>Unknown publication outcome</strong>
          <p>A Git commit or push ended with an unknown outcome. Reconcile publication state before continuing.</p>
          <div className="approval-actions"><button type="button" className="primary" disabled={Boolean(publishBusy)} onClick={() => void reconcilePublication()}>{publishBusy === 'reconcile' ? 'Checking…' : 'Check publication outcome'}</button></div>
        </div>}
        <h3>Publication outcome</h3>
        <div className="approval-actions"><button type="button" className="secondary" disabled={Boolean(publishBusy) || taskBusy || taskRetired} onClick={() => void reconcilePublication()}>{publishBusy === 'reconcile' ? 'Checking…' : 'Check publication outcome'}</button><small>Verifies whether an interrupted or timed-out commit or push succeeded in Git, without retrying.</small></div>
        <h3>Retire worktree</h3>
        <div className="approval-actions">{confirmAction === 'retire' ? <><button type="button" className="danger" disabled={Boolean(publishBusy)} onClick={() => void retire()}>Confirm retire (clean worktrees only)</button><button type="button" className="secondary" onClick={() => setConfirmAction(undefined)}>Keep worktree</button></> : <button type="button" className="secondary" disabled={Boolean(publishBusy) || taskBusy || taskRetired} onClick={() => setConfirmAction('retire')}>{publishBusy === 'retire' ? 'Retiring…' : taskRetired ? 'Retired' : 'Retire worktree…'}</button>}<small>Removes the app-owned worktree directory only when Git proves it has no uncommitted or untracked files. The branch, commits, history and evidence remain.</small></div>
        {taskRetired && <p className="muted">Retired {selectedTask?.retiredAt ? relativeTime(selectedTask.retiredAt) : ''} ago.</p>}
      </div> : <div className="approvals-panel">
        {(selectedTask?.mode ?? 'chat') === 'coding' && <p className="tool-readiness">{taskProfile?.apiKind === 'fake' ? 'Offline deterministic coding demo. Type /demo to create reviewed sample actions.' : taskProfile?.verifiedAt && taskProfile.capabilities?.tools && taskProfile.capabilities?.continuation ? 'Verified tool and continuation support. Each proposed action still needs review and approval.' : 'Tool execution unavailable until this profile is re-probed with tool and continuation support.'}</p>}
        {(detail?.approvals ?? []).map((approval) => <article className={`approval-card ${approval.state}`} data-approval-id={approval.id} key={approval.id}>
          <div className="approval-heading"><strong>{approval.tool}</strong><span>{approval.state}</span></div>
          <p>{approval.summary}</p>
          {approval.browser && <div className="command-evidence"><strong>Browser action</strong><dl><dt>Origin</dt><dd>{approval.browser.prepared.origin}</dd></dl><dl><dt>Target tab</dt><dd>{approval.browser.prepared.tabId}</dd></dl><dl><dt>Action</dt><dd>{approval.browser.prepared.action.kind}</dd></dl><dl><dt>Exact request</dt><dd><pre>{JSON.stringify(approval.browser.prepared.action, null, 2)}</pre></dd></dl><small>One approval permits this exact action only. The page may have changed; stale actions are rejected.</small></div>}
          {approval.mcp && <div className="command-evidence"><strong>External MCP tool</strong><dl><dt>Server</dt><dd>{approval.mcp.serverName} ({approval.mcp.serverKey})</dd></dl><dl><dt>Tool</dt><dd>{approval.mcp.tool}</dd></dl><dl><dt>Arguments</dt><dd><pre>{approval.mcp.arguments}</pre></dd></dl><small>External tools act outside the worktree with your Windows privileges; the server's own annotations grant nothing.</small></div>}
          {approval.path && <dl><dt>File</dt><dd>{approval.path}</dd></dl>}
          {approval.before !== undefined && <dl><dt>Before</dt><dd><pre>{approval.before}</pre></dd></dl>}
          {approval.after !== undefined && <dl><dt>After</dt><dd><pre>{approval.after}</pre></dd></dl>}
          {(approval.expectedHash !== undefined || approval.resultingHash !== undefined) && <dl><dt>Hash</dt><dd>{approval.expectedHash ?? 'none'} → {approval.resultingHash ?? 'pending'}</dd></dl>}
          {approval.command && <div className="command-evidence"><strong>Command</strong><pre>{approval.command}</pre><small>Runs with your Windows privileges; approval is not sandboxing.</small></div>}
          {approval.cwd && <dl><dt>Working directory</dt><dd>{approval.cwd}</dd></dl>}
          {approval.shell && <dl><dt>Shell</dt><dd>{approval.shell}</dd></dl>}
          {approval.environment && <dl><dt>Environment</dt><dd>{Object.entries(approval.environment).map(([key, value]) => <span className="environment" key={key}>{key}={value}</span>)}</dd></dl>}
          {approval.timeoutMs !== undefined && <dl><dt>Timeout</dt><dd>{approval.timeoutMs.toLocaleString()} ms</dd></dl>}
          {approval.result && <div className="approval-result"><strong>{approval.result.isError ? 'Redacted error result' : 'Redacted result'}</strong><pre>{approval.result.content}</pre>{approval.result.exitCode !== undefined && <small>Exit code {approval.result.exitCode}</small>}{approval.result.cleanupVerified !== undefined && <small>Cleanup {approval.result.cleanupVerified ? 'verified' : 'not verified'}</small>}</div>}
          {approval.state === 'awaiting-approval' && <div className="approval-actions">{incompleteApprovalIds.has(approval.id) && <p role="alert">Full evidence has not loaded. Refresh approvals before deciding.</p>}<button type="button" className="primary" disabled={Boolean(approvalInFlight[approval.id]) || incompleteApprovalIds.has(approval.id)} onClick={() => void decideApproval(approval, 'approve')}>{approvalInFlight[approval.id] === 'approve' ? 'Approving…' : 'Approve'}</button><button type="button" className="danger" disabled={Boolean(approvalInFlight[approval.id])} onClick={() => void decideApproval(approval, 'reject')}>{approvalInFlight[approval.id] === 'reject' ? 'Rejecting…' : 'Reject'}</button></div>}
          {approval.state === 'unknown' && (approval.browser ? <div className="approval-actions"><p>The browser action was dispatched, but its result is unknown. Inspect the tab manually before allowing newly reviewed actions. This action remains unknown and will not be retried.</p>{approval.browser.acknowledgment ? <small>Inspected {approval.browser.acknowledgment.inspectedAt}. New actions may be reviewed.</small> : <button type="button" className="secondary" disabled={Boolean(approvalInFlight[approval.id])} onClick={() => void acknowledgeBrowserUnknown(approval)}>{approvalInFlight[approval.id] === 'acknowledge' ? 'Recording inspection…' : 'I inspected the tab · allow new actions'}</button>}</div> : <div className="approval-actions"><button type="button" className="secondary" disabled={Boolean(approvalInFlight[approval.id])} onClick={() => void reconcileApproval(approval)}>{approvalInFlight[approval.id] === 'reconcile' ? 'Checking…' : 'Check outcome'}</button><small>Read-only reconciliation; this never retries or discards the action.</small></div>)}
        </article>)}
        {!detail?.approvals?.length && <p className="muted inspector-empty">No reviewed tool actions are queued.</p>}
        {approvalNextBefore !== null && <button type="button" className="quiet" onClick={() => selectedId && void loadApprovals(selectedId, approvalNextBefore)}>Older approvals</button>}
      </div>}
    </aside>
    </>}
    <dialog ref={manageDialogRef} className="settings-dialog manage-dialog" aria-labelledby="manage-projects-title" onToggle={updateDialogVisibility}>
      <div className="dialog-head"><div><p className="eyebrow">SAVED FOLDERS</p><h2 id="manage-projects-title">Manage projects</h2></div><button type="button" className="secondary" onClick={() => manageDialogRef.current?.close()}>Close</button></div>
      <div className="manage-list">{projects.map((project) => <form key={`${project.id}:${project.updatedAt}`} className="manage-project" onSubmit={(event) => { event.preventDefault(); const name = new FormData(event.currentTarget).get('name'); if (typeof name === 'string' && name.trim() && name.trim() !== project.name) void updateProject(project, { name: name.trim() }); }}><div><label>Name for {project.name}<input name="name" aria-label={`Name for ${project.name}`} defaultValue={project.name} maxLength={100} required /></label><small title={project.path}>{project.path}</small>{project.kind === 'unavailable' && <span className="project-unavailable-note">Folder unavailable</span>}</div><div className="manage-actions"><button type="submit" className="secondary">Save name</button><button type="button" className="secondary" onClick={() => void updateProject(project, { hidden: !project.hidden })}>{project.hidden ? `Restore ${project.name}` : `Hide ${project.name}`}</button></div></form>)}{!projects.length && <p className="muted">No saved projects yet.</p>}</div>
    </dialog>
    <dialog ref={dialogRef} className="settings-dialog" onToggle={updateDialogVisibility} onClose={() => setCredential('')}>
      <form method="dialog" className="dialog-head">
        <div><p className="eyebrow">CONNECTIONS</p><h2>Model profile</h2></div>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={newProfile}>New profile</button><button type="submit" className="secondary">Close settings</button></div>
      </form>
      <form onSubmit={saveProfile} className="profile-form">
        <label>Name <input value={profileDraft.name} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })} required maxLength={100} /></label>
        <label>API kind <select value={profileDraft.apiKind} disabled={isBuiltinProfile} onChange={(e) => { const apiKind = e.target.value as ModelProfile['apiKind']; setProfileDraft({ ...profileDraft, apiKind, effort: profileDraft.effort && supportedEfforts(apiKind).includes(profileDraft.effort) ? profileDraft.effort : undefined }); }}><option value="fake">Offline fake</option><option value="responses">Responses API</option><option value="chat-completions">Chat completions</option><option value="anthropic">Anthropic</option></select></label>
        <label>Endpoint <input value={profileDraft.endpoint} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, endpoint: e.target.value })} placeholder="https://…" /></label>
        <label>Deployment <input value={profileDraft.deployment} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, deployment: e.target.value })} /></label>
        {!isBuiltinProfile && profileDraft.apiKind !== 'fake' && schema && schema.version >= 4 && <label>Reasoning effort <select value={profileDraft.effort ?? ''} onChange={(e) => setProfileDraft({ ...profileDraft, effort: e.target.value ? e.target.value as ModelProfile['effort'] : undefined })}><option value="">Provider default</option>{supportedEfforts(profileDraft.apiKind).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select><small>Applied to requests sent with this profile. Changing it requires a new profile check; native tool conversations must start a new task.</small></label>}
        <div className="limits"><label>Context limit <input type="number" disabled={isBuiltinProfile} min="1024" max="2000000" value={profileDraft.contextLimit} onChange={(e) => setProfileDraft({ ...profileDraft, contextLimit: Number(e.target.value) })} /></label><label>Output limit <input type="number" disabled={isBuiltinProfile} min="16" max="128000" value={profileDraft.outputLimit} onChange={(e) => setProfileDraft({ ...profileDraft, outputLimit: Number(e.target.value) })} /></label></div>
        <label>Credential <input type="password" disabled={isBuiltinProfile} value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Stored by the local credential service" autoComplete="off" /><small>Cleared from this form after it is saved or tested.</small></label>
        {isBuiltinProfile ? <p className="probe-note">Offline demo is built in and tests local readiness only; it sends no remote request. Create a new profile to configure an Azure provider.</p> : <p className="probe-note">{profileDraft.apiKind === 'fake' ? 'Offline demo checks local readiness and sends no remote request.' : `Testing may send up to four requests to the selected endpoint${profileDraft.effort ? ` at ${profileDraft.effort} effort with the configured ${profileDraft.outputLimit}-token output cap` : ' with a 256-token output cap'}. Re-probe after changing a profile; start a new task for an existing native tool conversation.`}</p>}
        {probe && <div className={`probe ${probe.ok ? 'success' : 'failure'}`} role="status"><strong>{probe.ok ? 'Connection ready' : 'Connection unavailable'}</strong><p>{probe.detail}</p><small>Streaming {probe.capabilities.streaming ? 'available' : 'unavailable'} · tools {probe.capabilities.tools ? 'available' : 'unavailable'} · cancellation {probe.capabilities.cancellation ? 'available' : 'unavailable'}</small></div>}
        <div className="dialog-actions"><button type="button" className="secondary" onClick={() => void probeProfile()}>Test connection</button><button className="primary" disabled={isBuiltinProfile}>Save profile</button></div>
      </form>
      <McpSettings api={api} servers={mcpServers} onChanged={() => void loadMcp()} setNotice={setNotice} />
    </dialog>
    <dialog ref={automationDialogRef} className="settings-dialog automation-dialog" onClose={event => { if (event.target === event.currentTarget) { setAutomationOpen(false); updateDialogVisibility(); } }}><div className="dialog-actions"><button type="button" className="secondary" onClick={() => automationDialogRef.current?.close()}>Close hooks and follow-ups</button></div>{automationOpen && <AutomationSettings api={api} onDraft={useAutomationDraft} onPrepared={(draft, approvalId) => void openPreparedApproval(draft, approvalId)} setNotice={setNotice} />}</dialog>
    <dialog ref={upgradeDialogRef} className="settings-dialog upgrade-dialog" onToggle={updateDialogVisibility}>
      <div className="dialog-head"><div><p className="eyebrow">DATABASE UPGRADE</p><h2>Back up and upgrade</h2></div></div>
      <div className="profile-form">
        <p>This creates a verified SQLite backup, then upgrades the database to v{schema?.current ?? 5} for {upgradeFeatures}{!schema?.coordinatedAvailable ? ' and coordinated tasks' : ''}. Earlier chats remain available during the upgrade decision. Keep the backup to open the previous database with an older application.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => upgradeDialogRef.current?.close()}>Keep current database</button>
          <button type="button" className="primary" disabled={upgrading} onClick={() => void confirmUpgrade()}>{upgrading ? 'Upgrading…' : 'Create backup and upgrade'}</button>
        </div>
      </div>
    </dialog>
  </main>
  </>;
}

export default App;
