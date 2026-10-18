import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { estimateContext, estimateRequest, reserveRequest } from '../../packages/runtime/src/agent-loop';
import { measuredUsage } from '../../packages/runtime/src/usage-accounting';
import type { ProviderRequest, Task } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

type Input = { operation: string; value: Record<string, unknown>; task?: Record<string, unknown> };
const inputs: Input[] = [];
const contexts = [
  { messages: [] }, { messages: [{ role: 'user', content: 'hello' }] }, { messages: [{ role: 'user', content: '😀é文件\ud800' }] },
  { messages: [], tools: [] }, { messages: [], tools: null },
  { messages: [], tools: [{ name: 'fixture', inputSchema: { '2': true, '1': false }, description: 'fixture' }], continuation: { apiKind: 'fake', data: { opaque: [1, null, 'keep'], future: true } }, toolResults: [{ id: 'fixture', name: 'fixture', content: 'done', isError: false }] }
];
for (const context of contexts) {
  const value = { ...context, profile: { outputLimit: 512, contextLimit: 1000000 }, credential: 'fixture-not-in-estimate' };
  const amount = estimateContext(value as unknown as ProviderRequest);
  inputs.push({ operation: 'estimateContext', value });
  inputs.push({ operation: 'reserveRequest', value: { ...value, profile: { outputLimit: 512, contextLimit: amount - 1 } }, task: { usedTokens: 17, tokenBudget: amount + 16 } });
  for (const delta of [-1, 0, 1]) {
    inputs.push({ operation: 'estimateRequest', value: { ...value, profile: { outputLimit: 512, contextLimit: amount + delta } } });
    inputs.push({ operation: 'reserveRequest', value, task: { usedTokens: 17, tokenBudget: amount + 17 + delta } });
  }
}
const quantities = [undefined, null, '10', true, -1, -0, 0, 0.5, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1];
for (const inputTokens of quantities) for (const outputTokens of quantities) inputs.push({ operation: 'measuredUsage', value: { type: 'usage', inputTokens, outputTokens } });
const subsets = [undefined, null, -1, 0, 0.5, 2, 5, 10, 11, '3'];
for (const cacheReadTokens of subsets) for (const cacheCreationTokens of subsets) for (const reasoningTokens of [0, 5, 6])
  inputs.push({ operation: 'measuredUsage', value: { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens, cacheCreationTokens, reasoningTokens } });

it('pins budget byte counts, strict bounds and conservative measurement validation', () => {
  const cases = inputs.map((input, index) => {
    let expected;
    try {
      const value = input.operation === 'estimateContext' ? estimateContext(input.value as unknown as ProviderRequest)
        : input.operation === 'estimateRequest' ? estimateRequest(input.value as unknown as ProviderRequest)
          : input.operation === 'reserveRequest' ? reserveRequest(input.task as unknown as Task, input.value as unknown as ProviderRequest)
            : measuredUsage(input.value as unknown as Parameters<typeof measuredUsage>[0]);
      expected = { value: value ?? null };
    } catch (error) { if (!(error instanceof Error)) throw error; expected = { error: error.message }; }
    return { name: `${input.operation}:${index}`, ...input, expected };
  });
  if (regenerating('P2_WRITE_ACCOUNTING')) writeFileSync('tests/p2/request-accounting-vectors.json', JSON.stringify(cases, null, 2) + '\n');
  expect(JSON.parse(readFileSync('tests/p2/request-accounting-vectors.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(cases)));
});
