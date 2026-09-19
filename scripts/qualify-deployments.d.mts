export type ApiKind = 'responses' | 'chat-completions' | 'anthropic';

export const API_KINDS: readonly ApiKind[];
export const DEFAULT_CREDENTIAL_ENV: string;
export const DEFAULT_OUTPUT_PATH: string;

export interface QualificationOptions {
  endpoint?: string;
  deployment?: string;
  apiKind?: string;
  credential?: string;
  mock?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => string;
  /** Test-only injection point: substitutes canned SSE frames for one apiKind/turnKind pair. */
  mockOverrides?: Record<string, Record<string, string[] | ((nonce: string) => string[])>>;
}

export interface QualificationCheck {
  ok: boolean;
  detail: string;
  [key: string]: unknown;
}

export type UsageValue = number | 'unknown';

export interface QualificationReport {
  timestamp: string;
  endpoint: string;
  deployment: string;
  apiKind: string;
  fingerprint: string;
  mock: boolean;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    toolContinuation: boolean;
    cancellation: boolean;
    usageAccounting: boolean;
  };
  checks: {
    streaming: QualificationCheck;
    toolCalling: QualificationCheck;
    toolContinuation: QualificationCheck;
    cancellation: QualificationCheck;
    usageAccounting: QualificationCheck;
  };
  latency: {
    timeToFirstTokenMs: number | null;
    totalStreamMs: number | null;
    cancellationTeardownMs: number | null;
  };
  usage: {
    promptTokens: UsageValue;
    completionTokens: UsageValue;
    cacheReadTokens: UsageValue;
    cacheCreationTokens: UsageValue;
  };
}

export function runQualification(options?: QualificationOptions): Promise<QualificationReport>;
