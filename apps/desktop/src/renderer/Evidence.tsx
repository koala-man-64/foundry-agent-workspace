import { classifyPatchLines } from './layout';

/** An authoritative hash, SHA or id: always the full value, wrapped rather than truncated. */
export function Hash({ value }: { value?: string | null }) {
  return value ? <code className="hash">{value}</code> : <>none</>;
}

/** Unified-diff text with per-line classes; the rendered text is byte-for-byte the patch. */
export function PatchText({ patch, suffix = '' }: { patch: string; suffix?: string }) {
  // Very large patches stay one text node: per-line spans would cost layout without helping review.
  if (patch.length > 200_000) return <pre>{patch}{suffix}</pre>;
  return <pre>{classifyPatchLines(patch).map((line, index) => <span key={index} className={`patch-line ${line.kind}`}>{line.text}</span>)}{suffix}</pre>;
}
