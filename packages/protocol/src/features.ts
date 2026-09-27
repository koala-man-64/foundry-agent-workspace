import { z } from 'zod';

export const FeatureSchema = z.enum(['archive', 'hooks', 'scheduling']);
export const FeatureReasonSchema = z.enum(['user-paused', 'runtime-fault', 'migration-required']);
export type FeatureName = z.infer<typeof FeatureSchema>;
export type FeatureReason = z.infer<typeof FeatureReasonSchema>;
export interface FeatureState { feature: FeatureName; enabled: boolean; reason: FeatureReason | null; updatedAt: string | null; }
export interface FeatureSnapshot { features: FeatureState[]; history: FeatureState[]; }
export const FeatureRpc = {
  'features.get': z.object({}).strict(),
  'features.set': z.object({ feature: FeatureSchema, enabled: z.boolean(), reason: FeatureReasonSchema.optional() }).strict()
} as const;
export interface FeatureApi {
  invoke(method: 'features.get', params: Record<string, never>): Promise<FeatureSnapshot>;
  invoke(method: 'features.set', params: z.input<typeof FeatureRpc['features.set']>): Promise<FeatureState>;
}
