import { useEffect, useState, type ReactNode } from 'react';

/** Every closed disclosure says what it holds and how much: "Events (14)", "Decided approvals (3+: 2 complete, 1 rejected)". */
export function disclosureLabel(label: string, count: number, options: { more?: boolean; detail?: string } = {}): string {
  return `${label} (${count}${options.more ? '+' : ''}${options.detail ? `: ${options.detail}` : ''})`;
}

interface Props {
  summary: string;
  className?: string;
  /** Chosen once, when the disclosure first renders; after that the open state is the user's. */
  defaultOpen?: boolean;
  /** Opens the disclosure when it becomes true; it never closes one. */
  forceOpen?: boolean;
  children: ReactNode;
}

/**
 * Hidden detail, one action away. Native details keeps closed content in the DOM, so keyboard, screen readers and
 * find-in-page still reach it, and nothing opens or closes on its own except through forceOpen.
 */
export function Disclosure({ summary, className, defaultOpen = false, forceOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  return <details className={className ? `disclosure ${className}` : 'disclosure'} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {children}
  </details>;
}
