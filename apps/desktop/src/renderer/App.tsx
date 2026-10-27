import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Approval, DesktopApi, DiffResult, FileContent, FileEntry, McpServerStatus, McpStatusPage, ModelProfile, ProbeResult, Project, SchemaStatus, Snapshot, TaskDetail, UsageReport } from '../../../../packages/protocol/src/index';
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
import { ApprovalCard, focusAfterDecision } from './ApprovalCard';
import { diffSummaryText, mayChangeWorktree } from './worktree';
import { PatchText } from './Evidence';
import { inspectorTabInView, approvalsTabLabel, clampInspectorWidth, documentRailWidths, initialInspectorWidth, maxInspectorWidth, MIN_INSPECTOR_WIDTH, rememberInspectorWidth, useCompactLayout, useInspectorOverlay } from './layout';
import { draftSendBlockReason, isFocusShortcut, sendOnShortcut } from './composer';
import { FocusControls } from './FocusControls';
import { relativeTime, taskStatusLabel } from './labels';
import { mergeTranscriptPage, refreshedOlderCursor } from './transcriptHistory';
import type { ActionItem, CompactionSummary, SearchHit, WorkspaceSummary } from '../../../../packages/protocol/src/workspace';
import { decisionFailure, errorMessage, type NoticeState, type NoticeTone, type SetNotice } from './feedback';
import { Notice } from './Notice';
import { AttentionBannerView } from './AttentionBanner';
import { ApprovalTray } from './ApprovalTray';
import { Disclosure, disclosureLabel } from './Disclosure';
import { ToolReadinessNotes } from './ToolReadiness';
import { AppearanceSettings } from './Appearance';
import { applyStyle, applyTheme, documentThemeHost, readStyle, readTheme, saveStyle, saveTheme, type StylePreference, type ThemePreference } from './theme';
import { decidedSummaryDetail, foldableDecided, partitionApprovals, trayOrder } from './approvalGroups';
import { attentionBanner, cardsShown, decisionWhere, inboxChipLabel, inspectLabel, needsYou, statusWarnings, taskAttention, useAttentionAnnouncements, windowTitle, type DecisionSurface, type InboxCount } from './attention';

declare global { interface Window { workspace: DesktopApi; } }

const OFFLINE_PROFILE: ModelProfile = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'local demo',
  contextLimit: 128000, outputLimit: 8192
};

const APP_TITLE = 'Foundry Agent Workspace';
const LIVE_APPROVAL_STATES: readonly Approval['state'][] = ['awaiting-approval', 'approved', 'executing', 'unknown', 'failed'];
const emptySnapshot: Snapshot = { tasks: [], profiles: [], projects: [], preferences: { profileId: OFFLINE_PROFILE.id, mode: 'chat', collapsedProjectIds: [] }, lastSequence: 0, runtime: 'ready' };
const COMMAND_REVIEW_HELP = 'Command review hashes regular files, including ignored dependencies, within limits of 50,000\u00a0files / 1\u00a0GiB and 10,000\u00a0directories + links. Link targets are recorded without traversal; freshness is checked again before execution.';
type Mode = 'chat' | 'coding' | 'coordinated';
interface StartPayload { requestId: string; projectId: string | null; content: string; title?: string; profileId: string; mode: Mode; tokenBudget: number; coordination?: { childProfileIds: string[]; requiredValidation: { command: string; cwd: string; timeoutMs: number } }; }
interface Draft { content: string; title: string; requiredValidationCommand: string; tokenBudget: number; coordinatedBudget: number; childProfileIds: string[]; scopeGuidance: string[]; startPayload?: StartPayload; pending?: boolean; unknown?: boolean; }
const blankDraft = (): Draft => ({ content: '', title: '', requiredValidationCommand: '', tokenBudget: 100000, coordinatedBudget: 600000, childProfileIds: [], scopeGuidance: [] });
const draftKey = (projectId: string | null) => projectId ?? 'none';
/** Local storage is a per-viewer convenience (the inspector width); it can be unavailable, so every access is guarded. */
function viewerStorage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }

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
  /** Approvals seen in a live state while the open task has been open; they stay with the live cards until a task switch. */
  const seenLiveApprovals = useRef(new Set<string>());
  /** The Ctrl+Shift+F handler reads the latest toggle and whether it may act (not over a dialog or the open slide-over). */
  const focusShortcut = useRef<{ blocked: boolean; toggle: () => void }>({ blocked: true, toggle: () => undefined });
  const announcedInbox = useRef<number | undefined>(undefined);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isFocusShortcut({ code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat, isComposing: event.isComposing }) || focusShortcut.current.blocked) return;
      event.preventDefault();
      focusShortcut.current.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [incompleteApprovalIds, setIncompleteApprovalIds] = useState<Set<string>>(new Set());
  const [usage, setUsage] = useState<UsageReport>();
  const [usageError, setUsageError] = useState('');
  const [diffError, setDiffError] = useState('');
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
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [notice, setNoticeState] = useState<NoticeState>();
  const [announcement, setAnnouncement] = useState({ polite: '', assertive: '' });
  const [openDialog, setOpenDialog] = useState<'settings' | 'manage' | 'automation' | 'upgrade'>();
  /** Screen-reader announcement through the always-mounted live regions; errors interrupt, everything else waits. */
  const announcementTurn = useRef(false);
  // Alternating a zero-width suffix makes a repeated message a text change, so screen readers read it again.
  const announce = useCallback((text: string, tone: NoticeTone = 'info') => { announcementTurn.current = !announcementTurn.current; const spoken = `${text}${announcementTurn.current ? '\u200b' : ''}`; setAnnouncement(tone === 'error' ? { polite: '', assertive: spoken } : { polite: spoken, assertive: '' }); }, []);
  const setNotice: SetNotice = useCallback((text, tone = 'error') => { setNoticeState(text ? { text, tone } : undefined); if (text) announce(text, tone); }, [announce]);
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent>();
  const [diff, setDiff] = useState<DiffResult>();
  const [currentPath, setCurrentPath] = useState('');
  const [rightTab, setRightTab] = useState<'files' | 'changes' | 'approvals' | 'usage' | 'activity' | 'continuity' | 'publish' | 'channel' | 'browser'>('files');
  // The rail width comes from the page's tokens, so the inspector's limits follow a style that changes it.
  const [railWidths, setRailWidths] = useState(() => documentRailWidths());
  const [inspectorWidth, setInspectorWidth] = useState(() => initialInspectorWidth(window.innerWidth, viewerStorage(), railWidths));
  // The theme is a closed choice kept like the inspector width; public/theme-boot.js already applied it before the first paint.
  const [theme, setTheme] = useState<ThemePreference>(() => readTheme(viewerStorage()));
  useEffect(() => applyTheme(theme, documentThemeHost()), [theme]);
  const chooseTheme = (next: ThemePreference) => { saveTheme(next, viewerStorage()); setTheme(next); };
  const [style, setStyle] = useState<StylePreference>(() => readStyle(viewerStorage()));
  useEffect(() => {
    applyStyle(style, document.documentElement);
    // A style may change the rail; read it again and keep the inspector inside the new limits. The stored width is not
    // overwritten, so a style with a narrower rail can restore it on the next start.
    const rail = documentRailWidths();
    setRailWidths(current => current.wide === rail.wide && current.narrow === rail.narrow ? current : rail);
    setInspectorWidth(width => clampInspectorWidth(width, window.innerWidth, rail));
  }, [style]);
  const chooseStyle = (next: StylePreference) => { saveStyle(next, viewerStorage()); setStyle(next); };
  const [inspectorDragging, setInspectorDragging] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  /** Focus mode hides the sidebar and makes the inspector a slide-over. Session memory only: every launch starts with the full picture. */
  const [focus, setFocus] = useState(false);
  const [inboxRequest, setInboxRequest] = useState(0);
  const [appDialogOpen, setAppDialogOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ModelProfile>(OFFLINE_PROFILE);
  const [credential, setCredential] = useState('');
  const [probe, setProbe] = useState<ProbeResult>();
  const [approvalInFlight, setApprovalInFlight] = useState<Record<string, 'approve' | 'reject' | 'reconcile' | 'acknowledge'>>({});
  /** A failed action on a card, kept with the state it failed in so it disappears once the recorded state moves on. */
  const [approvalErrors, setApprovalErrors] = useState<Record<string, { text: string; state: Approval['state'] }>>({});
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
  const upgradeDialogRef = useRef<HTMLDialogElement>(null);
  const fileVersion = useRef(0);
  const inspectorVersion = useRef(0);
  const diffVersion = useRef(0);
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
  const inspectorWorker = useRef<(taskId: string) => void>(() => undefined);
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

  selectedRef.current = selectedId;
  // Unsent text belongs to the task it was typed in (memory only), so it can never be sent to a task switched to later.
  const composer = selectedId ? composerDrafts[selectedId] ?? '' : '';
  const setComposerFor = useCallback((taskId: string | undefined, text: string) => {
    if (!taskId) return;
    setComposerDrafts(current => { const { [taskId]: _previous, ...rest } = current; return text ? { ...rest, [taskId]: text } : rest; });
  }, []);
  const setComposer = (text: string) => setComposerFor(selectedRef.current, text);
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
  // Counts belong to the task they were read for; until the open task's read arrives nothing is claimed for it.
  const detailLoaded = Boolean(selectedId && detail?.task.id === selectedId);
  const attention = taskAttention(detailLoaded ? { pendingApprovals: pendingApprovalCount, unknownOutcomes, approvals: detail?.approvals } : { pendingApprovals: 0, unknownOutcomes: 0 });
  const awaitingApproval = attention.awaiting > 0;
  const unknownApprovals = detail?.approvals?.filter(approval => approval.state === 'unknown').length ?? 0;
  const approvalsLabel = approvalsTabLabel(attention.awaiting, unknownApprovals, awaitingApproval && pendingApprovalCount === 0);
  // Approvals load whenever something may need a decision, not only while their tab is open, so the counts and the
  // unknown-publication estimate come from the cards themselves.
  // Focus applies to the task and draft views; the Usage page keeps the sidebar, its only way back.
  const focusActive = focus && page === 'conversation';
  // While a loaded card is approved or executing its outcome is still coming, so keep reading until it settles.
  const approvalSettling = detail?.approvals?.some(approval => approval.state === 'approved' || approval.state === 'executing') ?? false;
  const approvalsWanted = rightTab === 'approvals' || pendingApprovalCount > 0 || unknownOutcomes > 0 || approvalSettling;
  const approvalsWantedRef = useRef(approvalsWanted);
  approvalsWantedRef.current = approvalsWanted;
  const isBuiltinProfile = profileDraft.id === OFFLINE_PROFILE.id;
  const taskRetired = selectedTask?.status === 'retired';
  const taskBusy = selectedTask?.status === 'running';
  const browserTabShown = page === 'conversation' && !isDraft && selectedTask?.mode !== 'coordinated' && effectiveRightTab === 'browser';
  // An expanded browser keeps its column (and hides the sidebar itself), so it wins over Focus.
  const browserHoldsColumn = browserExpanded && browserTabShown;
  const focusLayout = focusActive && !browserHoldsColumn;
  const inspector = useInspectorOverlay(focusActive, browserHoldsColumn);
  const { open: inspectorOpen, setOpen: setInspectorOpen } = inspector;
  const compactLayout = useCompactLayout();
  // The native browser view follows the inspector: it is shown only while the inspector is on screen.
  const browserVisible = browserTabShown && (!inspector.overlay || inspectorOpen);
  const statusWarningWords = selectedTask ? statusWarnings({ usedTokens: selectedTask.usedTokens, tokenBudget: selectedTask.tokenBudget, contextPercent: detailLoaded ? usage?.contextPercent : undefined, warningPercent: detailLoaded ? usage?.warningPercent : undefined }) : [];
  const unknownPublication = detailLoaded && attention.unknownPublication > 0;
  // Needs-decision work across every task (archived included), read on the same refresh as the sidebar; never a false zero.
  const [inboxCount, setInboxCount] = useState<InboxCount>();
  useEffect(() => {
    let active = true;
    void api.invoke('workspace.actions', { limit: 1 }).then(page => { if (active) setInboxCount({ needsDecision: page.counts.needsDecision }); }, () => { if (active) setInboxCount('unavailable'); });
    return () => { active = false; };
  }, [api, navigationVersion]);
  useEffect(() => { document.title = windowTitle(APP_TITLE, inboxCount, detailLoaded ? attention : undefined); }, [inboxCount, detailLoaded, attention.awaiting, attention.unknown]);

  const performTaskDetail = useCallback(async (taskId: string) => {
    const version = ++detailVersion.current;
    try {
      const [read, page, nextUsage] = await Promise.all([
        api.invoke('task.read', { taskId }), api.invoke('task.messages', { taskId, limit: 50 }),
        api.invoke('task.usage', { taskId }).then(report => ({ report, error: '' }), error => ({ report: undefined, error: errorMessage(error) }))
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
        setCompactions(nextUsage.report?.compactions ?? []);
        messageCursor.current = sameTask ? refreshedOlderCursor(previousThrough, messageCursor.current, page) : page.nextBefore;
        setMessageNextBefore(messageCursor.current);
        latestMessageThrough.current = page.through;
        setMessageThrough(page.through);
        setUsage(nextUsage.report); setUsageError(nextUsage.error); setPendingApprovalCount(read.pendingApprovals); setUnknownOutcomes(read.unknownOutcomes);
      }
    } catch (error) {
      if (version === detailVersion.current && selectedRef.current === taskId) setNotice(`Could not load task: ${errorMessage(error)}`);
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
    } catch (error) { setNotice(`Could not load older messages: ${errorMessage(error)}`); }
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
      if (reads.some(read => !read.complete)) setNotice('Some approval evidence could not be loaded. Approval is disabled until the full evidence is available. Retry by reopening Approvals.', 'warning');
      if (before !== undefined || !sameTask) setApprovalNextBefore(page.nextBefore);
    } catch (error) { setNotice(`Could not load approvals: ${errorMessage(error)}`); }
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

  // Entering Focus reads the list once so its tray can show failed and anomalous cards; refreshes then follow approvalsWanted.
  useEffect(() => { if (selectedId && (approvalsWanted || focusActive)) void loadApprovals(selectedId); }, [selectedId, approvalsWanted, focusActive, rightTab, loadApprovals]);
  useEffect(() => {
    if (focusAction?.kind !== 'approval' || !selectedId || focusAction.taskId !== selectedId || detail?.task.id !== selectedId || detail.task.mode === 'coordinated') return;
    void readApprovalEvidence(api, focusAction.sourceTaskId ?? selectedId, focusAction.sourceId).then(read => {
      const approval = read.approval;
      setIncompleteApprovalIds(current => { const next = new Set(current); if (read.complete) next.delete(approval.id); else next.add(approval.id); return next; });
      setDetail(current => current?.task.id === selectedId ? { ...current, approvals: [approval, ...(current.approvals ?? []).filter(item => item.id !== approval.id)] } : current);
    }, error => setNotice(`Could not open approval: ${errorMessage(error)}`));
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
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) setNotice(`Could not load files: ${errorMessage(error)}`);
    }
  }, [api]);

  const refreshInspector = useCallback(async (taskId: string, path: string, kind: 'git' | 'folder' | 'none') => {
    // Browsing a folder supersedes this listing but not the diff, which covers the whole worktree.
    const version = ++inspectorVersion.current; const diffRun = ++diffVersion.current;
    if (kind === 'none') { setFiles([]); setDiff(undefined); return; }
    try {
      const nextFiles = await api.invoke('files.list', { taskId, path });
      const nextDiff = kind === 'git' ? await api.invoke('task.diff', { taskId }) : undefined;
      if (selectedRef.current !== taskId) return;
      if (version === inspectorVersion.current && currentPathRef.current === path) setFiles(nextFiles);
      if (diffRun === diffVersion.current) { setDiff(nextDiff); setDiffError(''); }
    } catch (error) {
      if (selectedRef.current === taskId && diffRun === diffVersion.current) { setDiffError(errorMessage(error)); setNotice(`Could not refresh inspector: ${errorMessage(error)}`); }
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
    } catch (error) { if (version === mcpVersion.current) setNotice(`Could not load MCP servers: ${errorMessage(error)}`); }
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
      if (version === profilesVersion.current) setProfilesError(errorMessage(error));
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
            setNotice(`Could not load saved projects: ${errorMessage(error)}`);
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
        if (approvalsWantedRef.current) void loadApprovals(selection);
      }
      if (fresh.lastSequence < eventSequenceRef.current && retriedSequenceRef.current < eventSequenceRef.current) {
        retriedSequenceRef.current = eventSequenceRef.current;
        snapshotDirty.current = true;
      }
    } catch (error) { setNotice(`Could not refresh workspace: ${errorMessage(error)}`); }
  }, [api, loadTaskDetail, loadApprovals, loadProfiles]);
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
    } catch (error) { if (version === projectsVersion.current) setNotice(`Could not load saved projects: ${errorMessage(error)}`); }
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
    if (event.taskId && event.taskId === selectedRef.current && mayChangeWorktree(event)) inspectorWorker.current(event.taskId);
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
      setNotice(payloadString(event.data, 'reason') ?? 'The task stopped before a response was completed.', 'info');
    } else if (event.taskId === selectedRef.current && event.type === 'task.budget-warning') {
      const charged = payloadNumber(event.data, 'usedTokens');
      const budget = payloadNumber(event.data, 'budget');
      setNotice(charged !== undefined && budget !== undefined
        ? `This task has charged or reserved ${charged.toLocaleString()} of ${budget.toLocaleString()} tokens (80% warning).`
        : 'This task has reached 80% of its charged or reserved token budget.', 'warning');
    } else if (event.taskId === selectedRef.current && event.type === 'task.context-warning') {
      const percent = payloadNumber(event.data, 'percent');
      setNotice(`Context warning: the conservative request estimate is ${percent ?? 80}% of this profile's context limit. Compact the conversation from the Usage panel before it stops.`, 'warning');
    } else if (event.taskId === selectedRef.current && event.type === 'task.compacted') {
      const before = payloadNumber(event.data, 'estimatedTokensBefore'); const after = payloadNumber(event.data, 'estimatedTokensAfter'); const count = payloadNumber(event.data, 'compactedMessages');
      setNotice(`Compacted ${count ?? 0} earlier messages into a retained summary (estimate ${before?.toLocaleString() ?? '?'} → ${after?.toLocaleString() ?? '?'}). Originals stay in local history.`, 'success');
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
    approvalLoadedTask.current = undefined; seenLiveApprovals.current = new Set();
    setCurrentPath(''); setDetail(undefined); setUsage(undefined); setUsageError(''); setDiffError(''); setApprovalErrors({}); setFile(undefined); setDiff(undefined); setConfirmAction(undefined);
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
    }, error => setNotice(`Could not open search result: ${errorMessage(error)}`));
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
    catch (error) { setNotice(`Could not add project: ${errorMessage(error)}`); }
    finally { setAddingProject(false); }
  };
  const updateProject = async (project: Project, patch: { name?: string; hidden?: boolean }) => {
    try { await api.invoke('project.update', { projectId: project.id, ...patch }); await refresh(); }
    catch (error) { setNotice(`Could not update project: ${errorMessage(error)}`); }
  };
  const savePreferences = async (patch: { profileId?: string; mode?: Mode; collapsedProjectIds?: string[] }) => {
    try { await api.invoke('workspace.preferences.save', patch); }
    catch (error) { setNotice(`Could not save preferences: ${errorMessage(error)}`); }
  };
  const toggleProject = (projectId: string) => {
    const next = collapsedProjectIds.includes(projectId) ? collapsedProjectIds.filter((id) => id !== projectId) : [...collapsedProjectIds, projectId];
    setCollapsedProjectIds(next); void savePreferences({ collapsedProjectIds: next });
  };
  const startDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.content.trim() || creating || !schema || schema.version < 3) return;
    if (!draft.unknown && (!configuredProfile || (configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt))) { setNotice('Choose a verified model profile in Model settings before sending.', 'warning'); return; }
    if (!draft.unknown && activeProject?.kind === 'unavailable') { setNotice('This folder is unavailable. Restore it before starting a chat.', 'warning'); return; }
    const mode: Mode = activeProject?.kind === 'git' ? taskMode : 'chat';
    if (!draft.unknown && mode !== 'chat' && configuredProfile && !isProfileReady(configuredProfile)) { setNotice('Coding and coordinated modes require a verified profile with tools and continuation support.', 'warning'); return; }
    if (mode === 'coordinated' && !draft.requiredValidationCommand.trim() && !draft.unknown) { setNotice('Enter the required combined validation command.', 'warning'); return; }
    const originKey = draftKey(draftProjectId ?? null);
    const originSelection = selectionVersion.current;
    const guidedContent = draft.scopeGuidance.length ? `${draft.content.trim()}\n\nScope guidance (does not grant access):\n${draft.scopeGuidance.map(item => `- ${item}`).join('\n')}` : draft.content.trim();
    if (guidedContent.length > 64000) { setNotice('This draft exceeds the 64,000-character limit after scope guidance. Shorten it before sending.', 'warning'); return; }
    const budget = mode === 'coordinated' ? draft.coordinatedBudget : draft.tokenBudget;
    if (!Number.isInteger(budget) || budget < 1024 || budget > 10000000) { setNotice('Choose a token budget from 1,024 to 10,000,000.', 'warning'); return; }
    const payload: StartPayload = draft.unknown && draft.startPayload ? draft.startPayload : { requestId: crypto.randomUUID(), projectId: draftProjectId ?? null, content: guidedContent, title: draft.title.trim() || undefined, profileId, mode,
      tokenBudget: budget,
      ...(mode === 'coordinated' ? { coordination: { childProfileIds: draft.childProfileIds, requiredValidation: { command: draft.requiredValidationCommand.trim(), cwd: '', timeoutMs: 600000 } } } : {}) };
    updateDraftFor(originKey, { startPayload: payload, pending: true, unknown: false });
    setCreating(true); setNotice('');
    try {
      const task = await api.invoke('task.start', payload);
      setDrafts((current) => ({ ...current, [originKey]: blankDraft() }));
      if (originSelection === selectionVersion.current) {
        setSnapshot((current) => ({ ...current, tasks: [...current.tasks.filter((existing) => existing.id !== task.id), task] })); draftProjectRef.current = undefined; selectedRef.current = task.id; setDraftProjectId(undefined); setSelectedId(task.id); setPage('conversation'); await refresh(task.id);
        // The draft form unmounted with focus in it; continue in the new task's composer unless focus moved elsewhere.
        requestAnimationFrame(() => { if (document.activeElement === document.body || !document.activeElement) document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(); });
      }
      else await refresh();
    } catch (error) {
      updateDraftFor(originKey, { pending: false, unknown: true });
      if (originSelection === selectionVersion.current) setNotice(`Start outcome is unknown: ${errorMessage(error)}. Your draft is preserved. Retry uses the same request ID.`);
    } finally { setCreating(false); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const taskId = selectedId;
    if (!taskId || !composer.trim() || taskBusy || taskRetired || publishBusy) return;
    const content = composer.trim(); setComposerFor(taskId, '');
    try { await api.invoke('task.send', { taskId, content }); await refresh(taskId); }
    catch (error) { setComposerFor(taskId, content); setNotice(`Message was not sent: ${errorMessage(error)}`); }
  };
  const cancel = async () => { if (!selectedId) return; try { await api.invoke('task.cancel', { taskId: selectedId }); await refresh(selectedId); } catch (error) { setNotice(`Could not cancel: ${errorMessage(error)}`); } };
  const compact = async () => {
    if (!selectedId || compacting) return;
    setCompacting(true);
    try { await api.invoke('task.compact', { taskId: selectedId }); await loadTaskDetail(selectedId); }
    catch (error) { setNotice(`Could not compact: ${errorMessage(error)}`); }
    finally { setCompacting(false); }
  };
  const exportDiagnostics = async () => {
    if (exporting) return; setExporting(true);
    try { const result = await api.invoke('diagnostics.export', {}); setNotice(`Sanitized diagnostics written to ${result.path} (${result.bytes.toLocaleString()} bytes, SHA-256 ${result.sha256}). Credentials, file contents and patches are excluded.`, 'success'); }
    catch (error) { setNotice(`Could not export diagnostics: ${errorMessage(error)}`); }
    finally { setExporting(false); }
  };
  const openAutomation = () => { setAutomationOpen(true); showDialog(automationDialogRef.current); };
  const openAction = (action: ActionItem) => {
    if (action.kind === 'draft') { openAutomation(); return; }
    if (!action.taskId) return;
    selectTask(action.taskId); setFocusAction(action); setInspectorOpen(true);
    setRightTab(action.kind === 'approval' ? 'approvals' : action.kind === 'intent' ? 'publish' : 'activity');
  };
  const useAutomationDraft = (draft: AutomationDraft) => {
    if (draft.kind !== 'promptDraft') { setNotice('Only prompt drafts can be placed in the composer. Review proposed actions through Approvals.', 'warning'); return; }
    if (draft.taskId) void api.invoke('task.read', { taskId: draft.taskId }).then(read => { const target = read.task.parentTaskId ?? read.task.id; selectTask(target); setComposerFor(target, draft.body); }, error => setNotice(`Could not open draft task: ${errorMessage(error)}`));
    if (!draft.taskId && !selectedRef.current) { setNotice('Choose a task before using this workspace-wide draft.', 'warning'); return; }
    if (!draft.taskId) setComposer(draft.body);
    automationDialogRef.current?.close();
    setNotice('Draft placed in the composer. Review it and press Send when ready.', 'info');
  };
  const openPreparedApproval = async (draft: AutomationDraft, approvalId: string) => {
    if (!draft.taskId) return;
    try {
      const read = await api.invoke('task.read', { taskId: draft.taskId });
      const rootId = read.task.parentTaskId ?? read.task.id;
      selectTask(rootId);
      setFocusAction({ id: approvalId, taskId: rootId, sourceTaskId: draft.taskId, taskTitle: read.task.title, archived: Boolean(read.task.archivedAt), tier: 0, kind: 'approval', state: 'awaiting-approval', sourceId: approvalId, createdAt: new Date().toISOString(), detail: 'Review proposed action' });
      setRightTab('approvals'); setInspectorOpen(true); automationDialogRef.current?.close();
      setNotice('Action prepared for ordinary approval. Review the complete evidence before deciding.', 'info');
    } catch (cause) { setNotice(`Could not open prepared approval: ${errorMessage(cause)}`); }
  };
  const commit = async () => {
    if (!selectedId || publishBusy || !commitMessage.trim()) return;
    setPublishBusy('commit');
    try { const result = await api.invoke('task.commit', { taskId: selectedId, message: commitMessage.trim() }); setCommitMessage(''); setNotice(`Committed ${result.commit} on ${result.branch} (${result.changedPaths.length} paths).`, 'success'); await loadTaskDetail(selectedId); void refreshInspector(selectedId, currentPathRef.current, 'git'); }
    catch (error) { setNotice(`Could not commit: ${errorMessage(error)}`); }
    finally { setPublishBusy(undefined); }
  };
  const push = async () => {
    if (!selectedId || publishBusy) return;
    setPublishBusy('push'); setConfirmAction(undefined);
    try { const result = await api.invoke('task.push', { taskId: selectedId, remote: pushRemote.trim() || 'origin', confirm: 'push' }); setNotice(`Pushed ${result.branch} to ${result.remote}. ${result.detail}`.trim(), 'success'); }
    catch (error) { setNotice(`Could not push: ${errorMessage(error)}`); }
    finally { setPublishBusy(undefined); }
  };
  const retire = async () => {
    if (!selectedId || publishBusy) return;
    setPublishBusy('retire'); setConfirmAction(undefined);
    try { const result = await api.invoke('task.retire', { taskId: selectedId, confirm: 'retire' }); setNotice(`Retired ${result.removedWorktrees.length} clean worktree(s). Branch ${result.branch} and the task history are retained.`, 'success'); await refresh(selectedId); }
    catch (error) { setNotice(`Could not retire: ${errorMessage(error)}`); }
    finally { setPublishBusy(undefined); }
  };
  const reconcilePublication = async () => {
    if (!selectedId || publishBusy) return;
    setPublishBusy('reconcile');
    try {
      const result = await api.invoke('task.reconcilePublication', { taskId: selectedId });
      setNotice(result.detail, 'info');
      await loadTaskDetail(selectedId);
      void refreshInspector(selectedId, currentPathRef.current, 'git');
    } catch (error) {
      setNotice(`Could not reconcile publication: ${errorMessage(error)}`);
    } finally {
      setPublishBusy(undefined);
    }
  };
  const confirmUpgrade = async () => {
    setUpgrading(true);
    try {
      const result = await api.invoke('workspace.upgrade', { confirm: 'backup-and-upgrade' });
      upgradeDialogRef.current?.close();
      setNotice(`Database upgraded to v${result.version}. A verified backup was saved at ${result.backupPath}.`, 'success');
      await refresh();
    } catch (error) { setNotice(`Could not upgrade the database: ${errorMessage(error)}`); }
    finally { setUpgrading(false); }
  };
  const readFile = async (path: string) => {
    if (!selectedId) return; const taskId = selectedId; const version = ++fileVersion.current;
    try { const next = await api.invoke('files.read', { taskId, path }); if (version === fileVersion.current && selectedRef.current === taskId) setFile(next); }
    catch (error) { if (version === fileVersion.current && selectedRef.current === taskId) setNotice(`Could not read file: ${errorMessage(error)}`); }
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
  inspectorWorker.current = taskId => { if (taskId === selectedId) refreshCurrentInspector(); };
  const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  /** One approval action. A failure is shown in the card, and Approve stays disabled until a complete read of that approval succeeds. */
  const runApprovalAction = async (approval: Approval, action: 'approve' | 'reject' | 'reconcile' | 'acknowledge', run: (taskId: string) => Promise<unknown>) => {
    if (!selectedId || approvalInFlight[approval.id]) return;
    const taskId = selectedId;
    setApprovalInFlight((current) => ({ ...current, [approval.id]: action }));
    setApprovalErrors(({ [approval.id]: _previous, ...rest }) => rest);
    try {
      await run(taskId);
      await refresh(taskId); await loadTaskDetail(taskId);
      if (action === 'approve' || action === 'reject') { announce(`${action === 'approve' ? 'Approval' : 'Rejection'} recorded for ${approval.expectedHash === null ? 'create file' : approval.tool}.`); focusAfterDecision(approval.id); }
    } catch (error) {
      setApprovalErrors((current) => ({ ...current, [approval.id]: { text: decisionFailure(action, error), state: approval.state } }));
      setIncompleteApprovalIds(current => new Set(current).add(approval.id));
      await loadApprovals(taskId);
    } finally { setApprovalInFlight((current) => { const next = { ...current }; delete next[approval.id]; return next; }); }
  };
  const decideApproval = (approval: Approval, decision: 'approve' | 'reject') => runApprovalAction(approval, decision, taskId => api.invoke('approval.decide', { taskId, approvalId: approval.id, nonce: approval.nonce, decision }));
  const reconcileApproval = (approval: Approval) => runApprovalAction(approval, 'reconcile', taskId => api.invoke('approval.reconcile', { taskId, approvalId: approval.id }));
  const acknowledgeBrowserUnknown = (approval: Approval) => approval.browser ? runApprovalAction(approval, 'acknowledge', taskId => api.invoke('browser.acknowledgeUnknown', { taskId, approvalId: approval.id, confirm: 'inspected-unknown-result' })) : Promise.resolve();
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
    let latest: number | undefined;
    const move = (next: PointerEvent) => { latest = Math.max(MIN_INSPECTOR_WIDTH, Math.min(maxWidth, startWidth + startX - next.clientX)); setInspectorWidth(latest); };
    const stop = () => { if (latest !== undefined) rememberInspectorWidth(latest, viewerStorage()); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop); separator.removeEventListener('lostpointercapture', stop); if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId); setInspectorDragging(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    window.addEventListener('blur', stop, { once: true });
    separator.addEventListener('lostpointercapture', stop, { once: true });
  };
  const resizeInspectorByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === 'ArrowLeft' ? inspectorWidth + step : event.key === 'ArrowRight' ? inspectorWidth - step : event.key === 'Home' ? MIN_INSPECTOR_WIDTH : event.key === 'End' ? maxInspectorWidth(window.innerWidth, railWidths) : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const width = clampInspectorWidth(next, window.innerWidth, railWidths);
    setInspectorWidth(width); rememberInspectorWidth(width, viewerStorage());
  };
  const openSettings = async () => {
    setCredential(''); setProbe(undefined);
    try { setProfileDraft((await api.invoke('profile.read', { profileId })) ?? OFFLINE_PROFILE); }
    catch (error) { setNotice(`Could not load profile for editing: ${errorMessage(error)}`); return; }
    void loadMcp(); showDialog(dialogRef.current);
  };
  const newProfile = () => { setProfileDraft({ id: crypto.randomUUID(), name: 'New Azure profile', apiKind: 'responses', endpoint: '', deployment: '', contextLimit: 128000, outputLimit: 8192 }); setCredential(''); setProbe(undefined); };
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setNotice('');
    try {
      const saved = await api.invoke('profile.save', { ...profileDraft, name: profileDraft.name.trim(), endpoint: profileDraft.endpoint.trim(), deployment: profileDraft.deployment.trim() });
      if (credential) await api.saveCredential(saved.id, credential);
      setCredential(''); preferencesTouched.current = true; setProfileId(saved.id); await savePreferences({ profileId: saved.id }); await refresh(); dialogRef.current?.close();
    } catch (error) { setCredential(''); setNotice(`Could not save profile: ${errorMessage(error)}`); }
  };
  const probeProfile = async () => { try { const saved = await api.invoke('profile.save', profileDraft); if (credential) await api.saveCredential(saved.id, credential); setCredential(''); setProbe(await api.invoke('profile.probe', { profileId: saved.id })); } catch (error) { setCredential(''); setProbe({ ok: false, capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false }, detail: errorMessage(error), fingerprint: '' }); } };
  const coordinatedTask = selectedTask?.mode === 'coordinated' ? selectedTask : undefined;
  const updateDialogVisibility = () => {
    const open = dialogRef.current?.open ? 'settings' : manageDialogRef.current?.open ? 'manage' : automationDialogRef.current?.open ? 'automation' : upgradeDialogRef.current?.open ? 'upgrade' : undefined;
    setOpenDialog(open); setAppDialogOpen(Boolean(open));
  };
  const showDialog = (dialog: HTMLDialogElement | null) => { dialog?.showModal(); updateDialogVisibility(); };
  // One notice at a time: inside the open dialog (so the backdrop never hides it), otherwise in the main column.
  const mainNotice = openDialog ? null : <Notice notice={notice} onDismiss={() => setNotice('')} />;
  // The live regions outside an open modal dialog are inert, so a notice inside the dialog announces itself.
  const dialogNotice = (name: typeof openDialog) => openDialog === name ? <Notice notice={notice} onDismiss={() => setNotice('')} announce /> : null;
  const draftReason = draftSendBlockReason({ schemaVersion: schema?.version, unknownOutcome: Boolean(draft.unknown), folderUnavailable: activeProject?.kind === 'unavailable', profileMissing: !configuredProfile, profileUnverified: Boolean(configuredProfile && configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt), coordinatedWithoutValidation: activeProject?.kind === 'git' && taskMode === 'coordinated' && !draft.requiredValidationCommand.trim() });
  const draftSendDisabled = !draft.content.trim() || creating || !schema || schema.version < 3 || (!draft.unknown && (activeProject?.kind === 'unavailable' || !configuredProfile || (configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt) || (activeProject?.kind === 'git' && taskMode === 'coordinated' && !draft.requiredValidationCommand.trim())));
  const canSend = Boolean(selectedId && composer.trim() && !taskBusy && !taskRetired && !publishBusy);
  const contextLine = usage ? ` · context ≈ ${usage.contextPercent}% of ${usage.contextLimit.toLocaleString()}` : '';
  // Approvals panel: live cards first, then the decided ones folded under a counted summary.
  const approvalCards = detailLoaded ? detail?.approvals ?? [] : [];
  const approvalGroups = partitionApprovals(approvalCards, approval => foldableDecided(approval, !incompleteApprovalIds.has(approval.id), approvalErrors[approval.id]?.state === approval.state), seenLiveApprovals.current);
  const commandDecisionOpen = incompleteApprovalIds.size > 0 || approvalCards.some(approval => approval.command && LIVE_APPROVAL_STATES.includes(approval.state));
  const renderApproval = (approval: Approval) => <ApprovalCard key={approval.id} variant="task" approval={approval} complete={!incompleteApprovalIds.has(approval.id)} busy={approvalInFlight[approval.id]} error={approvalErrors[approval.id]?.state === approval.state ? approvalErrors[approval.id]!.text : undefined} onDecide={(item, decision) => void decideApproval(item, decision)} onReconcile={item => void reconcileApproval(item)} onAcknowledgeBrowser={item => void acknowledgeBrowserUnknown(item)} />;
  const toolNotes = (selectedTask?.mode ?? 'chat') === 'coding' ? <ToolReadinessNotes readiness={taskProfile?.apiKind === 'fake' ? 'offline' : taskProfile?.verifiedAt && taskProfile.capabilities?.tools && taskProfile.capabilities?.continuation ? 'verified' : 'unavailable'} commandReviewHelp={COMMAND_REVIEW_HELP} hasCards={approvalCards.length > 0} commandDecisionOpen={commandDecisionOpen} /> : null;
  const olderApprovals = approvalNextBefore !== null && <button type="button" className="quiet" onClick={() => selectedId && void loadApprovals(selectedId, approvalNextBefore)}>Older approvals</button>;
  // In Focus mode (wide enough, slide-over closed) the live cards render above the composer, so a pending decision and
  // its evidence stay on screen. Only one copy is ever rendered: the inspector shows them again once it is opened.
  const trayActive = focusLayout && !compactLayout && !inspectorOpen && Boolean(selectedTask) && !isDraft && !coordinatedTask && approvalGroups.live.length > 0;
  const decisionSurface: DecisionSurface = trayActive ? 'tray' : inspectorTabInView(effectiveRightTab === 'approvals', inspector.overlay, inspectorOpen) ? 'approvals' : 'banner';
  // Announce, once per change on the open task, a new decision, a new unknown outcome and the end of a run.
  const watchedStatus = detailLoaded ? detail?.task.status : undefined;
  useAttentionAnnouncements({ taskId: detailLoaded ? selectedId : undefined, awaiting: attention.awaiting, unknown: attention.unknown, running: watchedStatus === undefined ? undefined : watchedStatus === 'running',
    finished: watchedStatus && watchedStatus !== 'running' ? watchedStatus === 'idle' ? 'Response complete.' : `Task ${taskStatusLabel[watchedStatus].toLowerCase()}.` : undefined }, decisionSurface, announce);
  // The banner names what needs a decision whenever neither the tray nor the tab that holds it is on screen.
  const bannerCandidate = attentionBanner(attention, trayActive ? cardsShown(approvalGroups.live) : undefined);
  const bannerTab = bannerCandidate?.target === 'publish' && workspaceKind === 'git' ? 'publish' : 'approvals';
  const banner = bannerCandidate && !inspectorTabInView(effectiveRightTab === bannerTab, inspector.overlay, inspectorOpen) ? bannerCandidate : undefined;
  const inboxLabel = inboxChipLabel(inboxCount);
  const toggleFocus = () => {
    const next = !focus;
    const fromHidden = next && document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('.sidebar-shell'));
    setFocus(next);
    if (next && (needsYou(attention) || inboxLabel)) announce(['Focus mode on.', needsYou(attention) ? 'This task needs your decision.' : '', inboxLabel ? `Inbox: ${inboxLabel}.` : ''].filter(Boolean).join(' '));
    if (fromHidden) requestAnimationFrame(() => document.querySelector<HTMLElement>('.focus-toggle')?.focus());
  };
  const showInbox = () => {
    setFocus(false); setSidebarView('workspace'); setInboxRequest(current => current + 1);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.workspace-views button')?.focus());
  };
  const focusControls = <FocusControls on={focusActive} onToggle={toggleFocus} needsYou={inboxLabel} onShowInbox={showInbox} />;
  focusShortcut.current = { blocked: Boolean(openDialog) || page !== 'conversation' || (inspector.overlay && inspectorOpen), toggle: toggleFocus };
  // Work elsewhere that newly needs a decision is announced only while Focus hides the Inbox.
  useEffect(() => {
    const count = inboxCount && inboxCount !== 'unavailable' ? inboxCount.needsDecision : undefined;
    const previous = announcedInbox.current;
    announcedInbox.current = count;
    if (focusActive && previous !== undefined && count !== undefined && count > previous && inboxLabel) announce(`Inbox: ${inboxLabel}.`);
  }, [inboxCount, focusActive]);
  const upgradeFeatures = schema && schema.version < 3 ? 'saved projects, new chats, detailed usage, and personal workspace history' : schema && schema.version < 4 ? 'detailed usage and personal workspace history' : 'search, archive, automation, and continuity';

  return <>
    <div className="visually-hidden" aria-live="polite">{announcement.polite}</div>
    <div className="visually-hidden" aria-live="assertive">{announcement.assertive}</div>
    {schema?.upgradeRequired && <div className="upgrade-banner" role="status">
      This database needs a verified, backed-up upgrade to v{schema.current} for {upgradeFeatures}{!schema.coordinatedAvailable ? ' and coordinated tasks' : ''}. Earlier chats remain accessible.
      <button type="button" className="secondary" onClick={() => showDialog(upgradeDialogRef.current)}>Review upgrade</button>
    </div>}
    <button type="button" className="skip-link" onClick={() => document.querySelector<HTMLElement>('.composer textarea:not(:disabled), .draft-compose > textarea:not(:disabled), .messages')?.focus()}>Skip to message box</button>
    <div className={`workspace${page === 'usage' || isDraft ? ' wide-content-workspace' : coordinatedTask ? ' coordinated-workspace' : ''}${browserExpanded && browserVisible ? ' browser-expanded' : ''}`} data-inspector={inspector.overlay ? 'overlay' : undefined} data-focus={focusLayout ? 'on' : undefined} style={{ '--inspector-width': browserExpanded && browserVisible ? 'min(74vw, calc(100vw - 325px))' : `${inspectorWidth}px` } as React.CSSProperties}>
    <div className="sidebar-shell">
      <nav className="sidebar-mode-tabs" aria-label="Sidebar sections"><button type="button" className={sidebarView === 'workspace' ? 'selected' : ''} aria-pressed={sidebarView === 'workspace'} onClick={() => setSidebarView('workspace')}>Inbox & history</button>{sidebarView === 'projects' && inboxChipLabel(inboxCount) && <span className="mode-count">{inboxChipLabel(inboxCount)}</span>}<button type="button" className={sidebarView === 'projects' ? 'selected' : ''} aria-pressed={sidebarView === 'projects'} onClick={() => setSidebarView('projects')}>Projects</button>{sidebarView === 'workspace' && <button type="button" onClick={() => selectDraft(null)}>New chat</button>}</nav>
      {sidebarView === 'projects' ? <ProjectSidebar projects={projects} tasks={snapshot.tasks} selectedId={page === 'usage' ? undefined : selectedId} draftProjectId={page === 'usage' ? undefined : draftProjectId} collapsedProjectIds={collapsedProjectIds} canAdd={Boolean(schema && schema.version >= 3)} adding={addingProject} exporting={exporting} onNew={selectDraft} onSelect={selectTask} onAdd={() => void addProject()} onManage={() => showDialog(manageDialogRef.current)} onToggle={toggleProject} onHide={(project) => void updateProject(project, { hidden: true })} onSettings={() => void openSettings()} onExport={() => void exportDiagnostics()} /> : <WorkspaceNavigation api={api} projects={projects} selectedId={selectedId} onSelect={selectTask} onAction={openAction} onSearchHit={hit => { setSearchHit(hit); selectTask(hit.rootTaskId); }} onOpenAutomation={openAutomation} canArchive={Boolean(schema && schema.version >= 5)} refreshToken={navigationVersion} onChanged={() => void refresh(selectedRef.current)} inboxRequest={inboxRequest} />}
      <nav className="sidebar-usage" aria-label="Workspace views"><button type="button" className={page === 'usage' ? 'selected' : ''} aria-current={page === 'usage' ? 'page' : undefined} onClick={() => setPage('usage')}>Usage overview <span aria-hidden="true">↗</span></button><button type="button" disabled={!schema || schema.version < 5} onClick={openAutomation}>Hooks and follow-ups</button>{sidebarView === 'workspace' && <><button type="button" onClick={() => void openSettings()}>Model settings</button><button type="button" disabled={exporting} onClick={() => void exportDiagnostics()}>Export diagnostics</button></>}</nav>
    </div>
    {page === 'usage' ? schema && schema.version >= 4 ? <UsageView api={api} refreshKey={usageRefreshKey} onOpenTask={selectTask} notice={mainNotice} /> : <section className="usage-gate" role="main" aria-label="Usage">{mainNotice}<h1>Usage</h1><p>Upgrade the database to v{schema?.current ?? 4} to view detailed request history.</p><button type="button" className="secondary" onClick={() => showDialog(upgradeDialogRef.current)}>Review upgrade</button></section> : isDraft ? <section className="conversation draft-conversation" role="main" aria-label="New chat">
      <header className="task-header"><div><p className="eyebrow" title={activeProject?.path}>{activeProject?.path ?? 'NO FOLDER'}</p><h1>New chat</h1><p className="task-status">{activeProject ? activeProject.name : 'No folder'}{activeProject?.kind === 'unavailable' ? ' · Folder unavailable' : ''}</p></div><div className="header-actions">{focusControls}</div></header>
      {mainNotice}
      <div className="draft-welcome"><span className="large-mark">F</span><h2>What would you like to work on?</h2><p>{activeProject ? 'This conversation will start in ' + activeProject.name + '.' : 'Start a conversation without folder access.'}</p></div>
      <form className="draft-compose" onSubmit={startDraft} onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
        <textarea aria-label="Chat message" placeholder="Ask a question or describe the work…" onKeyDown={sendOnShortcut(!draftSendDisabled)} value={draft.content} onChange={(event) => updateDraft({ content: event.target.value, startPayload: undefined })} disabled={creating || draft.unknown || activeProject?.kind === 'unavailable' || !schema || schema.version < 3} />
        <div className="draft-toolbar"><label>Model<select aria-label="Model" value={draftDisplayProfileId} disabled={draft.unknown} onChange={(event) => { const next = event.target.value; preferencesTouched.current = true; setProfileId(next); void savePreferences({ profileId: next }); }}>{!profiles.some((profile) => profile.id === draftDisplayProfileId) && <option value={draftDisplayProfileId}>Unavailable profile</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label>Mode<select aria-label="Mode" value={draftDisplayMode} disabled={activeProject?.kind !== 'git' || draft.unknown} onChange={(event) => { const next = event.target.value as Mode; preferencesTouched.current = true; setTaskMode(next); void savePreferences({ mode: next }); }}><option value="chat">Chat</option><option value="coding" disabled={!codingReady}>Coding</option><option value="coordinated" disabled={!coordinatedReady}>Coordinated</option></select></label><button type="button" className="draft-more" aria-expanded={moreOptions} onClick={() => setMoreOptions(!moreOptions)}>More options {moreOptions ? '⌃' : '⌄'}</button></div>
        {moreOptions && <div className="draft-options"><label>Title (optional)<input value={draft.title} maxLength={160} disabled={draft.unknown} placeholder="From first message if empty" onChange={(event) => updateDraft({ title: event.target.value, startPayload: undefined })} /></label>{activeProject?.kind === 'git' && draftDisplayMode === 'coordinated' && <><label>Required validation command<textarea value={draft.requiredValidationCommand} maxLength={16384} disabled={draft.unknown} onChange={(event) => updateDraft({ requiredValidationCommand: event.target.value, startPayload: undefined })} /></label><label>Token budget<input type="number" min={1024} max={10000000} value={draft.coordinatedBudget} disabled={draft.unknown} onChange={(event) => updateDraft({ coordinatedBudget: Number(event.target.value), startPayload: undefined })} /></label><fieldset className="child-profiles" disabled={draft.unknown}><legend>Child profiles</legend>{availableChildProfiles.map((profile) => <label key={profile.id} className="checkbox-row"><input type="checkbox" checked={draft.childProfileIds.includes(profile.id)} disabled={!draft.childProfileIds.includes(profile.id) && draft.childProfileIds.length >= ORCHESTRATION_LIMITS.maxChildProfiles} onChange={(event) => updateDraft({ childProfileIds: event.target.checked ? [...draft.childProfileIds, profile.id] : draft.childProfileIds.filter((id) => id !== profile.id), startPayload: undefined })} />{profile.name}</label>)}{!availableChildProfiles.length && <p className="muted">Children reuse the coordinator profile.</p>}</fieldset></>}</div>}
        {draftDisplayMode === 'coding' && <p className="tool-readiness" data-testid="command-review-limits">{COMMAND_REVIEW_HELP}</p>}
        {moreOptions && draftDisplayMode !== 'coordinated' && <label>Token budget<input type="number" min={1024} max={10000000} value={draft.tokenBudget} disabled={draft.unknown} onChange={event => updateDraft({ tokenBudget: Number(event.target.value), startPayload: undefined })} /></label>}
        {draft.scopeGuidance.length > 0 && <p className="draft-warning">Scope guidance appended to the prompt: {draft.scopeGuidance.join(', ')}. This grants no filesystem access.</p>}
        {profilesLoading && <p className="muted" role="status">Loading saved model profiles…</p>}
        {profilesError && <p className="draft-warning" role="alert">Could not load all model profiles: {profilesError}</p>}
        {draftReason && <p id="draft-send-reason" className={schema ? 'draft-warning' : 'muted'}>{draftReason}</p>}
        {draft.unknown && <p className="draft-warning">The start outcome is unknown. Check the project chat list first. Retry uses the original message and settings. <button type="button" className="secondary" onClick={() => updateDraft({ startPayload: undefined, unknown: false })}>Start fresh draft</button></p>}
        <button type="submit" className="primary draft-send" disabled={draftSendDisabled} aria-describedby={draftReason ? 'draft-send-reason' : undefined} aria-keyshortcuts="Control+Enter" title="Send (Ctrl+Enter)">{creating ? 'Starting…' : draft.unknown ? 'Retry same request' : <>Send<span className="shortcut-hint" aria-hidden="true">Ctrl+Enter</span></>}</button>
      </form>
      {schema && schema.version >= 5 && <details className="template-disclosure">
        <summary>Templates</summary>
        <TemplatePicker api={api} current={{ prompt: draft.content, mode: activeProject?.kind === 'git' ? taskMode : 'chat', profileId, tokenBudget: taskMode === 'coordinated' ? draft.coordinatedBudget : draft.tokenBudget, scope: draft.scopeGuidance, ...(taskMode === 'coordinated' && activeProject?.kind === 'git' ? { coordination: { childProfileIds: draft.childProfileIds, requiredValidation: { command: draft.requiredValidationCommand, cwd: '', timeoutMs: 600000 } } } : {}) }} onApply={template => {
        updateDraft({ content: template.prompt, tokenBudget: template.tokenBudget, coordinatedBudget: template.tokenBudget, scopeGuidance: template.scope, childProfileIds: template.coordination?.childProfileIds ?? [], requiredValidationCommand: template.coordination?.requiredValidation.command ?? '', startPayload: undefined });
        if (profiles.some(profile => profile.id === template.profileId)) { setProfileId(template.profileId); void savePreferences({ profileId: template.profileId }); }
        else setNotice('Template profile is unavailable. Choose a model before sending.', 'warning');
        if (activeProject?.kind === 'git' || template.mode === 'chat') { setTaskMode(template.mode); void savePreferences({ mode: template.mode }); }
        else setNotice('This folder supports chat mode only. Review the template prompt before sending.', 'warning');
        setMoreOptions(true);
      }} setNotice={setNotice} />
      </details>}
    </section> : coordinatedTask ? <CoordinatedTaskView api={api} task={coordinatedTask} profiles={profiles} notice={mainNotice} setNotice={setNotice} composer={composerDrafts[coordinatedTask.id] ?? ''} setComposer={text => setComposerFor(coordinatedTask.id, text)} onWorkspaceRefresh={() => void refresh(coordinatedTask.id)} onTaskCreated={task => { setSnapshot(current => ({ ...current, tasks: [task, ...current.tasks.filter(item => item.id !== task.id)] })); void refresh(task.id); }} focusAction={focusAction} searchHit={searchHit} announce={announce} focus={focusActive} focusControls={focusControls} /> : <>
    <section className="conversation" role="main" aria-label="Conversation" data-attention={needsYou(attention) ? 'decision' : undefined}>
      <header className="task-header">{selectedTask ? <><div><p className="eyebrow" title={selectedTask.projectPath || undefined}>{selectedTask.projectPath || 'NO FOLDER'}</p><h1>{selectedTask.title}</h1><p className={`task-status ${awaitingApproval ? 'awaiting' : selectedTask.status}${statusWarningWords.length ? ' warning' : ''}`}><span className="task-state">{taskModeLabel} · {awaitingApproval ? 'Waiting for your approval' : taskStatusLabel[selectedTask.status]}{attention.unknown > 0 ? ' · outcome unknown' : ''}</span> · <span className="task-metrics">{selectedTask.usedTokens.toLocaleString()} / {selectedTask.tokenBudget.toLocaleString()} charged/reserved tokens{contextLine}{statusWarningWords.map(word => ` · ${word}`).join('')}</span></p></div><div className="header-actions">{focusControls}<button ref={inspector.toggleRef} type="button" className="secondary inspector-open" aria-controls="task-inspector" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(true)}>{inspectLabel(attention)}</button>{selectedTask.status === 'running' && <button className="danger" onClick={() => void cancel()}>Cancel task</button>}{!taskBusy && !taskRetired && <button type="button" className={statusWarningWords.includes('context warning') ? 'secondary' : 'secondary subdued'} disabled={compacting} onClick={() => void compact()}>{compacting ? 'Compacting…' : 'Compact context'}</button>}</div></> : <><div><p className="eyebrow">FOUNDATION</p><h1>A considered local workspace.</h1></div><div className="header-actions">{focusControls}</div></>}</header>
      {mainNotice}
      <Transcript messages={detail?.messages ?? []} compactions={compactions} ordinals={messageOrdinals.current} awaitingApproval={awaitingApproval} api={api} taskId={selectedId} empty={!selectedTask ? <div className="empty-state"><span className="large-mark">F</span><h2>Start with a local project.</h2><p>Create a task to send a focused brief to a configured model. The default offline profile helps you explore the workspace; it does not execute tools or delegate work.</p></div> : <div className="empty-state"><h2>{awaitingApproval ? 'Awaiting approval.' : selectedTask.status === 'running' ? 'Receiving response…' : 'Set the direction.'}</h2><p>{awaitingApproval ? trayActive ? 'Review the proposed tool action in Pending actions, above the message box, before it can continue.' : 'Review the proposed tool action in the Approvals panel before it can continue.' : selectedTask.status === 'running' ? 'The response is being checked locally before it is shown here.' : 'Describe the outcome, constraints, and the files or behavior that matter.'}</p></div>} />
      {messageNextBefore !== null && <button type="button" className="quiet older-messages" onClick={() => void loadOlderMessages()}>Load older messages</button>}
      {trayActive && <ApprovalTray shown={cardsShown(approvalGroups.live)} notes={toolNotes}>{trayOrder(approvalGroups.live).map(renderApproval)}</ApprovalTray>}
      {banner && <AttentionBannerView banner={banner} onReview={() => { setRightTab(bannerTab); if (inspector.overlay) setInspectorOpen(true); }} />}
      <form className="composer" onSubmit={send}>
        <textarea value={composer} onChange={(e) => setComposer(e.target.value)} onKeyDown={sendOnShortcut(canSend, () => announce(taskBusy ? awaitingApproval ? 'Send is unavailable until you decide the pending action or cancel the task.' : 'Send is available when the agent finishes, or cancel the task.' : 'Nothing to send yet.'))} disabled={!selectedId || taskRetired || Boolean(publishBusy)} aria-label="Task message"
          placeholder={selectedId ? taskRetired ? 'This task worktree is retired. Create a new task to continue.' : taskBusy ? awaitingApproval ? `Waiting for your decision${decisionWhere(decisionSurface)} You can write your next message meanwhile.` : 'The agent is working. Write your next message; Send is available when it finishes, or cancel to change direction.' : publishBusy ? 'Wait for the Git operation to finish…' : 'Message this task…' : 'Create or select a task to begin.'} />
        <button className="primary" disabled={!canSend} aria-keyshortcuts="Control+Enter" title="Send (Ctrl+Enter)">Send<span className="shortcut-hint" aria-hidden="true">Ctrl+Enter</span></button>
      </form>
    </section>
    <div className="inspector-resize" role="separator" aria-label="Resize inspector" aria-orientation="vertical" tabIndex={0} aria-valuenow={inspectorWidth} aria-valuemin={MIN_INSPECTOR_WIDTH} aria-valuemax={maxInspectorWidth(window.innerWidth, railWidths)} aria-valuetext={`Inspector ${inspectorWidth} pixels wide`} onPointerDown={beginInspectorResize} onKeyDown={resizeInspectorByKey} />
    <aside id="task-inspector" className={`inspector${inspectorOpen ? ' open' : ''}`} aria-label="Task inspector" {...inspector.asideProps}>
      <button ref={inspector.closeRef} type="button" className="inspector-close" onClick={() => setInspectorOpen(false)}>Close inspector</button>
      <div className="inspector-tabs" role="group" aria-label="Inspector sections">{([
        ['files', 'Files', workspaceKind !== 'none'], ['changes', 'Changes', workspaceKind === 'git'], ['approvals', approvalsLabel, true], ['activity', 'Activity', true],
        ['continuity', 'Continue', true], ['usage', 'Usage', true], ['publish', unknownPublication ? 'Publish (outcome unknown)' : 'Publish', workspaceKind === 'git'], ['browser', 'Browser', true]
      ] as const).filter(([, , shown]) => shown).map(([id, label]) => <button key={id} type="button" className={effectiveRightTab === id ? 'active' : ''} aria-pressed={effectiveRightTab === id} onClick={() => setRightTab(id)}>{label}</button>)}
      {workspaceKind === 'git' && <button type="button" className={`channel-tab ${effectiveRightTab === 'channel' ? 'active' : ''}`} aria-pressed={effectiveRightTab === 'channel'} onClick={() => setRightTab('channel')}>Project channel</button>}</div>
      {effectiveRightTab === 'browser' ? <><div className="browser-expand"><button type="button" onClick={() => setBrowserExpanded((current) => !current)}>{browserExpanded ? 'Reduce browser' : 'Expand browser'}</button></div><BrowserPanel api={api} taskId={selectedId} profileName={taskProfile?.name} eligible={Boolean(taskProfile && isProfileReady(taskProfile) && selectedTask?.mode !== 'coordinated' && selectedTask?.status !== 'retired')} hidden={appDialogOpen || inspectorDragging || !browserVisible} onNotice={setNotice} /></> : !selectedId ? <p className="muted inspector-empty">Select a chat to inspect it.</p> : effectiveRightTab === 'channel' ? <AgentChannelPanel key={selectedId} api={api} taskId={selectedId} /> : effectiveRightTab === 'activity' ? <TaskActivity api={api} taskId={selectedId} refreshToken={navigationVersion} unknownOutcomes={unknownOutcomes} /> : effectiveRightTab === 'continuity' ? <ContinuityPanel api={api} taskId={selectedId} messages={detail?.messages ?? []} profiles={profiles} onCreated={task => { setSnapshot(current => ({ ...current, tasks: [task, ...current.tasks] })); selectTask(task.id); void refresh(task.id); }} setNotice={setNotice} /> : effectiveRightTab === 'files' ? <>
        <div className="inspector-tools"><button type="button" onClick={() => browseDirectory('')} disabled={!currentPath}>Root</button><span title={currentPath || (workspaceKind === 'folder' ? 'Folder root' : 'Repository root')}>{currentPath || (workspaceKind === 'folder' ? 'Folder root' : 'Repository root')}</span><button type="button" onClick={refreshCurrentInspector}>Refresh</button></div>
        <div className="file-tree">
          {currentPath && <button type="button" className="up-directory" onClick={() => browseDirectory(parentPath)}><span>←</span>Up</button>}
          {files.map((entry) => <button key={entry.path} type="button" className={file?.path === entry.path ? 'active-file' : ''} onClick={() => entry.kind === 'directory' ? browseDirectory(entry.path) : void readFile(entry.path)}><span>{entry.kind === 'directory' ? '▸' : '·'}</span>{entry.path}</button>)}
          {!files.length && <p className="muted">No files here.</p>}
        </div>
        <div className="file-content"><p>{file?.path ?? 'Choose a file to read'}</p><pre>{file?.content}</pre></div>
      </> : effectiveRightTab === 'changes' ? <div className="patch">{!diff && diffError ? <div className="load-error" role="alert"><p>Could not load changes: {diffError}</p><button type="button" className="secondary" onClick={refreshCurrentInspector}>Retry</button></div> : <p>{diffSummaryText(diff)}</p>}{diff?.patch && <PatchText patch={diff.patch} />}</div> : effectiveRightTab === 'usage' ? <div className="usage-panel" data-testid="usage-panel">
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
        </> : usageError ? <div className="load-error inspector-empty" role="alert"><p>Could not load usage: {usageError}</p><button type="button" className="secondary" onClick={() => selectedId && void loadTaskDetail(selectedId)}>Retry</button></div> : <p className="muted inspector-empty">Loading usage…</p>}
      </div> : effectiveRightTab === 'publish' ? <div className="publish-panel" data-testid="publish-panel">
        <p className="tool-readiness">Commit, push and retirement are explicit actions you take here. The agent never proposes or runs them. Push uses your Git credential helper for this action only and never forces.</p>
        {selectedTask?.mode === 'coordinated' ? <p className="muted">Coordinated worktrees are integrated through reviewed operations; retire the root once every run is terminal.</p> : <>
          <label>Commit message <textarea value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Describe the change" maxLength={2000} disabled={Boolean(publishBusy) || taskBusy || taskRetired} /></label>
          <div className="approval-actions"><button type="button" className="primary" disabled={Boolean(publishBusy) || taskBusy || taskRetired || !commitMessage.trim()} onClick={() => void commit()}>{publishBusy === 'commit' ? 'Committing…' : 'Commit all changes'}</button><small>Stages every change in the task worktree except secret-named paths; hooks stay disabled.</small></div>
          <label>Remote <input value={pushRemote} onChange={(e) => setPushRemote(e.target.value)} maxLength={64} disabled={Boolean(publishBusy) || taskBusy || taskRetired} /></label>
          <div className="approval-actions">{confirmAction === 'push' ? <><button type="button" className="danger" disabled={Boolean(publishBusy)} onClick={() => void push()}>Confirm push to {pushRemote || 'origin'}</button><button type="button" className="secondary" onClick={() => setConfirmAction(undefined)}>Keep local</button></> : <button type="button" className="secondary" disabled={Boolean(publishBusy) || taskBusy || taskRetired} onClick={() => setConfirmAction('push')}>{publishBusy === 'push' ? 'Pushing…' : 'Push branch…'}</button>}<small>Publishes {selectedTask?.branch} to the remote configured in the project repository.</small></div>
        </>}
        {unknownPublication && <div className="command-evidence">
          <strong>Unknown publication outcome</strong>
          <p>A Git commit or push ended with an unknown outcome. Reconcile publication state before continuing.</p>
          <div className="approval-actions"><button type="button" className="primary" disabled={Boolean(publishBusy)} onClick={() => void reconcilePublication()}>{publishBusy === 'reconcile' ? 'Checking…' : 'Check publication outcome'}</button></div>
        </div>}
        <h3>Publication outcome</h3>
        <div className="approval-actions"><button type="button" className="secondary" disabled={Boolean(publishBusy) || taskBusy || taskRetired} onClick={() => void reconcilePublication()}>{publishBusy === 'reconcile' ? 'Checking…' : 'Check publication outcome'}</button><small>Verifies whether an interrupted or timed-out commit or push succeeded in Git, without retrying.</small></div>
        <h3>Retire worktree</h3>
        <div className="approval-actions">{confirmAction === 'retire' ? <><button type="button" className="danger" disabled={Boolean(publishBusy)} onClick={() => void retire()}>Confirm retire (clean worktrees only)</button><button type="button" className="secondary" onClick={() => setConfirmAction(undefined)}>Keep worktree</button></> : <button type="button" className="secondary" disabled={Boolean(publishBusy) || taskBusy || taskRetired} onClick={() => setConfirmAction('retire')}>{publishBusy === 'retire' ? 'Retiring…' : taskRetired ? 'Retired' : 'Retire worktree…'}</button>}<small>Removes the app-owned worktree directory only when Git proves it has no uncommitted or untracked files. The branch, commits, history and evidence remain.</small></div>
        {taskRetired && <p className="muted">Retired{selectedTask?.retiredAt ? ` ${relativeTime(selectedTask.retiredAt)}` : ''}.</p>}
      </div> : <div className="approvals-panel">
        {!trayActive && toolNotes}
        {!trayActive && approvalGroups.live.map(renderApproval)}
        {approvalGroups.decided.length > 0 && <Disclosure className="decided-approvals" summary={disclosureLabel('Decided approvals', approvalGroups.decided.length, { more: approvalNextBefore !== null, detail: decidedSummaryDetail(approvalGroups.decided) })} forceOpen={focusAction?.kind === 'approval' && approvalGroups.decided.some(item => item.id === focusAction.sourceId)}>
          {approvalGroups.decided.map(renderApproval)}
        </Disclosure>}
        {!approvalCards.length && <p className="muted inspector-empty">No reviewed tool actions are queued.</p>}
        {olderApprovals}
      </div>}
    </aside>
    </>}
    <dialog ref={manageDialogRef} className="settings-dialog manage-dialog" aria-labelledby="manage-projects-title" onToggle={updateDialogVisibility}>
      <div className="dialog-head"><div><p className="eyebrow">SAVED FOLDERS</p><h2 id="manage-projects-title">Manage projects</h2></div><button type="button" className="secondary" onClick={() => manageDialogRef.current?.close()}>Close</button></div>
      {dialogNotice('manage')}
      <div className="manage-list">{projects.map((project) => <form key={`${project.id}:${project.updatedAt}`} className="manage-project" onSubmit={(event) => { event.preventDefault(); const name = new FormData(event.currentTarget).get('name'); if (typeof name === 'string' && name.trim() && name.trim() !== project.name) void updateProject(project, { name: name.trim() }); }}><div><label>Name for {project.name}<input name="name" aria-label={`Name for ${project.name}`} defaultValue={project.name} maxLength={100} required /></label><small title={project.path}>{project.path}</small>{project.kind === 'unavailable' && <span className="project-unavailable-note">Folder unavailable</span>}</div><div className="manage-actions"><button type="submit" className="secondary">Save name</button><button type="button" className="secondary" onClick={() => void updateProject(project, { hidden: !project.hidden })}>{project.hidden ? `Restore ${project.name}` : `Hide ${project.name}`}</button></div></form>)}{!projects.length && <p className="muted">No saved projects yet.</p>}</div>
    </dialog>
    <dialog ref={dialogRef} className="settings-dialog" aria-labelledby="model-profile-title" onToggle={updateDialogVisibility} onClose={() => setCredential('')}>
      <form method="dialog" className="dialog-head">
        <div><p className="eyebrow">CONNECTIONS</p><h2 id="model-profile-title">Model profile</h2></div>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={newProfile}>New profile</button><button type="submit" className="secondary">Close settings</button></div>
      </form>
      {dialogNotice('settings')}
      <AppearanceSettings theme={theme} onChange={chooseTheme} style={style} onStyleChange={chooseStyle} />
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
    <dialog ref={automationDialogRef} className="settings-dialog automation-dialog" aria-labelledby="automation-title" onClose={event => { if (event.target === event.currentTarget) { setAutomationOpen(false); updateDialogVisibility(); } }}><div className="dialog-actions"><button type="button" className="secondary" onClick={() => automationDialogRef.current?.close()}>Close hooks and follow-ups</button></div>{dialogNotice('automation')}{automationOpen && <AutomationSettings api={api} onDraft={useAutomationDraft} onPrepared={(draft, approvalId) => void openPreparedApproval(draft, approvalId)} setNotice={setNotice} />}</dialog>
    <dialog ref={upgradeDialogRef} className="settings-dialog upgrade-dialog" aria-labelledby="upgrade-title" onToggle={updateDialogVisibility}>
      <div className="dialog-head"><div><p className="eyebrow">DATABASE UPGRADE</p><h2 id="upgrade-title">Back up and upgrade</h2></div></div>
      {dialogNotice('upgrade')}
      <div className="profile-form">
        <p>This creates a verified SQLite backup, then upgrades the database to v{schema?.current ?? 5} for {upgradeFeatures}{!schema?.coordinatedAvailable ? ' and coordinated tasks' : ''}. Earlier chats remain available during the upgrade decision. Keep the backup to open the previous database with an older application.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => upgradeDialogRef.current?.close()}>Keep current database</button>
          <button type="button" className="primary" disabled={upgrading} onClick={() => void confirmUpgrade()}>{upgrading ? 'Upgrading…' : 'Create backup and upgrade'}</button>
        </div>
      </div>
    </dialog>
  </div>
  </>;
}

export default App;
