import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../../../packages/protocol/src/index';
import { UsageChart } from './UsageChart';

describe('UsageChart', () => {
  it('separates reported tokens, unknown reservations, and requests not sent', () => {
    const base = { taskId: 'task', reservedTokens: 50, promptTokens: null, completionTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null, reason: null, createdAt: '2026-09-27T00:00:00.000Z' };
    const records: UsageRecord[] = [
      { ...base, id: 'known', requestId: 'known', usageKnown: true, promptTokens: 10, completionTokens: 5, outcome: 'completed', attemptedAt: base.createdAt },
      { ...base, id: 'unknown', requestId: 'unknown', usageKnown: false, outcome: 'failed', attemptedAt: base.createdAt },
      { ...base, id: 'not-sent', requestId: 'not-sent', usageKnown: false, outcome: 'cancelled', attemptedAt: null }
    ];
    const html = renderToStaticMarkup(createElement(UsageChart, { records }));
    expect(html).toContain('15 tokens');
    expect(html).toContain('50 reserved');
    expect(html).toContain('0 observed tokens');
    expect(html).toContain('Request was not sent; reservation released');
  });

  it('marks each kind by class and pattern, not by colour alone, with no inline colour to override', () => {
    const base = { taskId: 'task', reservedTokens: 50, promptTokens: null, completionTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null, reason: null, createdAt: '2026-09-27T00:00:00.000Z' };
    const records: UsageRecord[] = [
      { ...base, id: 'known', requestId: 'known', usageKnown: true, promptTokens: 10, completionTokens: 5, outcome: 'completed', attemptedAt: base.createdAt },
      { ...base, id: 'unknown', requestId: 'unknown', usageKnown: false, outcome: 'failed', attemptedAt: base.createdAt },
      { ...base, id: 'not-sent', requestId: 'not-sent', usageKnown: false, outcome: 'cancelled', attemptedAt: null }
    ];
    const html = renderToStaticMarkup(createElement(UsageChart, { records }));
    expect(html).toContain('class="request-chart"');
    expect(html).toMatch(/<rect class="bar-reported"/);
    expect(html).toMatch(/<rect class="bar-unsent"/);
    const hatch = /<pattern id="([^"]+)"/.exec(html)?.[1];
    expect(hatch).toBeTruthy();
    expect(html).toContain(`class="bar-unknown" x="`);
    expect(html).toContain(`fill="url(#${hatch})"`);
    expect(html).not.toMatch(/fill="#/);
    for (const label of ['Reported prompt + completion tokens', 'Conservative reservation, usage unknown', 'Request not sent']) expect(html).toContain(label);
  });
});
