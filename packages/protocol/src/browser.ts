import { z } from 'zod';

const Id = z.string().uuid();
export const BrowserUrlSchema = z.string().trim().max(8192).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Enter an HTTP or HTTPS URL without embedded credentials.');
const Target = { tabId: Id, snapshotId: Id, nodeId: z.string().min(1).max(80) };
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), tabId: Id, url: BrowserUrlSchema }).strict(),
  z.object({ kind: z.literal('click'), ...Target }).strict(),
  z.object({ kind: z.literal('fill'), ...Target, text: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('select'), ...Target, value: z.string().max(1024) }).strict(),
  z.object({ kind: z.literal('press'), ...Target, key: z.enum(['Enter', 'Space', 'Escape']) }).strict(),
  z.object({ kind: z.literal('scroll'), tabId: Id, snapshotId: Id, direction: z.enum(['up', 'down']), pixels: z.number().int().min(1).max(1500) }).strict()
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export const BrowserTabSchema = z.object({
  id: Id, title: z.string().max(512), url: z.string().max(8192), loading: z.boolean(),
  canGoBack: z.boolean(), canGoForward: z.boolean(), generation: z.number().int().nonnegative(),
  attachedTaskId: Id.nullable(), authorizedOrigin: z.string().max(8192).nullable(), sharing: z.boolean(), error: z.string().max(1000).nullable()
}).strict();
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export const BrowserStateSchema = z.object({ tabs: z.array(BrowserTabSchema).max(20), activeTabId: Id.nullable() }).strict();
export type BrowserState = z.infer<typeof BrowserStateSchema>;
export const BrowserBoundsSchema = z.object({ x: z.number().int().min(0).max(30000), y: z.number().int().min(0).max(30000), width: z.number().int().min(0).max(30000), height: z.number().int().min(0).max(30000), visible: z.boolean() }).strict();
export const BrowserCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state') }).strict(), z.object({ kind: z.literal('create') }).strict(),
  ...(['activate', 'close', 'back', 'forward', 'reload', 'stop', 'takeControl'] as const).map(kind => z.object({ kind: z.literal(kind), tabId: Id }).strict()),
  z.object({ kind: z.literal('navigate'), tabId: Id, url: BrowserUrlSchema }).strict(),
  z.object({ kind: z.literal('bounds'), bounds: BrowserBoundsSchema }).strict(),
  z.object({ kind: z.literal('attach'), tabId: Id, taskId: Id }).strict(),
  z.object({ kind: z.literal('clearSite'), tabId: Id, confirm: z.literal('clear-site') }).strict(),
  z.object({ kind: z.literal('clearProfile'), confirm: z.literal('clear-profile') }).strict()
]);
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export const BrowserNodeSchema = z.object({ id: z.string().max(80), role: z.string().max(80), name: z.string().max(512) }).strict();
export const BrowserSnapshotSchema = z.object({ id: Id, tabId: Id, generation: z.number().int().nonnegative(), origin: z.string().max(8192), url: z.string().max(8192), text: z.string().max(48000), nodes: z.array(BrowserNodeSchema).max(300), truncated: z.boolean() }).strict();
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;
export const BrowserPreparedSchema = z.object({ id: Id, taskId: Id, tabId: Id, attachmentId: Id, generation: z.number().int().nonnegative(), origin: z.string().max(8192), action: BrowserActionSchema, summary: z.string().max(6000), createdAt: z.string() }).strict();
export type BrowserPrepared = z.infer<typeof BrowserPreparedSchema>;
export const BrowserExecutionSchema = z.object({ status: z.literal('dispatched'), detail: z.string().max(4000) }).strict();
export const BrowserInspectionSchema = z.object({ tabId: Id, generation: z.number().int().nonnegative(), origin: z.string().max(8192), inspectedAt: z.string(), tabAvailable: z.boolean().optional() }).strict();
export type BrowserInspection = z.infer<typeof BrowserInspectionSchema>;
export const BrowserHostRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tabs'), taskId: Id }).strict(),
  z.object({ kind: z.literal('snapshot'), taskId: Id, tabId: Id }).strict(),
  z.object({ kind: z.literal('prepare'), taskId: Id, action: BrowserActionSchema }).strict(),
  z.object({ kind: z.literal('execute'), taskId: Id, preparedId: Id }).strict(),
  z.object({ kind: z.literal('revoke'), taskId: Id }).strict(),
  z.object({ kind: z.literal('inspect'), taskId: Id, tabId: Id }).strict()
]);
export type BrowserHostRequest = z.infer<typeof BrowserHostRequestSchema>;
export const BrowserHostResultSchema = z.union([z.array(BrowserTabSchema).max(20), BrowserSnapshotSchema, BrowserPreparedSchema, BrowserExecutionSchema, BrowserInspectionSchema, z.null()]);
export type BrowserHostResult = z.infer<typeof BrowserHostResultSchema>;
export const BrowserHostCallSchema = z.object({ jsonrpc: z.literal('2.0'), id: Id, method: z.literal('browser.host'), params: BrowserHostRequestSchema }).strict();
export const BrowserInvalidationSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.literal('browser.invalidated'), params: z.object({ taskId: Id, tabId: Id }).strict() }).strict();
export const BrowserHostReplySchema = z.object({ jsonrpc: z.literal('2.0'), id: Id, method: z.literal('browser.host.result'), result: BrowserHostResultSchema.optional(), error: z.object({ code: z.enum(['stale', 'failed', 'unknown']), message: z.string().max(1000) }).strict().optional() }).strict().refine(value => (value.result !== undefined) !== (value.error !== undefined), 'Exactly one result or error is required.');
export interface BrowserHost { request(input: BrowserHostRequest, signal?: AbortSignal): Promise<BrowserHostResult>; }
export class BrowserHostError extends Error { constructor(public readonly code: 'stale' | 'failed' | 'unknown', message: string) { super(message); this.name = 'BrowserHostError'; } }
export interface BrowserApprovalData { prepared: BrowserPrepared; acknowledgment?: BrowserInspection; }
export const BrowserRecoveryRpc = { 'browser.acknowledgeUnknown': z.object({ taskId: Id, approvalId: Id, confirm: z.literal('inspected-unknown-result') }).strict() };
