import { z } from 'zod';

const Id = z.string().uuid();
const Text = z.string().trim().min(1).max(2000);
export const HookTriggerSchema = z.enum(['task.started', 'task.completed', 'task.stopped', 'approval.changed']);
export const HookActionSchema = z.enum(['notification', 'label', 'promptDraft', 'actionDraft']);
export const ActionProposalSchema = z.object({ tool: z.enum(['run_command', 'write_file']), arguments: z.record(z.string(), z.unknown()) }).strict();
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export const HookConditionSchema = z.object({ status: z.enum(['idle', 'running', 'cancelled', 'interrupted', 'failed', 'retired']).optional(), mode: z.enum(['chat', 'coding', 'coordinated']).optional(), approvalState: z.enum(['awaiting-approval', 'approved', 'executing', 'complete', 'rejected', 'revoked', 'unknown', 'failed']).optional() }).strict();
export const HookRuleSchema = z.object({
  id: Id, version: z.number().int().positive(), name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  triggers: z.array(HookTriggerSchema).min(1).max(4), projectPath: z.string().max(4096).nullable(), taskId: Id.optional(), conditions: HookConditionSchema.optional(),
  action: HookActionSchema, title: Text, body: z.string().max(8000), proposal: ActionProposalSchema.optional(),
}).strict();
export type HookRule = z.infer<typeof HookRuleSchema>;

export const ScriptLanguageSchema = z.enum(['powershell', 'javascript']);
export const ScriptRegistrationSchema = z.object({
  id: Id, name: z.string().trim().min(1).max(100), language: ScriptLanguageSchema,
  source: z.string().min(1).max(64 * 1024), triggers: z.array(HookTriggerSchema).min(1).max(4),
  projectPath: z.string().max(4096).nullable(), arguments: z.array(z.string().max(512)).max(16).default([]),
  cwd: z.string().max(4096), inputFields: z.array(z.enum(['sequence', 'type', 'taskId', 'createdAt', 'projectPath', 'title', 'status', 'approvalId', 'approvalState'])).max(9),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
}).strict();
export type ScriptRegistration = z.infer<typeof ScriptRegistrationSchema>;
export interface ScriptRevision { id: string; scriptId: string; sha256: string; interpreterPath: string; interpreterSha256: string; interpreterVersion: string; snapshotPath: string; configSha256: string; registeredAt: string; trusted: boolean; }
export const ScriptGrantSchema = z.object({ revisionId: Id, expiresAt: z.string().datetime(), maxRunsPer24h: z.number().int().min(1).max(100).default(100) }).strict();
export type ScriptGrant = z.infer<typeof ScriptGrantSchema>;
export interface ScriptGrantSnapshot extends ScriptGrant { id: string; grantedAt: string; }
export interface HookRun { id: string; ruleId: string; ruleVersion: number; eventSequence: number; state: 'queued' | 'dispatching' | 'running' | 'complete' | 'failed' | 'unknown' | 'cancelled'; createdAt: string; updatedAt: string; detail?: string;
  grantSnapshot?: ScriptGrantSnapshot; pin?: { revisionId: string; scriptId: string; sourceSha256: string; interpreterSha256: string; configSha256: string }; }
export interface AutomationDraft { id: string; source: 'hook' | 'schedule'; sourceId: string; taskId: string | null; kind: 'notification' | 'label' | 'promptDraft' | 'actionDraft'; title: string; body: string; proposal?: ActionProposal; state: 'open' | 'dismissed' | 'preparing' | 'awaiting-approval' | 'complete' | 'rejected' | 'revoked' | 'failed' | 'unknown'; approvalId?: string; createdAt: string; occurrence?: { revision: string; localDate: string; localTime: string; timeZone: string; dueAt: string }; }

export const ScheduleSchema = z.object({
  id: Id, name: z.string().trim().min(1).max(100), enabled: z.boolean(), projectPath: z.string().max(4096).nullable(),
  taskId: Id.nullable(), kind: z.enum(['reminder', 'promptDraft']), title: Text, body: z.string().max(8000),
  cadence: z.enum(['once', 'daily', 'weekly']), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(100), startAt: z.string().datetime(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }, 'Use a valid calendar date.').optional(), weekDay: z.number().int().min(0).max(6).nullable(),
}).strict();
export type Schedule = z.infer<typeof ScheduleSchema>;
export interface AutomationView { rules: HookRule[]; scripts: { registration: Omit<ScriptRegistration, 'source'>; revision: ScriptRevision; grant: ScriptGrantSnapshot | null }[]; schedules: Schedule[]; drafts: AutomationDraft[]; runs: HookRun[]; truncated: boolean; }
export const AutomationQuerySchema = z.object({ kind: z.enum(['rules', 'scripts', 'schedules', 'drafts', 'runs']), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(20).default(20) }).strict();
export interface AutomationPage { kind: z.infer<typeof AutomationQuerySchema>['kind']; items: (HookRule | { registration: Omit<ScriptRegistration, 'source'>; revision: ScriptRevision; grant: ScriptGrantSnapshot | null } | Schedule | AutomationDraft | HookRun)[]; nextCursor: number | null; }
export const AutomationRpc = {
  'automation.list': z.object({}).strict(),
  'automation.query': AutomationQuerySchema,
  'automation.rule.save': HookRuleSchema,
  'automation.rule.preview': z.object({ ruleId: Id, taskId: Id, eventType: HookTriggerSchema, approvalState: HookConditionSchema.shape.approvalState }).strict(),
  'automation.rule.remove': z.object({ ruleId: Id }).strict(),
  'automation.script.register': ScriptRegistrationSchema,
  'automation.script.source': z.object({ revisionId: Id }).strict(),
  'automation.script.grant': ScriptGrantSchema,
  'automation.script.revoke': z.object({ revisionId: Id }).strict(),
  'automation.schedule.save': ScheduleSchema,
  'automation.schedule.remove': z.object({ scheduleId: Id }).strict(),
  'automation.schedule.tick': z.object({}).strict(),
  'automation.draft.dismiss': z.object({ draftId: Id }).strict(),
  'automation.draft.prepare': z.object({ draftId: Id }).strict(),
} as const;
export interface AutomationApi {
  invoke(method: 'automation.list', params: Record<string, never>): Promise<AutomationView>;
  invoke(method: 'automation.query', params: z.input<typeof AutomationQuerySchema>): Promise<AutomationPage>;
  invoke(method: 'automation.rule.save', params: HookRule): Promise<HookRule>;
  invoke(method: 'automation.rule.preview', params: z.input<typeof AutomationRpc['automation.rule.preview']>): Promise<{ matches: boolean; reason: string | null; draftPreview: Pick<AutomationDraft, 'kind' | 'title' | 'body' | 'proposal'> | null }>;
  invoke(method: 'automation.rule.remove', params: { ruleId: string }): Promise<{ removed: boolean }>;
  invoke(method: 'automation.script.register', params: ScriptRegistration): Promise<ScriptRevision>;
  invoke(method: 'automation.script.source', params: { revisionId: string }): Promise<{ source: string; revision: ScriptRevision }>;
  invoke(method: 'automation.script.grant', params: ScriptGrant): Promise<ScriptRevision>;
  invoke(method: 'automation.script.revoke', params: { revisionId: string }): Promise<{ revoked: boolean }>;
  invoke(method: 'automation.schedule.save', params: Schedule): Promise<Schedule>;
  invoke(method: 'automation.schedule.remove', params: { scheduleId: string }): Promise<{ removed: boolean }>;
  invoke(method: 'automation.schedule.tick', params: Record<string, never>): Promise<{ created: number }>;
  invoke(method: 'automation.draft.dismiss', params: { draftId: string }): Promise<{ dismissed: boolean }>;
  invoke(method: 'automation.draft.prepare', params: { draftId: string }): Promise<{ approvalId: string }>;
}
