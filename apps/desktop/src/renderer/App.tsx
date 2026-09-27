import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, CompactionRecord, DesktopApi, DiffResult, FileContent, FileEntry, McpServerStatus, ModelProfile, ProbeResult, Project, SchemaStatus, Snapshot, TaskDetail, TaskStatus, UsageReport } from '../../../../packages/protocol/src/index';
import { ORCHESTRATION_LIMITS, supportedEfforts } from '../../../../packages/protocol/src/index';
import { CoordinatedTaskView } from './Orchestration';
import { AgentChannelPanel } from './AgentChannel';
import { McpSettings } from './McpSettings';
import { UsageView } from './Usage';
import { ProjectSidebar } from './ProjectSidebar';

declare global { interface Window { workspace: DesktopApi; } }

const OFFLINE_PROFILE: ModelProfile = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'local demo',
  contextLimit: 128000, outputLimit: 8192
};

const statusLabel: Record<TaskStatus, string> = { idle: 'Ready', running: 'Working', cancelled: 'Cancelled', interrupted: 'Interrupted', failed: 'Needs attention', retired: 'Retired' };
const emptySnapshot: Snapshot = { tasks: [], profiles: [], projects: [], preferences: { profileId: OFFLINE_PROFILE.id, mode: 'chat', collapsedProjectIds: [] }, lastSequence: 0, runtime: 'ready' };
type Mode = 'chat' | 'coding' | 'coordinated';
interface StartPayload { requestId: string; projectId: string | null; content: string; title?: string; profileId: string; mode: Mode; tokenBudget: number; coordination?: { childProfileIds: string[]; requiredValidation: { command: string; cwd: string; timeoutMs: number } }; }
interface Draft { content: string; title: string; requiredValidationCommand: string; coordinatedBudget: number; childProfileIds: string[]; startPayload?: StartPayload; pending?: boolean; unknown?: boolean; }
const blankDraft = (): Draft => ({ content: '', title: '', requiredValidationCommand: '', coordinatedBudget: 600000, childProfileIds: [] });
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
  const [selectedId, setSelectedId] = useState<string>();
  const [page, setPage] = useState<'conversation' | 'usage'>('conversation');
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [detail, setDetail] = useState<TaskDetail>();
  const [usage, setUsage] = useState<UsageReport>();
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
  const [rightTab, setRightTab] = useState<'files' | 'changes' | 'approvals' | 'usage' | 'publish' | 'channel'>('files');
  const [profileDraft, setProfileDraft] = useState<ModelProfile>(OFFLINE_PROFILE);
  const [credential, setCredential] = useState('');
  const [probe, setProbe] = useState<ProbeResult>();
  const [approvalInFlight, setApprovalInFlight] = useState<Record<string, 'approve' | 'reject' | 'reconcile'>>({});
  const [upgrading, setUpgrading] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [pushRemote, setPushRemote] = useState('origin');
  const [publishBusy, setPublishBusy] = useState<'commit' | 'push' | 'retire' | 'reconcile' | undefined>();
  const [confirmAction, setConfirmAction] = useState<'push' | 'retire' | undefined>();
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [exporting, setExporting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const upgradeDialogRef = useRef<HTMLDialogElement>(null);
  const fileVersion = useRef(0);
  const inspectorVersion = useRef(0);
  const detailVersion = useRef(0);
  const snapshotVersion = useRef(0);
  const preferencesLoaded = useRef(false);
  const preferencesTouched = useRef(false);
  const selectionVersion = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  const draftProjectRef = useRef<string | null | undefined>(null);
  const currentPathRef = useRef('');
  const sequenceRef = useRef(0);
  const eventSequenceRef = useRef(0);
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
  const effectiveRightTab = (workspaceKind === 'git' || rightTab === 'usage' || (workspaceKind === 'folder' && rightTab === 'files')) ? rightTab : 'usage';
  const configuredProfile = profiles.find((profile) => profile.id === profileId);
  const taskProfile = selectedTask ? profiles.find((profile) => profile.id === selectedTask.profileId) : undefined;
  const isProfileReady = (profile: ModelProfile): boolean => profile.apiKind === 'fake' || Boolean(profile.verifiedAt && profile.capabilities?.tools && profile.capabilities?.continuation);
  const codingReady = Boolean(configuredProfile && isProfileReady(configuredProfile));
  const coordinatedAvailable = Boolean(schema?.coordinatedAvailable);
  const coordinatedReady = coordinatedAvailable && codingReady;
  const availableChildProfiles = profiles.filter((profile) => profile.id !== profileId && isProfileReady(profile));
  const taskModeLabel = (selectedTask?.mode ?? 'chat') === 'coding' ? 'Coding with reviewed tools' : (selectedTask?.mode ?? 'chat') === 'coordinated' ? 'Coordinated' : 'Chat';
  const awaitingApproval = detail?.approvals?.some((approval) => approval.state === 'awaiting-approval') ?? false;
  const isBuiltinProfile = profileDraft.id === OFFLINE_PROFILE.id;
  const taskRetired = selectedTask?.status === 'retired';
  const taskBusy = selectedTask?.status === 'running';
  const compactionByMessage = useMemo(() => {
    const map = new Map<string, CompactionRecord>();
    for (const record of detail?.compactions ?? []) for (const id of record.messageIds) map.set(id, record);
    return map;
  }, [detail?.compactions]);

  const loadTaskDetail = useCallback(async (taskId: string) => {
    const version = ++detailVersion.current;
    try {
      const [nextDetail, nextUsage] = await Promise.all([api.invoke('task.get', { taskId }), api.invoke('task.usage', { taskId }).catch(() => undefined)]);
      if (version === detailVersion.current && selectedRef.current === taskId) { setDetail(nextDetail); setUsage(nextUsage); }
    } catch (error) {
      if (version === detailVersion.current && selectedRef.current === taskId) setNotice(`Could not load task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);

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
    try { setMcpServers(await api.invoke('mcp.list', {})); }
    catch (error) { setNotice(`Could not load MCP servers: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api]);

  const refresh = useCallback(async (selection = selectedRef.current) => {
    const version = ++snapshotVersion.current;
    try {
      const [fresh, nextSchema] = await Promise.all([api.invoke('workspace.snapshot', {}), api.invoke('workspace.schema', {})]);
      if (version !== snapshotVersion.current) return;
      sequenceRef.current = fresh.lastSequence;
      setSnapshot(fresh);
      setSchema(nextSchema);
      if (!preferencesLoaded.current && fresh.preferences) {
        preferencesLoaded.current = true;
        if (!preferencesTouched.current) { setProfileId(fresh.preferences.profileId); setTaskMode(fresh.preferences.mode); }
        setCollapsedProjectIds(fresh.preferences.collapsedProjectIds);
      }
      const next = selection && fresh.tasks.some((task) => task.id === selection) ? selection : undefined;
      if (draftProjectRef.current !== undefined) return;
      if (next !== selectedRef.current) setSelectedId(next);
      else if (next) void loadTaskDetail(next);
      if (fresh.lastSequence < eventSequenceRef.current) void refresh(next);
    } catch (error) { setNotice(`Could not refresh workspace: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, loadTaskDetail]);

  useEffect(() => { void refresh(); void loadMcp(); }, [refresh, loadMcp]);
  useEffect(() => api.onEvent((event) => {
    eventSequenceRef.current = Math.max(eventSequenceRef.current, event.sequence);
    if (event.type === 'usage.changed' || event.type === 'task.completed' || event.type === 'task.stopped' || event.type === 'profiles.changed') setUsageRefreshKey(value => value + 1);
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
    }
    if (event.sequence > sequenceRef.current) void refresh(selectedRef.current);
  }), [api, refresh, loadMcp]);

  useEffect(() => {
    if (!selectedId) { ++detailVersion.current; ++inspectorVersion.current; setDetail(undefined); setUsage(undefined); setFiles([]); setFile(undefined); setDiff(undefined); setCurrentPath(''); return; }
    ++fileVersion.current;
    currentPathRef.current = '';
    setCurrentPath(''); setDetail(undefined); setUsage(undefined); setFile(undefined); setDiff(undefined); setConfirmAction(undefined);
    void loadTaskDetail(selectedId);
    const kind = snapshot.tasks.find((task) => task.id === selectedId)?.workspaceKind ?? 'git';
    void refreshInspector(selectedId, '', kind);
  }, [loadTaskDetail, refreshInspector, loadFiles, selectedId]);

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
    const payload: StartPayload = draft.unknown && draft.startPayload ? draft.startPayload : { requestId: crypto.randomUUID(), projectId: draftProjectId ?? null, content: draft.content.trim(), title: draft.title.trim() || undefined, profileId, mode,
      tokenBudget: mode === 'coordinated' ? draft.coordinatedBudget : 100000,
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
  const openSettings = () => { const profile = profiles.find((item) => item.id === profileId) ?? OFFLINE_PROFILE; setProfileDraft(profile); setCredential(''); setProbe(undefined); void loadMcp(); dialogRef.current?.showModal(); };
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
  const contextLine = usage ? ` · context ≈ ${usage.contextPercent}% of ${usage.contextLimit.toLocaleString()}` : '';

  return <>
    {schema?.upgradeRequired && <div className="upgrade-banner" role="status">
      This database needs a verified, backed-up upgrade to v{schema.current} for {schema.version < 3 ? 'saved projects, new chats, and detailed usage tracking' : 'detailed usage tracking'}{!schema.coordinatedAvailable ? ' and coordinated tasks' : ''}. Earlier chats remain accessible.
      <button type="button" className="secondary" onClick={() => upgradeDialogRef.current?.showModal()}>Review upgrade</button>
    </div>}
    <main className="workspace">
    <div className="sidebar-shell"><ProjectSidebar projects={projects} tasks={snapshot.tasks} selectedId={page === 'usage' ? undefined : selectedId} draftProjectId={page === 'usage' ? undefined : draftProjectId} collapsedProjectIds={collapsedProjectIds} canAdd={Boolean(schema && schema.version >= 3)} adding={addingProject} exporting={exporting} onNew={selectDraft} onSelect={selectTask} onAdd={() => void addProject()} onManage={() => manageDialogRef.current?.showModal()} onToggle={toggleProject} onHide={(project) => void updateProject(project, { hidden: true })} onSettings={openSettings} onExport={() => void exportDiagnostics()} /><nav className="sidebar-usage" aria-label="Workspace views"><button type="button" className={page === 'usage' ? 'selected' : ''} aria-current={page === 'usage' ? 'page' : undefined} onClick={() => setPage('usage')}>Usage overview <span aria-hidden="true">↗</span></button></nav></div>
    {page === 'usage' ? schema && schema.version >= 4 ? <UsageView api={api} refreshKey={usageRefreshKey} onOpenTask={selectTask} /> : <section className="usage-gate"><h1>Usage</h1><p>Upgrade the database to v{schema?.current ?? 4} to view detailed request history.</p><button type="button" className="secondary" onClick={() => upgradeDialogRef.current?.showModal()}>Review upgrade</button></section> : isDraft ? <section className="conversation draft-conversation">
      <header className="task-header"><div><p className="eyebrow">{activeProject?.path ?? 'NO FOLDER'}</p><h1>New chat</h1><p className="task-status">{activeProject ? activeProject.name : 'No folder'}{activeProject?.kind === 'unavailable' ? ' · Folder unavailable' : ''}</p></div></header>
      {notice && <div className="notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
      <div className="draft-welcome"><span className="large-mark">F</span><h2>What would you like to work on?</h2><p>{activeProject ? 'This conversation will start in ' + activeProject.name + '.' : 'Start a conversation without folder access.'}</p></div>
      <form className="draft-compose" onSubmit={startDraft}>
        <textarea aria-label="Chat message" placeholder="Ask a question or describe the work…" value={draft.content} onChange={(event) => updateDraft({ content: event.target.value, startPayload: undefined })} disabled={creating || draft.unknown || activeProject?.kind === 'unavailable' || !schema || schema.version < 3} />
        <div className="draft-toolbar"><label>Model<select aria-label="Model" value={draftDisplayProfileId} disabled={draft.unknown} onChange={(event) => { const next = event.target.value; preferencesTouched.current = true; setProfileId(next); void savePreferences({ profileId: next }); }}>{!profiles.some((profile) => profile.id === draftDisplayProfileId) && <option value={draftDisplayProfileId}>Unavailable profile</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label>Mode<select aria-label="Mode" value={draftDisplayMode} disabled={activeProject?.kind !== 'git' || draft.unknown} onChange={(event) => { const next = event.target.value as Mode; preferencesTouched.current = true; setTaskMode(next); void savePreferences({ mode: next }); }}><option value="chat">Chat</option><option value="coding" disabled={!codingReady}>Coding</option><option value="coordinated" disabled={!coordinatedReady}>Coordinated</option></select></label><button type="button" className="draft-more" aria-expanded={moreOptions} onClick={() => setMoreOptions(!moreOptions)}>More options {moreOptions ? '⌃' : '⌄'}</button></div>
        {moreOptions && <div className="draft-options"><label>Title (optional)<input value={draft.title} maxLength={160} disabled={draft.unknown} placeholder="From first message if empty" onChange={(event) => updateDraft({ title: event.target.value, startPayload: undefined })} /></label>{activeProject?.kind === 'git' && draftDisplayMode === 'coordinated' && <><label>Required validation command<textarea value={draft.requiredValidationCommand} maxLength={16384} disabled={draft.unknown} onChange={(event) => updateDraft({ requiredValidationCommand: event.target.value, startPayload: undefined })} /></label><label>Token budget<input type="number" min={1024} max={10000000} value={draft.coordinatedBudget} disabled={draft.unknown} onChange={(event) => updateDraft({ coordinatedBudget: Number(event.target.value), startPayload: undefined })} /></label><fieldset className="child-profiles" disabled={draft.unknown}><legend>Child profiles</legend>{availableChildProfiles.map((profile) => <label key={profile.id} className="checkbox-row"><input type="checkbox" checked={draft.childProfileIds.includes(profile.id)} disabled={!draft.childProfileIds.includes(profile.id) && draft.childProfileIds.length >= ORCHESTRATION_LIMITS.maxChildProfiles} onChange={(event) => updateDraft({ childProfileIds: event.target.checked ? [...draft.childProfileIds, profile.id] : draft.childProfileIds.filter((id) => id !== profile.id), startPayload: undefined })} />{profile.name}</label>)}{!availableChildProfiles.length && <p className="muted">Children reuse the coordinator profile.</p>}</fieldset></>}</div>}
        {!configuredProfile && <p className="draft-warning">The saved model profile is unavailable. Choose a profile before sending.</p>}
        {configuredProfile && configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt && <p className="draft-warning">Verify this profile in Model settings before sending.</p>}
        {draft.unknown && <p className="draft-warning">The start outcome is unknown. Check the project chat list first. Retry uses the original message and settings. <button type="button" className="secondary" onClick={() => updateDraft({ startPayload: undefined, unknown: false })}>Start fresh draft</button></p>}
        <button type="submit" className="primary draft-send" disabled={!draft.content.trim() || creating || !schema || schema.version < 3 || (!draft.unknown && (activeProject?.kind === 'unavailable' || !configuredProfile || (configuredProfile.apiKind !== 'fake' && !configuredProfile.verifiedAt) || (activeProject?.kind === 'git' && taskMode === 'coordinated' && !draft.requiredValidationCommand.trim())))}>{creating ? 'Starting…' : draft.unknown ? 'Retry same request' : 'Send'}</button>
      </form>
    </section> : coordinatedTask ? <CoordinatedTaskView api={api} task={coordinatedTask} notice={notice} setNotice={setNotice} onWorkspaceRefresh={() => void refresh(coordinatedTask.id)} /> : <>
    <section className="conversation">
      <header className="task-header">{selectedTask ? <><div><p className="eyebrow">{selectedTask.projectPath || 'NO FOLDER'}</p><h1>{selectedTask.title}</h1><p className={`task-status ${selectedTask.status}`}>{taskModeLabel} · {statusLabel[selectedTask.status]} · {selectedTask.usedTokens.toLocaleString()} / {selectedTask.tokenBudget.toLocaleString()} charged/reserved tokens{contextLine}</p></div><div className="header-actions">{selectedTask.status === 'running' && <button className="danger" onClick={() => void cancel()}>Cancel task</button>}{!taskBusy && !taskRetired && <button type="button" className="secondary" disabled={compacting} onClick={() => void compact()}>{compacting ? 'Compacting…' : 'Compact context'}</button>}</div></> : <><div><p className="eyebrow">FOUNDATION</p><h1>A considered local workspace.</h1></div></>}</header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
      <div className="messages" aria-live="polite">{detail?.messages.map((message, index) => {
        const record = compactionByMessage.get(message.id);
        const last = record ? record.messageIds[record.messageIds.length - 1] === message.id : false;
        return <div key={message.id}>
          <article className={`message ${message.role} ${record ? 'compacted' : ''}`}><div className="message-meta">{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'} <span>{message.status === 'streaming' ? awaitingApproval ? 'Awaiting approval…' : 'Receiving response…' : relativeTime(message.createdAt)}</span>{record && <span className="compacted-tag">compacted · retained locally</span>}</div><p>{message.content || (message.status === 'streaming' ? awaitingApproval ? 'Awaiting your reviewed tool approval.' : 'Receiving response…' : '')}</p></article>
          {record && last && <article className="message system compaction-summary" data-testid={`compaction-${index}`}><div className="message-meta">Runtime summary <span>{record.messageIds.length} messages · estimate {record.estimatedTokensBefore.toLocaleString()} → {record.estimatedTokensAfter.toLocaleString()}</span></div><p>{record.summary}</p></article>}
        </div>;
      })}{!selectedTask && <div className="empty-state"><span className="large-mark">F</span><h2>Start with a local project.</h2><p>Create a task to send a focused brief to a configured model. The default offline profile helps you explore the workspace; it does not execute tools or delegate work.</p></div>}{selectedTask && !detail?.messages.length && <div className="empty-state"><h2>{awaitingApproval ? 'Awaiting approval.' : selectedTask.status === 'running' ? 'Receiving response…' : 'Set the direction.'}</h2><p>{awaitingApproval ? 'Review the proposed tool action in the Approvals panel before it can continue.' : selectedTask.status === 'running' ? 'The response is being checked locally before it is shown here.' : 'Describe the outcome, constraints, and the files or behavior that matter.'}</p></div>}</div>
      <form className="composer" onSubmit={send}><textarea value={composer} onChange={(e) => setComposer(e.target.value)} disabled={!selectedId || taskBusy || taskRetired || Boolean(publishBusy)} placeholder={selectedId ? taskRetired ? 'This task worktree is retired. Create a new task to continue.' : taskBusy ? 'The agent is working. Cancel to send a new direction.' : publishBusy ? 'Wait for the Git operation to finish…' : 'Message this task…' : 'Create or select a task to begin.'} aria-label="Task message" /><button className="primary" disabled={!selectedId || !composer.trim() || taskBusy || taskRetired || Boolean(publishBusy)}>Send <span>↵</span></button></form>
    </section>
    <aside className="inspector">
      <div className="inspector-tabs">{workspaceKind !== 'none' && <button className={effectiveRightTab === 'files' ? 'active' : ''} onClick={() => setRightTab('files')}>Files</button>}{workspaceKind === 'git' && <button className={effectiveRightTab === 'changes' ? 'active' : ''} onClick={() => setRightTab('changes')}>Changes</button>}{workspaceKind === 'git' && <button className={effectiveRightTab === 'approvals' ? 'active' : ''} onClick={() => setRightTab('approvals')}>Approvals{awaitingApproval ? ' · 1+' : ''}</button>}<button className={effectiveRightTab === 'usage' ? 'active' : ''} onClick={() => setRightTab('usage')}>Usage</button>{workspaceKind === 'git' && <button className={effectiveRightTab === 'publish' ? 'active' : ''} onClick={() => setRightTab('publish')}>Publish</button>}</div>
      {workspaceKind === 'git' && <button type="button" className={`channel-tab ${effectiveRightTab === 'channel' ? 'active' : ''}`} onClick={() => setRightTab('channel')}>Project channel</button>}
      {!selectedId ? <p className="muted inspector-empty">Select a chat to inspect it.</p> : effectiveRightTab === 'channel' ? <AgentChannelPanel key={selectedId} api={api} taskId={selectedId} /> : effectiveRightTab === 'files' ? <>
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
          <div className="usage-actions"><button type="button" className="secondary" disabled={compacting || taskBusy || taskRetired} onClick={() => void compact()}>{compacting ? 'Compacting…' : 'Compact context'}</button></div>
          <h3>Compactions</h3>
          {usage.compactions.length ? usage.compactions.map((record) => <div className="usage-row" key={record.id}><strong>{record.messageIds.length} messages</strong><span>{record.estimatedTokensBefore.toLocaleString()} → {record.estimatedTokensAfter.toLocaleString()} · {relativeTime(record.createdAt)}</span></div>) : <p className="muted">No compactions yet.</p>}
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
        {(detail?.approvals ?? []).map((approval) => <article className={`approval-card ${approval.state}`} key={approval.id}>
          <div className="approval-heading"><strong>{approval.tool}</strong><span>{approval.state}</span></div>
          <p>{approval.summary}</p>
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
          {approval.state === 'awaiting-approval' && <div className="approval-actions"><button type="button" className="primary" disabled={Boolean(approvalInFlight[approval.id])} onClick={() => void decideApproval(approval, 'approve')}>{approvalInFlight[approval.id] === 'approve' ? 'Approving…' : 'Approve'}</button><button type="button" className="danger" disabled={Boolean(approvalInFlight[approval.id])} onClick={() => void decideApproval(approval, 'reject')}>{approvalInFlight[approval.id] === 'reject' ? 'Rejecting…' : 'Reject'}</button></div>}
          {approval.state === 'unknown' && <div className="approval-actions"><button type="button" className="secondary" disabled={Boolean(approvalInFlight[approval.id])} onClick={() => void reconcileApproval(approval)}>{approvalInFlight[approval.id] === 'reconcile' ? 'Checking…' : 'Check outcome'}</button><small>Read-only reconciliation; this never retries or discards the action.</small></div>}
        </article>)}
        {!detail?.approvals?.length && <p className="muted inspector-empty">No reviewed tool actions are queued.</p>}
      </div>}
    </aside>
    </>}
    <dialog ref={manageDialogRef} className="settings-dialog manage-dialog" aria-labelledby="manage-projects-title">
      <div className="dialog-head"><div><p className="eyebrow">SAVED FOLDERS</p><h2 id="manage-projects-title">Manage projects</h2></div><button type="button" className="secondary" onClick={() => manageDialogRef.current?.close()}>Close</button></div>
      <div className="manage-list">{projects.map((project) => <form key={`${project.id}:${project.updatedAt}`} className="manage-project" onSubmit={(event) => { event.preventDefault(); const name = new FormData(event.currentTarget).get('name'); if (typeof name === 'string' && name.trim() && name.trim() !== project.name) void updateProject(project, { name: name.trim() }); }}><div><label>Name for {project.name}<input name="name" aria-label={`Name for ${project.name}`} defaultValue={project.name} maxLength={100} required /></label><small title={project.path}>{project.path}</small>{project.kind === 'unavailable' && <span className="project-unavailable-note">Folder unavailable</span>}</div><div className="manage-actions"><button type="submit" className="secondary">Save name</button><button type="button" className="secondary" onClick={() => void updateProject(project, { hidden: !project.hidden })}>{project.hidden ? `Restore ${project.name}` : `Hide ${project.name}`}</button></div></form>)}{!projects.length && <p className="muted">No saved projects yet.</p>}</div>
    </dialog>
    <dialog ref={dialogRef} className="settings-dialog" onClose={() => setCredential('')}>
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
    <dialog ref={upgradeDialogRef} className="settings-dialog upgrade-dialog">
      <div className="dialog-head"><div><p className="eyebrow">DATABASE UPGRADE</p><h2>Back up and upgrade</h2></div></div>
      <div className="profile-form">
        <p>This creates a verified SQLite backup, then upgrades the database to v{schema?.current ?? 4} for {schema && schema.version < 3 ? 'saved projects, new chats, and detailed usage tracking' : 'detailed usage tracking'}{!schema?.coordinatedAvailable ? ' and coordinated tasks' : ''}. Earlier chats remain available during the upgrade decision. Keep the backup to open the previous database with an older application.</p>
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
