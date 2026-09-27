import { z } from 'zod';
import { BrowserRecoveryRpc, type BrowserCommand, type BrowserState, type BrowserApprovalData } from './browser';
export * from './browser';
import { CoordinationConfigSchema, OrchestrationRpc, type AgentRole, type ChildDetail, type CoordinationConfig, type OrchestrationView, type SchemaStatus, type UpgradeResult } from './orchestration';
import { EffortSchema, supportedEfforts, UsageRpc, type UsageSummary, type UsageBreakdown, type UsageRequests, type UsageTotals } from './usage';
export * from './usage';
export * from './orchestration';
import { ChannelRpc, type AgentMessage, type ChannelView } from './agent-channel';
export * from './agent-channel';
import { WorkspaceRpc, type WorkspaceApi } from './workspace';
export * from './workspace';
import { AutomationRpc, type AutomationApi } from './automation';
export * from './automation';
import { ContinuityRpc, type ContinuityApi } from './continuity';
export * from './continuity';
import { FeatureRpc, type FeatureApi } from './features';
export * from './features';

export const MAX_RPC_BYTES = 1024 * 1024;
export const ApiKindSchema = z.enum(['fake', 'responses', 'chat-completions', 'anthropic']);
export type ApiKind = z.infer<typeof ApiKindSchema>;
export const CapabilitiesSchema = z.object({ streaming: z.boolean(), tools: z.boolean(), continuation: z.boolean(), cancellation: z.boolean(), usage: z.boolean() }).strict();
export const ModelProfileSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100), apiKind: ApiKindSchema,
  endpoint: z.string().max(2048), deployment: z.string().max(200),
  credentialRef: z.string().max(100).optional(), contextLimit: z.number().int().min(1024).max(2000000),
  outputLimit: z.number().int().min(16).max(128000),
  effort: EffortSchema.optional(),
  verifiedAt: z.string().optional(), verificationFingerprint: z.string().optional(), capabilities: CapabilitiesSchema.optional()
}).strict().refine(value => value.effort === undefined || supportedEfforts(value.apiKind).includes(value.effort), { message: 'Effort is not supported by this API type.', path: ['effort'] });
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type TaskStatus = 'idle' | 'running' | 'cancelled' | 'interrupted' | 'failed' | 'retired';
export interface TaskBase { id: string; title: string; projectId?: string; profileId: string; status: TaskStatus; createdAt: string; updatedAt: string; tokenBudget: number; usedTokens: number; mode?: 'chat' | 'coding' | 'coordinated';
  /** Set once the task worktree was retired through the explicit user action; the branch and history remain. */
  retiredAt?: string;
  archivedAt?: string;
  /** Present only on coordinated roots and their children. Legacy tasks omit every field below. */
  rootTaskId?: string; parentTaskId?: string; role?: AgentRole; assignmentId?: string; coordination?: CoordinationConfig; }
export interface GitTask extends TaskBase { workspaceKind?: 'git'; projectPath: string; worktreePath: string; branch: string; baseCommit: string; }
export interface FolderTask extends TaskBase { workspaceKind: 'folder'; projectPath: string; worktreePath?: never; branch?: never; baseCommit?: never; mode: 'chat'; }
export interface NoFolderTask extends TaskBase { workspaceKind: 'none'; projectPath?: never; worktreePath?: never; branch?: never; baseCommit?: never; mode: 'chat'; }
export type Task = GitTask | FolderTask | NoFolderTask;
export function isGitTask(task: Task): task is GitTask { return !task.workspaceKind || task.workspaceKind === 'git'; }
export interface Project { id: string; name: string; path: string; hidden: boolean; kind: 'git' | 'folder' | 'unavailable'; unavailableReason?: string; createdAt: string; updatedAt: string; }
export interface WorkspacePreferences { profileId: string; mode: 'chat' | 'coding' | 'coordinated'; collapsedProjectIds: string[]; }
export interface Message { id: string; taskId: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; status: 'complete' | 'streaming' | 'cancelled' | 'interrupted' | 'failed'; }
export interface WorkspaceEvent { sequence: number; type: string; taskId?: string; rootTaskId?: string; data: unknown; createdAt: string; version?: 1; source?: 'runtime' | 'legacy'; legacy?: true; }
export interface Snapshot { tasks: Task[]; profiles: ModelProfile[]; projects: Project[]; preferences: WorkspacePreferences; lastSequence: number; runtime: 'ready'; }
export interface TaskDetail { task: Task; messages: Message[]; approvals?: Approval[]; compactions?: CompactionRecord[]; hasUnknownPublication?: boolean; }
/** One provider request's accounting. Unknown usage keeps its full conservative reservation. */
export interface UsageRecord { id: string; taskId: string; requestId: string; reservedTokens: number; promptTokens: number | null; completionTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null; usageKnown: boolean; reason: string | null; createdAt: string; }
/** A retained compaction: the summarized message range and the context estimate before and after. Originals are never deleted. */
export interface CompactionRecord { id: string; taskId: string; fromOrdinal: number; toOrdinal: number; messageIds: string[]; summary: string; estimatedTokensBefore: number; estimatedTokensAfter: number; createdAt: string; }
export const CONTEXT_WARNING_PERCENT = 80;
export interface UsageReport {
  taskId: string; tokenBudget: number; usedTokens: number; contextLimit: number; outputLimit: number;
  /** Conservative byte-based estimate of the next request's context (messages, native continuation, tool schemas) plus the output reservation. */
  estimatedContextTokens: number; contextPercent: number; warningPercent: number;
  totals: { requests: number; knownRequests: number; unknownRequests: number; prompt: number; completion: number; cacheRead: number; cacheCreation: number; reservedUnknown: number };
  records: UsageRecord[]; compactions: import('./workspace').CompactionSummary[];
  recordsNextBefore?: number | null; compactionsNextBefore?: number | null;
  metrics?: UsageTotals;
}
export const McpServerConfigSchema = z.object({
  id: z.string().uuid(), key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), name: z.string().trim().min(1).max(100),
  command: z.string().min(1).max(4096), arguments: z.array(z.string().max(4096)).max(32).default([]), cwd: z.string().max(4096).default(''),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).default({}),
  enabled: z.boolean().default(true),
  /** User-managed allowlist of tools that run without a per-call approval. Server annotations never populate it. */
  readOnlyTools: z.array(z.string().max(64)).max(64).default([]),
  callTimeoutMs: z.number().int().min(1000).max(600000).default(60000)
}).strict();
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint: boolean; }
export interface McpServerStatus extends Omit<McpServerConfig, 'arguments' | 'environment'> { argumentCount: number; environmentCount: number; environmentNames: string[]; tools: Pick<McpTool, 'name' | 'description' | 'readOnlyHint'>[]; toolsListedAt: string | null; serverInfo: { name: string; version: string } | null; lastError: string | null; running: boolean; }
export interface McpStatusPage { items: McpServerStatus[]; nextCursor: string | null; }
export interface DiagnosticsExport { path: string; bytes: number; sha256: string; }
export interface CommitResult { commit: string; branch: string; changedPaths: string[]; }
export interface PushResult { remote: string; branch: string; detail: string; }
export interface RetireResult { taskId: string; branch: string; removedWorktrees: string[]; }
export interface FileEntry { path: string; kind: 'file' | 'directory'; }
export interface FileContent { path: string; content: string; hash: string; }
export interface DiffResult { summary: string; patch: string; truncated: boolean; }
export interface ProbeResult { ok: boolean; capabilities: { streaming: boolean; tools: boolean; continuation: boolean; cancellation: boolean; usage: boolean }; detail: string; fingerprint: string; }

const Id = z.string().uuid();
export const RpcMethods = {
  ...BrowserRecoveryRpc,
  'project.add': z.object({ path: z.string().trim().min(1).max(4096) }).strict(),
  'project.update': z.object({ projectId: Id, name: z.string().trim().min(1).max(100).optional(), hidden: z.boolean().optional() }).strict(),
  'workspace.preferences.save': z.object({ profileId: Id.optional(), mode: z.enum(['chat', 'coding', 'coordinated']).optional(), collapsedProjectIds: z.array(z.union([Id, z.literal('none')])).max(1000).optional() }).strict(),
  'task.start': z.object({ requestId: Id, projectId: Id.nullable(), content: z.string().trim().min(1).max(64000), title: z.string().trim().min(1).max(160).optional(), profileId: Id, mode: z.enum(['chat', 'coding', 'coordinated']), tokenBudget: z.number().int().min(1024).max(10000000).default(100000), coordination: CoordinationConfigSchema.optional() }).strict(),
  'task.create': z.object({ title: z.string().trim().min(1).max(160), projectPath: z.string().min(1).max(4096), profileId: Id, tokenBudget: z.number().int().min(1024).max(10000000).default(100000), mode: z.enum(['chat', 'coding', 'coordinated']).default('chat'), coordination: CoordinationConfigSchema.optional() }).strict(),
  'task.send': z.object({ taskId: Id, content: z.string().trim().min(1).max(64000) }).strict(),
  'task.cancel': z.object({ taskId: Id }).strict(),
  'profile.save': ModelProfileSchema,
  'profile.probe': z.object({ profileId: Id }).strict(),
  'files.list': z.object({ taskId: Id, path: z.string().max(4096).default('') }).strict(),
  'files.read': z.object({ taskId: Id, path: z.string().min(1).max(4096) }).strict(),
  'task.diff': z.object({ taskId: Id }).strict(),
  'approval.decide': z.object({ taskId: Id, approvalId: Id, nonce: z.string().min(16).max(128), decision: z.enum(['approve', 'reject']) }).strict(),
  'approval.reconcile': z.object({ taskId: Id, approvalId: Id }).strict(),
  'task.compact': z.object({ taskId: Id, keepRecent: z.number().int().min(1).max(20).default(4) }).strict(),
  'task.usage': z.object({ taskId: Id }).strict(),
  'diagnostics.export': z.object({}).strict(),
  'task.commit': z.object({ taskId: Id, message: z.string().trim().min(1).max(2000) }).strict(),
  'task.push': z.object({ taskId: Id, remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default('origin'), confirm: z.literal('push') }).strict(),
  'task.reconcilePublication': z.object({ taskId: Id }).strict(),
  'task.retire': z.object({ taskId: Id, confirm: z.literal('retire') }).strict(),
  'mcp.list': z.object({ after: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(),
  'mcp.save': McpServerConfigSchema,
  'mcp.getConfig': z.object({ serverId: Id }).strict(),
  'mcp.update': z.object({ serverId: Id, enabled: z.boolean().optional(), readOnlyTools: z.array(z.string().max(64)).max(64).optional(), reconnect: z.boolean().optional() }).strict(),
  'mcp.remove': z.object({ serverId: Id }).strict(),
  ...OrchestrationRpc,
  ...ChannelRpc,
  ...UsageRpc,
  ...WorkspaceRpc,
  ...AutomationRpc,
  ...ContinuityRpc,
  ...FeatureRpc
} as const;
export type RpcMethod = keyof typeof RpcMethods;
export const RpcRequestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.string().min(1).max(100), method: z.enum(Object.keys(RpcMethods) as [RpcMethod, ...RpcMethod[]]), params: z.unknown() }).strict();
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = { jsonrpc: '2.0'; id: string; result: unknown } | { jsonrpc: '2.0'; id: string; error: { code: number; message: string } };
export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), id: z.string(), error: z.object({ code: z.number(), message: z.string() }).strict() }).strict()
]);
export interface CoreDesktopApi {
  invoke(method: 'channel.get', params: { taskId: string; before?: number; afterTaskId?: string }): Promise<ChannelView>;
  invoke(method: 'channel.send', params: { taskId: string; requestId: string; recipientTaskId?: string | null; content: string }): Promise<AgentMessage>;
  invoke(method: 'usage.summary', params: z.input<typeof UsageRpc['usage.summary']>): Promise<UsageSummary>;
  invoke(method: 'usage.breakdown', params: z.input<typeof UsageRpc['usage.breakdown']>): Promise<UsageBreakdown>;
  invoke(method: 'usage.requests', params: z.input<typeof UsageRpc['usage.requests']>): Promise<UsageRequests>;

  browser(command: BrowserCommand): Promise<BrowserState>;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  invoke(method: 'browser.acknowledgeUnknown', params: { taskId: string; approvalId: string; confirm: 'inspected-unknown-result' }): Promise<Approval>;
  invoke(method: 'project.add', params: { path: string }): Promise<Project>;
  invoke(method: 'project.update', params: { projectId: string; name?: string; hidden?: boolean }): Promise<Project>;
  invoke(method: 'workspace.preferences.save', params: z.input<typeof RpcMethods['workspace.preferences.save']>): Promise<WorkspacePreferences>;
  invoke(method: 'task.start', params: z.input<typeof RpcMethods['task.start']>): Promise<Task>;
  invoke(method: 'task.create', params: z.input<typeof RpcMethods['task.create']>): Promise<GitTask>;
  invoke(method: 'task.send' | 'task.cancel', params: { taskId: string; content?: string }): Promise<{ accepted: boolean }>;
  invoke(method: 'profile.save', params: ModelProfile): Promise<ModelProfile>;
  invoke(method: 'profile.probe', params: { profileId: string }): Promise<ProbeResult>;
  invoke(method: 'files.list', params: { taskId: string; path?: string }): Promise<FileEntry[]>;
  invoke(method: 'files.read', params: { taskId: string; path: string }): Promise<FileContent>;
  invoke(method: 'task.diff', params: { taskId: string }): Promise<DiffResult>;
  invoke(method: 'approval.decide', params: { taskId: string; approvalId: string; nonce: string; decision: 'approve' | 'reject' }): Promise<{ accepted: boolean }>;
  invoke(method: 'approval.reconcile', params: { taskId: string; approvalId: string }): Promise<Approval>;
  invoke(method: 'workspace.schema', params: Record<string, never>): Promise<SchemaStatus>;
  invoke(method: 'workspace.upgrade', params: { confirm: 'backup-and-upgrade' }): Promise<UpgradeResult>;
  invoke(method: 'orchestration.get', params: { rootTaskId: string; runsCursor?: number; eventsBefore?: number }): Promise<OrchestrationView>;
  invoke(method: 'orchestration.child', params: { rootTaskId: string; childTaskId: string }): Promise<ChildDetail>;
  invoke(method: 'orchestration.cancelChild', params: { rootTaskId: string; childTaskId: string; generation: number }): Promise<{ accepted: boolean }>;
  invoke(method: 'orchestration.cancelRoot', params: { rootTaskId: string }): Promise<{ accepted: boolean }>;
  invoke(method: 'orchestration.resume', params: { rootTaskId: string; content: string }): Promise<{ accepted: boolean; delivered: number }>;
  invoke(method: 'orchestration.reviseAssignment', params: { rootTaskId: string; assignmentId: string; objective: string; acceptance: string[] }): Promise<{ assignmentId: string; revision: number }>;
  invoke(method: 'orchestration.decide', params: { rootTaskId: string; taskId: string; approvalId: string; nonce: string; assignmentId: string | null; generation: number; fingerprint: string; decision: 'approve' | 'reject' }): Promise<{ accepted: boolean }>;
  invoke(method: 'orchestration.reconcile', params: { rootTaskId: string; operationId: string }): Promise<{ kind: string; detail: string }>;
  invoke(method: 'orchestration.prepareContinue', params: { rootTaskId: string; operationId: string }): Promise<{ approvalId: string }>;
  invoke(method: 'task.compact', params: { taskId: string; keepRecent?: number }): Promise<CompactionRecord>;
  invoke(method: 'task.usage', params: { taskId: string }): Promise<UsageReport>;
  invoke(method: 'diagnostics.export', params: Record<string, never>): Promise<DiagnosticsExport>;
  invoke(method: 'task.commit', params: { taskId: string; message: string }): Promise<CommitResult>;
  invoke(method: 'task.push', params: { taskId: string; remote?: string; confirm: 'push' }): Promise<PushResult>;
  invoke(method: 'task.reconcilePublication', params: { taskId: string }): Promise<{ reconciled: boolean; detail: string }>;
  invoke(method: 'task.retire', params: { taskId: string; confirm: 'retire' }): Promise<RetireResult>;
  invoke(method: 'mcp.list', params: { after?: string; limit?: number }): Promise<McpStatusPage>;
  invoke(method: 'mcp.save', params: z.input<typeof McpServerConfigSchema>): Promise<McpServerStatus>;
  invoke(method: 'mcp.getConfig', params: { serverId: string }): Promise<McpServerConfig>;
  invoke(method: 'mcp.update', params: { serverId: string; enabled?: boolean; readOnlyTools?: string[]; reconnect?: boolean }): Promise<McpServerStatus>;
  invoke(method: 'mcp.remove', params: { serverId: string }): Promise<{ removed: boolean }>;
  pickProject(): Promise<string | null>;
  saveCredential(profileId: string, value: string): Promise<void>;
  notificationPreferences(): Promise<{ enabled: boolean }>;
  setNotificationsEnabled(enabled: boolean): Promise<{ enabled: boolean }>;
  onEvent(listener: (event: WorkspaceEvent) => void): () => void;
}

export type DesktopApi = CoreDesktopApi & WorkspaceApi & AutomationApi & ContinuityApi & FeatureApi;
export interface ProviderMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface ToolCall { id: string; name: string; arguments: unknown; }
export interface ProviderToolResult { id: string; name: string; content: string; isError: boolean; }
export interface ProviderContinuation { apiKind: ApiKind; data: unknown; }
export interface ProviderRequest { profile: ModelProfile; messages: ProviderMessage[]; credential?: string; signal: AbortSignal; tools?: ToolDefinition[]; continuation?: ProviderContinuation; toolResults?: ProviderToolResult[]; channelCursor?: number; }
export type ProviderEvent = { type: 'text'; text: string } | { type: 'metadata'; reportedModel?: string; responseId?: string } | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; reasoningTokens?: number } | { type: 'tool_call'; call: ToolCall } | { type: 'done'; continuation?: ProviderContinuation };
/** Runtime-owned observation of each individual paid probe; adapters never persist data. */
export type ProbeObserver = (request: ProviderRequest, stream: () => AsyncIterable<ProviderEvent>) => AsyncIterable<ProviderEvent>;
export interface ProviderAdapter { streamTurn(request: ProviderRequest): AsyncIterable<ProviderEvent>; probe(profile: ModelProfile, credential?: string, observer?: ProbeObserver): Promise<ProbeResult>; }

export type ApprovalState = 'awaiting-approval' | 'approved' | 'executing' | 'complete' | 'rejected' | 'revoked' | 'unknown' | 'failed';
export interface Approval {
  browser?: BrowserApprovalData;
  /** Set by runtime-only draft preparation; suppresses recursive hook activation. */
  origin?: 'hook';
  id: string; taskId: string; toolCallId: string; nonce: string; tool: string; state: ApprovalState;
  createdAt: string; summary: string; path?: string; before?: string; after?: string;
  expectedHash?: string | null; resultingHash?: string;
  command?: string; cwd?: string; shell?: string; environment?: Record<string, string>; timeoutMs?: number;
  fingerprint: string; result?: { content: string; isError: boolean; exitCode?: number; cleanupVerified?: boolean };
  /** Orchestration binding. A coordinated approval can only be decided through `orchestration.decide` with all of these. */
  rootTaskId?: string; assignmentId?: string | null; generation?: number; targetLabel?: string; evidenceId?: string;
  handoff?: { operationId: string; branch: string; expectedHead: string; paths: string[]; manifestSha256: string; message: string; patch: string; patchTruncated: boolean; gitPath: string; gitSha256: string };
  /** External MCP tool call awaiting or given a one-shot decision. Arguments are the exact screened JSON the server will receive. */
  mcp?: { serverId: string; serverKey: string; serverName: string; tool: string; arguments: string };
  integration?: { operationId: string; kind: 'cherry-pick' | 'continue'; resultId: string; assignmentId: string; sourceSha: string; expectedHead: string; expectedTree: string; manifestSha256: string; resolvedTree: string | null; changedPaths: string[]; patch: string; patchTruncated: boolean; gitPath: string; gitSha256: string };
}
