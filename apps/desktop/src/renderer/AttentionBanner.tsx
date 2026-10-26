import type { AttentionBanner } from './attention';

/** The banner above the composer: what needs a decision, and one button that opens it. It is never dismissible. */
export function AttentionBannerView({ banner, onReview }: { banner: AttentionBanner; onReview: () => void }) {
  return <div className="approval-banner">
    <div>{banner.lines.map(line => <p key={line}>{line}</p>)}</div>
    <button type="button" className="secondary" onClick={onReview}>{banner.action}</button>
  </div>;
}
