import { describe, expect, it } from 'vitest';
import { ModelProfileSchema, RpcMethods, UsageFiltersSchema, supportedEfforts } from '../src/index';

describe('usage RPC and effort contracts', () => {
  it('canonicalizes offset date filters so storage comparisons share UTC boundaries', () => {
    expect(UsageFiltersSchema.parse({ from: '2026-11-01T00:00:00-05:00', to: '2026-11-02T00:00:00-06:00' })).toMatchObject({ from: '2026-11-01T05:00:00.000Z', to: '2026-11-02T06:00:00.000Z' });
  });
  it('rejects invalid dates, reversed instants, and timezone identifiers', () => {
    expect(() => UsageFiltersSchema.parse({ from: '2026-02-30T00:00:00Z' })).toThrow();
    expect(() => UsageFiltersSchema.parse({ from: '2026-01-01T01:00:00Z', to: '2026-01-01T00:00:00Z' })).toThrow();
    expect(() => RpcMethods['usage.summary'].parse({ timeZone: 'not/a/timezone' })).toThrow();
  });
  it('bounds request pagination and rejects unknown query capabilities', () => {
    expect(RpcMethods['usage.requests'].parse({})).toEqual({ filters: { includeDemo: false, includeChildren: true }, limit: 50 });
    expect(() => RpcMethods['usage.requests'].parse({ limit: 101 })).toThrow();
    expect(() => RpcMethods['usage.requests'].parse({ filters: { path: 'private.db' } })).toThrow();
    expect(() => RpcMethods['usage.requests'].parse({ filters: { model: 'u:garbage' } })).toThrow();
    expect(() => RpcMethods['usage.requests'].parse({ filters: { model: 'r:' } })).toThrow();
    const fullModel = 'r:' + 'm'.repeat(200);
    expect(RpcMethods['usage.requests'].parse({ filters: { model: fullModel } }).filters.model).toBe(fullModel);
  });
  it('permits only API-specific effort settings and leaves default absent', () => {
    const profile = { id: '00000000-0000-4000-8000-000000000123', name: 'fixture', apiKind: 'anthropic', endpoint: 'https://fixture.services.ai.azure.com', deployment: 'fixture', contextLimit: 32000, outputLimit: 4096 };
    expect(ModelProfileSchema.parse(profile).effort).toBeUndefined();
    expect(ModelProfileSchema.parse({ ...profile, effort: 'high' }).effort).toBe('high');
    expect(() => ModelProfileSchema.parse({ ...profile, effort: 'minimal' })).toThrow();
    expect(() => ModelProfileSchema.parse({ ...profile, apiKind: 'fake', effort: 'high' })).toThrow();
    expect(supportedEfforts('responses')).toContain('none');
    expect(ModelProfileSchema.parse({ ...profile, apiKind: 'responses', effort: 'max' }).effort).toBe('max');
    expect(() => ModelProfileSchema.parse({ ...profile, apiKind: 'chat-completions', effort: 'max' })).toThrow();
    expect(supportedEfforts('chat-completions')).not.toContain('max');
  });
});
