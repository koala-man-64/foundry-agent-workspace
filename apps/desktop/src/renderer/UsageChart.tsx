import { useId } from 'react';
import type { UsageRecord } from '../../../../packages/protocol/src/index';

/**
 * The last twenty requests of one task. Reported usage, unknown-usage reservations and requests never sent are told
 * apart by fill pattern as well as colour (solid, hatched, outlined), so unknown never reads like reported usage.
 */
export function UsageChart({ records }: { records: UsageRecord[] }) {
  const hatchId = `usage-hatch-${useId().replace(/:/g, '')}`;
  const items = records.slice(-20);
  if (!items.length) return <p className="muted">No completed provider requests recorded yet. Active reservations appear in usage totals.</p>;
  const notSent = (item: UsageRecord): boolean => !item.usageKnown && item.outcome !== undefined && item.attemptedAt === null;
  const values = items.map(item => item.usageKnown ? (item.promptTokens ?? 0) + (item.completionTokens ?? 0) : notSent(item) ? 0 : item.reservedTokens);
  const maximum = Math.max(1, ...values);
  const reported = items.filter(item => item.usageKnown);
  const unknown = items.filter(item => !item.usageKnown && !notSent(item));
  const released = items.filter(notSent);
  return <figure className="request-chart">
    <svg role="img" aria-label="Last twenty completed requests: reported usage as solid bars, unknown usage reservations as hatched bars, requests not sent as outlined bars" viewBox="0 0 320 118" preserveAspectRatio="none">
      <defs><pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="hatch-ground" width="5" height="5" /><line className="hatch-line" x1="0" y1="0" x2="0" y2="5" strokeWidth="2.4" /></pattern></defs>
      <line className="chart-axis" x1="0" y1="100" x2="320" y2="100" />
      {items.map((item, index) => {
        const height = Math.max(2, values[index]! / maximum * 85);
        const width = 300 / items.length;
        const kind = item.usageKnown ? 'reported' : notSent(item) ? 'unsent' : 'unknown';
        return <rect key={item.id} className={`bar-${kind}`} x={10 + index * width} y={100 - height} width={Math.max(3, width - 3)} height={height} fill={kind === 'unknown' ? `url(#${hatchId})` : undefined}><title>{item.usageKnown ? `${values[index]!.toLocaleString()} reported tokens` : notSent(item) ? 'Request was not sent; reservation released' : `${item.reservedTokens.toLocaleString()} retained reservation; usage unknown`}</title></rect>;
      })}
    </svg>
    <figcaption>
      <ul className="chart-legend">
        <li><span className="swatch bar-reported" aria-hidden="true" />Reported prompt + completion tokens</li>
        <li><span className="swatch bar-unknown" aria-hidden="true" />Conservative reservation, usage unknown</li>
        <li><span className="swatch bar-unsent" aria-hidden="true" />Request not sent</li>
      </ul>
      Active reservations appear in usage totals.
    </figcaption>
    <table><caption>Last {items.length} completed requests</caption><tbody>
      <tr><th scope="row">Reported</th><td>{reported.length} requests</td><td>{reported.reduce((sum, item) => sum + (item.promptTokens ?? 0) + (item.completionTokens ?? 0), 0).toLocaleString()} tokens</td></tr>
      <tr><th scope="row">Unknown usage</th><td>{unknown.length} requests</td><td>{unknown.reduce((sum, item) => sum + item.reservedTokens, 0).toLocaleString()} reserved</td></tr>
      <tr><th scope="row">Not sent</th><td>{released.length} requests</td><td>0 observed tokens</td></tr>
    </tbody></table>
  </figure>;
}
