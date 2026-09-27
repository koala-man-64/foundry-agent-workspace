import { z } from 'zod';
import type { Approval, Message, ModelProfile, Project, Task, UsageRecord, WorkspaceEvent, WorkspacePreferences } from './index';

const Id = z.string().uuid();
const Ordinal = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PageSize = z.number().int().min(1).max(50).default(50);
export const TaskCursorSchema = z.object({ at: z.string(), id: Id, highWaterAt: z.string(), highWaterId: Id, filterHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type TaskCursor = z.infer<typeof TaskCursorSchema>;
export const SearchCursorSchema = z.object({
  phase: z.enum(['titles', 'messages']), titleAfter: z.object({ at: z.string(), id: Id }).strict().optional(),
  beforeOrdinal: Ordinal.optional(), throughOrdinal: Ordinal, taskThroughRowid: Ordinal, filterHash: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();
export type SearchCursor = z.infer<typeof SearchCursorSchema>;

export const WorkspaceRpc = {
  'workspace.summary': z.object({}).strict(),
  'workspace.profiles': z.object({ after: Id.optional(), limit: PageSize }).strict(),
  'workspace.projects': z.object({ after: Id.optional(), limit: PageSize }).strict(),
  'profile.read': z.object({ profileId: Id }).strict(),
  'workspace.tasks': z.object({
    visibility: z.enum(['active', 'archived', 'all']).default('active'),
    sort: z.enum(['created', 'recent']).default('created'),
    limit: PageSize,
    cursor: TaskCursorSchema.optional(),
    projectPath: z.string().max(4096).optional(),
    projectId: Id.optional(),
    mode: z.enum(['chat', 'coding', 'coordinated']).optional(),
    status: z.enum(['idle', 'running', 'cancelled', 'interrupted', 'failed', 'retired']).optional(),
    from: z.string().datetime().optional(), to: z.string().datetime().optional()
  }).strict(),
  'workspace.search': z.object({
    query: z.string().trim().min(1).max(200),
    visibility: z.enum(['active', 'archived', 'all']).default('all'),
    limit: PageSize, cursor: SearchCursorSchema.optional(),
    projectPath: z.string().max(4096).optional(),
    projectId: Id.optional(),
    mode: z.enum(['chat', 'coding', 'coordinated']).optional(),
    status: z.enum(['idle', 'running', 'cancelled', 'interrupted', 'failed', 'retired']).optional(),
    from: z.string().datetime().optional(), to: z.string().datetime().optional()
  }).strict(),
  'workspace.actions': z.object({ limit: PageSize, cursor: z.object({ tier: z.union([z.literal(0), z.literal(1), z.literal(2)]), at: z.string(), id: z.string() }).strict().optional() }).strict(),
  'workspace.events': z.object({ after: Ordinal.default(0), limit: PageSize, taskId: Id.optional() }).strict(),
  'workspace.usageTrend': z.object({ groupBy: z.enum(['day', 'profile', 'task']), from: z.string().datetime().optional(), to: z.string().datetime().optional(),
    profileId: Id.optional(), taskId: Id.optional(), after: z.string().max(100).optional(), limit: PageSize }).strict(),
  'task.timeline': z.object({ taskId: Id, before: Ordinal.optional(), limit: PageSize }).strict(),
  'task.read': z.object({ taskId: Id }).strict(),
  'task.messages': z.object({ taskId: Id, before: Ordinal.optional(), through: Ordinal.optional(), limit: PageSize }).strict(),
  'task.messageContent': z.object({ taskId: Id, messageId: Id, offset: Ordinal.default(0), maxBytes: z.number().int().min(1).max(64 * 1024).default(64 * 1024) }).strict(),
  'task.usageRecords': z.object({ taskId: Id, before: Ordinal.optional(), limit: PageSize }).strict(),
  'task.compactions': z.object({ taskId: Id, before: Ordinal.optional(), limit: PageSize }).strict(),
  'task.compactionContent': z.object({ taskId: Id, compactionId: Id, offset: Ordinal.default(0), maxBytes: z.number().int().min(1).max(64 * 1024).default(64 * 1024) }).strict(),
  'task.approvals': z.object({ taskId: Id, limit: PageSize, before: Ordinal.optional() }).strict(),
  'approval.get': z.object({ taskId: Id, approvalId: Id }).strict(),
  'approval.content': z.object({ taskId: Id, approvalId: Id, field: z.enum(['full','summary','before','after','command','result.content','handoff.patch','integration.patch','mcp.arguments']),
    offset: Ordinal.default(0), maxBytes: z.number().int().min(1).max(32 * 1024).default(32 * 1024) }).strict(),
  'task.setArchived': z.object({ taskId: Id, archived: z.boolean() }).strict()
} as const;

export type WorkspaceMethod = keyof typeof WorkspaceRpc;
export interface WorkspaceSummary { profiles: ModelProfile[]; nextProfileAfter: string | null; projects: Project[]; nextProjectAfter: string | null; preferences: WorkspacePreferences; lastSequence: number; runtime: 'ready' }
export interface ProfilePage { profiles: ModelProfile[]; nextAfter: string | null }
export interface ProjectPage { projects: Project[]; nextAfter: string | null }
export interface TaskPage { tasks: Task[]; nextCursor: TaskCursor | null; visibility: 'active' | 'archived' | 'all' }
export interface MessageItem { message: Message & { truncated?: boolean }; ordinal: number }
export interface MessagePage { items: MessageItem[]; nextBefore: number | null; through: number }
export interface MessageContentChunk { messageId: string; content: string; offset: number; nextOffset: number | null; totalBytes: number }
export interface TaskRead { task: Task; compactionCount: number; pendingApprovals: number; unknownOutcomes: number }
export interface ApprovalSummary { id: string; taskId: string; tool: string; state: Approval['state']; createdAt: string; path?: string }
export interface ApprovalPage { approvals: ApprovalSummary[]; nextBefore: number | null }
export interface ApprovalRead { approval: Approval; truncatedFields: string[]; fullBytes: number; redacted: boolean }
export interface ApprovalContentChunk { approvalId: string; field: string; content: string; offset: number; nextOffset: number | null; totalBytes: number }
export interface SearchHit { taskId: string; rootTaskId: string; taskTitle: string; messageId?: string; ordinal?: number; role?: Message['role']; excerpt: string; createdAt: string }
export interface SearchPage { hits: SearchHit[]; nextCursor: SearchCursor | null }
export interface ActionItem { id: string; taskId: string | null; sourceTaskId?: string; taskTitle: string; archived: boolean; tier: 0 | 1 | 2; kind: 'approval' | 'intent' | 'run' | 'draft' | 'task' | 'validation' | 'outcome'; state: string; sourceId: string; createdAt: string; detail: string }
export interface ActionPage { items: ActionItem[]; hasMore: boolean; nextCursor: { tier: 0 | 1 | 2; at: string; id: string } | null; counts: { needsDecision: number; inProgress: number; recent: number } }
export interface EventPage { events: WorkspaceEvent[]; nextAfter: number | null }
export interface TimelinePage { events: WorkspaceEvent[]; nextBefore: number | null }
export interface UsageRecordPage { records: UsageRecord[]; nextBefore: number | null }
export interface CompactionSummary { id: string; taskId: string; fromOrdinal: number; toOrdinal: number; messageCount: number; summaryExcerpt: string; summaryTruncated: boolean; estimatedTokensBefore: number; estimatedTokensAfter: number; createdAt: string }
export interface CompactionPage { compactions: CompactionSummary[]; nextBefore: number | null }
export interface CompactionContentChunk { compactionId: string; content: string; offset: number; nextOffset: number | null; totalBytes: number }
export interface UsageTrendBucket { key: string; requests: number; knownRequests: number; unknownRequests: number; observedPrompt: number; observedCompletion: number; cacheRead: number; cacheCreation: number; reservedUnknown: number }
export interface UsageTrendPage { groupBy: 'day' | 'profile' | 'task'; buckets: UsageTrendBucket[]; nextAfter: string | null; timeZone: 'UTC' }

export interface WorkspaceApi {
  invoke(method: 'workspace.summary', params: z.input<typeof WorkspaceRpc['workspace.summary']>): Promise<WorkspaceSummary>;
  invoke(method: 'workspace.profiles', params: z.input<typeof WorkspaceRpc['workspace.profiles']>): Promise<ProfilePage>;
  invoke(method: 'workspace.projects', params: z.input<typeof WorkspaceRpc['workspace.projects']>): Promise<ProjectPage>;
  invoke(method: 'profile.read', params: z.input<typeof WorkspaceRpc['profile.read']>): Promise<ModelProfile | null>;
  invoke(method: 'workspace.tasks', params: z.input<typeof WorkspaceRpc['workspace.tasks']>): Promise<TaskPage>;
  invoke(method: 'workspace.search', params: z.input<typeof WorkspaceRpc['workspace.search']>): Promise<SearchPage>;
  invoke(method: 'workspace.actions', params: z.input<typeof WorkspaceRpc['workspace.actions']>): Promise<ActionPage>;
  invoke(method: 'workspace.events', params: z.input<typeof WorkspaceRpc['workspace.events']>): Promise<EventPage>;
  invoke(method: 'workspace.usageTrend', params: z.input<typeof WorkspaceRpc['workspace.usageTrend']>): Promise<UsageTrendPage>;
  invoke(method: 'task.timeline', params: z.input<typeof WorkspaceRpc['task.timeline']>): Promise<TimelinePage>;
  invoke(method: 'task.read', params: z.input<typeof WorkspaceRpc['task.read']>): Promise<TaskRead>;
  invoke(method: 'task.messages', params: z.input<typeof WorkspaceRpc['task.messages']>): Promise<MessagePage>;
  invoke(method: 'task.messageContent', params: z.input<typeof WorkspaceRpc['task.messageContent']>): Promise<MessageContentChunk>;
  invoke(method: 'task.usageRecords', params: z.input<typeof WorkspaceRpc['task.usageRecords']>): Promise<UsageRecordPage>;
  invoke(method: 'task.compactions', params: z.input<typeof WorkspaceRpc['task.compactions']>): Promise<CompactionPage>;
  invoke(method: 'task.compactionContent', params: z.input<typeof WorkspaceRpc['task.compactionContent']>): Promise<CompactionContentChunk>;
  invoke(method: 'task.approvals', params: z.input<typeof WorkspaceRpc['task.approvals']>): Promise<ApprovalPage>;
  invoke(method: 'approval.get', params: z.input<typeof WorkspaceRpc['approval.get']>): Promise<ApprovalRead>;
  invoke(method: 'approval.content', params: z.input<typeof WorkspaceRpc['approval.content']>): Promise<ApprovalContentChunk>;
  invoke(method: 'task.setArchived', params: z.input<typeof WorkspaceRpc['task.setArchived']>): Promise<Task>;
}
