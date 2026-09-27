import type { UsageRecord } from '../../../../packages/protocol/src/index';

export function UsageChart({ records }: { records: UsageRecord[] }) {
  const items = records.slice(-20);
  if (!items.length) return <p className="muted">No provider requests recorded yet.</p>;
  const values = items.map(item => item.usageKnown ? (item.promptTokens ?? 0) + (item.completionTokens ?? 0) : item.reservedTokens);
  const maximum = Math.max(1, ...values);
  return <figure className="usage-chart">
    <svg role="img" aria-label="Last twenty requests: known token usage in green, retained unknown reservations in orange" viewBox="0 0 320 118" preserveAspectRatio="none">
      <line x1="0" y1="100" x2="320" y2="100" stroke="#aeb9a7" />
      {items.map((item, index) => {
        const height = Math.max(2, values[index]! / maximum * 85);
        const width = 300 / items.length;
        return <rect key={item.id} x={10 + index * width} y={100 - height} width={Math.max(3, width - 3)} height={height} fill={item.usageKnown ? '#587f65' : '#c77b42'}><title>{item.usageKnown ? `${values[index]!.toLocaleString()} reported tokens` : `${item.reservedTokens.toLocaleString()} retained reservation; usage unknown`}</title></rect>;
      })}
    </svg>
    <figcaption>Reported prompt + completion tokens (green); conservative reservations with unknown usage (orange). Cache tokens appear in the request list below.</figcaption>
  </figure>;
}
