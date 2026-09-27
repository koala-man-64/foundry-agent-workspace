import { z } from 'zod';
import type { Task } from './index';
import { CoordinationConfigSchema } from './orchestration';
const Id = z.string().uuid();
export const TemplateSchema = z.object({ id: Id, name: z.string().trim().min(1).max(100), prompt: z.string().max(16000), mode: z.enum(['chat','coding','coordinated']), profileId: Id,
  tokenBudget: z.number().int().min(1024).max(10000000), scope: z.array(z.string().max(4096)).max(32).default([]), coordination: CoordinationConfigSchema.optional() }).strict();
export type TaskTemplate = z.infer<typeof TemplateSchema>;
export interface TemplatePage { items: TaskTemplate[]; nextAfter: string | null; }
export interface DecisionCard { id: string; taskId: string; title: string; rationale: string; messageIds: string[]; evidenceIds: string[]; supersedesId: string | null; superseded: boolean; createdAt: string; }
export interface TaskLineage { sourceTaskId: string; taskId: string; sourceCommit: string; messageIds: string[]; evidenceIds?: string[]; contextHash: string; createdAt: string; }
export interface ContinuityView { decisions: DecisionCard[]; lineage: TaskLineage[]; nextBefore: number | null; nextLineage: string | null; }
export interface ContinuationPreview { id: string; sourceTaskId: string; sourceCommit: string; messageIds: string[]; evidenceIds: string[]; context: string; bytes: number; warnings: string[]; expiresAt: string; }
export interface ArtifactPreview { id: string; taskId: string; path: string; mimeType: string; bytes: number; sha256: string; width?: number; height?: number; content: string; nextOffset: number | null; }
export interface TranscriptExport { path: string; files: { name: string; bytes: number; sha256: string }[]; messageCount: number; }
export const ContinuityRpc = {
  'templates.list': z.object({ after: Id.optional() }).strict(), 'templates.save': TemplateSchema, 'templates.remove': z.object({ templateId: Id }).strict(),
  'continuity.get': z.object({ taskId: Id, before: z.number().int().positive().optional(), lineageAfter: Id.optional() }).strict(),
  'decision.save': z.object({ taskId: Id, title: z.string().trim().min(1).max(160), rationale: z.string().trim().min(1).max(16000), messageIds: z.array(Id).max(50).default([]), evidenceIds: z.array(z.string().max(128)).max(50).default([]), supersedesId: Id.nullable().default(null) }).strict(),
  'task.continuationPreview': z.object({ taskId: Id, messageIds: z.array(Id).max(50), evidenceIds: z.array(z.string().max(128)).max(50).default([]), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/i).optional() }).strict(),
  'task.continue': z.object({ previewId: Id, title: z.string().trim().min(1).max(160), profileId: Id, tokenBudget: z.number().int().min(1024).max(10000000), mode: z.enum(['chat','coding']).default('chat') }).strict(),
  'artifact.preview': z.object({ taskId: Id, path: z.string().min(1).max(4096) }).strict(),
  'artifact.chunk': z.object({ previewId: Id, offset: z.number().int().nonnegative() }).strict(),
  'task.exportTranscript': z.object({ taskId: Id, includeChildren: z.boolean().default(true) }).strict(),
} as const;
export interface ContinuityApi {
  invoke(method: 'templates.list', params: z.input<typeof ContinuityRpc['templates.list']>): Promise<TemplatePage>;
  invoke(method: 'templates.save', params: TaskTemplate): Promise<TaskTemplate>;
  invoke(method: 'templates.remove', params: {templateId:string}): Promise<{removed:boolean}>;
  invoke(method: 'continuity.get', params:z.input<typeof ContinuityRpc['continuity.get']>):Promise<ContinuityView>;
  invoke(method: 'decision.save', params:z.input<typeof ContinuityRpc['decision.save']>):Promise<DecisionCard>;
  invoke(method: 'task.continuationPreview', params:z.input<typeof ContinuityRpc['task.continuationPreview']>):Promise<ContinuationPreview>;
  invoke(method: 'task.continue', params:z.input<typeof ContinuityRpc['task.continue']>):Promise<Task>;
  invoke(method: 'artifact.preview', params:{taskId:string;path:string}):Promise<ArtifactPreview>;
  invoke(method: 'artifact.chunk', params:{previewId:string;offset:number}):Promise<{content:string;nextOffset:number|null}>;
  invoke(method: 'task.exportTranscript', params:{taskId:string;includeChildren?:boolean}):Promise<TranscriptExport>;
}
