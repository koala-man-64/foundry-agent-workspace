import { z } from 'zod';

export const MAX_RPC_BYTES = 1024 * 1024;
export const ApiKindSchema = z.enum(['fake', 'responses', 'chat-completions', 'anthropic']);
export type ApiKind = z.infer<typeof ApiKindSchema>;
export const ModelProfileSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100), apiKind: ApiKindSchema,
  endpoint: z.string().max(2048), deployment: z.string().max(200),
  credentialRef: z.string().max(100).optional(), contextLimit: z.number().int().min(1024).max(2000000),
  outputLimit: z.number().int().min(16).max(128000),
  verifiedAt: z.string().optional(), verificationFingerprint: z.string().optional()
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type TaskStatus = 'idle' | 'running' | 'cancelled' | 'interrupted' | 'failed';
export interface Task { id: string; title: string; projectPath: string; worktreePath: string; branch: string; baseCommit: string; profileId: string; status: TaskStatus; createdAt: string; updatedAt: string; tokenBudget: number; usedTokens: number; }
export interface Message { id: string; taskId: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; status: 'complete' | 'streaming' | 'cancelled' | 'interrupted' | 'failed'; }
export interface WorkspaceEvent { sequence: number; type: string; taskId?: string; data: unknown; createdAt: string; }
export interface Snapshot { tasks: Task[]; profiles: ModelProfile[]; lastSequence: number; runtime: 'ready'; }
export interface TaskDetail { task: Task; messages: Message[]; }
export interface FileEntry { path: string; kind: 'file' | 'directory'; }
export interface FileContent { path: string; content: string; hash: string; }
export interface DiffResult { summary: string; patch: string; truncated: boolean; }
export interface ProbeResult { ok: boolean; capabilities: { streaming: boolean; tools: boolean; continuation: boolean; cancellation: boolean; usage: boolean }; detail: string; fingerprint: string; }

const Id = z.string().uuid();
export const RpcMethods = {
  'workspace.snapshot': z.object({}).strict(),
  'task.create': z.object({ title: z.string().trim().min(1).max(160), projectPath: z.string().min(1).max(4096), profileId: Id, tokenBudget: z.number().int().min(1024).max(10000000).default(100000) }).strict(),
  'task.get': z.object({ taskId: Id }).strict(),
  'task.send': z.object({ taskId: Id, content: z.string().trim().min(1).max(64000) }).strict(),
  'task.cancel': z.object({ taskId: Id }).strict(),
  'profile.save': ModelProfileSchema,
  'profile.probe': z.object({ profileId: Id }).strict(),
  'files.list': z.object({ taskId: Id, path: z.string().max(4096).default('') }).strict(),
  'files.read': z.object({ taskId: Id, path: z.string().min(1).max(4096) }).strict(),
  'task.diff': z.object({ taskId: Id }).strict()
} as const;
export type RpcMethod = keyof typeof RpcMethods;
export const RpcRequestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.string().min(1).max(100), method: z.enum(Object.keys(RpcMethods) as [RpcMethod, ...RpcMethod[]]), params: z.unknown() }).strict();
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = { jsonrpc: '2.0'; id: string; result: unknown } | { jsonrpc: '2.0'; id: string; error: { code: number; message: string } };
export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), id: z.string(), error: z.object({ code: z.number(), message: z.string() }).strict() }).strict()
]);
export interface DesktopApi {
  invoke(method: 'workspace.snapshot', params: Record<string, never>): Promise<Snapshot>;
  invoke(method: 'task.create', params: z.input<typeof RpcMethods['task.create']>): Promise<Task>;
  invoke(method: 'task.get', params: { taskId: string }): Promise<TaskDetail>;
  invoke(method: 'task.send' | 'task.cancel', params: { taskId: string; content?: string }): Promise<{ accepted: boolean }>;
  invoke(method: 'profile.save', params: ModelProfile): Promise<ModelProfile>;
  invoke(method: 'profile.probe', params: { profileId: string }): Promise<ProbeResult>;
  invoke(method: 'files.list', params: { taskId: string; path?: string }): Promise<FileEntry[]>;
  invoke(method: 'files.read', params: { taskId: string; path: string }): Promise<FileContent>;
  invoke(method: 'task.diff', params: { taskId: string }): Promise<DiffResult>;
  pickProject(): Promise<string | null>;
  saveCredential(profileId: string, value: string): Promise<void>;
  onEvent(listener: (event: WorkspaceEvent) => void): () => void;
}

export interface ProviderMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export interface ProviderRequest { profile: ModelProfile; messages: ProviderMessage[]; credential?: string; signal: AbortSignal; }
export type ProviderEvent = { type: 'text'; text: string } | { type: 'usage'; inputTokens: number; outputTokens: number } | { type: 'done' };
export interface ProviderAdapter { streamTurn(request: ProviderRequest): AsyncIterable<ProviderEvent>; probe(profile: ModelProfile, credential?: string): Promise<ProbeResult>; }
