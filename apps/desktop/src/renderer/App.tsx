import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi, DiffResult, FileContent, FileEntry, ModelProfile, ProbeResult, Snapshot, TaskDetail, TaskStatus } from '../../../../packages/protocol/src/index';

declare global { interface Window { workspace: DesktopApi; } }

const OFFLINE_PROFILE: ModelProfile = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'local demo',
  contextLimit: 128000, outputLimit: 8192
};

const statusLabel: Record<TaskStatus, string> = { idle: 'Ready', running: 'Working', cancelled: 'Cancelled', interrupted: 'Interrupted', failed: 'Needs attention' };
const emptySnapshot: Snapshot = { tasks: [], profiles: [], lastSequence: 0, runtime: 'ready' };

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
  const [detail, setDetail] = useState<TaskDetail>();
  const [projectPath, setProjectPath] = useState('');
  const [title, setTitle] = useState('');
  const [profileId, setProfileId] = useState(OFFLINE_PROFILE.id);
  const [composer, setComposer] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent>();
  const [diff, setDiff] = useState<DiffResult>();
  const [currentPath, setCurrentPath] = useState('');
  const [rightTab, setRightTab] = useState<'files' | 'changes'>('files');
  const [profileDraft, setProfileDraft] = useState<ModelProfile>(OFFLINE_PROFILE);
  const [credential, setCredential] = useState('');
  const [probe, setProbe] = useState<ProbeResult>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileVersion = useRef(0);
  const inspectorVersion = useRef(0);
  const detailVersion = useRef(0);
  const snapshotVersion = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  const currentPathRef = useRef('');
  const sequenceRef = useRef(0);
  const eventSequenceRef = useRef(0);
  selectedRef.current = selectedId;
  currentPathRef.current = currentPath;

  const profiles = snapshot.profiles.length ? snapshot.profiles : [OFFLINE_PROFILE];
  const selectedTask = detail?.task ?? snapshot.tasks.find((task) => task.id === selectedId);
  const isBuiltinProfile = profileDraft.id === OFFLINE_PROFILE.id;

  const loadTaskDetail = useCallback(async (taskId: string) => {
    const version = ++detailVersion.current;
    try {
      const nextDetail = await api.invoke('task.get', { taskId });
      if (version === detailVersion.current && selectedRef.current === taskId) setDetail(nextDetail);
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

  const refreshInspector = useCallback(async (taskId: string, path: string) => {
    const version = ++inspectorVersion.current;
    try {
      const [nextFiles, nextDiff] = await Promise.all([
        api.invoke('files.list', { taskId, path }),
        api.invoke('task.diff', { taskId })
      ]);
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) {
        setFiles(nextFiles);
        setDiff(nextDiff);
      }
    } catch (error) {
      if (version === inspectorVersion.current && selectedRef.current === taskId && currentPathRef.current === path) setNotice(`Could not refresh inspector: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);

  const refresh = useCallback(async (selection = selectedRef.current) => {
    const version = ++snapshotVersion.current;
    try {
      const fresh = await api.invoke('workspace.snapshot', {});
      if (version !== snapshotVersion.current) return;
      sequenceRef.current = fresh.lastSequence;
      setSnapshot(fresh);
      const next = selection && fresh.tasks.some((task) => task.id === selection) ? selection : fresh.tasks[0]?.id;
      if (next !== selectedRef.current) setSelectedId(next);
      else if (next) void loadTaskDetail(next);
      if (fresh.lastSequence < eventSequenceRef.current) void refresh(next);
    } catch (error) { setNotice(`Could not refresh workspace: ${error instanceof Error ? error.message : String(error)}`); }
  }, [api, loadTaskDetail]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => api.onEvent((event) => {
    eventSequenceRef.current = Math.max(eventSequenceRef.current, event.sequence);
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
    }
    if (event.sequence > sequenceRef.current) void refresh(selectedRef.current);
  }), [api, refresh]);

  useEffect(() => {
    if (!selectedId) { ++detailVersion.current; ++inspectorVersion.current; setDetail(undefined); setFiles([]); setFile(undefined); setDiff(undefined); setCurrentPath(''); return; }
    ++fileVersion.current;
    currentPathRef.current = '';
    setCurrentPath(''); setDetail(undefined); setFile(undefined); setDiff(undefined);
    void loadTaskDetail(selectedId);
    void refreshInspector(selectedId, '');
  }, [loadTaskDetail, refreshInspector, selectedId]);

  const chooseProject = async () => { const chosen = await api.pickProject(); if (chosen) setProjectPath(chosen); };
  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectPath.trim() || !title.trim()) { setNotice('Choose a project and name the task before creating it.'); return; }
    setCreating(true); setNotice('');
    try {
      const activeProfile = profiles.find((profile) => profile.id === profileId) ?? OFFLINE_PROFILE;
      if (!snapshot.profiles.some((profile) => profile.id === activeProfile.id)) await api.invoke('profile.save', activeProfile);
      const task = await api.invoke('task.create', { projectPath: projectPath.trim(), title: title.trim(), profileId: activeProfile.id, tokenBudget: 100000 });
      setTitle(''); setSelectedId(task.id); await refresh(task.id);
    } catch (error) { setNotice(`Could not create task: ${error instanceof Error ? error.message : String(error)}`); } finally { setCreating(false); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!selectedId || !composer.trim()) return;
    const content = composer.trim(); setComposer('');
    try { await api.invoke('task.send', { taskId: selectedId, content }); await refresh(selectedId); }
    catch (error) { setComposer(content); setNotice(`Message was not sent: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const cancel = async () => { if (!selectedId) return; try { await api.invoke('task.cancel', { taskId: selectedId }); await refresh(selectedId); } catch (error) { setNotice(`Could not cancel: ${error instanceof Error ? error.message : String(error)}`); } };
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
    void refreshInspector(selectedId, currentPathRef.current);
    if (file) void readFile(file.path);
  };
  const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  const openSettings = () => { const profile = profiles.find((item) => item.id === profileId) ?? OFFLINE_PROFILE; setProfileDraft(profile); setCredential(''); setProbe(undefined); dialogRef.current?.showModal(); };
  const newProfile = () => { setProfileDraft({ id: crypto.randomUUID(), name: 'New Azure profile', apiKind: 'responses', endpoint: '', deployment: '', contextLimit: 128000, outputLimit: 8192 }); setCredential(''); setProbe(undefined); };
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setNotice('');
    try {
      const saved = await api.invoke('profile.save', { ...profileDraft, name: profileDraft.name.trim(), endpoint: profileDraft.endpoint.trim(), deployment: profileDraft.deployment.trim() });
      if (credential) await api.saveCredential(saved.id, credential);
      setCredential(''); setProfileId(saved.id); await refresh(); dialogRef.current?.close();
    } catch (error) { setCredential(''); setNotice(`Could not save profile: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const probeProfile = async () => { try { const saved = await api.invoke('profile.save', profileDraft); if (credential) await api.saveCredential(saved.id, credential); setCredential(''); setProbe(await api.invoke('profile.probe', { profileId: saved.id })); } catch (error) { setCredential(''); setProbe({ ok: false, capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false }, detail: error instanceof Error ? error.message : String(error), fingerprint: '' }); } };
  const sortedTasks = useMemo(() => [...snapshot.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [snapshot.tasks]);

  return <main className="workspace">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">F</span><div><strong>Foundry</strong><small>Agent workspace</small></div></div>
      <form className="new-task" onSubmit={createTask}><h2>New task</h2>
        <label>Project <div className="project-picker"><input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="Choose a local project" aria-label="Project path" /><button type="button" onClick={() => void chooseProject()}>Browse</button></div></label>
        <label>Task title <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should this task do?" /></label>
        <label>Profile <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.apiKind}</option>)}</select></label>
        <button className="primary" disabled={creating}>{creating ? 'Creating…' : 'Create task'}</button>
      </form>
      <div className="history-head"><h2>Task history</h2><button className="quiet" type="button" onClick={() => void refresh()}>Refresh</button></div>
      <nav className="task-list" aria-label="Task history">{sortedTasks.map((task) => <button key={task.id} className={`task-row ${task.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(task.id)}><span className={`status-dot ${task.status}`} /><span><strong>{task.title}</strong><small>{statusLabel[task.status]} · {relativeTime(task.updatedAt)}</small></span></button>)}{!sortedTasks.length && <p className="muted">Your local tasks will appear here.</p>}</nav>
      <button className="settings-link" type="button" onClick={openSettings}>Model settings <span>↗</span></button>
    </aside>
    <section className="conversation">
      <header className="task-header">{selectedTask ? <><div><p className="eyebrow">{selectedTask.projectPath}</p><h1>{selectedTask.title}</h1><p className={`task-status ${selectedTask.status}`}>{statusLabel[selectedTask.status]} · {selectedTask.usedTokens.toLocaleString()} / {selectedTask.tokenBudget.toLocaleString()} charged/reserved tokens</p></div>{selectedTask.status === 'running' && <button className="danger" onClick={() => void cancel()}>Cancel task</button>}</> : <><div><p className="eyebrow">FOUNDATION</p><h1>A considered local workspace.</h1></div></>}</header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
      <div className="messages" aria-live="polite">{detail?.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-meta">{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'} <span>{message.status === 'streaming' ? 'Receiving response…' : relativeTime(message.createdAt)}</span></div><p>{message.content || (message.status === 'streaming' ? 'Receiving response…' : '')}</p></article>)}{!selectedTask && <div className="empty-state"><span className="large-mark">F</span><h2>Start with a local project.</h2><p>Create a task to send a focused brief to a configured model. The default offline profile helps you explore the workspace; it does not execute tools or delegate work.</p></div>}{selectedTask && !detail?.messages.length && <div className="empty-state"><h2>{selectedTask.status === 'running' ? 'Receiving response…' : 'Set the direction.'}</h2><p>{selectedTask.status === 'running' ? 'The response is being checked locally before it is shown here.' : 'Describe the outcome, constraints, and the files or behavior that matter.'}</p></div>}</div>
      <form className="composer" onSubmit={send}><textarea value={composer} onChange={(e) => setComposer(e.target.value)} disabled={!selectedId || selectedTask?.status === 'running'} placeholder={selectedId ? selectedTask?.status === 'running' ? 'The agent is working. Cancel to send a new direction.' : 'Message this task…' : 'Create or select a task to begin.'} aria-label="Task message" /><button className="primary" disabled={!selectedId || !composer.trim() || selectedTask?.status === 'running'}>Send <span>↵</span></button></form>
    </section>
    <aside className="inspector">
      <div className="inspector-tabs"><button className={rightTab === 'files' ? 'active' : ''} onClick={() => setRightTab('files')}>Files</button><button className={rightTab === 'changes' ? 'active' : ''} onClick={() => setRightTab('changes')}>Changes</button></div>
      {!selectedId ? <p className="muted inspector-empty">Select a task to inspect its local worktree.</p> : rightTab === 'files' ? <>
        <div className="inspector-tools"><button type="button" onClick={() => browseDirectory('')} disabled={!currentPath}>Root</button><span title={currentPath || 'Repository root'}>{currentPath || 'Repository root'}</span><button type="button" onClick={refreshCurrentInspector}>Refresh</button></div>
        <div className="file-tree">
          {currentPath && <button type="button" className="up-directory" onClick={() => browseDirectory(parentPath)}><span>←</span>Up</button>}
          {files.map((entry) => <button key={entry.path} type="button" className={file?.path === entry.path ? 'active-file' : ''} onClick={() => entry.kind === 'directory' ? browseDirectory(entry.path) : void readFile(entry.path)}><span>{entry.kind === 'directory' ? '▸' : '·'}</span>{entry.path}</button>)}
          {!files.length && <p className="muted">No files here.</p>}
        </div>
        <div className="file-content"><p>{file?.path ?? 'Choose a file to read'}</p><pre>{file?.content}</pre></div>
      </> : <div className="patch"><p>{diff?.summary ?? 'Loading changes…'}{diff?.truncated ? ' (truncated)' : ''}</p><pre>{diff?.patch}</pre></div>}
    </aside>
    <dialog ref={dialogRef} className="settings-dialog" onClose={() => setCredential('')}>
      <form method="dialog" className="dialog-head">
        <div><p className="eyebrow">CONNECTIONS</p><h2>Model profile</h2></div>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={newProfile}>New profile</button><button type="submit" className="secondary">Close settings</button></div>
      </form>
      <form onSubmit={saveProfile} className="profile-form">
        <label>Name <input value={profileDraft.name} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })} required maxLength={100} /></label>
        <label>API kind <select value={profileDraft.apiKind} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, apiKind: e.target.value as ModelProfile['apiKind'] })}><option value="fake">Offline fake</option><option value="responses">Responses API</option><option value="chat-completions">Chat completions</option><option value="anthropic">Anthropic</option></select></label>
        <label>Endpoint <input value={profileDraft.endpoint} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, endpoint: e.target.value })} placeholder="https://…" /></label>
        <label>Deployment <input value={profileDraft.deployment} disabled={isBuiltinProfile} onChange={(e) => setProfileDraft({ ...profileDraft, deployment: e.target.value })} /></label>
        <div className="limits"><label>Context limit <input type="number" disabled={isBuiltinProfile} min="1024" max="2000000" value={profileDraft.contextLimit} onChange={(e) => setProfileDraft({ ...profileDraft, contextLimit: Number(e.target.value) })} /></label><label>Output limit <input type="number" disabled={isBuiltinProfile} min="16" max="128000" value={profileDraft.outputLimit} onChange={(e) => setProfileDraft({ ...profileDraft, outputLimit: Number(e.target.value) })} /></label></div>
        <label>Credential <input type="password" disabled={isBuiltinProfile} value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Stored by the local credential service" autoComplete="off" /><small>Cleared from this form after it is saved or tested.</small></label>
        {isBuiltinProfile ? <p className="probe-note">Offline demo is built in and tests local readiness only; it sends no remote request. Create a new profile to configure an Azure provider.</p> : <p className="probe-note">{profileDraft.apiKind === 'fake' ? 'Offline demo checks local readiness and sends no remote request.' : 'Testing sends two small requests to the selected endpoint. It checks the connection only; tool readiness is unavailable in this workspace.'}</p>}
        {probe && <div className={`probe ${probe.ok ? 'success' : 'failure'}`} role="status"><strong>{probe.ok ? 'Connection ready' : 'Connection unavailable'}</strong><p>{probe.detail}</p><small>Streaming {probe.capabilities.streaming ? 'available' : 'unavailable'} · tools {probe.capabilities.tools ? 'available' : 'unavailable'} · cancellation {probe.capabilities.cancellation ? 'available' : 'unavailable'}</small></div>}
        <div className="dialog-actions"><button type="button" className="secondary" onClick={() => void probeProfile()}>Test connection</button><button className="primary" disabled={isBuiltinProfile}>Save profile</button></div>
      </form>
    </dialog>
  </main>;
}

export default App;
