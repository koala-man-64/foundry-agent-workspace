import type { Project, Task, TaskStatus } from '../../../../packages/protocol/src/index';

const statusLabel: Record<TaskStatus, string> = { idle: 'Ready', running: 'Working', cancelled: 'Cancelled', interrupted: 'Interrupted', failed: 'Needs attention', retired: 'Retired' };

interface Props {
  projects: Project[];
  tasks: Task[];
  selectedId?: string;
  draftProjectId?: string | null;
  collapsedProjectIds: string[];
  canAdd: boolean;
  adding: boolean;
  exporting: boolean;
  onNew: (projectId: string | null) => void;
  onSelect: (taskId: string) => void;
  onAdd: () => void;
  onManage: () => void;
  onToggle: (projectId: string) => void;
  onHide: (project: Project) => void;
  onSettings: () => void;
  onExport: () => void;
}

function TaskRows({ tasks, selectedId, onSelect }: Pick<Props, 'selectedId' | 'onSelect'> & { tasks: Task[] }) {
  return <>{tasks.map((task) => <button key={task.id} type="button" className={`task-row ${selectedId === task.id ? 'selected' : ''}`} aria-current={selectedId === task.id ? 'page' : undefined} title={`${statusLabel[task.status]} · ${new Date(task.updatedAt).toLocaleString()} · ${task.projectPath || 'No folder'}`} onClick={() => onSelect(task.id)}><span className={`status-dot ${task.status}`} aria-hidden="true" /><span className="task-row-title">{task.title}</span></button>)}</>;
}

export function ProjectSidebar(props: Props) {
  const { projects, tasks, selectedId, draftProjectId, collapsedProjectIds, canAdd, adding, exporting, onNew, onSelect, onAdd, onManage, onToggle, onHide, onSettings, onExport } = props;
  const visibleProjects = projects.filter((project) => !project.hidden).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path));
  const sortedTasks = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const noFolder = sortedTasks.filter((task) => task.workspaceKind === 'none');
  const legacy = sortedTasks.filter((task) => !task.projectId && task.workspaceKind !== 'none');

  return <aside className="sidebar">
    <div className="sidebar-top">
      <button type="button" className="sidebar-new" onClick={() => onNew(null)}><span className="sidebar-plus" aria-hidden="true">+</span>New chat</button>
      <div className="projects-head"><h2>Projects</h2><button type="button" className="icon-button" aria-label="Add project" title={canAdd ? 'Add a local folder' : 'Upgrade the database to add projects'} disabled={!canAdd || adding} onClick={onAdd}>{adding ? '…' : '+'}</button></div>
    </div>
    <nav className="project-list" aria-label="Chats by project">
      {visibleProjects.map((project) => {
        const collapsed = collapsedProjectIds.includes(project.id);
        const projectTasks = sortedTasks.filter((task) => task.projectId === project.id && !task.parentTaskId);
        return <section className="project-group" key={project.id}>
          <div className="project-heading">
            <button type="button" className="project-toggle" aria-expanded={!collapsed} title={project.path} onClick={() => onToggle(project.id)}><span className="chevron" aria-hidden="true">{collapsed ? '›' : '⌄'}</span><span className="project-name">{project.name}</span>{project.kind === 'unavailable' && <span className="project-unavailable" title={project.unavailableReason || 'Folder unavailable'}>!</span>}</button>
            <button type="button" className="icon-button" aria-label={`New chat in ${project.name}`} title={project.kind === 'unavailable' ? 'Folder unavailable' : `New chat in ${project.name}`} disabled={project.kind === 'unavailable'} onClick={() => onNew(project.id)}>+</button>
            <details className="project-menu"><summary aria-label={`Manage ${project.name}`} title={`Manage ${project.name}`}>⋯</summary><div><button type="button" onClick={onManage}>Rename</button><button type="button" onClick={() => onHide(project)}>Hide</button></div></details>
          </div>
          {!collapsed && <div className="project-rows">{draftProjectId === project.id && <span className="draft-row" aria-current="page">Draft chat</span>}<TaskRows tasks={projectTasks} selectedId={selectedId} onSelect={onSelect} />{!projectTasks.length && draftProjectId !== project.id && <span className="project-empty">No chats yet</span>}</div>}
        </section>;
      })}
      {!!legacy.length && <section className="project-group"><div className="project-heading"><span className="project-legacy">Earlier chats</span></div><div className="project-rows"><TaskRows tasks={legacy.filter((task) => !task.parentTaskId)} selectedId={selectedId} onSelect={onSelect} /></div></section>}
      <section className="project-group"><div className="project-heading"><button type="button" className="project-toggle" aria-expanded={!collapsedProjectIds.includes('none')} onClick={() => onToggle('none')}><span className="chevron" aria-hidden="true">{collapsedProjectIds.includes('none') ? '›' : '⌄'}</span><span className="project-name">No folder</span></button><button type="button" className="icon-button" aria-label="New chat with no folder" onClick={() => onNew(null)}>+</button></div>{!collapsedProjectIds.includes('none') && <div className="project-rows">{draftProjectId === null && <span className="draft-row" aria-current="page">Draft chat</span>}<TaskRows tasks={noFolder.filter((task) => !task.parentTaskId)} selectedId={selectedId} onSelect={onSelect} /></div>}</section>
    </nav>
    <div className="sidebar-footer"><button type="button" onClick={onManage}>Manage projects</button><button type="button" onClick={onSettings}>Model settings</button><button type="button" disabled={exporting} onClick={onExport}>{exporting ? 'Exporting diagnostics…' : 'Export diagnostics'}</button></div>
  </aside>;
}
