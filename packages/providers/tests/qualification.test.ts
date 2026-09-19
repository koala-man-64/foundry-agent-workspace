import { describe, expect, it } from 'vitest';
import { API_KINDS, runQualification } from '../../../scripts/qualify-deployments.mjs';

describe('qualification engine (mock mode, offline)', () => {
  it.each(API_KINDS)('truthfully reports all 5 capabilities for %s', async apiKind => {
    const report = await runQualification({ apiKind, mock: true });
    expect(report.mock).toBe(true);
    expect(report.apiKind).toBe(apiKind);
    expect(report.capabilities).toEqual({ streaming: true, toolCalling: true, toolContinuation: true, cancellation: true, usageAccounting: true });
    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(report)).not.toMatch(/api-?key|credential|secret/i);

    expect(report.latency.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    expect(report.latency.cancellationTeardownMs).toBeGreaterThanOrEqual(0);
    const toolCall = report.checks.toolCalling.toolCall as { arguments: { nonce: string } };
    expect(toolCall.arguments.nonce).toBeTruthy();
    expect(report.checks.toolContinuation.preservedOpaqueContinuationData).toBe(true);

    expect(report.usage.promptTokens).not.toBe(0);
    expect(report.usage.completionTokens).not.toBe(0);
    expect(typeof report.usage.promptTokens === 'number' || report.usage.promptTokens === 'unknown').toBe(true);
    expect(typeof report.usage.cacheReadTokens === 'number' || report.usage.cacheReadTokens === 'unknown').toBe(true);
  });

  it('rejects an unsupported --api-kind before running any turn', async () => {
    await expect(runQualification({ apiKind: 'not-a-kind', mock: true })).rejects.toThrow('Unsupported --api-kind');
  });

  it('requires a credential outside of mock mode', async () => {
    await expect(runQualification({ apiKind: 'responses', endpoint: 'https://sample.openai.azure.com', deployment: 'd' })).rejects.toThrow('A credential is required');
  });

  it('classifies a missing tool call as a failed capability without crashing the run, and skips the dependent continuation check', async () => {
    const report = await runQualification({
      apiKind: 'responses',
      mock: true,
      mockOverrides: {
        responses: {
          'tool-call': () => [
            'event: response.output_text.delta\ndata: {"delta":"no tool call here"}\n\n',
            'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"no tool call here"}]}],"usage":{"input_tokens":5,"output_tokens":5}}}\n\n'
          ]
        }
      }
    });
    expect(report.capabilities.toolCalling).toBe(false);
    expect(report.checks.toolCalling.detail).toContain('No tool call was returned');
    expect(report.capabilities.toolContinuation).toBe(false);
    expect(report.checks.toolContinuation.detail).toContain('Skipped');
    // Independent checks still run and are unaffected by the tool-calling failure.
    expect(report.capabilities.streaming).toBe(true);
    expect(report.capabilities.cancellation).toBe(true);
  });

  it('classifies a stream that never reaches a completion signal as a failed streaming capability', async () => {
    const report = await runQualification({
      apiKind: 'chat-completions',
      mock: true,
      mockOverrides: { 'chat-completions': { streaming: () => ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'] } }
    });
    expect(report.capabilities.streaming).toBe(false);
    expect(report.checks.streaming.detail).toBeTruthy();
    expect(report.capabilities.usageAccounting).toBe(false);
    expect(report.checks.usageAccounting.detail).toContain('No usage event');
    expect(report.usage).toEqual({ promptTokens: 'unknown', completionTokens: 'unknown', cacheReadTokens: 'unknown', cacheCreationTokens: 'unknown' });
  });

  it('classifies a tool call whose arguments never complete as failed, not as a thrown error', async () => {
    const report = await runQualification({
      apiKind: 'anthropic',
      mock: true,
      mockOverrides: {
        anthropic: {
          'tool-call': () => [
            'event: message_start\ndata: {"message":{"usage":{"input_tokens":10}}}\n\n',
            'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"call-1","name":"report_nonce"}}\n\n',
            'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"nonce\\":"}}\n\n',
            'event: content_block_stop\ndata: {"index":0}\n\n',
            'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
            'event: message_stop\ndata: {}\n\n'
          ]
        }
      }
    });
    expect(report.capabilities.toolCalling).toBe(false);
    expect(report.checks.toolCalling.detail).toBeTruthy();
  });

  it('marks missing usage fields as "unknown" rather than defaulting to zero', async () => {
    const report = await runQualification({
      apiKind: 'responses',
      mock: true,
      mockOverrides: {
        responses: {
          streaming: () => [
            'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
            'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"hi"}]}],"usage":{}}}\n\n'
          ]
        }
      }
    });
    expect(report.usage.promptTokens).toBe('unknown');
    expect(report.usage.completionTokens).toBe('unknown');
    expect(report.usage.cacheReadTokens).toBe('unknown');
    expect(report.usage.cacheCreationTokens).toBe('unknown');
    expect(report.capabilities.usageAccounting).toBe(false);
  });

  it('never touches the network in mock mode', async () => {
    let called = false;
    const fetchImpl = (() => { called = true; throw new Error('must not be called in --mock'); }) as typeof fetch;
    const report = await runQualification({ apiKind: 'responses', mock: true, fetchImpl });
    expect(called).toBe(false);
    expect(report.capabilities.streaming).toBe(true);
  });
});
