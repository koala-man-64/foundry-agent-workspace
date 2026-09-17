import { randomUUID, createHash } from 'node:crypto';
import type { Message, ModelProfile, ProviderAdapter, RpcMethod, Task, WorkspaceEvent } from '../../protocol/src/index';
import { ModelProfileSchema, RpcMethods } from '../../protocol/src/index';
import { createProvider } from '../../providers/src/index';
import { RepositoryService, RepositoryError } from './repository';
import { Redactor } from './redaction';
import { Store, FAKE_PROFILE_ID } from './store';
import { CommandRunner } from './command-runner';
import { ToolRuntime } from './tool-runtime';
import { ExecutionSlots } from './execution-slots';
import { AgentLoop, prepareRequest, reserveRequest } from './agent-loop';

export function profileFingerprint(profile: ModelProfile): string {
  return createHash('sha256').update(JSON.stringify({ apiKind: profile.apiKind, endpoint: profile.endpoint, deployment: profile.deployment, credentialRef: profile.credentialRef, contextLimit: profile.contextLimit, outputLimit: profile.outputLimit })).digest('hex');
}
export class RuntimeService {
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly dispatches = new Set<Promise<unknown>>();
  private readonly credentials = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly probing = new Set<string>();
  readonly redactor = new Redactor();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private readonly tools: ToolRuntime;
  private readonly loop: AgentLoop;
  constructor(readonly store: Store, private readonly repositories: RepositoryService, private readonly emit: (event: WorkspaceEvent) => void, providerFactory: (kind: ModelProfile['apiKind']) => ProviderAdapter = createProvider, commands = new CommandRunner()) {
    this.providerFactory = providerFactory;
    const slots = new ExecutionSlots();
    const publish = (type: string, data: unknown, taskId: string): void => this.publish(type, data, taskId);
    this.tools = new ToolRuntime(store, repositories, commands, this.redactor, publish, slots);
    this.loop = new AgentLoop(store, this.tools, slots, this.redactor, providerFactory, publish);
  }
  private readonly providerFactory: (kind: ModelProfile['apiKind']) => ProviderAdapter;
  private publish(type: string, data: unknown, taskId?: string): void { this.emit(this.store.event(type, data, taskId)); }
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
  private async dispatchInternal(method: RpcMethod, input: unknown): Promise<unknown> {
    if (this.closing) throw new Error('Runtime is shutting down.');
    const params = RpcMethods[method].parse(input);
    switch (method) {
      case 'workspace.snapshot': return this.store.snapshot();
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
        const p = params as { title: string; projectPath: string; profileId: string; tokenBudget: number; mode: 'chat' | 'coding' };
        const selected = this.store.profile(p.profileId);
        if (!selected) throw new Error('Select an existing model profile.');
        if (p.mode === 'coding' && selected.apiKind !== 'fake' && (selected.verificationFingerprint !== profileFingerprint(selected) || !selected.capabilities?.tools || !selected.capabilities?.continuation)) throw new Error('Probe tool and continuation capabilities before creating a coding task.');
        if (this.store.unknownIntents()) throw new Error('An earlier worktree creation has an unknown outcome. Inspect the retained worktree and database intent before creating another task.');
        const id = randomUUID(); const intent = this.store.intent('worktree.create', { taskId: id, projectPath: p.projectPath });
        try {
          const worktree = await this.repositories.createTaskWorktree(p.projectPath, id);
          const now = new Date().toISOString();
          const task: Task = { id, title: this.redactor.text(p.title), projectPath: p.projectPath, ...worktree, profileId: p.profileId, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: p.tokenBudget, usedTokens: 0, mode: p.mode };
          this.store.transaction(() => { this.store.saveTask(task); this.store.finishIntent(intent, 'complete'); });
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
        const p = params as { taskId: string; content: string }; this.startTurn(p.taskId, p.content); return { accepted: true };
      }
      case 'task.cancel': {
        const entry = this.running.get((params as { taskId: string }).taskId); entry?.abort.abort();
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
    }
  }
  private startTurn(taskId: string, content: string): void {
    if (this.running.has(taskId)) throw new Error('This task already has an active response.');
    if (this.running.size >= 16) throw new Error('Too many active tasks. Finish or cancel a task first.');
    const task = this.store.task(taskId);
    const profile = this.store.profile(task.profileId);
    if (!profile) throw new Error('Profile not found.');
    if (profile.apiKind !== 'fake' && profile.verificationFingerprint !== profileFingerprint(profile)) throw new Error('Probe this model profile successfully before starting a response.');
    if (task.mode === 'coding' && profile.apiKind !== 'fake' && (!profile.capabilities?.tools || !profile.capabilities?.continuation)) throw new Error('Probe tool and continuation capabilities before starting a coding response.');
    const cleanContent = this.redactor.text(content);
    const abort = new AbortController();
    const fingerprint = profileFingerprint(profile);
    const request = prepareRequest(this.store, task, profile, fingerprint, cleanContent, this.credentials.get(profile.id), abort.signal);
    const reservation = reserveRequest(task, request);
    const now = new Date().toISOString();
    const answer: Message = { id: randomUUID(), taskId, role: 'assistant', content: '', createdAt: now, status: 'streaming' };
    this.store.transaction(() => {
      this.store.saveMessage({ id: randomUUID(), taskId, role: 'user', content: cleanContent, createdAt: now, status: 'complete' });
      this.store.saveMessage(answer);
      this.store.saveTask({ ...task, status: 'running', updatedAt: now, usedTokens: task.usedTokens + reservation });
    });
    const done = Promise.resolve().then(() => this.loop.run(task, request, answer, reservation, fingerprint, abort)).finally(() => this.running.delete(taskId));
    this.running.set(taskId, { abort, done });
    this.publish('task.started', {}, taskId);
    if (task.usedTokens + reservation >= task.tokenBudget * 0.8) this.publish('task.budget-warning', { usedTokens: task.usedTokens + reservation, budget: task.tokenBudget }, taskId);
  }
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = (async () => {
      for (const { abort } of this.running.values()) abort.abort();
      // Worktree creation and profile probes are not model loops. Let them reach a
      // known result before closing SQLite; an external supervisor may still kill
      // an overlong drain, in which case intent recovery remains conservative.
      await Promise.allSettled([
        ...[...this.running.values()].map(entry => entry.done),
        ...this.dispatches
      ]);
      this.store.close();
    })();
    return this.shutdownPromise;
  }
}
