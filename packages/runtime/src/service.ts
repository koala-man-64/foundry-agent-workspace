import { randomUUID, createHash } from 'node:crypto';
import type { CoordinationConfig, GitTask, McpServerStatus, Message, ModelProfile, Project, ProviderAdapter, RpcMethod, Task, WorkspaceEvent, WorkspacePreferences } from '../../protocol/src/index';
import { COORDINATED_MODE_ENABLED, isGitTask, McpServerConfigSchema, ModelProfileSchema, RpcMethods, SCHEMA_VERSION } from '../../protocol/src/index';
import { createProvider } from '../../providers/src/index';
import { RepositoryService, RepositoryError } from './repository';
import { Redactor } from './redaction';
import { Store, FAKE_PROFILE_ID, canonicalPath } from './store';
import { CommandRunner } from './command-runner';
import { ToolRuntime } from './tool-runtime';
import { ExecutionSlots } from './execution-slots';
import { AgentLoop, legacyHooks, prepareRequest, type ReservationHandle, type TurnHooks } from './agent-loop';
import { GitOperations } from './git-operations';
import { Orchestrator } from './orchestrator';
import { McpManager } from './mcp';
import { WorkspaceOperations } from './workspace-operations';
import { dirname, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

export function profileFingerprint(profile: ModelProfile): string {
  return createHash('sha256').update(JSON.stringify({ apiKind: profile.apiKind, endpoint: profile.endpoint, deployment: profile.deployment, credentialRef: profile.credentialRef, contextLimit: profile.contextLimit, outputLimit: profile.outputLimit })).digest('hex');
}
export interface RuntimeOptions { git?: GitOperations; coordinatedMode?: boolean; mcpHostPath?: string }
export class RuntimeService {
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly dispatches = new Set<Promise<unknown>>();
  private readonly credentials = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly probing = new Set<string>();
  private readonly starts = new Map<string, { hash: string; promise: Promise<Task> }>();
  readonly redactor = new Redactor();
  private closing = false;
  private upgrading = false;
  private mcpBusy = false;
  private shutdownPromise?: Promise<void>;
  private readonly tools: ToolRuntime;
  private readonly loop: AgentLoop;
  readonly orchestrator: Orchestrator;
  readonly mcp: McpManager;
  readonly operations: WorkspaceOperations;
  private readonly coordinatedMode: boolean;
  constructor(readonly store: Store, private readonly repositories: RepositoryService, private readonly emit: (event: WorkspaceEvent) => void, providerFactory: (kind: ModelProfile['apiKind']) => ProviderAdapter = createProvider, commands = new CommandRunner(), options: RuntimeOptions = {}) {
    this.providerFactory = providerFactory;
    this.coordinatedMode = options.coordinatedMode ?? (COORDINATED_MODE_ENABLED || process.env.FOUNDRY_WORKSPACE_ENABLE_COORDINATED === '1');
    const slots = new ExecutionSlots();
    const publish = (type: string, data: unknown, taskId: string): void => this.publish(type, data, taskId);
    this.tools = new ToolRuntime(store, repositories, commands, this.redactor, publish, slots);
    this.loop = new AgentLoop(store, this.tools, slots, this.redactor, providerFactory, publish);
    this.orchestrator = new Orchestrator(store, options.git ?? new GitOperations(repositories.worktreeBaseDirectory), this.tools, this.redactor, publish, {
      startTurn: (taskId, content, hooks) => this.startTurn(taskId, content, hooks),
      abort: taskId => { const entry = this.running.get(taskId); entry?.abort.abort(); return Boolean(entry); },
      isRunning: taskId => this.running.has(taskId),
      profileReady: profile => this.profileReady(profile),
      profileFingerprint
    });
    this.tools.attachOrchestration(this.orchestrator);
    this.mcp = new McpManager(() => this.store.mcpServers(), this.redactor, { hostPath: options.mcpHostPath, forbiddenRoots: () => [repositories.worktreeBaseDirectory] });
    this.tools.attachMcp(this.mcp);
    this.operations = new WorkspaceOperations(store, repositories, this.redactor, this.mcp, (type, data, taskId) => this.publish(type, data, taskId), {
      isRunning: taskId => this.running.has(taskId),
      profileFingerprint,
      activeRuns: rootTaskId => this.store.orchestrationAvailable ? this.orchestrator.records.runs(rootTaskId).filter(run => run.lifecycle !== 'terminal').length : 0
    }, dirname(store.path), this.tools.channel);
  }
  private readonly providerFactory: (kind: ModelProfile['apiKind']) => ProviderAdapter;
  private publish(type: string, data: unknown, taskId?: string): void { this.emit(this.store.event(type, data, taskId)); }
  private profileReady(profile: ModelProfile): boolean {
    return profile.apiKind === 'fake' || (profile.verificationFingerprint === profileFingerprint(profile) && Boolean(profile.capabilities?.tools && profile.capabilities?.continuation));
  }
  setCredential(id: string, secret: string, binding?: string): void {
    const targetProfile = this.store.profile(id);
    if (binding !== undefined && (!targetProfile || JSON.stringify([targetProfile.apiKind, targetProfile.endpoint, targetProfile.deployment]) !== binding)) throw new Error('Profile changed while saving the credential; retry from model settings.');
    if (this.credentials.get(id) === secret) return;
    if (this.running.size) throw new Error('Wait for active responses before changing credentials.');
    this.credentials.set(id, secret); this.redactor.add(secret);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const profile = this.store.profile(id);
    if (profile) { delete profile.verifiedAt; delete profile.verificationFingerprint; delete profile.capabilities; this.store.saveProfile(profile); }
  }
  dispatch(method: RpcMethod, input: unknown): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error('Runtime is shutting down.'));
    const operation = this.dispatchInternal(method, input);
    this.dispatches.add(operation);
    void operation.then(() => this.dispatches.delete(operation), () => this.dispatches.delete(operation));
    return operation;
  }
  private coordinatedAvailable(): boolean { return this.coordinatedMode && this.store.orchestrationAvailable; }
  private async dispatchInternal(method: RpcMethod, input: unknown): Promise<unknown> {
    if (this.closing) throw new Error('Runtime is shutting down.');
    const params = RpcMethods[method].parse(input);
    if (this.upgrading && method !== 'workspace.snapshot' && method !== 'workspace.schema') throw new Error('The database upgrade is in progress.');
    if (method.startsWith('orchestration.') && !this.coordinatedAvailable()) throw new Error('Coordinated tasks are not available in this build or database.');
    switch (method) {
      case 'workspace.snapshot': {
        const snapshot = this.store.snapshot();
        snapshot.projects = snapshot.projects.map(project => {
          try {
            if (!statSync(project.path).isDirectory()) throw new Error('Folder unavailable.');
            const same = process.platform === 'win32' ? canonicalPath(project.path).toLowerCase() === project.path.toLowerCase() : canonicalPath(project.path) === project.path;
            if (!same) throw new Error('Folder now resolves to a different location.');
            return project;
          }
          catch { return { ...project, kind: 'unavailable', unavailableReason: 'Folder is unavailable.' }; }
        });
        return snapshot;
      }
      case 'workspace.schema': return { version: this.store.schemaVersion, current: SCHEMA_VERSION, upgradeRequired: this.store.schemaVersion < SCHEMA_VERSION, coordinatedAvailable: this.coordinatedAvailable() };
      case 'workspace.upgrade': {
        // Stop admission and require idle work before the backed-up transactional upgrade.
        if (this.running.size || this.dispatches.size > 1) throw new Error('Finish or cancel active work before upgrading the database.');
        this.upgrading = true;
        try { return await this.store.upgradeToV3(); } finally { this.upgrading = false; }
      }
      case 'project.add': {
        this.store.requireProjects();
        const raw = (params as { path: string }).path;
        if (!isAbsolute(raw)) throw new Error('Select an absolute folder path.');
        const path = canonicalPath(raw);
        if (!statSync(path).isDirectory()) throw new Error('Select a folder.');
        const previous = this.store.projectByPath(path);
        if (previous) return previous;
        const kind = await this.repositories.isGitWorkingTree(path) ? 'git' : 'folder';
        const project = this.store.projectByPath(path) ?? this.store.insertProject(path, kind);
        this.publish('projects.changed', { projectId: project.id }); return project;
      }
      case 'project.update': {
        this.store.requireProjects(); const p = params as { projectId: string; name?: string; hidden?: boolean };
        const project = this.store.project(p.projectId); if (!project) throw new Error('Project not found.');
        if (p.name === undefined && p.hidden === undefined) throw new Error('Choose a name or visibility change.');
        const updated: Project = { ...project, ...(p.name !== undefined ? { name: p.name } : {}), ...(p.hidden !== undefined ? { hidden: p.hidden } : {}), updatedAt: new Date().toISOString() };
        this.store.saveProject(updated); this.publish('projects.changed', { projectId: updated.id }); return updated;
      }
      case 'workspace.preferences.save': {
        this.store.requireProjects(); const p = params as Partial<WorkspacePreferences>;
        if (p.profileId && !this.store.profile(p.profileId)) throw new Error('Select an existing model profile.');
        for (const id of p.collapsedProjectIds ?? []) if (id !== 'none' && !this.store.project(id)) throw new Error('A collapsed project no longer exists.');
        const saved = this.store.savePreferences({ ...this.store.preferences(), ...p, ...(p.collapsedProjectIds ? { collapsedProjectIds: [...new Set(p.collapsedProjectIds)] } : {}) });
        this.publish('preferences.changed', {}); return saved;
      }
      case 'task.start': return this.startTaskCoalesced(params as { requestId: string; projectId: string | null; content: string; title?: string; profileId: string; mode: 'chat' | 'coding' | 'coordinated'; tokenBudget: number; coordination?: CoordinationConfig });
      case 'task.get': return this.store.detail((params as { taskId: string }).taskId);
      case 'profile.save': {
        const profile = ModelProfileSchema.parse(params);
        if (profile.id === FAKE_PROFILE_ID && profile.apiKind !== 'fake') throw new Error('Create a new profile to configure Foundry; the offline profile is reserved.');
        if ([...this.running.keys()].some(id => this.store.task(id).profileId === profile.id)) throw new Error('Cancel active responses before editing this profile.');
        if (profile.outputLimit >= profile.contextLimit) throw new Error('Output budget must be below the context limit.');
        if (profile.apiKind !== 'fake') {
          const endpoint = new URL(profile.endpoint);
          if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || (endpoint.port && endpoint.port !== '443') || !['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com', '.inference.ai.azure.com'].some(suffix => endpoint.hostname.endsWith(suffix))) throw new Error('Use a credential-free HTTPS Azure resource endpoint without a path or query.');
        }
        const previous = this.store.profile(profile.id);
        if (previous && (previous.apiKind !== profile.apiKind || previous.endpoint !== profile.endpoint || previous.deployment !== profile.deployment)) this.credentials.delete(profile.id);
        this.generations.set(profile.id, (this.generations.get(profile.id) ?? 0) + 1);
        // Verification can only be supplied by a runtime probe, never by the renderer.
        delete profile.verifiedAt; delete profile.verificationFingerprint; delete profile.capabilities;
        if (profile.apiKind !== 'fake') profile.credentialRef = profile.id;
        if (previous && profileFingerprint(previous) === profileFingerprint(profile)) {
          profile.verifiedAt = previous.verifiedAt; profile.verificationFingerprint = previous.verificationFingerprint; profile.capabilities = previous.capabilities;
        }
        const saved = this.store.saveProfile(profile); this.publish('profiles.changed', {}); return saved;
      }
      case 'profile.probe': {
        const profile = this.store.profile((params as { profileId: string }).profileId);
        if (!profile) throw new Error('Profile not found.');
        if (this.probing.has(profile.id)) throw new Error('A probe for this profile is already running.');
        this.probing.add(profile.id);
        const fingerprint = profileFingerprint(profile);
        const generation = this.generations.get(profile.id) ?? 0;
        try {
        const result = await this.providerFactory(profile.apiKind).probe(profile, this.credentials.get(profile.id));
        if (this.closing) throw new Error('Runtime is shutting down.');
        if (result.ok && result.capabilities.streaming && result.capabilities.cancellation) {
          const current = this.store.profile(profile.id);
          if (!current || profileFingerprint(current) !== fingerprint || generation !== (this.generations.get(profile.id) ?? 0)) throw new Error('Profile or credential changed during probe; probe it again.');
          this.store.saveProfile({ ...profile, verifiedAt: new Date().toISOString(), verificationFingerprint: fingerprint, capabilities: result.capabilities });
          this.publish('profiles.changed', {});
        } else {
          const current = this.store.profile(profile.id);
          if (current && profileFingerprint(current) === fingerprint && generation === (this.generations.get(profile.id) ?? 0)) {
            delete current.verifiedAt; delete current.verificationFingerprint; delete current.capabilities;
            this.store.saveProfile(current); this.publish('profiles.changed', {});
          }
        }
        return { ...result, fingerprint, detail: this.redactor.text(result.detail) };
        } finally { this.probing.delete(profile.id); }
      }
      case 'task.create': {
        const p = params as { title: string; projectPath: string; profileId: string; tokenBudget: number; mode: 'chat' | 'coding' | 'coordinated'; coordination?: CoordinationConfig };
        const selected = this.store.profile(p.profileId);
        if (!selected) throw new Error('Select an existing model profile.');
        if (p.mode !== 'coordinated' && p.coordination) throw new Error('Coordination settings apply only to coordinated tasks.');
        if (p.mode === 'coordinated') {
          if (!this.coordinatedAvailable()) throw new Error(this.coordinatedMode ? 'Coordinated tasks require the backed-up database upgrade.' : 'Coordinated tasks are not available in this build.');
          if (!p.coordination) throw new Error('Configure child profiles and the required combined validation command.');
          for (const id of [p.profileId, ...p.coordination.childProfileIds]) {
            const profile = this.store.profile(id);
            if (!profile || !this.profileReady(profile)) throw new Error('Every coordinator and child profile must be verified for tools and continuation. No fallback profile is used.');
          }
        }
        if (p.mode === 'coding' && !this.profileReady(selected)) throw new Error('Probe tool and continuation capabilities before creating a coding task.');
        if (this.store.unknownIntents()) throw new Error('An earlier worktree creation has an unknown outcome. Inspect the retained worktree and database intent before creating another task.');
        const id = randomUUID(); const intent = this.store.intent('worktree.create', { taskId: id, projectPath: p.projectPath });
        try {
          const worktree = await this.repositories.createTaskWorktree(p.projectPath, id);
          const now = new Date().toISOString();
          let projectId: string | undefined;
          if (this.store.schemaVersion >= 3) {
            const project = this.store.projectByPath(p.projectPath) ?? this.store.insertProject(canonicalPath(p.projectPath), 'git');
            if (project.kind !== 'git') this.store.saveProject({ ...project, kind: 'git' });
            projectId = project.id;
          }
          const task: GitTask = { id, title: this.redactor.text(p.title), workspaceKind: 'git', ...(projectId ? { projectId } : {}), projectPath: p.projectPath, ...worktree, profileId: p.profileId, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: p.tokenBudget, usedTokens: 0, mode: p.mode, ...(p.mode === 'coordinated' ? { role: 'coordinator' as const, rootTaskId: id, coordination: { childProfileIds: [...new Set(p.coordination!.childProfileIds)], requiredValidation: p.coordination!.requiredValidation } } : {}) };
          this.store.transaction(() => {
            this.store.saveTask(task);
            if (task.mode === 'coordinated') this.orchestrator.createRoot(task);
            this.store.finishIntent(intent, 'complete');
          });
          this.publish('tasks.changed', {}, id); return task;
        } catch (error) { this.store.finishIntent(intent, error instanceof RepositoryError && error.outcome === 'none' ? 'complete' : 'unknown'); throw error; }
      }
      case 'approval.decide': {
        const p = params as { taskId: string; approvalId: string; nonce: string; decision: 'approve' | 'reject' };
        return this.tools.decide(p.taskId, p.approvalId, p.nonce, p.decision);
      }
      case 'approval.reconcile': {
        const p = params as { taskId: string; approvalId: string }; return this.tools.reconcile(p.taskId, p.approvalId);
      }
      case 'task.send': {
        const p = params as { taskId: string; content: string };
        const task = this.store.task(p.taskId);
        // Child input only enters through immutable assignments; reject before any provider or repository activity.
        if (task.parentTaskId || task.role === 'child') throw new Error('Child agents receive input only through coordinator assignments. Revise the assignment from its coordinated task.');
        if (task.mode === 'coordinated') {
          if (!this.coordinatedAvailable()) throw new Error('Coordinated tasks are not available in this build or database.');
          return this.orchestrator.resume(task.id, p.content);
        }
        this.startTurn(p.taskId, p.content, legacyHooks(this.store)); return { accepted: true };
      }
      case 'task.cancel': {
        const task = this.store.task((params as { taskId: string }).taskId);
        if (task.parentTaskId || task.role === 'child') throw new Error('Cancel a child from its coordinated task so the cancellation scope is explicit.');
        if (task.mode === 'coordinated' && this.store.orchestrationAvailable) return this.orchestrator.cancelRoot(task.id);
        const entry = this.running.get(task.id); entry?.abort.abort();
        return { accepted: Boolean(entry) };
      }
      case 'files.list': {
        const p = params as { taskId: string; path: string }; return this.repositories.listFiles(this.fileRoot(this.store.task(p.taskId)), p.path);
      }
      case 'files.read': {
        const p = params as { taskId: string; path: string };
        const result = await this.repositories.readFile(this.fileRoot(this.store.task(p.taskId)), p.path);
        return { ...result, content: this.redactor.text(result.content) };
      }
      case 'task.diff': {
        const result = await this.repositories.diff(this.store.gitTask((params as { taskId: string }).taskId).worktreePath);
        return { ...result, patch: this.redactor.text(result.patch), summary: this.redactor.text(result.summary) };
      }
      case 'channel.get': { const p = params as { taskId: string; before?: number; afterTaskId?: string }; return this.tools.channel.view(p.taskId, p.before, p.afterTaskId); }
      case 'channel.send': { const p = params as { taskId: string; requestId: string; recipientTaskId: string | null; content: string }; return this.tools.channel.send(p.taskId, p.requestId, { recipientTaskId: p.recipientTaskId, content: p.content }, 'user'); }
      case 'orchestration.get': { const p = params as { rootTaskId: string; runsCursor: number; eventsBefore?: number }; return this.orchestrator.view(p.rootTaskId, p.runsCursor, p.eventsBefore); }
      case 'orchestration.child': { const p = params as { rootTaskId: string; childTaskId: string }; return this.orchestrator.childDetail(p.rootTaskId, p.childTaskId); }
      case 'orchestration.cancelChild': { const p = params as { rootTaskId: string; childTaskId: string; generation: number }; return this.orchestrator.cancelChild(p.rootTaskId, p.childTaskId, p.generation); }
      case 'orchestration.cancelRoot': return this.orchestrator.cancelRoot((params as { rootTaskId: string }).rootTaskId);
      case 'orchestration.resume': { const p = params as { rootTaskId: string; content: string }; return this.orchestrator.resume(p.rootTaskId, this.redactor.text(p.content)); }
      case 'orchestration.reviseAssignment': { const p = params as { rootTaskId: string; assignmentId: string; objective: string; acceptance: string[] }; return this.orchestrator.reviseAssignment(p.rootTaskId, p.assignmentId, p.objective, p.acceptance); }
      case 'orchestration.decide': return this.orchestrator.decide(params as Parameters<Orchestrator['decide']>[0]);
      case 'orchestration.reconcile': { const p = params as { rootTaskId: string; operationId: string }; return this.orchestrator.reconcile(p.rootTaskId, p.operationId); }
      case 'orchestration.prepareContinue': { const p = params as { rootTaskId: string; operationId: string }; return this.orchestrator.prepareContinue(p.rootTaskId, p.operationId); }
      case 'task.compact': { const p = params as { taskId: string; keepRecent: number }; return this.operations.compact(p.taskId, p.keepRecent); }
      case 'task.usage': return this.operations.usage((params as { taskId: string }).taskId);
      case 'diagnostics.export': return this.operations.exportDiagnostics();
      case 'task.commit': { const p = params as { taskId: string; message: string }; return this.operations.commit(p.taskId, p.message); }
      case 'task.push': { const p = params as { taskId: string; remote: string }; return this.operations.push(p.taskId, p.remote); }
      case 'task.reconcilePublication': return this.operations.reconcilePublication((params as { taskId: string }).taskId);
      case 'task.retire': return this.operations.retire((params as { taskId: string }).taskId);
      case 'mcp.list': return this.store.mcpServers().map(server => this.mcpStatus(server));
      case 'mcp.save': {
        const config = McpServerConfigSchema.parse(params);
        const conflict = this.store.mcpServers().find(server => server.key === config.key && server.id !== config.id);
        if (conflict) throw new Error(`Another MCP server already uses the key ${config.key}.`);
        if (this.running.size || this.mcpBusy) throw new Error('Wait for active responses before changing MCP servers; advertised tools must not change during a turn.');
        this.mcpBusy = true;
        try {
          if (!config.enabled) {
            await this.mcp.stopServer(config.id);
            if (this.running.size) throw new Error('Wait for active responses before changing MCP servers; advertised tools must not change during a turn.');
            const saved = this.store.saveMcpServer(config, { tools: [], toolsListedAt: null, serverInfo: null, lastError: null });
            this.publish('mcp.changed', { serverId: config.id });
            return this.mcpStatus(saved);
          }
          const listing = await this.mcp.connect(config);
          if (this.running.size) throw new Error('Wait for active responses before changing MCP servers; advertised tools must not change during a turn.');
          const saved = this.store.saveMcpServer(config, { tools: listing.tools, toolsListedAt: new Date().toISOString(), serverInfo: listing.serverInfo, lastError: listing.skipped.length ? `Skipped tools: ${listing.skipped.join('; ')}` : null });
          this.publish('mcp.changed', { serverId: config.id }); return this.mcpStatus(saved);
        } catch (error) {
          if (!config.enabled) throw error;
          const saved = this.store.saveMcpServer(config, { tools: [], toolsListedAt: null, serverInfo: null, lastError: this.redactor.text(error instanceof Error ? error.message : 'The server could not be started.') });
          this.publish('mcp.changed', { serverId: config.id }); return { ...saved, running: false };
        } finally {
          this.mcpBusy = false;
        }
      }
      case 'mcp.remove': {
        const id = (params as { serverId: string }).serverId;
        if (this.running.size || this.mcpBusy) throw new Error('Wait for active responses before removing MCP servers.');
        this.mcpBusy = true;
        try {
          await this.mcp.stopServer(id);
          if (this.running.size) throw new Error('Wait for active responses before removing MCP servers.');
          const removed = this.store.removeMcpServer(id);
          this.publish('mcp.changed', { serverId: id }); return { removed };
        } finally {
          this.mcpBusy = false;
        }
      }
    }
  }
  /** Stored listing plus live process state; a live failure is shown, otherwise the retained listing note (e.g. skipped tools). */
  private mcpStatus(server: McpServerStatus): McpServerStatus {
    const live = this.mcp.statusOf(server.id);
    return { ...server, running: live.running, lastError: live.lastError ?? server.lastError };
  }
  private fileRoot(task: Task): string {
    if (isGitTask(task)) return task.worktreePath;
    if (task.workspaceKind === 'folder') {
      const same = process.platform === 'win32'
        ? canonicalPath(task.projectPath).toLowerCase() === task.projectPath.toLowerCase()
        : canonicalPath(task.projectPath) === task.projectPath;
      if (!same) throw new Error('The saved folder now resolves to a different location. Restore the original folder before browsing files.');
      return task.projectPath;
    }
    throw new Error('This chat has no folder access.');
  }
  private startTaskCoalesced(p: { requestId: string; projectId: string | null; content: string; title?: string; profileId: string; mode: 'chat' | 'coding' | 'coordinated'; tokenBudget: number; coordination?: CoordinationConfig }): Promise<Task> {
    const hash = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const inflight = this.starts.get(p.requestId);
    if (inflight) return inflight.hash === hash ? inflight.promise : Promise.reject(new Error('This request ID belongs to different chat settings.'));
    const promise = Promise.resolve().then(() => this.startTask(p)).finally(() => {
      if (this.starts.get(p.requestId)?.promise === promise) this.starts.delete(p.requestId);
    });
    this.starts.set(p.requestId, { hash, promise });
    return promise;
  }
  private async startTask(p: { requestId: string; projectId: string | null; content: string; title?: string; profileId: string; mode: 'chat' | 'coding' | 'coordinated'; tokenBudget: number; coordination?: CoordinationConfig }): Promise<Task> {
    this.store.requireProjects();
    const inputHash = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const prior = this.store.taskStart(p.requestId);
    if (prior) {
      if (prior.inputHash !== inputHash) throw new Error('This request ID belongs to different chat settings.');
      if (prior.state === 'complete') return this.store.task(prior.taskId);
      if (prior.state === 'failed') {
        const task = this.store.task(prior.taskId);
        if (this.store.detail(task.id).messages.some(message => message.role === 'user')) { this.store.finishTaskStart(p.requestId, 'complete'); return task; }
        this.store.finishTaskStart(p.requestId, 'pending');
        try {
          if (task.mode === 'coordinated') await this.orchestrator.resume(task.id, p.content);
          else this.startTurn(task.id, p.content, legacyHooks(this.store));
          this.store.finishTaskStart(p.requestId, 'complete'); return this.store.task(task.id);
        }
        catch (error) { this.store.finishTaskStart(p.requestId, 'failed'); throw error; }
      }
      throw new Error('Chat creation has an unknown outcome. Inspect the saved chat and retained intent before trying again with a new request.');
    }
    const project = p.projectId ? this.store.project(p.projectId) : undefined;
    if (p.projectId && !project) throw new Error('Project not found.');
    if (project?.hidden) throw new Error('Restore this project before starting a chat.');
    if (project) {
      try {
        if (!statSync(project.path).isDirectory()) throw new Error();
        const same = process.platform === 'win32' ? canonicalPath(project.path).toLowerCase() === project.path.toLowerCase() : canonicalPath(project.path) === project.path;
        if (!same) throw new Error();
      } catch { throw new Error('Project folder is unavailable or resolves to a different location.'); }
    }
    const kind = project ? await this.repositories.isGitWorkingTree(project.path) ? 'git' : 'folder' : 'none';
    if (kind !== 'git' && p.mode !== 'chat') throw new Error('Coding and coordination require a Git project.');
    if (p.mode !== 'coordinated' && p.coordination) throw new Error('Coordination settings apply only to coordinated tasks.');
    if (p.mode === 'coordinated') {
      if (!this.coordinatedAvailable() || !p.coordination) throw new Error('Configure coordination and its required validation command for a Git project.');
      for (const id of [p.profileId, ...p.coordination.childProfileIds]) {
        const profile = this.store.profile(id); if (!profile || !this.profileReady(profile)) throw new Error('Every coordinator and child profile must be verified for tools and continuation. No fallback profile is used.');
      }
    }
    const profile = this.store.profile(p.profileId);
    if (!profile) throw new Error('Select an existing model profile.');
    if (profile.apiKind !== 'fake' && profile.verificationFingerprint !== profileFingerprint(profile)) throw new Error('Probe this model profile successfully before starting a response.');
    if (p.mode === 'coding' && !this.profileReady(profile)) throw new Error('Probe tool and continuation capabilities before starting a coding task.');
    if (kind === 'git' && this.store.unknownIntents()) throw new Error('An earlier worktree creation has an unknown outcome. Inspect it before creating another task.');
    const id = randomUUID();
    const title = this.redactor.text(p.title ?? p.content.trim().split(/\r?\n/, 1)[0]!.slice(0, 80));
    // Durable reservation precedes any worktree creation or first-message dispatch. A retry
    // can return only a completed task; pending and unknown outcomes are never replayed.
    this.store.reserveTaskStart(p.requestId, inputHash, id);
    let intent: string | undefined;
    let worktreeCreated = false;
    let taskSaved = false;
    let sending = false;
    try {
      const worktree = kind === 'git' ? await (async () => {
        intent = this.store.intent('worktree.create', { taskId: id, projectPath: project!.path, requestId: p.requestId });
        return this.repositories.createTaskWorktree(project!.path, id);
      })() : undefined;
      if (worktree) worktreeCreated = true;
      const now = new Date().toISOString();
      const base = { id, title, ...(project ? { projectId: project.id } : {}), profileId: p.profileId, status: 'idle' as const, createdAt: now, updatedAt: now, tokenBudget: p.tokenBudget, usedTokens: 0, mode: p.mode };
      const task: Task = kind === 'git'
        ? { ...base, workspaceKind: 'git', projectPath: project!.path, ...worktree!, ...(p.mode === 'coordinated' ? { role: 'coordinator' as const, rootTaskId: id, coordination: { childProfileIds: [...new Set(p.coordination!.childProfileIds)], requiredValidation: p.coordination!.requiredValidation } } : {}) }
        : kind === 'folder' ? { ...base, mode: 'chat', workspaceKind: 'folder', projectPath: project!.path }
          : { ...base, mode: 'chat', workspaceKind: 'none' };
      this.store.transaction(() => {
        this.store.saveTask(task);
        if (task.mode === 'coordinated') this.orchestrator.createRoot(task);
        if (intent) this.store.finishIntent(intent, 'complete');
      });
      taskSaved = true;
      this.publish('tasks.changed', {}, id);
      sending = true;
      if (task.mode === 'coordinated') await this.orchestrator.resume(id, p.content);
      else this.startTurn(id, p.content, legacyHooks(this.store));
      this.store.finishTaskStart(p.requestId, 'complete');
      return this.store.task(id);
    } catch (error) {
      if (intent && !taskSaved) this.store.finishIntent(intent, worktreeCreated ? 'unknown' : error instanceof RepositoryError && error.outcome === 'none' ? 'complete' : 'unknown');
      if (!taskSaved && !worktreeCreated && error instanceof RepositoryError && error.outcome === 'none') {
        this.store.clearTaskStart(p.requestId);
        throw error;
      }
      if (taskSaved && sending && p.mode !== 'coordinated' && !this.store.detail(id).messages.some(message => message.role === 'user')) {
        this.store.finishTaskStart(p.requestId, 'failed');
        throw error;
      }
      this.store.finishTaskStart(p.requestId, 'unknown');
      throw new Error(`Chat creation has an unknown outcome. Inspect the saved chat and retained intent before retrying. ${this.redactor.text(error instanceof Error ? error.message : 'Operation failed.')}`, { cause: error });
    }
  }
  private startTurn(taskId: string, content: string, hooks: TurnHooks): void {
    if (this.closing) throw new Error('Runtime is shutting down.');
    if (this.mcpBusy) throw new Error('Wait for MCP server configuration to finish before starting a response.');
    if (this.running.has(taskId)) throw new Error('This task already has an active response.');
    if (this.running.size >= 16) throw new Error('Too many active tasks. Finish or cancel a task first.');
    const task = this.store.task(taskId);
    if (task.status === 'retired' || this.operations.isRetiring(taskId)) throw new Error('This task worktree is retired. Create a new task to continue the work.');
    const rootTaskId = task.parentTaskId ?? task.id;
    if (this.store.unknownRetireIntents(task.id).length > 0 || this.store.unknownRetireIntents(rootTaskId).length > 0) {
      throw new Error('This task has an unknown worktree retirement outcome. Reconcile state before starting a response.');
    }
    if (this.store.unknownPublicationIntents(task.id).length > 0) {
      throw new Error('This task has an unknown publication outcome. Reconcile publication state before starting a response.');
    }
    if (this.operations.isPublishing(taskId)) throw new Error('Wait for the Git operation to finish before starting a response.');
    const profile = this.store.profile(task.profileId);
    if (!profile) throw new Error('Profile not found.');
    if (profile.apiKind !== 'fake' && profile.verificationFingerprint !== profileFingerprint(profile)) throw new Error('Probe this model profile successfully before starting a response.');
    if ((task.mode === 'coding' || task.mode === 'coordinated') && !this.profileReady(profile)) throw new Error('Probe tool and continuation capabilities before starting a coding response.');
    const cleanContent = this.redactor.text(content);
    const abort = new AbortController();
    const fingerprint = profileFingerprint(profile);
    const request = prepareRequest(this.store, task, profile, fingerprint, cleanContent, this.credentials.get(profile.id), abort.signal, hooks, task.mode === 'coding' ? this.mcp.toolDefinitions() : [], this.tools.channel);
    const now = new Date().toISOString();
    const answer: Message = { id: randomUUID(), taskId, role: 'assistant', content: '', createdAt: now, status: 'streaming' };
    let handle!: ReservationHandle;
    this.store.transaction(() => {
      handle = hooks.reserve(task, request);
      this.store.saveMessage({ id: randomUUID(), taskId, role: 'user', content: cleanContent, createdAt: now, status: 'complete' });
      this.store.saveMessage(answer);
      this.store.saveTask({ ...this.store.task(taskId), status: 'running', updatedAt: now });
    });
    if (this.store.orchestrationAvailable && task.rootTaskId) this.orchestrator.records.setLifecycle(taskId, 'running');
    const started = this.store.task(taskId);
    const done = Promise.resolve().then(() => this.loop.run(started, request, answer, handle, fingerprint, abort, hooks)).finally(() => this.running.delete(taskId));
    this.running.set(taskId, { abort, done });
    this.publish('task.started', {}, taskId);
    if (!task.rootTaskId && started.usedTokens >= task.tokenBudget * 0.8) this.publish('task.budget-warning', { usedTokens: started.usedTokens, budget: task.tokenBudget }, taskId);
  }
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.orchestrator.beginShutdown();
    this.shutdownPromise = (async () => {
      for (const { abort } of this.running.values()) abort.abort();
      // Worktree creation and profile probes are not model loops. Let them reach a
      // known result before closing SQLite; an external supervisor may still kill
      // an overlong drain, in which case intent recovery remains conservative.
      await Promise.allSettled([
        ...[...this.running.values()].map(entry => entry.done),
        ...this.dispatches,
        this.orchestrator.close(),
        this.mcp.shutdown()
      ]);
      await Promise.allSettled([...this.running.values()].map(entry => entry.done));
      this.store.close();
    })();
    return this.shutdownPromise;
  }
}
