import { z } from 'zod';

/**
 * Shared, tested orchestration bounds. Store, runtime and renderer use these
 * constants; nothing in repository text or model output can raise them.
 */
export const ORCHESTRATION_LIMITS = {
  maxAssignmentRevisions: 8,
  maxAdmittedChildren: 2,
  childSummariesPerPage: 8,
  eventsPerPage: 50,
  summaryTextBytes: 4 * 1024,
  childReportBytes: 16 * 1024,
  responseBytes: 256 * 1024,
  maxScopePaths: 32,
  maxDependencies: 8,
  maxAcceptanceItems: 16,
  maxChildProfiles: 4,
  protectedCoordinatorPercent: 20,
  budgetWarningPercent: 80,
  patchBytes: 128 * 1024
} as const;

/**
 * Coordinated mode is enabled after the approved increments passed local tests, E2E, packaged smoke
 * and independent review. It still requires a v2 database (a verified, backed-up upgrade for v1 data).
 */
export const COORDINATED_MODE_ENABLED = true;

/** Current SQLite schema version produced by this build. */
export const SCHEMA_VERSION = 2;

export type AgentRole = 'coordinator' | 'child';
export type RunLifecycle = 'queued' | 'preparing' | 'running' | 'waiting' | 'terminal';
export type RunOutcome = 'succeeded' | 'incomplete' | 'failed' | 'cancelled';
export type WaitReason = 'admission' | 'dependencies' | 'children' | 'approval' | 'profile-quota' | 'task-budget' | 'conflict' | 'reconciliation' | 'user-continuation';
export type AssignmentState = 'proposed' | 'admitted' | 'result-submitted' | 'integrated' | 'incomplete' | 'failed' | 'cancelled' | 'revoked' | 'superseded';
export type IntegrationState = 'awaiting-approval' | 'executing' | 'succeeded' | 'conflict' | 'continued' | 'empty' | 'mismatch' | 'unknown' | 'rejected' | 'revoked' | 'failed';
export type HandoffState = 'awaiting-approval' | 'executing' | 'staged' | 'committed' | 'complete' | 'rejected' | 'revoked' | 'failed' | 'unknown';

export const CommandSpecSchema = z.object({
  command: z.string().trim().min(1).max(16384),
  cwd: z.string().max(4096).default(''),
  timeoutMs: z.number().int().min(100).max(600000).default(600000)
}).strict();
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const CoordinationConfigSchema = z.object({
  childProfileIds: z.array(z.string().uuid()).max(ORCHESTRATION_LIMITS.maxChildProfiles).default([]),
  requiredValidation: CommandSpecSchema
}).strict();
export type CoordinationConfig = z.infer<typeof CoordinationConfigSchema>;

export interface AgentRun {
  taskId: string; rootTaskId: string; parentTaskId: string | null; role: AgentRole; assignmentId: string | null;
  lifecycle: RunLifecycle; waitReason: WaitReason | null; outcome: RunOutcome | null; generation: number; cancelRequested: boolean;
  title: string; profileId: string; worktreePath: string; branch: string; baseCommit: string; createdAt: string; updatedAt: string;
}

export interface AssignmentSpec {
  objective: string; acceptance: string[]; readPaths: string[]; writePaths: string[];
  profileId: string; profileFingerprint: string; allocation: number; validation: CommandSpec | null;
}
export interface Assignment extends AssignmentSpec {
  id: string; rootTaskId: string; revision: number; supersedesId: string | null; key: string; dependsOn: string[];
  createdBy: 'coordinator' | 'user'; state: AssignmentState; childTaskId: string | null; baseCommit: string | null; baseTree: string | null;
  waitReason: WaitReason | null; createdAt: string; updatedAt: string;
}

export interface ChildResult {
  id: string; rootTaskId: string; assignmentId: string; childTaskId: string; revision: number;
  baseCommit: string; commit: string; tree: string; changedPaths: string[]; manifestSha256: string;
  evidenceIds: string[]; summary: string; unresolved: string; createdAt: string;
}

export interface ValidationEvidence {
  id: string; rootTaskId: string; runTaskId: string; approvalId: string; kind: 'child' | 'combined';
  command: string; cwd: string; head: string; tree: string; branch: string | null; clean: boolean; stateFingerprint: string;
  exitCode: number | null; cleanupVerified: boolean; passed: boolean; createdAt: string;
}

export interface IntegrationOperation {
  id: string; rootTaskId: string; resultId: string; assignmentId: string; kind: 'cherry-pick' | 'continue'; parentOperationId: string | null;
  state: IntegrationState; approvalId: string | null; expectedHead: string; expectedTree: string; sourceSha: string;
  manifestSha256: string; resolvedTree: string | null;
  observed: { commit?: string; tree?: string; cherryPickHead?: string | null; unmergedPaths?: string[]; detail?: string } | null;
  createdAt: string; updatedAt: string;
}

export interface RunBudget { taskId: string; role: AgentRole; allocation: number | null; charged: number; inFlight: number; unusedHold: number; released: boolean }
export interface BudgetSummary {
  cap: number; protectedCoordinator: number; charged: number; inFlight: number; unusedHolds: number; unallocated: number;
  retainedUnknown: number; overrun: boolean; warning: boolean; runs: RunBudget[];
}

export interface CompletionState { complete: boolean; completedAt: string | null; blockers: string[] }

export interface OrchestrationView {
  rootTaskId: string; config: CoordinationConfig; runs: AgentRun[]; runsCursor: number | null; assignments: Assignment[];
  results: ChildResult[]; integrations: IntegrationOperation[]; evidence: ValidationEvidence[]; budget: BudgetSummary;
  events: { sequence: number; type: string; data: unknown; createdAt: string }[]; eventsCursor: number | null;
  completion: CompletionState; truncated: boolean;
}

export const OrchestrationRpc = {
  'workspace.schema': z.object({}).strict(),
  'workspace.upgrade': z.object({ confirm: z.literal('backup-and-upgrade') }).strict(),
  'orchestration.get': z.object({ rootTaskId: z.string().uuid(), runsCursor: z.number().int().min(0).max(1000).default(0), eventsBefore: z.number().int().min(1).optional() }).strict(),
  'orchestration.child': z.object({ rootTaskId: z.string().uuid(), childTaskId: z.string().uuid() }).strict(),
  'orchestration.cancelChild': z.object({ rootTaskId: z.string().uuid(), childTaskId: z.string().uuid(), generation: z.number().int().min(1) }).strict(),
  'orchestration.cancelRoot': z.object({ rootTaskId: z.string().uuid() }).strict(),
  'orchestration.resume': z.object({ rootTaskId: z.string().uuid(), content: z.string().trim().min(1).max(64000) }).strict(),
  'orchestration.reviseAssignment': z.object({ rootTaskId: z.string().uuid(), assignmentId: z.string().uuid(), objective: z.string().trim().min(1).max(ORCHESTRATION_LIMITS.summaryTextBytes), acceptance: z.array(z.string().trim().min(1).max(1024)).min(1).max(ORCHESTRATION_LIMITS.maxAcceptanceItems) }).strict(),
  'orchestration.decide': z.object({ rootTaskId: z.string().uuid(), taskId: z.string().uuid(), approvalId: z.string().uuid(), nonce: z.string().min(16).max(128), assignmentId: z.string().uuid().nullable(), generation: z.number().int().min(1), fingerprint: z.string().min(1).max(128), decision: z.enum(['approve', 'reject']) }).strict(),
  'orchestration.reconcile': z.object({ rootTaskId: z.string().uuid(), operationId: z.string().uuid() }).strict(),
  'orchestration.prepareContinue': z.object({ rootTaskId: z.string().uuid(), operationId: z.string().uuid() }).strict()
} as const;

export interface SchemaStatus { version: number; current: number; upgradeRequired: boolean; coordinatedAvailable: boolean }
export interface UpgradeResult { version: number; backupPath: string }
export interface ChildDetail {
  run: AgentRun; assignment: Assignment | null; messages: { id: string; role: 'user' | 'assistant' | 'system'; content: string; status: string; createdAt: string; truncated: boolean }[];
  approvals: import('./index').Approval[]; results: ChildResult[]; evidence: ValidationEvidence[]; truncated: boolean;
}

/** UTF-8-safe truncation for display text only. IDs, hashes and structured evidence are never passed here. */
export function boundText(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return { text: value, truncated: false };
  const marker = '\n[truncated]';
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, Math.max(0, maximumBytes - marker.length)));
  // A cut inside a multi-byte sequence decodes to U+FFFD; drop it rather than display a false character.
  return { text: kept.replace(/�$/, '') + marker, truncated: true };
}
