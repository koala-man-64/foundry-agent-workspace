import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DesktopApi, Project, Task } from '../../../../packages/protocol/src/index';
import type { ActionItem, ActionPage, SearchHit, SearchPage, TaskPage } from '../../../../packages/protocol/src/workspace';

type View = 'inbox' | 'recent' | 'all' | 'archived';
type Cursor = TaskPage['nextCursor'];
const PAGE_SIZE = 30;

const taskStatus = (task: Task) => task.status === 'idle' ? 'Ready' : task.status === 'running' ? 'Working' : task.status === 'failed' ? 'Needs attention' : task.status.charAt(0).toUpperCase() + task.status.slice(1);
const actionGroup = (action: ActionItem) => action.tier === 0 ? 'Needs decision' : action.tier === 1 ? 'In progress' : 'Recent outcomes';

export function WorkspaceNavigation({ api, projects, selectedId, onSelect, onAction, onSearchHit, onOpenAutomation, refreshToken, onChanged, canArchive = true }: {
  api: DesktopApi;
  projects: Project[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAction?: (action: ActionItem) => void;
  onSearchHit?: (hit: SearchHit) => void;
  onOpenAutomation?: () => void;
  refreshToken: number;
  onChanged: () => void;
  canArchive?: boolean;
}) {
  const [view, setView] = useState<View>('inbox');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<Cursor>(null);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [actionMore, setActionMore] = useState(false);
  const [actionCursor, setActionCursor] = useState<ActionPage['nextCursor']>(null);
  const [actionCounts, setActionCounts] = useState<ActionPage['counts']>();
  const [actionError, setActionError] = useState('');
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionPageLoading, setActionPageLoading] = useState(false);
  const [searchPageLoading, setSearchPageLoading] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchCursor, setSearchCursor] = useState<SearchPage['nextCursor']>(null);
  const [mode, setMode] = useState<'' | 'chat' | 'coding' | 'coordinated'>('');
  const [status, setStatus] = useState<'' | Task['status']>('');
  const [projectPath, setProjectPath] = useState('');
  const [projectId, setProjectId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const requestVersion = useRef(0);
  const activeLoad = useRef<Promise<void> | null>(null);
  const reloadQueued = useRef(false);
  const currentLoad = useRef<(more: boolean) => Promise<void>>(async () => undefined);
  const actionPageActive = useRef(false);
  const searchPageActive = useRef(false);

  const load = useCallback(async (more = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const actionResult = await api.invoke('workspace.actions', { limit: 50 }).then(value => ({ value, error: '' }), error => ({ value: null, error: error instanceof Error ? error.message : String(error) }));
      if (version !== requestVersion.current) return;
      const failedActions = Boolean(actionResult.error);
      setActionError(actionResult.error);
      if (actionResult.value) { setActions(actionResult.value.items); setActionMore(actionResult.value.hasMore); setActionCursor(actionResult.value.nextCursor); setActionCounts(actionResult.value.counts); }
      // An unavailable action center must never silently hide archived running or pending work.
      const visibility = failedActions || view === 'all' ? 'all' : view === 'archived' ? 'archived' : 'active';
      const result = await api.invoke('workspace.tasks', {
        visibility, sort: view === 'recent' || view === 'inbox' ? 'recent' : 'created', limit: PAGE_SIZE,
        ...(more && cursor ? { cursor } : {}), ...(mode ? { mode } : {}), ...(status ? { status } : {}),
        ...(projectPath.trim() ? { projectPath: projectPath.trim() } : {}), ...(projectId ? { projectId } : {}),
        ...(fromDate ? { from: new Date(`${fromDate}T00:00:00`).toISOString() } : {}),
        ...(toDate ? { to: new Date(`${toDate}T23:59:59.999`).toISOString() } : {})
      });
      if (version !== requestVersion.current) return;
      setTasks(current => more ? [...current, ...result.tasks.filter(item => !current.some(existing => existing.id === item.id))] : result.tasks);
      setCursor(result.nextCursor);
      setListError('');
      if (submittedQuery) {
        const search = await api.invoke('workspace.search', { query: submittedQuery, visibility, limit: PAGE_SIZE, ...(mode ? { mode } : {}), ...(status ? { status } : {}), ...(projectPath.trim() ? { projectPath: projectPath.trim() } : {}), ...(projectId ? { projectId } : {}), ...(fromDate ? { from: new Date(`${fromDate}T00:00:00`).toISOString() } : {}), ...(toDate ? { to: new Date(`${toDate}T23:59:59.999`).toISOString() } : {}) });
        if (version === requestVersion.current) { setHits(search.hits); setSearchCursor(search.nextCursor); }
      }
    } catch (error) { if (version === requestVersion.current) { setListError(error instanceof Error ? error.message : String(error)); setTasks([]); setCursor(null); } }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [api, view, cursor, mode, status, projectPath, projectId, fromDate, toDate, selectedId, onSelect, submittedQuery]);
  currentLoad.current = load;

  const requestLoad = useCallback((more = false) => {
    if (activeLoad.current) { if (!more) { ++requestVersion.current; reloadQueued.current = true; } return; }
    const run = currentLoad.current(more);
    activeLoad.current = run;
    void run.finally(() => {
      if (activeLoad.current !== run) return;
      activeLoad.current = null;
      if (reloadQueued.current) { reloadQueued.current = false; requestLoad(false); }
    });
  }, []);

  useEffect(() => { requestLoad(); }, [view, mode, status, projectPath, projectId, fromDate, toDate, submittedQuery, refreshToken]);

  const submitSearch = (event: FormEvent) => { event.preventDefault(); setSubmittedQuery(query.trim()); };
  const loadMoreActions = async () => {
    if (!actionCursor || actionPageActive.current) return;
    actionPageActive.current = true; setActionPageLoading(true);
    const version = requestVersion.current;
    try {
      const page = await api.invoke('workspace.actions', { limit: 50, cursor: actionCursor });
      if (version !== requestVersion.current) return;
      setActions(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]);
      setActionMore(page.hasMore); setActionCursor(page.nextCursor); setActionCounts(page.counts);
    } catch (error) { setActionError(`Could not load more actions: ${error instanceof Error ? error.message : String(error)}`); requestLoad(); }
    finally { actionPageActive.current = false; setActionPageLoading(false); }
  };
  const loadMoreSearch = async () => {
    if (searchCursor === null || !submittedQuery || searchPageActive.current) return;
    searchPageActive.current = true; setSearchPageLoading(true);
    const version = requestVersion.current;
    try {
      const result = await api.invoke('workspace.search', { query: submittedQuery, visibility: actionError || view === 'all' ? 'all' : view === 'archived' ? 'archived' : 'active', limit: PAGE_SIZE, cursor: searchCursor, ...(mode ? { mode } : {}), ...(status ? { status } : {}), ...(projectPath.trim() ? { projectPath: projectPath.trim() } : {}), ...(projectId ? { projectId } : {}), ...(fromDate ? { from: new Date(`${fromDate}T00:00:00`).toISOString() } : {}), ...(toDate ? { to: new Date(`${toDate}T23:59:59.999`).toISOString() } : {}) });
      if (version !== requestVersion.current) return;
      setHits(current => [...current, ...result.hits]); setSearchCursor(result.nextCursor);
    } catch (error) {
      setListError(`Search results changed or could not load: ${error instanceof Error ? error.message : String(error)}. Refreshing from the first page.`);
      setSearchCursor(null);
      requestLoad();
    } finally { searchPageActive.current = false; setSearchPageLoading(false); }
  };
  const setArchived = async (task: Task) => {
    setBusyId(task.id);
    try { await api.invoke('task.setArchived', { taskId: task.id, archived: !task.archivedAt }); onChanged(); requestLoad(); }
    catch (error) { setListError(`Could not ${task.archivedAt ? 'restore' : 'archive'} task: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusyId(undefined); }
  };

  return <section className="workspace-navigation" aria-label="Workspace navigation">
    <div className="workspace-views" role="group" aria-label="Task views">
      {(['inbox', 'recent', 'all', 'archived'] as const).map(item => <button key={item} type="button" className={view === item ? 'active' : ''} aria-pressed={view === item} onClick={() => { if (view === item) { requestLoad(); return; } setView(item); setTasks([]); setCursor(null); }}>{item === 'inbox' ? `Inbox${actions.length ? ` (${actions.length}${actionMore ? '+' : ''})` : ''}` : item === 'recent' ? 'Recent' : item === 'all' ? 'All tasks' : 'Archived'}</button>)}
    </div>
    <form className="task-search" onSubmit={submitSearch}><label htmlFor="task-search-input">Search tasks and conversations</label><div><input id="task-search-input" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Search locally" /><button type="submit">Search</button></div>{submittedQuery && <button type="button" className="quiet" onClick={() => { setQuery(''); setSubmittedQuery(''); setHits([]); setSearchCursor(null); }}>Clear search</button>}</form>
    <div className="task-filters"><label>Mode <select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="">Any</option><option value="chat">Chat</option><option value="coding">Coding</option><option value="coordinated">Coordinated</option></select></label><label>Status <select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="">Any</option><option value="running">Working</option><option value="idle">Ready</option><option value="failed">Needs attention</option><option value="interrupted">Interrupted</option><option value="cancelled">Cancelled</option><option value="retired">Retired</option></select></label><label>Saved project <select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Any project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Project path <input value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="Optional path filter" /></label><label>From <input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>Through <input type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)} /></label></div>
    {actionError && <p role="alert" className="navigation-error">Action center unavailable: {actionError}. Showing active and archived tasks together until it recovers.</p>}
    {listError && <p role="alert" className="navigation-error">Could not load tasks: {listError} <button type="button" onClick={() => requestLoad()}>Retry</button></p>}
    {view === 'inbox' && !actionError && <div className="action-list" aria-label="Global action center">{(['Needs decision', 'In progress', 'Recent outcomes'] as const).map((group, tier) => <section key={group} aria-label={group}><h3>{group} ({actionCounts ? [actionCounts.needsDecision, actionCounts.inProgress, actionCounts.recent][tier] : actions.filter(action => actionGroup(action) === group).length})</h3>{actions.filter(action => actionGroup(action) === group).map(action => <button key={action.id} type="button" className="action-row" onClick={() => onAction ? onAction(action) : action.taskId ? onSelect(action.taskId) : onOpenAutomation?.()}><strong>{action.taskTitle}</strong><span>{action.kind} · {action.state}{action.archived ? ' · Archived' : ''}</span><small>{action.detail}</small></button>)}{!actions.some(action => actionGroup(action) === group) && <p className="muted">None on this page.</p>}</section>)}{!actions.length && !loading && !listError && <p className="muted">No work needs attention or is in progress.</p>}{actionMore && <button type="button" className="quiet" disabled={actionPageLoading || loading} onClick={() => void loadMoreActions()}>{actionPageLoading ? 'Loading…' : 'More actions'}</button>}</div>}
    {submittedQuery && <div className="search-results" aria-label="Search results">{hits.map((hit, index) => <button key={`${hit.taskId}-${hit.messageId ?? ''}-${index}`} type="button" onClick={() => onSearchHit ? onSearchHit(hit) : onSelect(hit.rootTaskId)}><strong>{hit.taskTitle}</strong><small>{hit.excerpt}</small></button>)}{!hits.length && !loading && !listError && <p className="muted">No matches. Clear or adjust the search.</p>}{searchCursor !== null && <button type="button" className="quiet" disabled={searchPageLoading || loading} onClick={() => void loadMoreSearch()}>{searchPageLoading ? 'Loading…' : 'More results'}</button>}</div>}
    {!submittedQuery && (view !== 'inbox' || actionError) && <nav className="task-list" aria-label="Task history">{tasks.map(task => <div className="task-row-wrap" key={task.id}><button type="button" className={`task-row ${task.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(task.id)}><span className={`status-dot ${task.status}`} /><span><strong>{task.title}</strong><small>{taskStatus(task)}{task.archivedAt ? ' · Archived' : ''} · {new Date(task.updatedAt).toLocaleDateString()}</small></span></button><button type="button" className="task-archive" disabled={busyId === task.id || !canArchive || Boolean(actionError && !task.archivedAt)} onClick={() => void setArchived(task)} aria-label={`${task.archivedAt ? 'Restore' : 'Archive'} ${task.title}`}>{task.archivedAt ? 'Restore' : 'Archive'}</button></div>)}{!tasks.length && !loading && !listError && <p className="muted">{view === 'archived' ? 'No archived tasks. Browse All tasks to find your work.' : 'No tasks in this view.'}</p>}{cursor && <button type="button" className="quiet" onClick={() => requestLoad(true)} disabled={loading}>Older tasks</button>}</nav>}
    {loading && <p className="muted" role="status">Loading workspace…</p>}
  </section>;
}
