import { z } from 'zod';
import { EFFORTS, supportedEfforts } from './limits';

export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;
export { supportedEfforts };
// SQLite stores canonical UTC strings; normalize RPC offsets before comparisons.
const Timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const UsageFiltersSchema = z.object({
  from: Timestamp.optional(), to: Timestamp.optional(), includeDemo: z.boolean().default(false),
  taskId: z.string().uuid().optional(), includeChildren: z.boolean().default(true),
  profileId: z.string().uuid().optional(), apiKind: z.enum(['fake', 'responses', 'chat-completions', 'anthropic']).optional(),
  model: z.string().max(202).regex(/^(?:u:|[rd]:[\s\S]{1,200})$/).optional(), effort: z.union([EffortSchema, z.literal('default'), z.literal('unknown')]).optional(),
  purpose: z.enum(['conversation', 'probe', 'legacy']).optional()
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to), 'Start must precede end.');
export type UsageFilters = z.input<typeof UsageFiltersSchema>;
export const UsageGroupSchema = z.enum(['conversation', 'model', 'effort', 'modelEffort', 'profile', 'api']);
export type UsageGroup = z.infer<typeof UsageGroupSchema>;
export const UsageRpc = {
  'usage.summary': z.object({ filters: UsageFiltersSchema.prefault({}), timeZone: z.string().max(100).default('UTC') }).strict().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); return true; } catch { return false; } }, 'Invalid time zone.'),
  'usage.breakdown': z.object({ filters: UsageFiltersSchema.prefault({}), groupBy: UsageGroupSchema, sort: z.enum(['tokens', 'requests', 'name']).default('tokens'), cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  'usage.requests': z.object({ filters: UsageFiltersSchema.prefault({}), cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict()
} as const;
export interface UsageTotals {
  requests: number; attemptedRequests: number; pendingRequests: number; knownRequests: number; unknownRequests: number; notSentRequests: number;
  input: number; output: number; total: number;
  cacheRead: number | null; cacheCreation: number | null; reasoning: number | null;
  cacheReadKnownRequests: number; cacheCreationKnownRequests: number; reasoningKnownRequests: number;
  reservedUnknown: number; reservedPending: number; reservedNotSent: number;
}
export type RequestOutcome = 'pending' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export interface UsageRequest {
  requestId: string; taskId: string | null; rootTaskId: string | null; parentTaskId: string | null;
  taskTitle: string | null; rootTaskTitle?: string | null; role: string | null; purpose: 'conversation' | 'probe' | 'legacy';
  profileId: string | null; profileName: string | null; apiKind: string | null; deployment: string | null;
  effort: Effort | null; attributionKnown: boolean; reportedModel: string | null; responseId: string | null;
  createdAt: string; attemptedAt: string | null; finishedAt: string | null; outcome: RequestOutcome;
  reservedTokens: number; inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheCreationTokens: number | null; reasoningTokens: number | null;
  usageKnown: boolean; reason: string | null;
}
export interface UsageSummary { totals: UsageTotals; days: Array<{ date: string; totals: UsageTotals }>; detailedTracking: boolean; daysTruncated?: boolean; }
export interface UsageBreakdownRow { key: string; label: string; totals: UsageTotals; sharePercent: number; filters: UsageFilters; }
export interface UsageBreakdown { rows: UsageBreakdownRow[]; nextCursor: string | null; }
export interface UsageRequests { records: UsageRequest[]; nextCursor: string | null; }
