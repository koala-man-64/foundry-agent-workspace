import type { UsageRecord } from '../../../../packages/protocol/src/index';

export function UsageChart({ records }: { records: UsageRecord[] }) {
  const items = records.slice(-20);
  if (!items.length) return <p className="muted">No completed provider requests recorded yet. Active reservations appear in usage totals.</p>;
  const notSent = (item: UsageRecord): boolean => !item.usageKnown && item.outcome !== undefined && item.attemptedAt === null;
  const values = items.map(item => item.usageKnown ? (item.promptTokens ?? 0) + (item.completionTokens ?? 0) : notSent(item) ? 0 : item.reservedTokens);
  const maximum = Math.max(1, ...values);
  const reported = items.filter(item => item.usageKnown);
  const unknown = items.filter(item => !item.usageKnown && !notSent(item));
  const released = items.filter(notSent);
  return <figure className="usage-chart">
    <svg role="img" aria-label="Last twenty completed requests: reported usage in green, unknown usage reservations in orange, requests not sent in gray" viewBox="0 0 320 118" preserveAspectRatio="none">
      <line x1="0" y1="100" x2="320" y2="100" stroke="#aeb9a7" />
      {items.map((item, index) => {
        const height = Math.max(2, values[index]! / maximum * 85);
        const width = 300 / items.length;
        return <rect key={item.id} x={10 + index * width} y={100 - height} width={Math.max(3, width - 3)} height={height} fill={item.usageKnown ? '#587f65' : notSent(item) ? '#8c948c' : '#c77b42'}><title>{item.usageKnown ? `${values[index]!.toLocaleString()} reported tokens` : notSent(item) ? 'Request was not sent; reservation released' : `${item.reservedTokens.toLocaleString()} retained reservation; usage unknown`}</title></rect>;
      })}
    </svg>
    <figcaption>Reported prompt + completion tokens (green); conservative reservations with unknown usage (orange); requests not sent (gray). Active reservations appear in usage totals.</figcaption>
    <table><caption>Last {items.length} completed requests</caption><tbody>
      <tr><th scope="row">Reported</th><td>{reported.length} requests</td><td>{reported.reduce((sum, item) => sum + (item.promptTokens ?? 0) + (item.completionTokens ?? 0), 0).toLocaleString()} tokens</td></tr>
      <tr><th scope="row">Unknown usage</th><td>{unknown.length} requests</td><td>{unknown.reduce((sum, item) => sum + item.reservedTokens, 0).toLocaleString()} reserved</td></tr>
      <tr><th scope="row">Not sent</th><td>{released.length} requests</td><td>0 observed tokens</td></tr>
    </tbody></table>
  </figure>;
}
