import { randomUUID, createHash } from 'node:crypto';
import type { CoordinationConfig, McpServerStatus, Message, ModelProfile, ProviderAdapter, RpcMethod, Task, WorkspaceEvent } from '../../protocol/src/index';
import { COORDINATED_MODE_ENABLED, McpServerConfigSchema, ModelProfileSchema, RpcMethods, SCHEMA_VERSION } from '../../protocol/src/index';
import { createProvider } from '../../providers/src/index';
import { RepositoryService, RepositoryError } from './repository';
import { Redactor } from './redaction';
import { Store, FAKE_PROFILE_ID } from './store';
import { CommandRunner } from './command-runner';
import { ToolRuntime } from './tool-runtime';
import { ExecutionSlots } from './execution-slots';
import { AgentLoop, legacyHooks, prepareRequest, type ReservationHandle, type TurnHooks } from './agent-loop';
import { GitOperations } from './git-operations';
import { Orchestrator } from './orchestrator';
import { McpManager } from './mcp';
import { WorkspaceOperations } from './workspace-operations';
import { dirname } from 'node:path';

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
    }, dirname(store.path));
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
      case 'workspace.snapshot': return this.store.snapshot();
      case 'workspace.schema': return { version: this.store.schemaVersion, current: SCHEMA_VERSION, upgradeRequired: this.store.schemaVersion < SCHEMA_VERSION, coordinatedAvailable: this.coordinatedAvailable() };
      case 'workspace.upgrade': {
        // Stop admission and require idle work before the backed-up transactional upgrade.
        if (this.running.size || this.dispatches.size > 1) throw new Error('Finish or cancel active work before upgrading the database.');
        this.upgrading = true;
        try { return await this.store.upgradeToV2(); } finally { this.upgrading = false; }
      }
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
          const task: Task = { id, title: this.redactor.text(p.title), projectPath: p.projectPath, ...worktree, profileId: p.profileId, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: p.tokenBudget, usedTokens: 0, mode: p.mode, ...(p.mode === 'coordinated' ? { role: 'coordinator' as const, rootTaskId: id, coordination: { childProfileIds: [...new Set(p.coordination!.childProfileIds)], requiredValidation: p.coordination!.requiredValidation } } : {}) };
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
        const p = params as { taskId: string; path: string }; return this.repositories.listFiles(this.store.task(p.taskId).worktreePath, p.path);
      }
      case 'files.read': {
        const p = params as { taskId: string; path: string };
        const result = await this.repositories.readFile(this.store.task(p.taskId).worktreePath, p.path);
        return { ...result, content: this.redactor.text(result.content) };
      }
      case 'task.diff': {
        const result = await this.repositories.diff(this.store.task((params as { taskId: string }).taskId).worktreePath);
        return { ...result, patch: this.redactor.text(result.patch), summary: this.redactor.text(result.summary) };
      }
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
  private startTurn(taskId: string, content: string, hooks: TurnHooks): void {
    if (this.closing) throw new Error('Runtime is shutting down.');
    if (this.mcpBusy) throw new Error('Wait for MCP server configuration to finish before starting a response.');
    if (this.running.has(taskId)) throw new Error('This task already has an active response.');
    if (this.running.size >= 16) throw new Error('Too many active tasks. Finish or cancel a task first.');
    const task = this.store.task(taskId);
    if (task.status === 'retired' || this.operations.isRetiring(taskId)) throw new Error('This task worktree is retired. Create a new task to continue the work.');
    if (this.operations.isPublishing(taskId)) throw new Error('Wait for the Git operation to finish before starting a response.');
    const profile = this.store.profile(task.profileId);
    if (!profile) throw new Error('Profile not found.');
    if (profile.apiKind !== 'fake' && profile.verificationFingerprint !== profileFingerprint(profile)) throw new Error('Probe this model profile successfully before starting a response.');
    if ((task.mode === 'coding' || task.mode === 'coordinated') && !this.profileReady(profile)) throw new Error('Probe tool and continuation capabilities before starting a coding response.');
    const cleanContent = this.redactor.text(content);
    const abort = new AbortController();
    const fingerprint = profileFingerprint(profile);
    const request = prepareRequest(this.store, task, profile, fingerprint, cleanContent, this.credentials.get(profile.id), abort.signal, hooks, task.mode === 'coding' ? this.mcp.toolDefinitions() : []);
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
